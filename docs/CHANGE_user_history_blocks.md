# User + History Block Extraction

**Branch:** `feature/user-history-blocks`
**Target version:** 1.1.0
**Status:** Design locked, implementation in progress

## Background

Through v1.0.x the SDK emits telemetry blocks only for `source: 'system'`
and `source: 'tool'`. The current user message is hashed *separately* in
`computeFingerprint()` but never appears as a block. Prior conversation
turns (assistant responses + earlier user messages) are completely
invisible to telemetry.

This creates two real problems downstream:

1. **The dashboard's content-mix view** can't account for the spend
   attributable to user input or conversation history. For multi-turn
   chat apps this is often the bulk of input tokens.
2. **Memoization correctness on multi-turn requests.** v1.0's
   fingerprint formula uses the *last* user message but ignores
   history. Two requests with the same system + same last-user-message
   but different prior history fingerprint identically — meaning a
   memoization hit could serve a stale response that doesn't match the
   actual conversation.

## Change

`extractBlocks()` now also emits:

- `source: 'user'` — exactly one block per call, hash of the **last**
  `role: 'user'` message's content. This is the "current" user input.
- `source: 'history'` — one block per remaining message (prior user,
  any assistant message, any `role: 'tool'` result), in conversation
  order.

Position numbering continues monotonically after system + tool blocks.
A typical Anthropic-format request looks like:

```
position 0   tool block
position 1   tool block
position 2   system block
position 3   history block (prior user turn 1)
position 4   history block (prior assistant turn 1)
position 5   user block (current message)
```

OpenAI/Google format places system in messages instead of `params.system`,
but the layout is otherwise identical:

```
position 0   system block (extracted from messages)
position 1   tool block
position 2   history block
position 3   history block
position 4   user block
```

## Fingerprint backward-compatibility

`computeFingerprint()` previously concatenated all block hashes (system
+ tool) and appended `sha256(userMessage)`. In 1.1.0 the user message
is itself a block, so the formula simplifies to "concatenate all block
hashes by position." Crucially:

- **Single-turn requests**: same hash as 1.0.x. The block has the same
  `sha256(user text)` value, just appended into the blocks array
  instead of a separate suffix. Backward compatible by construction.
- **Multi-turn requests**: hash changes. v1.0's fingerprint was a bug
  here — two different conversations could fingerprint identically.
  v1.1 correctly differentiates them. Customers upgrading should not
  observe a regression; they'll see better memoization correctness.

`fingerprint_stats` rows from 1.0.x clients remain valid for single-turn
traffic and degrade gracefully for multi-turn (new fingerprints will
accumulate after upgrade; old rows will age out naturally).

## What does NOT change

- `TelemetryBlock` shape: same fields (`hash, tokens, position, cached,
  source`). Just two new allowed `source` values.
- System + tool extraction logic: byte-for-byte unchanged.
- `cached` flag: user / history blocks are always `cached: false`. We
  don't apply `cache_control` to user content.
- The telemetry payload schema, the API ingest endpoint, the rollup
  function — all untouched.

## Tests

Existing 236 tests must stay green. New tests cover:

1. Single user message → 1 user block, 0 history blocks
2. Multi-turn (3 messages: user → assistant → user) → 1 user + 2 history
3. With system in messages array (OpenAI shape) → system extracted as
   `source: 'system'`, not double-counted as `history`
4. Tool-role messages count as history
5. Assistant messages with tool_calls count as history
6. Multipart content arrays produce one block per text part
7. Empty / whitespace-only messages skipped
8. Position numbering correct for both Anthropic and OpenAI shapes
9. Fingerprint regression: single-turn 1.1.0 fingerprint equals 1.0.x
   fingerprint for identical input (the backward-compat guarantee)
10. Fingerprint differentiation: two multi-turn requests with same
    last-user-message but different history produce different
    fingerprints

## Rollout

1. Implement + tests on this branch (`feature/user-history-blocks`)
2. Manual smoke test against a real Anthropic + OpenAI call
3. Open PR back to `main`
4. Tag `v1.1.0` after merge
5. Publish to npm
6. Coordinate the dashboard side (`DASHBOARD-1`: restore user + history
   slices in `ContentMixChart`) — but ONLY after this is published, so
   we don't ship a dashboard expecting data that no SDK is yet emitting.
