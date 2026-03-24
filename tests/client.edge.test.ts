/**
 * Edge case tests for the Genosis TypeScript SDK client.
 *
 * Covers scenarios not exercised by client.test.ts:
 *   1. call() fallback contract — Genosis errors vs LLM errors
 *   2. Manifest lifecycle edge cases
 *   3. Optimization process edge cases
 *   4. Reporting edge cases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { Genosis, _setNowIso, _resetNowIso } from '../src/index.js';
import type { CacheManifest } from '../src/index.js';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

let testCounter = 0;

function makeClient(overrides: Record<string, any> = {}): {
  client: Genosis;
  bufferEvents: Array<{ type: string; payload: Record<string, any> }>;
} {
  testCounter++;
  const bufferEvents: Array<{ type: string; payload: Record<string, any> }> = [];

  const client = new Genosis({
    apiKey: 'gns_test_edge01xtest',
    baseUrl: 'http://localhost:3001',
    manifestRefreshInterval: 0,
    bufferPath: `/tmp/genosis_edge_ts_${process.pid}_${testCounter}.db`,
    memoizationEnabled: false,
    ...overrides,
  });

  (client as any).worker.shutdown(0);

  (client as any).buffer = {
    put: (type: string, payload: Record<string, any>) => {
      bufferEvents.push({ type, payload });
      return payload.event_id ?? 'mock-id';
    },
    peek: () => [],
    remove: () => 0,
    size: () => 0,
    clear: () => {},
    close: () => {},
  };

  (client as any).http = {
    get: vi.fn(async () => ({ data: {}, status: 200, headers: new Headers() })),
    post: vi.fn(async () => ({ data: {}, status: 200, headers: new Headers() })),
    put: vi.fn(async () => ({ data: {}, status: 200, headers: new Headers() })),
    delete: vi.fn(async () => ({ data: {}, status: 200, headers: new Headers() })),
  };

  return { client, bufferEvents };
}

function setManifest(client: Genosis, provider: string, model: string, manifest: CacheManifest): void {
  (client as any).manifestData.set(`${provider}/${model}`, manifest);
  (client as any).lastManifestFetch.set(`${provider}/${model}`, Date.now());
}

// ── 1. call() fallback contract ───────────────────────────────────────────────

describe('call() fallback contract', () => {
  const SYSTEM = 'You are a helpful assistant.';
  const USER = 'Hello.';

  it('Genosis internal error → fn called exactly once with ORIGINAL params', async () => {
    const { client } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Break manifestData so outer detectProvider path throws inside the try block
    (client as any).manifestData = null;

    const originalParams = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER }] };
    const fn = vi.fn(async (p: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));

    const result = await client.call(originalParams, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe(originalParams); // original params, not a copy
    expect(result.memoized).toBe(false);
    expect(result.response).toBeDefined();

    warnSpy.mockRestore();
  });

  it('Genosis internal error → error queued to buffer', async () => {
    const { client, bufferEvents } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (client as any).manifestData = null;

    await client.call({ model: 'claude-sonnet-4-6', system: SYSTEM, messages: [] },
      async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }));

    const errors = bufferEvents.filter(e => e.type === 'error_report');
    expect(errors.length).toBeGreaterThan(0);
    // Both optimize's internal error AND the outer fallback error should be logged
    expect(errors.some(e => e.payload.context === 'call() fallback')).toBe(true);

    warnSpy.mockRestore();
  });

  it('fn(optimized) throws (LLM API error) → error propagates, fn NOT called twice', async () => {
    const { client } = makeClient();

    const SYSTEM_TEXT = 'System prompt for cache test.';
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', {
      cache_train: [{ hash: sha256(SYSTEM_TEXT), tokens: 100, priority: 1.0, position: 0 }],
    });

    const lLMError = new Error('Rate limit exceeded (429)');
    const fn = vi.fn(async () => { throw lLMError; });

    await expect(
      client.call({ model: 'claude-sonnet-4-6', system: SYSTEM_TEXT, messages: [] }, fn)
    ).rejects.toThrow('Rate limit exceeded (429)');

    // fn must be called exactly once — not retried with original params
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fn(optimized) throws → Genosis does NOT log "call() fallback" (not a Genosis error)', async () => {
    const { client, bufferEvents } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    setManifest(client, 'anthropic', 'claude-sonnet-4-6', { cache_train: [] });

    const fn = vi.fn(async () => { throw new Error('LLM network error'); });

    await expect(
      client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn)
    ).rejects.toThrow();

    // No Genosis fallback error queued
    const fallbackErrors = bufferEvents.filter(e => e.type === 'error_report' && e.payload.context === 'call() fallback');
    expect(fallbackErrors).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('fn() with no manifest → called with original params (no optimization)', async () => {
    const { client } = makeClient();

    const params = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER }] };
    const fn = vi.fn(async (p: any) => ({ usage: { input_tokens: 5, output_tokens: 3 } }));

    await client.call(params, fn);

    expect(fn).toHaveBeenCalledTimes(1);
    // No manifest → no cache_control added → system stays as string
    expect(fn.mock.calls[0][0].system).toBe(SYSTEM);
  });
});

// ── 2. Manifest lifecycle edge cases ─────────────────────────────────────────

describe('manifest lifecycle edge cases', () => {
  it('manifest null data from server → stale manifest preserved, not overwritten', async () => {
    const { client } = makeClient({ manifestRefreshInterval: 300 });
    const systemText = 'Preserved system.';

    // Seed a manifest
    const seedManifest: CacheManifest = {
      manifest_version: 'v-seed',
      cache_train: [{ hash: sha256(systemText), tokens: 50, priority: 1.0, position: 0 }],
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', seedManifest);

    // Server returns null data (e.g. 304 Not Modified)
    (client as any).http.get = vi.fn(async () => ({ data: null, status: 304, headers: new Headers() }));

    // Trigger manifest refresh via refreshManifest
    const result = await (client as any).getManifest('anthropic', 'claude-sonnet-4-6');

    // Stale manifest should still be in place
    const still = (client as any).manifestData.get('anthropic/claude-sonnet-4-6');
    expect(still?.manifest_version).toBe('v-seed');
    expect(result?.manifest_version).toBe('v-seed');
  });

  it('ackManifest: skips ack when manifest_token is missing', async () => {
    const { client, bufferEvents } = makeClient();

    // Manifest with version but NO token
    const manifest: CacheManifest = {
      manifest_version: 'v2026',
      cache_train: [],
    };

    (client as any).ackManifest(manifest);

    const acks = bufferEvents.filter(e => e.type === 'manifest_ack');
    expect(acks).toHaveLength(0);
  });

  it('ackManifest: skips ack when manifest_version is missing', async () => {
    const { client, bufferEvents } = makeClient();

    const manifest: CacheManifest = {
      manifest_token: 'tok_abc',
      cache_train: [],
    };

    (client as any).ackManifest(manifest);

    const acks = bufferEvents.filter(e => e.type === 'manifest_ack');
    expect(acks).toHaveLength(0);
  });

  it('ackManifest: queues ack when both version and token present', async () => {
    const { client, bufferEvents } = makeClient();

    const manifest: CacheManifest = {
      manifest_version: 'v2026-03-18',
      manifest_token: 'tok_abc123',
      cache_train: [],
    };

    (client as any).ackManifest(manifest);

    const acks = bufferEvents.filter(e => e.type === 'manifest_ack');
    expect(acks).toHaveLength(1);
    expect(acks[0].payload.manifest_version).toBe('v2026-03-18');
    expect(acks[0].payload.manifest_token).toBe('tok_abc123');
  });

  it('manifestRefreshInterval: 0 → no manifest fetch triggered on first call', async () => {
    // manifestRefreshInterval: 0 means disabled; makeClient already uses 0
    const { client } = makeClient({ manifestRefreshInterval: 0 });

    const fn = vi.fn(async () => ({ usage: { input_tokens: 5, output_tokens: 3 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    // With refresh disabled, http.get should never be called for manifests
    const httpMock = (client as any).http.get as ReturnType<typeof vi.fn>;
    expect(httpMock).not.toHaveBeenCalled();
  });

  it('refreshInProgress guard prevents concurrent duplicate background refreshes', async () => {
    const { client } = makeClient({ manifestRefreshInterval: 300 });

    // Set stale lastManifestFetch to trigger background refresh
    (client as any).lastManifestFetch.set('anthropic/claude-sonnet-4-6', Date.now() - 999_999);

    let resolveFirst: () => void;
    const firstFetchBlocker = new Promise<void>(r => { resolveFirst = r; });

    let manifestFetchCount = 0;
    (client as any).http.get = vi.fn(async (path: string) => {
      if (path.includes('/v1/manifest')) {
        manifestFetchCount++;
        await firstFetchBlocker;
      }
      return { data: null, status: 304, headers: new Headers() };
    });

    // Trigger two concurrent calls — both hit the stale interval check simultaneously
    const fn = vi.fn(async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }));
    const p1 = client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);
    const p2 = client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    // Allow refreshes to complete
    resolveFirst!();
    await Promise.all([p1, p2]);

    // Only one background refresh should have been started (refreshInProgress guard)
    expect(manifestFetchCount).toBeLessThanOrEqual(1);
  });
});

// ── 3. Optimization process edge cases ────────────────────────────────────────

describe('optimization process edge cases', () => {
  it('suspend_memoization: true → memoization bypassed even with storage and candidate', async () => {
    const SYSTEM = 'Suspended system.';
    const USER = 'Question?';
    const { client } = makeClient({ memoizationEnabled: true });

    const blocks = [{ hash: sha256(SYSTEM), tokens: 50, position: 0, cached: false }];
    const combined = blocks.map(b => b.hash).join('+') + '+' + sha256(USER);
    const fingerprint = sha256(combined);

    const manifest: CacheManifest = {
      cache_train: [{ hash: sha256(SYSTEM), tokens: 50, priority: 1.0, position: 0 }],
      mode: { suspend_memoization: true },
      memoization: {
        enabled: true,
        candidates: [{
          fingerprint,
          ttl_seconds: 600,
          block_hashes: [sha256(SYSTEM)],
          estimated_savings_per_hit: 0.01,
        }],
      },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    const params = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER }] };

    // Both calls should go to fn — memoization suspended
    await client.call(params, fn);
    const result2 = await client.call(params, fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result2.memoized).toBe(false);
  });

  it('response exceeds max_response_tokens → NOT stored in memo cache', async () => {
    const SYSTEM = 'Response size test.';
    const USER = 'Give me a huge response.';
    const { client } = makeClient({ memoizationEnabled: true });

    const blocks = [{ hash: sha256(SYSTEM), tokens: 50, position: 0, cached: false }];
    const combined = blocks.map(b => b.hash).join('+') + '+' + sha256(USER);
    const fingerprint = sha256(combined);

    const manifest: CacheManifest = {
      cache_train: [{ hash: sha256(SYSTEM), tokens: 50, priority: 1.0, position: 0 }],
      memoization: {
        enabled: true,
        candidates: [{
          fingerprint,
          ttl_seconds: 600,
          block_hashes: [sha256(SYSTEM)],
          estimated_savings_per_hit: 0.01,
          max_response_tokens: 10, // very small limit
        }],
      },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    // Response is large — will exceed max_response_tokens
    const largeResponse = {
      id: 'msg_abc',
      usage: { input_tokens: 50, output_tokens: 200 },
      content: [{ text: 'A'.repeat(5000) }], // ~1250 tokens
    };

    const fn = vi.fn(async () => largeResponse);
    const params = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER }] };

    const r1 = await client.call(params, fn);
    expect(r1.memoized).toBe(false);

    // Second call should also call fn (not memoized, because response was too large)
    const r2 = await client.call(params, fn);
    expect(r2.memoized).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('TTL capped by manifest.max_ttl_seconds when lower than candidate.ttl_seconds', async () => {
    const SYSTEM = 'TTL cap test system.';
    const USER = 'TTL question.';
    const { client } = makeClient({ memoizationEnabled: true });

    const blocks = [{ hash: sha256(SYSTEM), tokens: 50, position: 0, cached: false }];
    const combined = blocks.map(b => b.hash).join('+') + '+' + sha256(USER);
    const fingerprint = sha256(combined);

    const manifest: CacheManifest = {
      cache_train: [{ hash: sha256(SYSTEM), tokens: 50, priority: 1.0, position: 0 }],
      memoization: {
        enabled: true,
        max_ttl_seconds: 1, // 1 second cap
        candidates: [{
          fingerprint,
          ttl_seconds: 3600, // candidate wants 1 hour — must be capped
          block_hashes: [sha256(SYSTEM)],
          estimated_savings_per_hit: 0.01,
          max_response_tokens: 2000,
        }],
      },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 }, content: 'ok' }));
    const params = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER }] };

    // First call stores in cache
    await client.call(params, fn);
    expect(fn).toHaveBeenCalledTimes(1);

    // Second call immediately — should hit cache (TTL hasn't expired yet)
    const r2 = await client.call(params, fn);
    expect(r2.memoized).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);

    // Wait for TTL to expire (1 second cap)
    await new Promise(r => setTimeout(r, 1200));

    // Third call — TTL expired, cache miss
    const r3 = await client.call(params, fn);
    expect(r3.memoized).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('Anthropic applyAnthropicCache: injects only on blocks at breakpoint positions', async () => {
    // Scenario: A and B are both in cache_train (one segment A+B), but only B is
    // the breakpoint (last block of the segment). Server sets breakpoint_positions: [1].
    const BLOCK_A = 'You are a helpful assistant for enterprise support. '.repeat(20);
    const BLOCK_B = 'Tool: search_knowledge_base(query: string) -> Returns relevant articles. '.repeat(20);
    const { client } = makeClient();

    const manifest: CacheManifest = {
      cache_train: [
        { hash: sha256(BLOCK_A), tokens: 260, priority: 0.9, position: 0 },
        { hash: sha256(BLOCK_B), tokens: 360, priority: 0.8, position: 1 },
      ],
      provider_hints: { anthropic: { breakpoint_positions: [1], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: BLOCK_A },
        { type: 'text', text: BLOCK_B },
      ],
      messages: [],
    }, fn);

    const system = fn.mock.calls[0][0].system;
    // A is cached but not the breakpoint — no cache_control
    expect(system[0].cache_control).toBeUndefined();
    // B is the breakpoint — gets cache_control
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('Anthropic applyAnthropicCache: non-cached block at end gets no cache_control', async () => {
    // Block B is NOT in cache_train and NOT a breakpoint. Block A is in cache_train
    // but also not a breakpoint (server chose not to break here). Neither gets cache_control.
    const BLOCK_A = 'Cacheable block.';
    const BLOCK_B = 'Non-cacheable trailing block.';

    const { client } = makeClient();
    const manifest: CacheManifest = {
      cache_train: [{ hash: sha256(BLOCK_A), tokens: 4, priority: 0.9, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: BLOCK_A },
        { type: 'text', text: BLOCK_B },
      ],
      messages: [],
    }, fn);

    const system = fn.mock.calls[0][0].system;
    // Neither block gets a breakpoint — accumulated tokens never reach 500
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toBeUndefined();
  });

  it('Anthropic applyAnthropicCache: reorders tools to match manifest position', async () => {
    // User sends tools in order [C, A, B] but manifest prescribes [A, B, C].
    // SDK must reorder to [A, B, C] so Anthropic's cache prefix is consistent.
    const TOOL_A = { name: 'tool_a', description: 'Tool A', input_schema: { type: 'object', properties: {} } };
    const TOOL_B = { name: 'tool_b', description: 'Tool B', input_schema: { type: 'object', properties: {} } };
    const TOOL_C = { name: 'tool_c', description: 'Tool C', input_schema: { type: 'object', properties: {} } };

    // Must match the SDK's sortedStringify for cross-SDK hash stability
    function sortedStringify(obj: unknown): string {
      if (typeof obj !== 'object' || obj === null) return JSON.stringify(obj);
      if (Array.isArray(obj)) return '[' + (obj as unknown[]).map(sortedStringify).join(',') + ']';
      const keys = Object.keys(obj as object).sort();
      return '{' + keys.map(k => JSON.stringify(k) + ':' + sortedStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
    }
    const toolHash = (t: object) => sha256(sortedStringify(t));

    const { client } = makeClient();
    const manifest: CacheManifest = {
      cache_train: [
        { hash: toolHash(TOOL_A), tokens: 20, priority: 0.9, position: 0, source: 'tool' },
        { hash: toolHash(TOOL_B), tokens: 20, priority: 0.8, position: 1, source: 'tool' },
        { hash: toolHash(TOOL_C), tokens: 20, priority: 0.7, position: 2, source: 'tool' },
      ],
      provider_hints: { anthropic: { breakpoint_positions: [2], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: 'System prompt',
      tools: [TOOL_C, TOOL_A, TOOL_B],  // caller sends in wrong order
      messages: [],
    }, fn);

    const tools = fn.mock.calls[0][0].tools;
    // Must be reordered to manifest positions [A=0, B=1, C=2]
    expect(tools[0].name).toBe('tool_a');
    expect(tools[1].name).toBe('tool_b');
    expect(tools[2].name).toBe('tool_c');
    // cache_control on C (position 2, the breakpoint)
    expect(tools[2].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('Anthropic applyAnthropicCache: reorders system blocks to match manifest position', async () => {
    // User sends system blocks in order [B, A] but manifest prescribes [A, B].
    const BLOCK_A = 'System block A. '.repeat(30);
    const BLOCK_B = 'System block B. '.repeat(30);

    const { client } = makeClient();
    const manifest: CacheManifest = {
      cache_train: [
        { hash: sha256(BLOCK_A), tokens: 120, priority: 0.9, position: 0, source: 'system' },
        { hash: sha256(BLOCK_B), tokens: 120, priority: 0.8, position: 1, source: 'system' },
      ],
      provider_hints: { anthropic: { breakpoint_positions: [1], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: BLOCK_B },  // wrong order
        { type: 'text', text: BLOCK_A },
      ],
      messages: [],
    }, fn);

    const system = fn.mock.calls[0][0].system;
    // Must be reordered to [A, B]
    expect(system[0].text).toBe(BLOCK_A);
    expect(system[1].text).toBe(BLOCK_B);
    // B (position 1) is the breakpoint
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('params with no model field → passed through unchanged, no crash', async () => {
    const { client } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const params = { messages: [{ role: 'user', content: 'Hello' }] };
    const fn = vi.fn(async (p: any) => ({ choices: [{ message: { content: 'hi' } }] }));

    // Should not throw
    const result = await client.call(params as any, fn);
    expect(result.response).toBeDefined();

    warnSpy.mockRestore();
  });
});

// ── 5. Unrecognized provider / model / format edge cases ───────────────────────
//
// These tests verify the core safety guarantee: Genosis must NEVER crash the
// caller's LLM call regardless of what model name, provider, or request shape
// it receives. Unknown inputs fall back to calling fn with the original params.

describe('unrecognized provider / model / format', () => {
  it('empty string model → falls back to original params, fn still called', async () => {
    const { client } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async (p: any) => ({ choices: [] }));

    const params = { model: '', messages: [{ role: 'user', content: 'hi' }] };
    const result = await client.call(params as any, fn);

    expect(result.response).toBeDefined();
    expect(fn).toHaveBeenCalledWith(params);

    warnSpy.mockRestore();
  });

  it('null model → falls back to original params, fn still called', async () => {
    const { client } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async (p: any) => ({ choices: [] }));

    const params = { model: null, messages: [{ role: 'user', content: 'hi' }] };
    const result = await client.call(params as any, fn);

    expect(result.response).toBeDefined();
    expect(fn).toHaveBeenCalledWith(params);

    warnSpy.mockRestore();
  });

  it('completely empty params object → falls back, fn still called', async () => {
    const { client } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async (p: any) => ({ choices: [] }));

    const params = {};
    const result = await client.call(params as any, fn);

    expect(result.response).toBeDefined();
    expect(fn).toHaveBeenCalledWith(params);

    warnSpy.mockRestore();
  });

  it('params with no messages, no system, no systemInstruction → falls back', async () => {
    const { client } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async (p: any) => ({ choices: [] }));

    // No shape hints at all — provider cannot be inferred from anything
    const params = { model: 'some-future-model-v99', extra_field: 'value' };
    const result = await client.call(params as any, fn);

    expect(result.response).toBeDefined();
    expect(fn).toHaveBeenCalledWith(params);

    warnSpy.mockRestore();
  });

  it('provider_map with invalid provider value → graceful fallback', async () => {
    // User misconfigures provider_map with an unsupported provider name.
    // Optimization will fail server-side, but call() must still complete.
    const { client } = makeClient({
      providerMap: { 'my-custom-model': 'unsupported-provider-xyz' },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async (p: any) => ({ choices: [] }));

    const params = { model: 'my-custom-model', messages: [{ role: 'user', content: 'hi' }] };
    const result = await client.call(params as any, fn);

    // Must not throw; fn must be called with something (original or optimized)
    expect(result.response).toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('unrecognized model queues exactly one error_report event', async () => {
    const { client, bufferEvents } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await client.call(
      { model: 'unknown-llm-7b', messages: [] } as any,
      async () => ({ usage: {} }),
    );

    const errors = bufferEvents.filter(e => e.type === 'error_report');
    expect(errors).toHaveLength(1);
    expect(errors[0].payload.message).toMatch(/unrecognized/i);

    warnSpy.mockRestore();
  });

  it('fn error propagates even when provider is unknown (LLM errors are never swallowed)', async () => {
    const { client } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const apiError = new Error('Rate limit exceeded');
    const fn = vi.fn(async () => { throw apiError; });

    await expect(
      client.call({ model: 'unknown-xyz', messages: [] } as any, fn)
    ).rejects.toThrow('Rate limit exceeded');

    warnSpy.mockRestore();
  });

  it('fn error propagates for valid provider too (LLM errors never swallowed)', async () => {
    const { client } = makeClient();

    const apiError = new Error('Context window exceeded');
    const fn = vi.fn(async () => { throw apiError; });

    await expect(
      client.call({ model: 'claude-sonnet-4-6', messages: [] }, fn)
    ).rejects.toThrow('Context window exceeded');
  });

  it('model name with special characters → falls back gracefully', async () => {
    const { client } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fn = vi.fn(async (p: any) => ({ choices: [] }));

    // Unusual model names that no regex will match
    for (const model of ['gpt 4o', 'claude/opus', 'gemini-2.5™', '']) {
      fn.mockClear();
      const params = { model, messages: [] };
      const result = await client.call(params as any, fn);
      expect(result.response).toBeDefined();
      expect(fn).toHaveBeenCalledTimes(1);
    }

    warnSpy.mockRestore();
  });
});

// ── 4. Reporting edge cases ────────────────────────────────────────────────────

describe('reporting edge cases', () => {
  it('error sanitization: file paths are redacted', async () => {
    const { client, bufferEvents } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (client as any).queueError('test', 'Error loading config from /Users/alice/secrets/config.json', 'claude-sonnet-4-6');

    const errorEvent = bufferEvents.find(e => e.type === 'error_report');
    expect(errorEvent!.payload.message).not.toContain('/Users/alice');
    expect(errorEvent!.payload.message).toContain('PATH_REDACTED');

    warnSpy.mockRestore();
  });

  it('error sanitization: Bearer tokens are redacted', async () => {
    const { client, bufferEvents } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    (client as any).queueError('test', 'Authorization: Bearer sk-ant-api03-supersecrettoken123', 'claude-sonnet-4-6');

    const errorEvent = bufferEvents.find(e => e.type === 'error_report');
    expect(errorEvent!.payload.message).not.toContain('sk-ant-api03-supersecrettoken123');
    expect(errorEvent!.payload.message).toContain('REDACTED');

    warnSpy.mockRestore();
  });

  it('OpenAI usage with null prompt_tokens_details → cache_read_tokens defaults to 0', async () => {
    const { client, bufferEvents } = makeClient();
    setManifest(client, 'openai', 'gpt-4o', { cache_train: [] });

    const fn = vi.fn(async () => ({
      usage: { prompt_tokens: 500, completion_tokens: 200, prompt_tokens_details: null },
    }));
    await client.call({ model: 'gpt-4o', messages: [{ role: 'system', content: 'hello' }, { role: 'user', content: 'hi' }] }, fn);

    const event = bufferEvents.find(e => e.type === 'telemetry')?.payload;
    expect(event!.usage.cache_read_tokens).toBe(0);
    expect(event!.usage.input_tokens).toBe(500);
    expect(event!.usage.output_tokens).toBe(200);
  });

  it('OpenAI usage with missing cached_tokens field → defaults to 0', async () => {
    const { client, bufferEvents } = makeClient();
    setManifest(client, 'openai', 'gpt-4o', { cache_train: [] });

    const fn = vi.fn(async () => ({
      usage: { prompt_tokens: 300, completion_tokens: 100, prompt_tokens_details: {} },
    }));
    await client.call({ model: 'gpt-4o', messages: [{ role: 'system', content: 'hello' }, { role: 'user', content: 'hi' }] }, fn);

    const event = bufferEvents.find(e => e.type === 'telemetry')?.payload;
    expect(event!.usage.cache_read_tokens).toBe(0);
  });

  it('telemetry not queued for memoized hit (only memoized telemetry queued)', async () => {
    const SYSTEM = 'Telemetry dedup test system.';
    const USER = 'Telemetry dedup question.';
    const { client, bufferEvents } = makeClient({ memoizationEnabled: true });

    const blocks = [{ hash: sha256(SYSTEM), tokens: 50, position: 0, cached: false }];
    const combined = blocks.map(b => b.hash).join('+') + '+' + sha256(USER);
    const fingerprint = sha256(combined);

    const manifest: CacheManifest = {
      cache_train: [{ hash: sha256(SYSTEM), tokens: 50, priority: 1.0, position: 0 }],
      memoization: {
        enabled: true,
        candidates: [{ fingerprint, ttl_seconds: 3600, block_hashes: [sha256(SYSTEM)], estimated_savings_per_hit: 0.01, max_response_tokens: 2000 }],
      },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 50, output_tokens: 20 } }));
    const params = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER }] };

    // First call: cache miss → normal telemetry
    await client.call(params, fn);
    const firstTelemetry = bufferEvents.filter(e => e.type === 'telemetry');
    expect(firstTelemetry).toHaveLength(1);
    expect(firstTelemetry[0].payload.memoized).toBe(false);

    bufferEvents.length = 0; // reset

    // Second call: cache hit → memoized telemetry (not regular telemetry)
    const r2 = await client.call(params, fn);
    expect(r2.memoized).toBe(true);
    const secondTelemetry = bufferEvents.filter(e => e.type === 'telemetry');
    expect(secondTelemetry).toHaveLength(1);
    expect(secondTelemetry[0].payload.memoized).toBe(true);
    expect(secondTelemetry[0].payload.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 });
  });

  it('telemetry has no blocks when no system prompt provided', async () => {
    const { client, bufferEvents } = makeClient();
    setManifest(client, 'openai', 'gpt-4o', { cache_train: [] });

    const fn = vi.fn(async () => ({
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }));

    // No system message — only user turn
    await client.call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] }, fn);

    const event = bufferEvents.find(e => e.type === 'telemetry')?.payload;
    expect(event!.blocks).toEqual([]); // no blocks extracted
    expect(event!.fingerprint).toBeNull(); // no fingerprint without blocks
  });

  it('queueTelemetry handles null response gracefully', async () => {
    const { client, bufferEvents } = makeClient();
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', { cache_train: [] });

    // fn returns null
    const fn = vi.fn(async () => null);

    // Should not throw
    const result = await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);
    expect(result.response).toBeNull();

    const event = bufferEvents.find(e => e.type === 'telemetry')?.payload;
    expect(event!.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 });
  });
});
