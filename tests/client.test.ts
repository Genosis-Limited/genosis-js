/**
 * Tests for the Genosis TypeScript SDK client.
 *
 * Covers the complete SDK v1 contract:
 * 1. Hash — SHA-256 block identification
 * 2. Optimize — manifest application with cache_control
 * 3. Report — telemetry with blocks + raw usage, no cost math
 * 4. Refresh — manifest fetch + ack + optimization trigger
 * Plus: memoization, error reporting, provider detection, safety guarantees, sub-clients.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { Genosis, _setNowIso, _resetNowIso, InMemoryMemoStorage } from '../src/index.js';
import type { MemoStorage, CacheManifest } from '../src/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

let testCounter = 0;

/**
 * Mock the DiskBuffer, HttpClient, and BackgroundWorker so no real I/O occurs.
 * Returns a Genosis instance with intercepted internals for inspection.
 */
function makeClient(overrides: Record<string, any> = {}): {
  client: Genosis;
  httpCalls: Array<{ method: string; path: string; body?: any }>;
  bufferEvents: Array<{ type: string; payload: Record<string, any> }>;
} {
  testCounter++;
  const httpCalls: Array<{ method: string; path: string; body?: any }> = [];
  const bufferEvents: Array<{ type: string; payload: Record<string, any> }> = [];

  // We need to mock DiskBuffer and BackgroundWorker before constructing Genosis.
  // The cleanest approach: mock the modules that client.ts imports.
  // Since vitest module mocks are complex with ESM, we'll use a different approach:
  // Create the client with a temp buffer path, then replace internals.

  const opts = {
    apiKey: 'gns_test_abc123',
    baseUrl: 'http://localhost:3001',
    manifestRefreshInterval: 0, // disable auto-refresh for deterministic tests
    bufferPath: `/tmp/genosis_test_${process.pid}_${testCounter}.db`,
    memoizationEnabled: true,
    ...overrides,
  };

  const client = new Genosis(opts);

  // Shut down the real worker immediately
  (client as any).worker.shutdown(0);

  // Replace the buffer with a mock that captures events
  const mockBuffer = {
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
  (client as any).buffer = mockBuffer;

  // Replace the HTTP client with a mock that captures calls
  const mockHttp = {
    get: vi.fn(async (path: string, headers?: Record<string, string>) => {
      httpCalls.push({ method: 'GET', path });
      return { data: {}, status: 200, headers: new Headers() };
    }),
    post: vi.fn(async (path: string, body?: any) => {
      httpCalls.push({ method: 'POST', path, body });
      return { data: {}, status: 200, headers: new Headers() };
    }),
    put: vi.fn(async (path: string, body?: any) => {
      httpCalls.push({ method: 'PUT', path, body });
      return { data: {}, status: 200, headers: new Headers() };
    }),
    delete: vi.fn(async (path: string) => {
      httpCalls.push({ method: 'DELETE', path });
      return { data: {}, status: 200, headers: new Headers() };
    }),
  };
  (client as any).http = mockHttp;

  return { client, httpCalls, bufferEvents };
}

/**
 * Set up a manifest in the client's internal state for testing.
 */
function setManifest(client: Genosis, provider: string, model: string, manifest: CacheManifest): void {
  (client as any).manifestData.set(`${provider}/${model}`, manifest);
  (client as any).lastManifestFetch.set(`${provider}/${model}`, Date.now());
}

// Simple mock LLM function
const mockLlmFn = vi.fn(async (params: Record<string, any>) => ({
  id: 'msg_123',
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
}));

// ── Constructor ───────────────────────────────────────────────────────────────

describe('Constructor', () => {
  it('accepts a valid test API key', () => {
    const { client } = makeClient({ apiKey: 'gns_test_abc123' });
    expect(client).toBeTruthy();
  });

  it('accepts a valid live API key', () => {
    const { client } = makeClient({ apiKey: 'gns_live_xyz789' });
    expect(client).toBeTruthy();
  });

  it('rejects missing API key', () => {
    expect(() => new Genosis({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('rejects invalid API key format', () => {
    expect(() => new Genosis({ apiKey: 'sk-not-a-genosis-key' })).toThrow('Invalid API key format');
  });

  it('has all sub-clients', () => {
    const { client } = makeClient();
    expect(client.account).toBeDefined();
    expect(client.manifest).toBeDefined();
    expect(client.optimization).toBeDefined();
    expect(client.telemetry).toBeDefined();
  });

  it('generates a worker ID', () => {
    const { client } = makeClient();
    expect(client.workerId).toBeDefined();
    expect(client.workerId.length).toBeGreaterThan(10);
    // Format: hostname-pid-random
    const parts = client.workerId.split('-');
    expect(parts.length).toBeGreaterThanOrEqual(3);
  });

  it('generates unique worker IDs per instance', () => {
    const { client: c1 } = makeClient();
    const { client: c2 } = makeClient();
    expect(c1.workerId).not.toBe(c2.workerId);
  });
});

// ── Provider detection ────────────────────────────────────────────────────────

describe('Provider detection', () => {
  it('detects claude-* as anthropic', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'claude-sonnet-4-6' })).toBe('anthropic');
  });

  it('detects claude-3-5-* as anthropic', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'claude-3-5-haiku-20241022' })).toBe('anthropic');
  });

  it('detects gpt-* as openai', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'gpt-4o' })).toBe('openai');
  });

  it('detects o1-* as openai', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'o1-mini' })).toBe('openai');
  });

  it('detects o2 as openai', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'o2' })).toBe('openai');
  });

  it('detects o3-* as openai', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'o3' })).toBe('openai');
  });

  it('detects o4-* as openai', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'o4-mini' })).toBe('openai');
  });

  it('detects future o-series (o5, o10) as openai', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'o5' })).toBe('openai');
    expect(client.detectProvider({ model: 'o10-mini' })).toBe('openai');
  });

  it('detects gemini-* as google', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'gemini-2.0-flash' })).toBe('google');
  });

  it('detects vgai-* as verygoodai', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'vgai-sonnet' })).toBe('verygoodai');
  });

  it('detects Bedrock anthropic.claude-* as anthropic', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'anthropic.claude-sonnet-4-6-20250514-v1:0' })).toBe('anthropic');
  });

  it('detects Bedrock us.anthropic.claude-* as anthropic', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'us.anthropic.claude-3-5-haiku-20241022-v1:0' })).toBe('anthropic');
  });

  it('falls back to anthropic if system param present', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'some-unknown-model', system: 'hello' })).toBe('anthropic');
  });

  it('falls back to google if systemInstruction param present', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'some-unknown-model', systemInstruction: {} })).toBe('google');
  });

  it('throws for unknown model without shape fallback', () => {
    const { client } = makeClient();
    expect(() => client.detectProvider({ model: 'unknown-xyz' })).toThrow('Unrecognized provider');
  });

  it('providerMap overrides prefix detection', () => {
    const { client } = makeClient({ providerMap: { 'my-gpt4-deployment': 'openai', 'my-claude-prod': 'anthropic' } });
    expect(client.detectProvider({ model: 'my-gpt4-deployment' })).toBe('openai');
    expect(client.detectProvider({ model: 'my-claude-prod' })).toBe('anthropic');
  });

  it('defaultProvider resolves unknown model names (Azure)', () => {
    const { client } = makeClient({ defaultProvider: 'openai' });
    expect(client.detectProvider({ model: 'company-prod-gpt4' })).toBe('openai');
    expect(client.detectProvider({ model: 'azure-deployment-v2' })).toBe('openai');
  });

  it('providerMap takes precedence over defaultProvider', () => {
    const { client } = makeClient({
      providerMap: { 'my-claude-deployment': 'anthropic' },
      defaultProvider: 'openai',
    });
    expect(client.detectProvider({ model: 'my-claude-deployment' })).toBe('anthropic');
    expect(client.detectProvider({ model: 'any-other-deployment' })).toBe('openai');
  });

  it('unknown model still throws when no providerMap or defaultProvider set', () => {
    const { client } = makeClient();
    expect(() => client.detectProvider({ model: 'company-prod-gpt4' })).toThrow('providerMap');
  });
});

// ── Model normalization ──────────────────────────────────────────────────────

describe('Model normalization', () => {
  it('normalizes Bedrock anthropic.claude-* to claude-*', () => {
    expect(Genosis.normalizeModel('anthropic.claude-sonnet-4-6-20250514-v1:0')).toBe('claude-sonnet-4-6-20250514');
  });

  it('normalizes Bedrock us.anthropic.claude-* to claude-*', () => {
    expect(Genosis.normalizeModel('us.anthropic.claude-3-5-haiku-20241022-v1:0')).toBe('claude-3-5-haiku-20241022');
  });

  it('passes through direct claude model names unchanged', () => {
    expect(Genosis.normalizeModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('passes through gpt model names unchanged', () => {
    expect(Genosis.normalizeModel('gpt-4o')).toBe('gpt-4o');
  });

  it('passes through gemini model names unchanged', () => {
    expect(Genosis.normalizeModel('gemini-2.0-flash')).toBe('gemini-2.0-flash');
  });

  it('passes through empty string unchanged', () => {
    expect(Genosis.normalizeModel('')).toBe('');
  });
});

// ── Cache breakpoint application ─────────────────────────────────────────────

describe('Cache breakpoints', () => {
  const SYSTEM_TEXT = 'You are a helpful assistant with knowledge of TypeScript.';
  const SYSTEM_HASH = sha256(SYSTEM_TEXT);

  it('applies cache_control to matching block (string system)', async () => {
    const { client } = makeClient();
    const manifest: CacheManifest = {
      cache_train: [{ hash: SYSTEM_HASH, tokens: 100, priority: 1.0, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: SYSTEM_TEXT, messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(calledParams.system).toEqual([
      { type: 'text', text: SYSTEM_TEXT, cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('does not apply cache_control to non-matching block', async () => {
    const { client } = makeClient();
    const manifest: CacheManifest = {
      cache_train: [{ hash: sha256('other text'), tokens: 100, priority: 1.0, position: 0 }],
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: SYSTEM_TEXT, messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    // String system with no match stays as-is
    expect(calledParams.system).toBe(SYSTEM_TEXT);
  });

  it('converts string system to array with cache_control when matching', async () => {
    const { client } = makeClient();
    const manifest: CacheManifest = {
      cache_train: [{ hash: SYSTEM_HASH, tokens: 100, priority: 1.0, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: SYSTEM_TEXT, messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(Array.isArray(calledParams.system)).toBe(true);
    expect(calledParams.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('preserves other params (model, messages) through optimization', async () => {
    const { client } = makeClient();
    const manifest: CacheManifest = {
      cache_train: [{ hash: SYSTEM_HASH, tokens: 100, priority: 1.0, position: 0 }],
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    const messages = [{ role: 'user', content: 'Hello' }];
    await client.call({ model: 'claude-sonnet-4-6', system: SYSTEM_TEXT, messages, max_tokens: 1024 }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(calledParams.model).toBe('claude-sonnet-4-6');
    expect(calledParams.messages).toBe(messages);
    expect(calledParams.max_tokens).toBe(1024);
  });

  it('passes through when cache_train is empty', async () => {
    const { client } = makeClient();
    const manifest: CacheManifest = { cache_train: [] };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: SYSTEM_TEXT, messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(calledParams.system).toBe(SYSTEM_TEXT);
  });

  it('applies cache_control to array system blocks', async () => {
    const block1 = 'Block one with some text.';
    const block2 = 'Block two with more text.';
    const { client } = makeClient();
    const manifest: CacheManifest = {
      cache_train: [{ hash: sha256(block1), tokens: 50, priority: 1.0, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: block1 },
        { type: 'text', text: block2 },
      ],
      messages: [],
    }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(calledParams.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(calledParams.system[1].cache_control).toBeUndefined();
  });
});

// ── Manifest behavior ────────────────────────────────────────────────────────

describe('Manifest behavior', () => {
  it('first call with no manifest passes through unchanged', async () => {
    const { client } = makeClient();

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(calledParams.system).toBe('hello');
  });

  it('stale manifest is still applied (not skipped)', async () => {
    const systemText = 'You are a helpful assistant.';
    const { client } = makeClient();
    const manifest: CacheManifest = {
      manifest_version: 'v1',
      cache_train: [{ hash: sha256(systemText), tokens: 100, priority: 1.0, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);
    // Make the fetch time old
    (client as any).lastManifestFetch.set('anthropic/claude-sonnet-4-6', Date.now() - 999999999);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: systemText, messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    // The stale manifest should still be applied
    expect(Array.isArray(calledParams.system)).toBe(true);
    expect(calledParams.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('fresh manifest applies breakpoints', async () => {
    const systemText = 'You are a coding assistant.';
    const { client } = makeClient();
    const manifest: CacheManifest = {
      manifest_version: 'v2',
      cache_train: [{ hash: sha256(systemText), tokens: 100, priority: 1.0, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: systemText, messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(Array.isArray(calledParams.system)).toBe(true);
    expect(calledParams.system[0].cache_control).toBeDefined();
  });

  it('manifest fetch failure keeps old manifest', async () => {
    const systemText = 'You are a helpful assistant.';
    const { client } = makeClient({ manifestRefreshInterval: 300 });

    // Set up a manifest first
    const manifest: CacheManifest = {
      manifest_version: 'v1',
      cache_train: [{ hash: sha256(systemText), tokens: 100, priority: 1.0, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    // Make HTTP fail for manifest requests
    (client as any).http.get = vi.fn(async () => { throw new Error('Network error'); });

    // The old manifest should still be used
    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: systemText, messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(Array.isArray(calledParams.system)).toBe(true);
    expect(calledParams.system[0].cache_control).toBeDefined();
  });

  it('empty cache_train passes through unchanged', async () => {
    const { client } = makeClient();
    const manifest: CacheManifest = { cache_train: [] };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async (params: any) => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const calledParams = fn.mock.calls[0][0];
    expect(calledParams.system).toBe('hello');
  });

  it('empty manifest schedules fast retry (~60s) instead of full interval', async () => {
    const { client } = makeClient({ manifestRefreshInterval: 300 });

    // Simulate: server returns empty manifest
    (client as any).http.get = vi.fn(async () => ({
      data: { cache_train: [] },
      status: 200,
      headers: new Headers(),
    }));

    // Trigger first manifest fetch (last === 0)
    await (client as any).getManifest('anthropic', 'claude-sonnet-4-6');

    const last = (client as any).lastManifestFetch.get('anthropic/claude-sonnet-4-6') as number;
    const retries = (client as any).emptyManifestRetries.get('anthropic/claude-sonnet-4-6') as number;

    // After an empty manifest, last should be set back in time so next refresh
    // fires in ~60s (not 300s). Check it's between 230-250s ago (i.e. 50-70s remaining).
    const elapsed = Date.now() - last;
    expect(elapsed).toBeGreaterThan(230_000); // at least 230s "elapsed"
    expect(elapsed).toBeLessThan(250_000);    // but not more than 250s
    expect(retries).toBe(1);
  });

  it('fast retry stops after FAST_RETRY_MAX empty responses, falls back to normal interval', async () => {
    const { client } = makeClient({ manifestRefreshInterval: 300 });

    (client as any).http.get = vi.fn(async () => ({
      data: { cache_train: [] },
      status: 200,
      headers: new Headers(),
    }));

    // Exhaust fast retries
    for (let i = 0; i < 11; i++) {
      await (client as any).getManifest('anthropic', 'claude-sonnet-4-6');
    }

    const last = (client as any).lastManifestFetch.get('anthropic/claude-sonnet-4-6') as number;
    // Should have reset to normal: elapsed should be near 0 (just set)
    expect(Date.now() - last).toBeLessThan(500);
  });

  it('non-empty manifest clears fast retry state', async () => {
    const { client } = makeClient({ manifestRefreshInterval: 300 });

    // First: empty manifest → increment retries
    (client as any).http.get = vi.fn(async () => ({
      data: { cache_train: [] },
      status: 200,
      headers: new Headers(),
    }));
    await (client as any).getManifest('anthropic', 'claude-sonnet-4-6');
    expect((client as any).emptyManifestRetries.get('anthropic/claude-sonnet-4-6')).toBe(1);

    // Then: non-empty manifest → clear retries, use normal interval
    (client as any).http.get = vi.fn(async () => ({
      data: { cache_train: [{ hash: 'abc', tokens: 100, priority: 1.0, position: 0 }] },
      status: 200,
      headers: new Headers(),
    }));
    await (client as any).getManifest('anthropic', 'claude-sonnet-4-6');
    expect((client as any).emptyManifestRetries.has('anthropic/claude-sonnet-4-6')).toBe(false);
    const last = (client as any).lastManifestFetch.get('anthropic/claude-sonnet-4-6') as number;
    expect(Date.now() - last).toBeLessThan(500); // normal — just set
  });

  it('stale manifest telemetry includes manifest_version', async () => {
    const systemText = 'Hello world test.';
    const { client, bufferEvents } = makeClient();
    const manifest: CacheManifest = {
      manifest_version: 'v-stale',
      manifest_token: 'tok-stale',
      cache_train: [{ hash: sha256(systemText), tokens: 50, priority: 1.0, position: 0 }],
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: systemText, messages: [] }, fn);

    const telemetryEvent = bufferEvents.find(e => e.type === 'telemetry');
    expect(telemetryEvent).toBeDefined();
    expect(telemetryEvent!.payload.manifest_version).toBe('v-stale');
    expect(telemetryEvent!.payload.manifest_token).toBe('tok-stale');
  });

  it('maintains separate manifests per provider/model', async () => {
    const { client } = makeClient();

    const text1 = 'Anthropic system prompt.';
    const text2 = 'Another model system prompt.';

    setManifest(client, 'anthropic', 'claude-sonnet-4-6', {
      cache_train: [{ hash: sha256(text1), tokens: 50, priority: 1.0, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    });
    setManifest(client, 'anthropic', 'claude-3-5-haiku-20241022', {
      cache_train: [{ hash: sha256(text2), tokens: 50, priority: 1.0, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    });

    // text1 should match for claude-sonnet-4-6 but not claude-3-5-haiku
    const fn1 = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: text1, messages: [] }, fn1);
    expect(Array.isArray(fn1.mock.calls[0][0].system)).toBe(true);

    const fn2 = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-3-5-haiku-20241022', system: text1, messages: [] }, fn2);
    // text1 not in haiku's manifest
    expect(fn2.mock.calls[0][0].system).toBe(text1);
  });

  it('OpenAI params pass through cleanly (no cache_control added)', async () => {
    const { client } = makeClient();

    // Even with a manifest, OpenAI doesn't use system key format
    setManifest(client, 'openai', 'gpt-4o', {
      cache_train: [{ hash: sha256('You are helpful'), tokens: 50, priority: 1.0, position: 0 }],
    });

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'You are helpful' }, { role: 'user', content: 'Hello' }],
    }, fn);

    const calledParams = fn.mock.calls[0][0];
    // OpenAI format: no system key, so no cache_control is applied
    expect(calledParams.messages).toBeDefined();
    // No cache_control should appear on any message
    for (const msg of calledParams.messages) {
      expect(msg.cache_control).toBeUndefined();
    }
  });

  it('OpenAI reorders multi-part system content by manifest frequency order', async () => {
    const { client } = makeClient();

    const blockA = 'Stable block A — appears in every request';
    const blockB = 'Less stable block B — appears in half of requests';
    const blockC = 'Infrequent block C — appears rarely';

    // Manifest: A first (highest priority), then B, then C
    setManifest(client, 'openai', 'gpt-4o', {
      cache_train: [
        { hash: sha256(blockA), tokens: 100, priority: 1.0, position: 0 },
        { hash: sha256(blockB), tokens: 80, priority: 0.6, position: 1 },
      ],
    });

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 50, completion_tokens: 10 } }));
    // User sends system content in reverse order
    await client.call({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: [
          { type: 'text', text: blockC },
          { type: 'text', text: blockB },
          { type: 'text', text: blockA },
        ] },
        { role: 'user', content: 'Hello' },
      ],
    }, fn);

    const calledParams = fn.mock.calls[0][0];
    const systemContent = calledParams.messages[0].content;
    // A should be first, B second, C last (not in manifest → sorts to end)
    expect(systemContent[0].text).toBe(blockA);
    expect(systemContent[1].text).toBe(blockB);
    expect(systemContent[2].text).toBe(blockC);
  });

  it('OpenAI single-string system content passes through unchanged', async () => {
    const { client } = makeClient();
    const systemText = 'You are a helpful assistant.';

    setManifest(client, 'openai', 'gpt-4o', {
      cache_train: [{ hash: sha256(systemText), tokens: 50, priority: 1.0, position: 0 }],
    });

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemText }, { role: 'user', content: 'Hello' }],
    }, fn);

    const calledParams = fn.mock.calls[0][0];
    // String content: unchanged (nothing to reorder)
    expect(calledParams.messages[0].content).toBe(systemText);
  });
});

// ── Memoization ──────────────────────────────────────────────────────────────

describe('Memoization', () => {
  const SYSTEM = 'You are a code reviewer.';
  const USER_MSG = 'Review this code.';
  const MOCK_RESPONSE = { id: 'msg_abc', content: [{ text: 'Looks good!' }], usage: { input_tokens: 50, output_tokens: 20 } };

  function makeMemoClient() {
    const { client, bufferEvents } = makeClient({ memoizationEnabled: true });

    // Set up manifest with a memoization candidate
    const blocks = [{ hash: sha256(SYSTEM), tokens: 50, position: 0, cached: false }];
    const userHash = sha256(USER_MSG);
    const combined = blocks.map(b => b.hash).join('+') + '+' + userHash;
    const fingerprint = sha256(combined);

    const manifest: CacheManifest = {
      manifest_version: 'v1',
      cache_train: [{ hash: sha256(SYSTEM), tokens: 50, priority: 1.0, position: 0 }],
      memoization: {
        enabled: true,
        max_ttl_seconds: 3600,
        candidates: [{
          fingerprint,
          ttl_seconds: 600,
          block_hashes: [sha256(SYSTEM)],
          estimated_savings_per_hit: 0.01,
          max_response_tokens: 2000,
        }],
      },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    return { client, bufferEvents, fingerprint };
  }

  it('returns cached response with memoized=true on exact duplicate', async () => {
    const { client } = makeMemoClient();
    const params = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER_MSG }] };

    const fn = vi.fn(async () => MOCK_RESPONSE);

    // First call: cache miss, calls fn
    const result1 = await client.call(params, fn);
    expect(result1.memoized).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);

    // Second call: cache hit, fn NOT called
    const result2 = await client.call(params, fn);
    expect(result2.memoized).toBe(true);
    expect(result2.response).toEqual(MOCK_RESPONSE);
    expect(fn).toHaveBeenCalledTimes(1); // Still 1
  });

  it('different user message is not memoized', async () => {
    const { client } = makeMemoClient();

    const fn = vi.fn(async () => MOCK_RESPONSE);

    await client.call({ model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER_MSG }] }, fn);
    await client.call({ model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: 'Different question' }] }, fn);

    expect(fn).toHaveBeenCalledTimes(2); // Both called fn
  });

  it('memoization disabled means never memoizes', async () => {
    const { client } = makeClient({ memoizationEnabled: false });
    const systemText = 'System prompt.';
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', {
      cache_train: [{ hash: sha256(systemText), tokens: 50, priority: 1.0, position: 0 }],
      memoization: {
        enabled: true,
        candidates: [{ fingerprint: 'any', ttl_seconds: 600, block_hashes: [], estimated_savings_per_hit: 0.01 }],
      },
    });

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    const params = { model: 'claude-sonnet-4-6', system: systemText, messages: [{ role: 'user', content: 'Hello' }] };

    await client.call(params, fn);
    await client.call(params, fn);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('TTL expiry causes cache miss', async () => {
    const storage = new InMemoryMemoStorage(100);
    const { client } = makeClient({ memoizationEnabled: true, memoStorage: storage });

    const manifest: CacheManifest = {
      cache_train: [{ hash: sha256(SYSTEM), tokens: 50, priority: 1.0, position: 0 }],
      memoization: {
        enabled: true,
        max_ttl_seconds: 1, // 1 second max TTL
        candidates: [{
          fingerprint: (() => {
            const blocks = [{ hash: sha256(SYSTEM), tokens: 50, position: 0, cached: false }];
            const combined = blocks.map(b => b.hash).join('+') + '+' + sha256(USER_MSG);
            return sha256(combined);
          })(),
          ttl_seconds: 1,
          block_hashes: [sha256(SYSTEM)],
          estimated_savings_per_hit: 0.01,
          max_response_tokens: 2000,
        }],
      },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => MOCK_RESPONSE);
    const params = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER_MSG }] };

    await client.call(params, fn);
    expect(fn).toHaveBeenCalledTimes(1);

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 1100));

    await client.call(params, fn);
    expect(fn).toHaveBeenCalledTimes(2); // Called again after TTL expiry
  });

  it('memo storage get/set interface works correctly', () => {
    const storage = new InMemoryMemoStorage(10);

    // Set and get
    storage.set('fp1', { data: 'test' }, 60);
    expect(storage.get('fp1')).toEqual({ data: 'test' });

    // Missing key
    expect(storage.get('fp_nonexistent')).toBeNull();
  });

  it('memoized telemetry has zero usage', async () => {
    const { client, bufferEvents } = makeMemoClient();
    const params = { model: 'claude-sonnet-4-6', system: SYSTEM, messages: [{ role: 'user', content: USER_MSG }] };

    const fn = vi.fn(async () => MOCK_RESPONSE);
    await client.call(params, fn); // First call
    await client.call(params, fn); // Second call (memoized)

    // Find the memoized telemetry event (second one)
    const telemetryEvents = bufferEvents.filter(e => e.type === 'telemetry');
    expect(telemetryEvents.length).toBe(2);

    const memoizedEvent = telemetryEvents[1];
    expect(memoizedEvent.payload.usage.input_tokens).toBe(0);
    expect(memoizedEvent.payload.usage.output_tokens).toBe(0);
    expect(memoizedEvent.payload.usage.cache_write_tokens).toBe(0);
    expect(memoizedEvent.payload.usage.cache_read_tokens).toBe(0);
  });
});

// ── Telemetry ────────────────────────────────────────────────────────────────

describe('Telemetry', () => {
  it('includes usage fields', async () => {
    const { client, bufferEvents } = makeClient();

    const fn = vi.fn(async () => ({
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 },
    }));
    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev).toBeDefined();
    expect(ev!.payload.usage.input_tokens).toBe(100);
    expect(ev!.payload.usage.output_tokens).toBe(50);
    expect(ev!.payload.usage.cache_write_tokens).toBe(20);
    expect(ev!.payload.usage.cache_read_tokens).toBe(30);
  });

  it('includes blocks and fingerprint', async () => {
    const systemText = 'You are an assistant.';
    const { client, bufferEvents } = makeClient();

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: systemText,
      messages: [{ role: 'user', content: 'hi' }],
    }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev).toBeDefined();
    expect(ev!.payload.blocks.length).toBe(1);
    expect(ev!.payload.blocks[0].hash).toBe(sha256(systemText));
    expect(ev!.payload.fingerprint).toBeDefined();
  });

  it('extracts blocks from OpenAI messages[role=system] string', async () => {
    const systemText = 'You are a helpful assistant.';
    const { client, bufferEvents } = makeClient();

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemText }, { role: 'user', content: 'Hello' }],
    }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev).toBeDefined();
    expect(ev!.payload.blocks.length).toBe(1);
    expect(ev!.payload.blocks[0].hash).toBe(sha256(systemText));
    expect(ev!.payload.blocks[0].cached).toBe(false);
  });

  it('extracts multiple blocks from OpenAI messages[role=system] array', async () => {
    const segA = 'You are a code assistant.';
    const segB = 'You specialize in TypeScript.';
    const { client, bufferEvents } = makeClient();

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 30, completion_tokens: 10 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: [
          { type: 'text', text: segA },
          { type: 'text', text: segB },
        ] },
        { role: 'user', content: 'Hello' },
      ],
    }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev).toBeDefined();
    expect(ev!.payload.blocks.length).toBe(2);
    expect(ev!.payload.blocks[0].hash).toBe(sha256(segA));
    expect(ev!.payload.blocks[1].hash).toBe(sha256(segB));
    expect(ev!.payload.blocks[0].cached).toBe(false);
    expect(ev!.payload.blocks[1].cached).toBe(false);
  });

  it('includes manifest_version and manifest_token', async () => {
    const { client, bufferEvents } = makeClient();
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', {
      manifest_version: 'v-test',
      manifest_token: 'tok-test',
      cache_train: [],
    });

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev!.payload.manifest_version).toBe('v-test');
    expect(ev!.payload.manifest_token).toBe('tok-test');
  });

  it('does NOT include cost fields (server-side only)', async () => {
    const { client, bufferEvents } = makeClient();

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev!.payload.cost).toBeUndefined();
    expect(ev!.payload.savings).toBeUndefined();
    expect(ev!.payload.cost_usd).toBeUndefined();
  });

  it('includes worker_id', async () => {
    const { client, bufferEvents } = makeClient();

    const fn = vi.fn(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev!.payload.worker_id).toBe(client.workerId);
  });
});

// ── Error handling ───────────────────────────────────────────────────────────

describe('Error handling', () => {
  it('unknown provider falls back to original params', async () => {
    const { client } = makeClient();

    const originalParams = { model: 'unknown-xyz', messages: [{ role: 'user', content: 'hello' }] };
    const fn = vi.fn(async (params: any) => ({ choices: [{ message: { content: 'hi' } }] }));

    // Suppress console.warn for this test
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await client.call(originalParams, fn);
    expect(result.response).toBeDefined();
    // Should have been called with original params as fallback
    expect(fn).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('unknown provider reports error', async () => {
    const { client, bufferEvents } = makeClient();

    const fn = vi.fn(async () => ({ choices: [] }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await client.call({ model: 'unknown-xyz', messages: [] }, fn);

    const errorEvents = bufferEvents.filter(e => e.type === 'error_report');
    expect(errorEvents.length).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });

  it('unknown provider emits console.warn exactly once', async () => {
    const { client } = makeClient();

    const fn = vi.fn(async () => ({ choices: [] }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await client.call({ model: 'unknown-xyz', messages: [] }, fn);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('call() never throws (catches everything)', async () => {
    const { client } = makeClient();

    const fn = vi.fn(async () => {
      throw new Error('LLM provider error');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Even when fn throws in the fallback path, call() should still throw
    // (because the fn itself throws, not SDK internals)
    // Actually: call() catches SDK errors and calls fn(original). If fn throws, that propagates.
    // Let's test SDK internal error doesn't prevent fn from being called
    const fnGood = vi.fn(async () => ({ data: 'ok' }));

    // Force an internal error by corrupting internals
    (client as any).manifestData = null; // will cause TypeError in optimize

    const result = await client.call(
      { model: 'claude-sonnet-4-6', system: 'hello', messages: [] },
      fnGood,
    );
    expect(result.response).toEqual({ data: 'ok' });
    expect(result.memoized).toBe(false);

    warnSpy.mockRestore();
  });

  it('error messages are sanitized (API keys redacted)', async () => {
    const { client, bufferEvents } = makeClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Trigger an error that includes a key in the message
    (client as any).queueError('test', 'Failed with key gns_test_secretkey123', 'test-model');

    const errorEvent = bufferEvents.find(e => e.type === 'error_report');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.payload.message).not.toContain('gns_test_secretkey123');
    expect(errorEvent!.payload.message).toContain('REDACTED');

    warnSpy.mockRestore();
  });
});

// ── Usage extraction ─────────────────────────────────────────────────────────

describe('Usage extraction', () => {
  it('extracts Anthropic format', async () => {
    const { client, bufferEvents } = makeClient();
    const fn = vi.fn(async () => ({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 25,
        cache_read_input_tokens: 75,
      },
    }));

    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev!.payload.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_write_tokens: 25,
      cache_read_tokens: 75,
    });
  });

  it('extracts OpenAI format', async () => {
    const { client, bufferEvents } = makeClient();
    const fn = vi.fn(async () => ({
      usage: {
        prompt_tokens: 80,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 60 },
      },
    }));

    await client.call({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev!.payload.usage).toEqual({
      input_tokens: 80,
      output_tokens: 40,
      cache_write_tokens: 0,
      cache_read_tokens: 60,
    });
  });

  it('extracts Google format', async () => {
    const { client, bufferEvents } = makeClient();
    const fn = vi.fn(async () => ({
      usageMetadata: {
        promptTokenCount: 90,
        candidatesTokenCount: 45,
        cachedContentTokenCount: 30,
      },
    }));

    await client.call({ model: 'gemini-2.0-flash', messages: [] }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev!.payload.usage).toEqual({
      input_tokens: 90,
      output_tokens: 45,
      cache_write_tokens: 0,
      cache_read_tokens: 30,
    });
  });

  it('handles empty/null response with zero usage', async () => {
    const { client, bufferEvents } = makeClient();
    const fn = vi.fn(async () => null);

    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev!.payload.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_read_tokens: 0,
    });
  });

  it('handles response with empty usage object', async () => {
    const { client, bufferEvents } = makeClient();
    const fn = vi.fn(async () => ({ usage: {} }));

    await client.call({ model: 'claude-sonnet-4-6', system: 'hello', messages: [] }, fn);

    const ev = bufferEvents.find(e => e.type === 'telemetry');
    expect(ev!.payload.usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_read_tokens: 0,
    });
  });
});

// ── Sub-client tests ─────────────────────────────────────────────────────────

describe('Account sub-client', () => {
  it('get() calls GET /v1/account', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: { name: 'Test Org' }, status: 200, headers: new Headers() });

    const result = await client.account.get();
    expect(http.get).toHaveBeenCalledWith('/v1/account');
    expect(result).toEqual({ name: 'Test Org' });
  });

  it('getUsage() calls GET /v1/account/usage', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: { total_requests: 100 }, status: 200, headers: new Headers() });

    const result = await client.account.getUsage();
    expect(http.get).toHaveBeenCalledWith('/v1/account/usage');
    expect(result).toEqual({ total_requests: 100 });
  });

  it('listApiKeys() calls GET /v1/account/api-keys and returns api_keys', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const keys = [{ id: 'key1', name: 'My Key' }];
    http.get.mockResolvedValueOnce({ data: { api_keys: keys }, status: 200, headers: new Headers() });

    const result = await client.account.listApiKeys();
    expect(http.get).toHaveBeenCalledWith('/v1/account/api-keys');
    expect(result).toEqual(keys);
  });

  it('createApiKey() calls POST /v1/account/api-keys with name', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const created = { id: 'key2', name: 'New Key', key: 'gns_test_newkey' };
    http.post.mockResolvedValueOnce({ data: created, status: 200, headers: new Headers() });

    const result = await client.account.createApiKey('New Key');
    expect(http.post).toHaveBeenCalledWith('/v1/account/api-keys', { name: 'New Key' });
    expect(result).toEqual(created);
  });

  it('createApiKey() includes scopes when provided', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.post.mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers() });

    await client.account.createApiKey('Key', ['read', 'write']);
    expect(http.post).toHaveBeenCalledWith('/v1/account/api-keys', { name: 'Key', scopes: ['read', 'write'] });
  });

  it('revokeApiKey() calls DELETE /v1/account/api-keys/:id', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.delete.mockResolvedValueOnce({ data: { revoked: true }, status: 200, headers: new Headers() });

    const result = await client.account.revokeApiKey('key-123');
    expect(http.delete).toHaveBeenCalledWith('/v1/account/api-keys/key-123');
    expect(result).toEqual({ revoked: true });
  });
});

describe('Manifest sub-client', () => {
  it('get() calls GET /v1/manifest with query params', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const manifestData = { manifest_version: 'v1', cache_train: [] };
    http.get.mockResolvedValueOnce({ data: manifestData, status: 200, headers: new Headers() });

    const result = await client.manifest.get('anthropic', 'claude-sonnet-4-6');
    // No ETag stored yet → second arg is undefined (no If-None-Match header sent)
    expect(http.get).toHaveBeenCalledWith('/v1/manifest?provider=anthropic&model=claude-sonnet-4-6', undefined);
    expect(result.data).toEqual(manifestData);
  });

  it('get() returns null data when server returns null', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: null, status: 200, headers: new Headers() });

    const result = await client.manifest.get('anthropic', 'claude-sonnet-4-6');
    expect(result.data).toBeNull();
  });

  it('listAll() calls GET /v1/manifests and returns manifests', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const manifests = [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }];
    http.get.mockResolvedValueOnce({ data: { manifests }, status: 200, headers: new Headers() });

    const result = await client.manifest.listAll();
    expect(http.get).toHaveBeenCalledWith('/v1/manifests');
    expect(result).toEqual(manifests);
  });

  it('getHistory() calls GET /v1/manifest/history with query params', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const history = [{ version: 'v1', created_at: '2026-03-17' }];
    http.get.mockResolvedValueOnce({ data: { manifests: history }, status: 200, headers: new Headers() });

    const result = await client.manifest.getHistory('anthropic', 'claude-sonnet-4-6');
    expect(http.get).toHaveBeenCalledWith('/v1/manifest/history?provider=anthropic&model=claude-sonnet-4-6');
    expect(result).toEqual(history);
  });

  it('getHistory() with no params omits query string', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: { manifests: [] }, status: 200, headers: new Headers() });

    await client.manifest.getHistory();
    expect(http.get).toHaveBeenCalledWith('/v1/manifest/history');
  });
});

describe('Manifest sub-client — ETag caching', () => {
  it('first call sends no If-None-Match header when no ETag is stored', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers() });

    await client.manifest.get('anthropic', 'claude-sonnet-4-6');

    // No ETag stored yet → extraHeaders argument is undefined
    expect(http.get).toHaveBeenCalledWith(
      '/v1/manifest?provider=anthropic&model=claude-sonnet-4-6',
      undefined,
    );
  });

  it('stores ETag returned in the response', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({
      data: { manifest_version: 'v1', cache_train: [] },
      status: 200,
      headers: new Headers({ etag: '"etag-v1"' }),
    });

    await client.manifest.get('anthropic', 'claude-sonnet-4-6');

    expect((client as any).etagMap.get('anthropic/claude-sonnet-4-6')).toBe('"etag-v1"');
  });

  it('sends If-None-Match on second call using stored ETag', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const manifestData = { manifest_version: 'v1', cache_train: [] };
    http.get
      .mockResolvedValueOnce({ data: manifestData, status: 200, headers: new Headers({ etag: '"etag-v1"' }) })
      .mockResolvedValueOnce({ data: manifestData, status: 200, headers: new Headers() });

    await client.manifest.get('anthropic', 'claude-sonnet-4-6');
    await client.manifest.get('anthropic', 'claude-sonnet-4-6');

    expect(http.get).toHaveBeenNthCalledWith(
      2,
      '/v1/manifest?provider=anthropic&model=claude-sonnet-4-6',
      { 'If-None-Match': '"etag-v1"' },
    );
  });

  it('304 response returns null data and preserves existing ETag', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get
      .mockResolvedValueOnce({
        data: { manifest_version: 'v1', cache_train: [] },
        status: 200,
        headers: new Headers({ etag: '"etag-v1"' }),
      })
      .mockResolvedValueOnce({ data: null, status: 304, headers: new Headers() });

    await client.manifest.get('anthropic', 'claude-sonnet-4-6');
    const result = await client.manifest.get('anthropic', 'claude-sonnet-4-6');

    expect(result.data).toBeNull();
    // ETag should survive the 304 — not cleared
    expect((client as any).etagMap.get('anthropic/claude-sonnet-4-6')).toBe('"etag-v1"');
  });

  it('ETags are tracked independently per provider/model key', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get
      .mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers({ etag: '"etag-anthropic"' }) })
      .mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers({ etag: '"etag-openai"' }) });

    await client.manifest.get('anthropic', 'claude-sonnet-4-6');
    await client.manifest.get('openai', 'gpt-4o');

    expect((client as any).etagMap.get('anthropic/claude-sonnet-4-6')).toBe('"etag-anthropic"');
    expect((client as any).etagMap.get('openai/gpt-4o')).toBe('"etag-openai"');
    // No cross-contamination
    expect((client as any).etagMap.get('anthropic/gpt-4o')).toBeUndefined();
  });
});

describe('Optimization sub-client', () => {
  it('trigger() calls POST /v1/optimize with provider and model', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.post.mockResolvedValueOnce({ data: { status: 'completed' }, status: 200, headers: new Headers() });

    const result = await client.optimization.trigger('anthropic', 'claude-sonnet-4-6');
    expect(http.post).toHaveBeenCalledWith('/v1/optimize', { provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(result).toEqual({ status: 'completed' });
  });

  it('trigger() with no args calls POST /v1/optimize with no body', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.post.mockResolvedValueOnce({ data: { status: 'completed' }, status: 200, headers: new Headers() });

    await client.optimization.trigger();
    expect(http.post).toHaveBeenCalledWith('/v1/optimize', undefined);
  });

  it('getStatus() calls GET /v1/optimize/status with query params', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: { status: 'running' }, status: 200, headers: new Headers() });

    const result = await client.optimization.getStatus('anthropic', 'claude-sonnet-4-6');
    expect(http.get).toHaveBeenCalledWith('/v1/optimize/status?provider=anthropic&model=claude-sonnet-4-6');
    expect(result).toEqual({ status: 'running' });
  });

  it('getResults() calls GET /v1/optimize/results with query params', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: { savings: 0.42 }, status: 200, headers: new Headers() });

    const result = await client.optimization.getResults('anthropic', 'claude-sonnet-4-6');
    expect(http.get).toHaveBeenCalledWith('/v1/optimize/results?provider=anthropic&model=claude-sonnet-4-6');
    expect(result).toEqual({ savings: 0.42 });
  });

  it('getStatus() with no args omits query string', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers() });

    await client.optimization.getStatus();
    expect(http.get).toHaveBeenCalledWith('/v1/optimize/status');
  });

  it('getResults() with no args omits query string', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers() });

    await client.optimization.getResults();
    expect(http.get).toHaveBeenCalledWith('/v1/optimize/results');
  });
});

describe('Telemetry sub-client', () => {
  it('getSummary() calls GET /v1/telemetry/summary with days param', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const summary = { total_requests: 500, total_savings: 12.50 };
    http.get.mockResolvedValueOnce({ data: summary, status: 200, headers: new Headers() });

    const result = await client.telemetry.getSummary(7);
    expect(http.get).toHaveBeenCalledWith('/v1/telemetry/summary?days=7');
    expect(result).toEqual(summary);
  });

  it('getSummary() with all params', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers() });

    await client.telemetry.getSummary(30, 'anthropic', 'claude-sonnet-4-6');
    expect(http.get).toHaveBeenCalledWith('/v1/telemetry/summary?days=30&provider=anthropic&model=claude-sonnet-4-6');
  });

  it('getSummary() with no params omits query string', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers() });

    await client.telemetry.getSummary();
    expect(http.get).toHaveBeenCalledWith('/v1/telemetry/summary');
  });

  it('getCostBreakdown() calls GET /v1/telemetry/cost and returns cost_breakdown', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const breakdown = [{ date: '2026-03-17', cost: 1.50 }];
    http.get.mockResolvedValueOnce({ data: { cost_breakdown: breakdown }, status: 200, headers: new Headers() });

    const result = await client.telemetry.getCostBreakdown(14, 'anthropic');
    expect(http.get).toHaveBeenCalledWith('/v1/telemetry/cost?days=14&provider=anthropic');
    expect(result).toEqual(breakdown);
  });

  it('getBlockFrequencies() calls GET /v1/telemetry/blocks', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    const blocks = { blocks: [{ hash: 'abc', frequency: 42 }] };
    http.get.mockResolvedValueOnce({ data: blocks, status: 200, headers: new Headers() });

    const result = await client.telemetry.getBlockFrequencies(7, 'anthropic', 'claude-sonnet-4-6');
    expect(http.get).toHaveBeenCalledWith('/v1/telemetry/blocks?days=7&provider=anthropic&model=claude-sonnet-4-6');
    expect(result).toEqual(blocks);
  });

  it('getBlockFrequencies() with no params omits query string', async () => {
    const { client } = makeClient();
    const http = (client as any).http;
    http.get.mockResolvedValueOnce({ data: {}, status: 200, headers: new Headers() });

    await client.telemetry.getBlockFrequencies();
    expect(http.get).toHaveBeenCalledWith('/v1/telemetry/blocks');
  });
});

// ── buildQs helper ───────────────────────────────────────────────────────────

describe('buildQs helper', () => {
  it('builds correct query string with all params', () => {
    const { client } = makeClient();
    const qs = (client as any).buildQs({ days: 30, provider: 'anthropic', model: 'claude-sonnet-4-6' });
    expect(qs).toBe('?days=30&provider=anthropic&model=claude-sonnet-4-6');
  });

  it('omits undefined params', () => {
    const { client } = makeClient();
    const qs = (client as any).buildQs({ days: 7, provider: undefined, model: undefined });
    expect(qs).toBe('?days=7');
  });

  it('returns empty string when all params undefined', () => {
    const { client } = makeClient();
    const qs = (client as any).buildQs({ days: undefined, provider: undefined });
    expect(qs).toBe('');
  });

  it('encodes special characters', () => {
    const { client } = makeClient();
    const qs = (client as any).buildQs({ model: 'claude sonnet/4.6' });
    expect(qs).toBe('?model=claude%20sonnet%2F4.6');
  });
});
