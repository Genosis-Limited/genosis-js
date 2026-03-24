# @genosis/sdk

Genosis reduces LLM inference costs by up to 75% through server-optimized prompt caching. The SDK wraps your existing API calls with one method — `g.call()` — and applies optimization transparently.

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { Genosis } from '@genosis/sdk'

const anthropic = new Anthropic()
const g = new Genosis({ apiKey: 'gns_live_...' })

const result = await g.call(
  {
    model: 'claude-sonnet-4-6',
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 1024,
  },
  (params) => anthropic.messages.create(params)
)

console.log(result.response)   // the Anthropic response object
console.log(result.memoized)   // true if served from local cache
```

No schema changes. No new concepts. Your existing LLM code stays intact.

## Installation

```bash
npm install @genosis/sdk
```

Requires Node.js 18+. Ships as ESM + CJS.

## Provider Examples

### Anthropic

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { Genosis } from '@genosis/sdk'

const anthropic = new Anthropic()
const g = new Genosis({ apiKey: 'gns_live_...' })

const result = await g.call(
  {
    model: 'claude-sonnet-4-6',
    system: [
      { type: 'text', text: systemContext },
      { type: 'text', text: productCatalog },
    ],
    messages: [{ role: 'user', content: question }],
    max_tokens: 512,
  },
  (params) => anthropic.messages.create(params)
)
```

Genosis adds `cache_control` breakpoints to your system blocks automatically. You do not need to add them yourself.

### OpenAI

```typescript
import OpenAI from 'openai'
import { Genosis } from '@genosis/sdk'

const openai = new OpenAI()
const g = new Genosis({ apiKey: 'gns_live_...' })

const result = await g.call(
  {
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: [
          { type: 'text', text: systemContext },
          { type: 'text', text: productCatalog },
        ],
      },
      { role: 'user', content: question },
    ],
    max_tokens: 512,
  },
  (params) => openai.chat.completions.create(params)
)
```

For OpenAI, Genosis reorders system content blocks to maximize prefix cache hits. No `cache_control` markers — OpenAI's prompt caching is automatic. If your prompt has strict block-ordering requirements, keep order-sensitive content in a single block rather than multiple separate blocks.

### AWS Bedrock

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { Genosis } from '@genosis/sdk'

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' })
const g = new Genosis({ apiKey: 'gns_live_...' })

// Bedrock ARNs are normalized automatically — the manifest lookup uses
// the canonical model name (e.g., claude-sonnet-4-6-20250514)
const result = await g.call(
  {
    model: 'anthropic.claude-sonnet-4-6-20250514-v1:0',
    system: systemPrompt,
    messages: [{ role: 'user', content: question }],
    max_tokens: 512,
    anthropic_version: 'bedrock-2023-05-31',
  },
  async (params) => {
    const cmd = new InvokeModelCommand({
      modelId: params.model,
      body: JSON.stringify(params),
    })
    const resp = await bedrock.send(cmd)
    return JSON.parse(new TextDecoder().decode(resp.body))
  }
)
```

Cross-region inference ARNs (`us.anthropic.claude-*`) are also handled.

### Azure OpenAI

```typescript
import { AzureOpenAI } from 'openai'
import { Genosis } from '@genosis/sdk'

const azure = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  apiVersion: '2024-02-01',
})
const g = new Genosis({ apiKey: 'gns_live_...' })

const result = await g.call(
  {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ],
    max_tokens: 512,
  },
  (params) => azure.chat.completions.create(params)
)
```

## Supported Providers and Models

| Provider | Models | Also works via |
|----------|--------|----------------|
| Anthropic | claude-opus-4, claude-sonnet-4-6, claude-haiku-4-5 | AWS Bedrock |
| OpenAI | gpt-4.1, gpt-4.1-mini, gpt-4o, gpt-4o-mini, o1, o3, o4-mini | Azure OpenAI |
| Google *(coming soon)* | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite | Vertex AI |

Provider detection is automatic from the model name. Bedrock ARNs (`anthropic.claude-*`, `us.anthropic.claude-*`) are recognized and normalized to canonical model IDs for manifest lookup.

## How It Works

On each `g.call()`:

1. The SDK detects your provider from the model field.
2. It checks whether a server-optimized manifest exists for that provider/model. On the first call, the manifest is fetched in the background — your call goes through normally.
3. When a manifest is available, the SDK applies it: for Anthropic, it inserts `cache_control` breakpoints on high-value system blocks; for OpenAI, it reorders system content blocks to maximize prefix cache hits.
4. Your function is called with the (possibly modified) params.
5. Usage data is hashed and queued for telemetry. The background worker flushes it to `api.usegenosis.ai` — no synchronous network call on the hot path.
6. Manifests refresh every 5 minutes in the background. A stale manifest is better than no optimization.

If anything in the Genosis layer throws, your function is called with the original unmodified params. `g.call()` cannot break your LLM calls.

## Configuration

```typescript
const g = new Genosis({
  // Required
  apiKey: 'gns_live_...',            // or 'gns_test_...' for test keys

  // Optional — shown with defaults
  baseUrl: 'https://api.usegenosis.ai',
  maxRetries: 2,                     // retries on 429/5xx (exponential backoff)
  timeout: 60000,                    // per-request timeout in ms
  manifestRefreshInterval: 300,      // seconds between manifest refreshes; 0 = disabled
  memoizationEnabled: true,          // see Memoization below
  memoizationMaxEntries: 1000,       // max entries in the in-process LRU cache
  memoStorage: undefined,            // plug in Redis, etc. (see Memoization below)
  bufferPath: '~/.genosis/buffer.db',// SQLite telemetry buffer path
  bufferMaxSize: 10000,              // max buffered events before oldest are dropped
})
```

## Memoization

Memoization serves identical requests from a local cache without calling the LLM at all. The server identifies which request patterns are worth memoizing based on your telemetry — the SDK just applies the decision.

When a memoized response is served, `result.memoized === true` and no LLM call is made.

The default storage is an in-process LRU map. For multi-process deployments (e.g., multiple Node workers, serverless), plug in a shared store:

```typescript
import { Genosis } from '@genosis/sdk'
import type { MemoStorage } from '@genosis/sdk'

// MemoStorage.get() is synchronous — use a sync Redis client (e.g. ioredis in sync mode)
// or a simple in-process Map for multi-worker setups sharing memory via IPC.
// The example below shows the interface contract; adapt to your storage backend.
class RedisMemoStorage implements MemoStorage {
  private store = new Map<string, { value: any; expiresAt: number }>()

  get(fingerprint: string): any | null {
    const entry = this.store.get(fingerprint)
    if (!entry || Date.now() > entry.expiresAt) return null
    return entry.value
  }
  set(fingerprint: string, response: any, ttlSeconds: number): void {
    this.store.set(fingerprint, { value: response, expiresAt: Date.now() + ttlSeconds * 1000 })
  }
}

const g = new Genosis({
  apiKey: 'gns_live_...',
  memoStorage: new RedisMemoStorage(),
})
```

`MemoStorage` is a two-method interface — any implementation works.

To disable memoization entirely:

```typescript
const g = new Genosis({ apiKey: 'gns_live_...', memoizationEnabled: false })
```

## Serverless and Batch Jobs

The background worker flushes telemetry continuously in long-running processes. In serverless functions or batch jobs that exit after each invocation, call `flush()` before the process ends:

```typescript
// At the end of your handler / job
const remaining = await g.flush(30_000)  // wait up to 30s for buffer to drain
```

`flush()` returns the number of events still in the buffer when the timeout is reached.

## Background Worker

The worker starts automatically when you construct `Genosis`. It handles:

- Telemetry batching and upload
- Manifest acknowledgement
- Error reporting

Telemetry is written to a local SQLite file first (`~/.genosis/buffer_<keyprefix>.db`). If the network is unavailable, events are held in the buffer and retried on the next worker cycle. Nothing is lost on transient failures.

Each key prefix gets its own buffer file, so multiple apps on the same machine do not share state.

## Content-Blind Security Model

Genosis never sees your prompts, responses, user data, or API keys.

What leaves the SDK:

- SHA-256 hashes of content blocks (one-way, irreversible)
- Token counts
- Usage numbers from the LLM response (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, etc.)
- Provider and model name

What stays local:

- All prompt text
- All LLM responses
- The memoization cache

The hashing is done in the SDK before any network call. You can verify this in [`src/client.ts`](./src/client.ts) — search for `sha256`. Error messages are also sanitized before logging: API keys, file paths, and long base64 strings are redacted automatically.

## Error Handling

Errors from the management API (`g.account`, `g.manifest`, etc.) throw typed errors:

```typescript
import {
  GenosisError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  ConnectionError,
  TimeoutError,
} from '@genosis/sdk'

try {
  await g.optimization.trigger('anthropic', 'claude-sonnet-4-6')
} catch (err) {
  if (err instanceof AuthenticationError) {
    // Invalid or revoked API key (HTTP 401)
  } else if (err instanceof RateLimitError) {
    // Too many requests (HTTP 429) — back off
  } else if (err instanceof ConnectionError) {
    // Network failure — no HTTP response received
  } else if (err instanceof TimeoutError) {
    // Request exceeded the configured timeout
  } else if (err instanceof GenosisError) {
    console.error(err.status, err.code, err.message)
  }
}
```

All typed errors extend `GenosisError` and expose `status` (HTTP status code) and `code` (machine-readable string).

**`g.call()` does not throw Genosis errors.** If the optimization layer fails for any reason, `fn` is called with the original unmodified params. LLM errors (rate limits, network failures, etc.) propagate normally — Genosis does not swallow them.

### Error classes

| Class | Status | Default code |
|-------|--------|--------------|
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `AuthenticationError` | 401 | `UNAUTHORIZED` |
| `PermissionDeniedError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `ConflictError` | 409 | `CONFLICT` |
| `UnprocessableEntityError` | 422 | `UNPROCESSABLE` |
| `RateLimitError` | 429 | `RATE_LIMITED` |
| `InternalServerError` | 500+ | `INTERNAL` |
| `ConnectionError` | — | `CONNECTION_ERROR` |
| `TimeoutError` | — | `TIMEOUT` |

## Management API

Use these for dashboards, scripts, and setup tooling — not in the hot path.

```typescript
// Account
const account = await g.account.get()
const usage = await g.account.getUsage()
const keys = await g.account.listApiKeys()
const newKey = await g.account.createApiKey('worker-prod', ['ingest', 'manifest:read'])
await g.account.revokeApiKey(keyId)

// Manifests
const { data: manifest } = await g.manifest.get('anthropic', 'claude-sonnet-4-6')
const all = await g.manifest.listAll()
const history = await g.manifest.getHistory('anthropic', 'claude-sonnet-4-6')

// Optimization (runs server-side)
const run = await g.optimization.trigger('anthropic', 'claude-sonnet-4-6')
const status = await g.optimization.getStatus('anthropic', 'claude-sonnet-4-6')
const results = await g.optimization.getResults('anthropic', 'claude-sonnet-4-6')

// Telemetry
const summary = await g.telemetry.getSummary(7)                          // last 7 days
const costs = await g.telemetry.getCostBreakdown(30, 'anthropic')
const blocks = await g.telemetry.getBlockFrequencies(7, 'anthropic', 'claude-sonnet-4-6')
```

## TypeScript Types

```typescript
import type {
  GenosisOptions,
  CallResult,
  CacheManifest,
  TelemetryBlock,
  MemoStorage,
  MemoCandidate,
} from '@genosis/sdk'
```

Key types:

**`CallResult`**
```typescript
interface CallResult {
  response: any      // the LLM response object, unmodified
  memoized: boolean  // true if served from local memo cache
}
```

**`TelemetryBlock`**
```typescript
interface TelemetryBlock {
  hash: string      // SHA-256 of the content block text
  tokens: number    // estimated token count
  position: number  // position in the system prompt
  cached: boolean   // whether a cache breakpoint was placed on this block
}
```

**`CacheManifest`**
```typescript
interface CacheManifest {
  manifest_version?: string
  manifest_token?: string
  cache_train?: Array<{
    hash: string
    tokens: number
    priority: number
    position: number
  }>
  memoization?: {
    enabled: boolean
    max_ttl_seconds?: number
    candidates?: MemoCandidate[]
  }
}
```

**`MemoCandidate`**
```typescript
interface MemoCandidate {
  fingerprint: string
  ttl_seconds: number
  block_hashes: string[]
  estimated_savings_per_hit: number
  max_response_tokens?: number
}
```

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Patent pending. All patent inquiries: legal@usegenosis.ai
