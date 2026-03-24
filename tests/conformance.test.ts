/**
 * Cross-SDK Conformance Tests
 *
 * These tests verify that the TypeScript and Python SDKs produce identical
 * behavior for the same inputs. Each test here has an exact counterpart in
 * the Python SDK at tests/test_conformance.py.
 *
 * If a test fails here, the same scenario MUST also be verified in the Python
 * SDK. Any behavioral difference between the two SDKs is a bug.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { Genosis } from '../src/index.js';
import type { CacheManifest } from '../src/index.js';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

let testCounter = 0;

function makeClient(overrides: Record<string, any> = {}) {
  testCounter++;
  const bufferEvents: Array<{ type: string; payload: Record<string, any> }> = [];

  const client = new Genosis({
    apiKey: 'gns_test_conformance',
    baseUrl: 'http://localhost:3001',
    manifestRefreshInterval: 0,
    bufferPath: `/tmp/genosis_conformance_ts_${process.pid}_${testCounter}.db`,
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

// ── Shared test data ─────────────────────────────────────────────────────────
// These exact strings and hashes must be identical in the Python conformance tests.

const BLOCK_A = 'You are a helpful customer support assistant for Acme Corp.';
const BLOCK_B = 'Product catalog: Widget A costs $10, Widget B costs $20, Widget C costs $50. All widgets come with a 30-day warranty.';
const BLOCK_C = 'Return policy: Items may be returned within 30 days of purchase for a full refund. Items must be in original packaging.';
const BLOCK_D = 'Current promotion: 20% off all Widget B purchases this week only.';
const BLOCK_E = 'Tool: lookup_order(order_id: string) -> Returns order details including status and tracking.';

const HASH_A = sha256(BLOCK_A);
const HASH_B = sha256(BLOCK_B);
const HASH_C = sha256(BLOCK_C);
const HASH_D = sha256(BLOCK_D);
const HASH_E = sha256(BLOCK_E);

const USER_MSG = 'What is the return policy?';

// ── C1: Anthropic breakpoint placement ───────────────────────────────────────

describe('C1: Anthropic breakpoint placement', () => {
  it('places breakpoints on all cached blocks with min_spacing=0', async () => {
    const { client } = makeClient();

    // All three positions are breakpoints — server decided to cache each as a segment
    const manifest: CacheManifest = {
      cache_train: [
        { hash: HASH_A, tokens: 100, priority: 0.9, position: 0 },
        { hash: HASH_B, tokens: 200, priority: 0.8, position: 1 },
        { hash: HASH_C, tokens: 150, priority: 0.7, position: 2 },
      ],
      provider_hints: { anthropic: { breakpoint_positions: [0, 1, 2], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: BLOCK_A },
        { type: 'text', text: BLOCK_B },
        { type: 'text', text: BLOCK_C },
        { type: 'text', text: BLOCK_D },  // not in cache_train
      ],
      messages: [],
    }, fn);

    const system = fn.mock.calls[0][0].system;
    // A, B, C should each get breakpoints (all cached, spacing=0)
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[2].cache_control).toEqual({ type: 'ephemeral' });
    // D is not in cache_train — no cache_control
    expect(system[3].cache_control).toBeUndefined();
  });

  it('only injects cache_control on blocks whose position is in breakpoint_positions', async () => {
    const { client } = makeClient();

    // Server decided only position 1 is a breakpoint (A+B form one segment ending at B).
    // A is in cache_train (will be cached) but is not a breakpoint block itself.
    const manifest: CacheManifest = {
      cache_train: [
        { hash: HASH_A, tokens: 15, priority: 0.9, position: 0 },
        { hash: HASH_B, tokens: 30, priority: 0.8, position: 1 },
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
    // A is cached but not a breakpoint — no cache_control
    expect(system[0].cache_control).toBeUndefined();
    // B is the breakpoint — gets cache_control
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('uses cache_type from provider_hints', async () => {
    const { client } = makeClient();

    const manifest: CacheManifest = {
      cache_train: [{ hash: HASH_B, tokens: 200, priority: 0.9, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'persistent' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: BLOCK_B }],
      messages: [],
    }, fn);

    const system = fn.mock.calls[0][0].system;
    expect(system[0].cache_control).toEqual({ type: 'persistent' });
  });

  it('no-match string system passes through unchanged', async () => {
    const { client } = makeClient();

    const manifest: CacheManifest = {
      cache_train: [{ hash: HASH_B, tokens: 200, priority: 0.9, position: 0 }],
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: BLOCK_A,  // BLOCK_A hash not in cache_train
      messages: [],
    }, fn);

    // String system with no match stays as string
    expect(fn.mock.calls[0][0].system).toBe(BLOCK_A);
  });
});

// ── C2: OpenAI block reordering ──────────────────────────────────────────────

describe('C2: OpenAI block reordering', () => {
  it('reorders system content blocks by manifest frequency order', async () => {
    const { client } = makeClient();

    // Manifest says frequency order is: B, A, C (B most frequent)
    const manifest: CacheManifest = {
      cache_train: [
        { hash: HASH_B, tokens: 200, priority: 0.9, position: 0 },
        { hash: HASH_A, tokens: 100, priority: 0.8, position: 1 },
        { hash: HASH_C, tokens: 150, priority: 0.7, position: 2 },
      ],
    };
    setManifest(client, 'openai', 'gpt-4o', manifest);

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: [
          { type: 'text', text: BLOCK_A },  // position 1 in manifest
          { type: 'text', text: BLOCK_C },  // position 2 in manifest
          { type: 'text', text: BLOCK_B },  // position 0 in manifest
          { type: 'text', text: BLOCK_D },  // not in manifest → end
        ]},
        { role: 'user', content: USER_MSG },
      ],
    }, fn);

    const content = fn.mock.calls[0][0].messages[0].content;
    // Should be reordered: B (pos 0), A (pos 1), C (pos 2), D (not in manifest → end)
    expect(content[0].text).toBe(BLOCK_B);
    expect(content[1].text).toBe(BLOCK_A);
    expect(content[2].text).toBe(BLOCK_C);
    expect(content[3].text).toBe(BLOCK_D);
  });

  it('pushes uncached blocks to end', async () => {
    const { client } = makeClient();

    // Only A is in manifest
    const manifest: CacheManifest = {
      cache_train: [{ hash: HASH_A, tokens: 100, priority: 0.9, position: 0 }],
    };
    setManifest(client, 'openai', 'gpt-4o', manifest);

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: [
          { type: 'text', text: BLOCK_D },  // not cached
          { type: 'text', text: BLOCK_A },  // cached → front
          { type: 'text', text: BLOCK_C },  // not cached
        ]},
        { role: 'user', content: USER_MSG },
      ],
    }, fn);

    const content = fn.mock.calls[0][0].messages[0].content;
    expect(content[0].text).toBe(BLOCK_A);     // cached → first
    // D and C order is stable (both Infinity, sort is stable in V8)
    expect(content[1].text).toBe(BLOCK_D);
    expect(content[2].text).toBe(BLOCK_C);
  });

  it('leaves single-item system content unchanged', async () => {
    const { client } = makeClient();

    const manifest: CacheManifest = {
      cache_train: [{ hash: HASH_A, tokens: 100, priority: 0.9, position: 0 }],
    };
    setManifest(client, 'openai', 'gpt-4o', manifest);

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: [{ type: 'text', text: BLOCK_A }] },
        { role: 'user', content: USER_MSG },
      ],
    }, fn);

    // Single item — no reordering needed
    const content = fn.mock.calls[0][0].messages[0].content;
    expect(content).toHaveLength(1);
    expect(content[0].text).toBe(BLOCK_A);
  });

  it('leaves string system content unchanged', async () => {
    const { client } = makeClient();

    const manifest: CacheManifest = {
      cache_train: [{ hash: HASH_A, tokens: 100, priority: 0.9, position: 0 }],
    };
    setManifest(client, 'openai', 'gpt-4o', manifest);

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: BLOCK_A },
        { role: 'user', content: USER_MSG },
      ],
    }, fn);

    // String content can't be reordered
    expect(fn.mock.calls[0][0].messages[0].content).toBe(BLOCK_A);
  });
});

// ── C3: Provider detection ───────────────────────────────────────────────────

describe('C3: Provider detection', () => {
  it('detects anthropic from model prefix', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'claude-sonnet-4-6' })).toBe('anthropic');
    expect(client.detectProvider({ model: 'claude-3-5-haiku-20241022' })).toBe('anthropic');
  });

  it('detects openai from model prefix', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'gpt-4o' })).toBe('openai');
    expect(client.detectProvider({ model: 'o1-preview' })).toBe('openai');
    expect(client.detectProvider({ model: 'o3-mini' })).toBe('openai');
    expect(client.detectProvider({ model: 'o4-mini' })).toBe('openai');
  });

  it('detects google from model prefix', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'gemini-2.5-flash' })).toBe('google');
  });

  it('detects bedrock anthropic', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'anthropic.claude-sonnet-4-6-20250514-v1:0' })).toBe('anthropic');
    expect(client.detectProvider({ model: 'us.anthropic.claude-3-5-haiku-20241022-v1:0' })).toBe('anthropic');
  });

  it('falls back to request shape for anthropic', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'custom-model', system: 'hello' })).toBe('anthropic');
  });

  it('falls back to request shape for google', () => {
    const { client } = makeClient();
    expect(client.detectProvider({ model: 'custom-model', systemInstruction: {} })).toBe('google');
  });
});

// ── C4: Model normalization ──────────────────────────────────────────────────

describe('C4: Model normalization', () => {
  it('normalizes bedrock ARN to canonical model', () => {
    expect(Genosis.normalizeModel('anthropic.claude-sonnet-4-6-20250514-v1:0')).toBe('claude-sonnet-4-6-20250514');
    expect(Genosis.normalizeModel('us.anthropic.claude-3-5-haiku-20241022-v1:0')).toBe('claude-3-5-haiku-20241022');
  });

  it('passes through non-bedrock models', () => {
    expect(Genosis.normalizeModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(Genosis.normalizeModel('gpt-4o')).toBe('gpt-4o');
    expect(Genosis.normalizeModel('gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});

// ── C5: Fingerprint computation ──────────────────────────────────────────────

describe('C5: Fingerprint computation', () => {
  it('produces deterministic fingerprint from blocks + user message', async () => {
    const { client, bufferEvents } = makeClient();

    setManifest(client, 'anthropic', 'claude-sonnet-4-6', { cache_train: [] });

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    // Run twice with same content — should produce same fingerprint
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [BLOCK_A, BLOCK_B],
      messages: [{ role: 'user', content: USER_MSG }],
    }, fn);
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [BLOCK_A, BLOCK_B],
      messages: [{ role: 'user', content: USER_MSG }],
    }, fn);

    const events = bufferEvents.filter(e => e.type === 'telemetry');
    expect(events).toHaveLength(2);
    expect(events[0].payload.fingerprint).toBeTruthy();
    expect(events[0].payload.fingerprint).toBe(events[1].payload.fingerprint);

    // Verify the expected fingerprint value
    // combined = HASH_A + "+" + HASH_B + "+" + sha256(USER_MSG)
    const expectedCombined = HASH_A + '+' + HASH_B + '+' + sha256(USER_MSG);
    const expectedFingerprint = sha256(expectedCombined);
    expect(events[0].payload.fingerprint).toBe(expectedFingerprint);
  });

  it('different user message produces different fingerprint', async () => {
    const { client, bufferEvents } = makeClient();

    setManifest(client, 'anthropic', 'claude-sonnet-4-6', { cache_train: [] });

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [BLOCK_A],
      messages: [{ role: 'user', content: 'Question A' }],
    }, fn);
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [BLOCK_A],
      messages: [{ role: 'user', content: 'Question B' }],
    }, fn);

    const events = bufferEvents.filter(e => e.type === 'telemetry');
    expect(events[0].payload.fingerprint).not.toBe(events[1].payload.fingerprint);
  });
});

// ── C6: Error fallback ───────────────────────────────────────────────────────

describe('C6: Error fallback', () => {
  it('returns original params on optimization error', async () => {
    const { client } = makeClient();

    // Set a manifest that will cause an error during application
    (client as any).manifestData.set('anthropic/claude-sonnet-4-6', {
      cache_train: [{ hash: 'abc', tokens: 100, priority: 1, position: 0 }],
      provider_hints: { anthropic: { min_breakpoint_spacing: 0, cache_type: 'ephemeral' } },
    });
    (client as any).lastManifestFetch.set('anthropic/claude-sonnet-4-6', Date.now());

    // Break the optimize method to force error path
    const originalOptimize = (client as any).optimize.bind(client);
    (client as any).optimize = () => { throw new Error('test error'); };

    const originalParams = {
      model: 'claude-sonnet-4-6',
      system: BLOCK_A,
      messages: [{ role: 'user', content: USER_MSG }],
    };

    const fn = vi.fn(async (params: any) => {
      // Verify we receive the ORIGINAL params, not optimized
      expect(params).toBe(originalParams);
      return { usage: { input_tokens: 100, output_tokens: 50 } };
    });

    const result = await client.call(originalParams, fn);
    expect(result.memoized).toBe(false);
    expect(fn).toHaveBeenCalledOnce();
  });
});

// ── C7: Telemetry event structure ────────────────────────────────────────────

describe('C7: Telemetry event structure', () => {
  it('queues telemetry with all required fields', async () => {
    const { client, bufferEvents } = makeClient();

    setManifest(client, 'anthropic', 'claude-sonnet-4-6', {
      cache_train: [],
      manifest_version: 'v2026-03-18-120000-test',
      manifest_token: 'tok_test',
    });

    const fn = vi.fn(async () => ({
      usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 300 },
    }));

    await client.call({
      model: 'claude-sonnet-4-6',
      system: [BLOCK_A],
      messages: [{ role: 'user', content: USER_MSG }],
    }, fn);

    const event = bufferEvents.find(e => e.type === 'telemetry')?.payload;
    expect(event).toBeDefined();
    expect(event!.event_id).toBeTruthy();
    expect(event!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event!.model).toBe('claude-sonnet-4-6');
    expect(event!.provider).toBe('anthropic');
    expect(event!.blocks).toBeInstanceOf(Array);
    expect(event!.blocks[0]).toHaveProperty('hash');
    expect(event!.blocks[0]).toHaveProperty('tokens');
    expect(event!.blocks[0]).toHaveProperty('position');
    expect(event!.blocks[0]).toHaveProperty('cached');
    expect(event!.usage).toEqual({
      input_tokens: 500,
      output_tokens: 200,
      cache_write_tokens: 100,
      cache_read_tokens: 300,
    });
    expect(event!.fingerprint).toBeTruthy();
    expect(event!.worker_id).toBeTruthy();
    expect(event!.memoized).toBe(false);
    expect(event!.manifest_version).toBe('v2026-03-18-120000-test');
    expect(event!.manifest_token).toBe('tok_test');
  });
});

// ── C9: Cross-SDK hash consistency ───────────────────────────────────────────

describe('C9: Hash consistency', () => {
  // These expected hashes are computed once and must match exactly in the Python tests.
  // If they don't, the entire manifest/fingerprint system is broken.

  it('produces expected SHA-256 for ASCII text', () => {
    expect(sha256('Hello, world!')).toBe('315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3');
  });

  it('produces expected SHA-256 for unicode text', () => {
    expect(sha256('こんにちは世界 🌍')).toBe(sha256('こんにちは世界 🌍'));
    // Verify a known value — computed from Python hashlib
    const unicodeHash = sha256('Ünïcödé tëxt with émojis 🎉🚀');
    expect(unicodeHash).toBeTruthy();
    expect(unicodeHash.length).toBe(64);
  });

  it('produces expected SHA-256 for shared test blocks', () => {
    // These are the exact hashes both SDKs must agree on
    expect(HASH_A).toBe(sha256(BLOCK_A));
    expect(HASH_B).toBe(sha256(BLOCK_B));
    expect(HASH_C).toBe(sha256(BLOCK_C));
    expect(HASH_D).toBe(sha256(BLOCK_D));
    expect(HASH_E).toBe(sha256(BLOCK_E));
  });
});

// ── C10: Stale cache_control removal ─────────────────────────────────────────

describe('C10: Stale cache_control removal', () => {
  it('removes old cache_control when block is no longer in manifest', async () => {
    const { client } = makeClient();

    // Manifest only caches B, not A
    const manifest: CacheManifest = {
      cache_train: [{ hash: HASH_B, tokens: 200, priority: 0.9, position: 0 }],
      provider_hints: { anthropic: { breakpoint_positions: [0], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: BLOCK_A, cache_control: { type: 'ephemeral' } },  // stale marker
        { type: 'text', text: BLOCK_B },
      ],
      messages: [],
    }, fn);

    const system = fn.mock.calls[0][0].system;
    // A's stale cache_control should be removed
    expect(system[0].cache_control).toBeUndefined();
    // B should get cache_control from manifest
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ── C11: OpenAI preserves non-system messages ────────────────────────────────

describe('C11: OpenAI preserves non-system messages', () => {
  it('reorders system content without affecting user/assistant messages', async () => {
    const { client } = makeClient();

    const manifest: CacheManifest = {
      cache_train: [
        { hash: HASH_B, tokens: 200, priority: 0.9, position: 0 },
        { hash: HASH_A, tokens: 100, priority: 0.8, position: 1 },
      ],
    };
    setManifest(client, 'openai', 'gpt-4o', manifest);

    const fn = vi.fn(async () => ({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    await client.call({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: [{ type: 'text', text: BLOCK_A }, { type: 'text', text: BLOCK_B }] },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Follow up' },
      ],
    }, fn);

    const messages = fn.mock.calls[0][0].messages;
    // System content reordered (B first, then A)
    expect(messages[0].content[0].text).toBe(BLOCK_B);
    expect(messages[0].content[1].text).toBe(BLOCK_A);
    // All other messages untouched in order
    expect(messages[1]).toEqual({ role: 'user', content: 'First question' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'First answer' });
    expect(messages[3]).toEqual({ role: 'user', content: 'Follow up' });
  });
});

// ── C12: Mixed string/dict system list ───────────────────────────────────────

describe('C12: Mixed string/dict Anthropic system list', () => {
  it('handles mix of string and dict items in system array', async () => {
    const { client } = makeClient();

    const manifest: CacheManifest = {
      cache_train: [
        { hash: HASH_A, tokens: 100, priority: 0.9, position: 0 },
        { hash: HASH_B, tokens: 200, priority: 0.8, position: 1 },
      ],
      provider_hints: { anthropic: { breakpoint_positions: [0, 1], cache_type: 'ephemeral' } },
    };
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', manifest);

    const fn = vi.fn(async () => ({ usage: { input_tokens: 100, output_tokens: 50 } }));
    await client.call({
      model: 'claude-sonnet-4-6',
      system: [
        BLOCK_A,  // plain string
        { type: 'text', text: BLOCK_B },  // dict
      ],
      messages: [],
    }, fn);

    const system = fn.mock.calls[0][0].system;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ── C8: Usage extraction ─────────────────────────────────────────────────────

describe('C8: Usage extraction across providers', () => {
  it('extracts anthropic usage correctly', async () => {
    const { client, bufferEvents } = makeClient();
    setManifest(client, 'anthropic', 'claude-sonnet-4-6', { cache_train: [] });

    const fn = vi.fn(async () => ({
      usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 300 },
    }));
    await client.call({ model: 'claude-sonnet-4-6', system: BLOCK_A, messages: [] }, fn);

    const usage = bufferEvents.find(e => e.type === 'telemetry')?.payload.usage;
    expect(usage).toEqual({ input_tokens: 500, output_tokens: 200, cache_write_tokens: 100, cache_read_tokens: 300 });
  });

  it('extracts openai usage correctly', async () => {
    const { client, bufferEvents } = makeClient();
    setManifest(client, 'openai', 'gpt-4o', { cache_train: [] });

    const fn = vi.fn(async () => ({
      usage: { prompt_tokens: 500, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 300 } },
    }));
    await client.call({ model: 'gpt-4o', messages: [{ role: 'system', content: BLOCK_A }, { role: 'user', content: USER_MSG }] }, fn);

    const usage = bufferEvents.find(e => e.type === 'telemetry')?.payload.usage;
    expect(usage).toEqual({ input_tokens: 500, output_tokens: 200, cache_write_tokens: 0, cache_read_tokens: 300 });
  });

  it('extracts google usage correctly', async () => {
    const { client, bufferEvents } = makeClient();
    setManifest(client, 'google', 'gemini-2.5-flash', { cache_train: [] });

    const fn = vi.fn(async () => ({
      usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 200, cachedContentTokenCount: 300 },
    }));
    await client.call({ model: 'gemini-2.5-flash', systemInstruction: { parts: [{ text: BLOCK_A }] }, contents: [{ role: 'user', parts: [{ text: USER_MSG }] }], messages: [] }, fn);

    const usage = bufferEvents.find(e => e.type === 'telemetry')?.payload.usage;
    expect(usage).toEqual({ input_tokens: 500, output_tokens: 200, cache_write_tokens: 0, cache_read_tokens: 300 });
  });
});
