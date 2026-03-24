import { createHash, randomUUID } from 'crypto';
import { hostname, homedir } from 'os';
import { join } from 'path';
import { HttpClient } from './http.js';
import { DiskBuffer } from './buffer.js';
import { BackgroundWorker } from './worker.js';
import type { CallResult, CacheManifest, MemoStorage, GenosisOptions, TelemetryBlock, MemoCandidate } from './types.js';
import { InMemoryMemoStorage } from './types.js';

const DEFAULT_BASE_URL = 'https://api.usegenosis.ai';
const DEFAULT_REFRESH_INTERVAL = 300; // 5 minutes

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON.stringify with recursively sorted keys — ensures identical hashes across SDKs. */
function sortedStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(sortedStringify).join(',') + ']';
  const keys = Object.keys(obj as object).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + sortedStringify((obj as Record<string, unknown>)[k])).join(',') + '}';
}

function sanitizeError(message: string): string {
  return message
    .replace(/gns_(live|test)_\w+/g, 'REDACTED')
    .replace(/Bearer\s+\S+/gi, 'Bearer REDACTED')
    .replace(/\/Users\/\S+/g, 'PATH_REDACTED')
    .replace(/\/home\/\S+/g, 'PATH_REDACTED')
    .replace(/[A-Za-z0-9+/]{40,}/g, 'REDACTED');
}

let _nowIso = (): string => new Date().toISOString().replace('+00:00', 'Z');

/** Override timestamp for testing/experiments. */
export function _setNowIso(fn: () => string): void { _nowIso = fn; }
export function _resetNowIso(): void { _nowIso = () => new Date().toISOString().replace('+00:00', 'Z'); }

// After an empty manifest, retry every 60s instead of the full refresh interval.
// Stops fast-retrying after 10 consecutive empty responses (~10 minutes),
// then falls back to the normal interval.
const FAST_RETRY_INTERVAL_MS = 60_000;
const FAST_RETRY_MAX = 10;

export class Genosis {
  private http: HttpClient;
  private buffer: DiskBuffer;
  private worker: BackgroundWorker;
  private manifestRefreshInterval: number;
  private manifestData: Map<string, CacheManifest> = new Map();
  private lastManifestFetch: Map<string, number> = new Map();
  private emptyManifestRetries: Map<string, number> = new Map();
  private refreshInProgress: Set<string> = new Set();
  private etagMap: Map<string, string> = new Map();
  private memoStorage: MemoStorage | null = null;
  private providerMap: Record<string, string>;
  private defaultProvider: string | undefined;
  readonly workerId: string;

  // Sub-clients for direct API access
  readonly account: {
    get: () => Promise<any>;
    getUsage: () => Promise<any>;
    listApiKeys: () => Promise<any>;
    createApiKey: (name: string, scopes?: string[]) => Promise<any>;
    revokeApiKey: (id: string) => Promise<any>;
  };
  readonly manifest: {
    get: (provider: string, model: string) => Promise<{ data: CacheManifest | null }>;
    listAll: () => Promise<any>;
    getHistory: (provider?: string, model?: string) => Promise<any>;
  };
  readonly optimization: {
    trigger: (provider?: string, model?: string) => Promise<any>;
    getStatus: (provider?: string, model?: string) => Promise<any>;
    getResults: (provider?: string, model?: string) => Promise<any>;
  };
  readonly telemetry: {
    getSummary: (days?: number, provider?: string, model?: string) => Promise<any>;
    getCostBreakdown: (days?: number, provider?: string, model?: string) => Promise<any>;
    getBlockFrequencies: (days?: number, provider?: string, model?: string) => Promise<any>;
  };

  constructor(options: GenosisOptions) {
    const {
      apiKey,
      baseUrl = DEFAULT_BASE_URL,
      maxRetries = 2,
      timeout = 60000,
      manifestRefreshInterval = DEFAULT_REFRESH_INTERVAL,
      memoizationEnabled = true,
      memoizationMaxEntries = 1000,
      memoStorage,
      bufferPath: bufferPathOption,
      bufferMaxSize = 10000,
      providerMap = {},
      defaultProvider,
    } = options;

    if (!apiKey) throw new Error('apiKey is required');
    if (!/^gns_(live|test)_/.test(apiKey)) throw new Error('Invalid API key format. Expected gns_live_* or gns_test_*');

    this.http = new HttpClient(apiKey, baseUrl, maxRetries, timeout);

    // Scope buffer by API key prefix so different apps don't share a buffer
    let bufferPath = bufferPathOption;
    if (!bufferPath) {
      const parts = apiKey.split('_');
      const keyPrefix = parts.length >= 3 ? parts[2] : 'default';
      bufferPath = join(homedir(), '.genosis', `buffer_${keyPrefix}.db`);
    }
    this.buffer = new DiskBuffer(bufferPath, bufferMaxSize);
    this.worker = new BackgroundWorker(this.buffer, baseUrl, apiKey, timeout);
    this.worker.start();

    this.manifestRefreshInterval = manifestRefreshInterval;
    this.providerMap = providerMap;
    this.defaultProvider = defaultProvider;
    this.workerId = `${hostname().slice(0, 20) || 'unknown'}-${process.pid}-${randomUUID().slice(0, 6)}`;

    if (memoizationEnabled) {
      this.memoStorage = memoStorage ?? new InMemoryMemoStorage(memoizationMaxEntries);
    }

    // Sub-clients
    this.account = {
      get: async () => {
        const resp = await this.http.get('/v1/account');
        return resp.data;
      },
      getUsage: async () => {
        const resp = await this.http.get('/v1/account/usage');
        return resp.data;
      },
      listApiKeys: async () => {
        const resp = await this.http.get('/v1/account/api-keys');
        return resp.data.api_keys;
      },
      createApiKey: async (name: string, scopes?: string[]) => {
        const body: Record<string, any> = { name };
        if (scopes !== undefined) body.scopes = scopes;
        const resp = await this.http.post('/v1/account/api-keys', body);
        return resp.data;
      },
      revokeApiKey: async (id: string) => {
        const resp = await this.http.delete(`/v1/account/api-keys/${id}`);
        return resp.data;
      },
    };
    this.manifest = {
      get: async (provider: string, model: string) => {
        const key = `${provider}/${model}`;
        const storedEtag = this.etagMap.get(key);
        const extraHeaders = storedEtag ? { 'If-None-Match': storedEtag } : undefined;
        const resp = await this.http.get(
          `/v1/manifest?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
          extraHeaders,
        );
        const newEtag = resp.headers.get('etag');
        if (newEtag) this.etagMap.set(key, newEtag);
        return { data: resp.data ?? null };
      },
      listAll: async () => {
        const resp = await this.http.get('/v1/manifests');
        return resp.data.manifests;
      },
      getHistory: async (provider?: string, model?: string) => {
        const qs = this.buildQs({ provider, model });
        const resp = await this.http.get(`/v1/manifest/history${qs}`);
        return resp.data.manifests;
      },
    };
    this.optimization = {
      trigger: async (provider?: string, model?: string) => {
        const body: Record<string, any> = {};
        if (provider) body.provider = provider;
        if (model) body.model = model;
        const resp = await this.http.post('/v1/optimize', Object.keys(body).length ? body : undefined);
        return resp.data;
      },
      getStatus: async (provider?: string, model?: string) => {
        const qs = this.buildQs({ provider, model });
        const resp = await this.http.get(`/v1/optimize/status${qs}`);
        return resp.data;
      },
      getResults: async (provider?: string, model?: string) => {
        const qs = this.buildQs({ provider, model });
        const resp = await this.http.get(`/v1/optimize/results${qs}`);
        return resp.data;
      },
    };
    this.telemetry = {
      getSummary: async (days?: number, provider?: string, model?: string) => {
        const qs = this.buildQs({ days, provider, model });
        const resp = await this.http.get(`/v1/telemetry/summary${qs}`);
        return resp.data;
      },
      getCostBreakdown: async (days?: number, provider?: string, model?: string) => {
        const qs = this.buildQs({ days, provider, model });
        const resp = await this.http.get(`/v1/telemetry/cost${qs}`);
        return resp.data.cost_breakdown;
      },
      getBlockFrequencies: async (days?: number, provider?: string, model?: string) => {
        const qs = this.buildQs({ days, provider, model });
        const resp = await this.http.get(`/v1/telemetry/blocks${qs}`);
        return resp.data;
      },
    };
  }

  // ── Buffer management ──────────────────────────────────────────────

  async flush(timeout: number = 30000): Promise<number> {
    const start = Date.now();
    while (this.buffer.size() > 0) {
      if (Date.now() - start > timeout) break;
      await new Promise(r => setTimeout(r, 250));
    }
    return this.buffer.size();
  }

  // ── Manifest management ────────────────────────────────────────────

  async refreshManifest(provider: string, model: string): Promise<CacheManifest | null> {
    return this.getManifest(provider, model);
  }

  // ── Core method ────────────────────────────────────────────────────

  /**
   * Make an LLM API call with automatic cache optimization and memoization.
   *
   * **What Genosis modifies:**
   * - Anthropic: adds `cache_control` breakpoints to high-value system/tool blocks.
   *   Content is never changed — only metadata is added.
   * - OpenAI/Google: may reorder system content blocks and tool definitions to
   *   maximize prefix cache hits. All content is preserved; only order may change.
   *   If your prompt has strict block-ordering requirements, keep order-sensitive
   *   content in a single block rather than multiple separate blocks.
   * - All other params (model, messages, temperature, etc.) pass through unchanged.
   *
   * **Safety guarantee:** If anything in the Genosis layer throws, `fn` is called
   * with your original unmodified params. This method cannot break your LLM calls.
   */
  async call(params: Record<string, any>, fn: (params: Record<string, any>) => Promise<any>): Promise<CallResult> {
    // Phase 1: Genosis-controlled optimization.
    // Only Genosis code is wrapped — fn() errors are NOT caught here.
    // If Genosis throws, we fall back to calling fn with the original params.
    let optimized = params;
    let memoHit: { response: any; blocks: TelemetryBlock[]; fingerprint: string } | null = null;
    let pendingMemo: { fingerprint: string; candidate: MemoCandidate; manifestKey: string; provider: string } | null = null;

    try {
      const o = this.optimize(params);
      // detectProvider may throw for unknown models — already warned in optimize().
      // Wrap silently so we don't double-log; memoization is skipped for unknown providers.
      let provider: string | null = null;
      try { provider = this.detectProvider(o); } catch { /* already warned in optimize() */ }

      if (provider) {
        const model = Genosis.normalizeModel(String(o.model ?? ''));
        const manifest = this.manifestData.get(`${provider}/${model}`);
        const memoSuspended = (manifest as any)?.mode?.suspend_memoization === true;

        if (this.memoStorage && !memoSuspended) {
          const blocks = this.extractBlocks(o, provider);
          const userMsg = this.extractUserMessage(o);
          const fingerprint = this.computeFingerprint(blocks, userMsg);

          if (fingerprint) {
            const candidate = this.findMemoCandidate(provider, model, fingerprint);
            const cached = this.memoStorage.get(fingerprint);

            if (cached !== null && candidate) {
              memoHit = { response: cached, blocks, fingerprint };
            } else if (candidate) {
              pendingMemo = { fingerprint, candidate, manifestKey: `${provider}/${model}`, provider };
            }
          }
        }
      }
      optimized = o;
    } catch (err: any) {
      this.queueError('call() fallback', String(err?.message ?? err), params.model);
      optimized = params;
    }

    // Phase 2: return memoized hit without calling fn.
    if (memoHit !== null) {
      const approxTokens = Math.max(1, Math.floor(JSON.stringify(memoHit.response).length / 4));
      this.queueMemoizedTelemetry(optimized, memoHit.blocks, memoHit.fingerprint, approxTokens);
      return { response: memoHit.response, memoized: true };
    }

    // Phase 3: call fn. Errors propagate to the caller — this is intentional.
    // Genosis must never swallow LLM API errors (rate limits, network failures, etc.).
    const response = await fn(optimized);
    this.queueTelemetry(optimized, response);

    if (pendingMemo && this.memoStorage) {
      const { fingerprint, candidate, manifestKey, provider } = pendingMemo;
      const maxTtl = this.manifestData.get(manifestKey)?.memoization?.max_ttl_seconds ?? 3600;
      const ttl = Math.min(candidate.ttl_seconds, maxTtl);
      const usage = this.extractUsage(response, provider);
      const outputTokens = usage.output > 0
        ? usage.output
        : Math.max(1, Math.floor(JSON.stringify(response).length / 4));
      if (outputTokens <= (candidate.max_response_tokens ?? 2000)) {
        this.memoStorage.set(fingerprint, response, ttl);
      }
    }

    return { response, memoized: false };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private buildQs(params: Record<string, string | number | undefined>): string {
    const parts = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    return parts.length ? '?' + parts.join('&') : '';
  }

  private optimize(params: Record<string, any>): Record<string, any> {
    try {
      const model = params.model;
      if (!model) return params;

      const provider = this.detectProvider(params);
      const normalized = Genosis.normalizeModel(String(model));
      const key = `${provider}/${normalized}`;

      if (this.manifestRefreshInterval > 0) {
        const last = this.lastManifestFetch.get(key) ?? 0;
        if (last === 0) {
          // First call — just fetch the manifest. Don't trigger optimization yet —
          // no telemetry has been ingested, so no config exists. The ingestion route
          // auto-triggers optimization once enough telemetry arrives.
          // Set lastManifestFetch immediately to prevent redundant fetches on concurrent calls.
          this.lastManifestFetch.set(key, Date.now());
          this.getManifest(provider, normalized).catch(() => {});
        } else if (Date.now() - last > this.manifestRefreshInterval * 1000) {
          // Refresh interval passed — trigger background refresh.
          // Keep using the current manifest. A stale manifest is better than no optimization.
          this.lastManifestFetch.set(key, Date.now());
          this.triggerBackgroundRefresh(provider, normalized);
        }
      }

      // Always apply the best manifest we have.
      const manifest = this.manifestData.get(key);
      if (!manifest?.cache_train?.length) return params;

      if ('system' in params) return this.applyAnthropicCache(params, manifest);
      if ((params.messages ?? []).some((m: any) => m.role === 'system')) return this.applyOpenAIOrder(params, manifest);
      return params;
    } catch (err: any) {
      this.queueError('_optimize failed', String(err?.message ?? err), params.model);
      return params;
    }
  }

  detectProvider(params: Record<string, any>): string {
    const model = String(params.model ?? '');
    // Explicit override takes top priority (Azure deployments, custom names)
    if (this.providerMap[model]) return this.providerMap[model];
    // Model prefix detection
    if (model.startsWith('vgai')) return 'verygoodai';
    if (model.startsWith('claude-')) return 'anthropic';
    // AWS Bedrock: "anthropic.claude-*" or "us.anthropic.claude-*"
    if (model.startsWith('anthropic.claude') || model.includes('.anthropic.claude')) return 'anthropic';
    if (model.startsWith('gemini-')) return 'google';
    if (model.startsWith('gpt-') || /^o\d+(-|$)/.test(model)) return 'openai';
    // Request shape fallback
    if ('system' in params) return 'anthropic';
    if ('systemInstruction' in params) return 'google';
    // User-configured default (e.g. all Azure deployments are openai)
    if (this.defaultProvider) return this.defaultProvider;
    throw new Error(
      `Unrecognized provider for model '${model}'. ` +
      'Pass providerMap: { \'${model}\': \'openai\' } or defaultProvider: \'openai\' ' +
      'in the Genosis constructor for Azure/custom deployments.'
    );
  }

  static normalizeModel(model: string): string {
    // AWS Bedrock: strip provider prefix and version suffix
    const match = model.match(/^(?:[a-z]{2}\.)?anthropic\.(claude-[a-z0-9-]+?)(?:-v\d+(?::\d+)?)?$/);
    if (match) return match[1];
    return model;
  }

  private extractBlocks(params: Record<string, any>, provider: string): TelemetryBlock[] {
    const blocks: TelemetryBlock[] = [];
    const system = params.system;
    const tools = params.tools;

    if (system !== undefined) {
      // Anthropic wire format. Context window order: tools → system → messages.
      // Tool blocks get LOWER positions so fingerprint and optimization reflect correct prefix order.
      let pos = 0;

      // 1. Tool definitions first (lower positions)
      if (Array.isArray(tools)) {
        const toolBlocks: TelemetryBlock[] = [];
        for (let i = 0; i < tools.length; i++) {
          const { cache_control: _cc, ...toolClean } = tools[i] ?? {};
          const serialized = sortedStringify(toolClean);
          if (serialized) {
            toolBlocks.push({ hash: sha256(serialized), tokens: Math.ceil(serialized.length / 4), position: pos++, cached: !!tools[i]?.cache_control, source: 'tool' });
          }
        }
        // Propagate cached=true to all blocks before each breakpoint within tools
        const bpIdx = toolBlocks.flatMap((b, i) => b.cached ? [i] : []);
        if (bpIdx.length > 0) {
          let seg = 0;
          for (const bp of bpIdx) { for (let i = seg; i < bp; i++) toolBlocks[i].cached = true; seg = bp + 1; }
        }
        blocks.push(...toolBlocks);
      }

      // 2. System blocks after tools
      if (typeof system === 'string') {
        blocks.push({ hash: sha256(system), tokens: Math.ceil(system.length / 4), position: pos, cached: false, source: 'system' });
      } else if (Array.isArray(system)) {
        const sysBlocks: TelemetryBlock[] = [];
        for (let i = 0; i < system.length; i++) {
          const block = system[i];
          const text = typeof block === 'string' ? block : (block?.text ?? '');
          if (text) {
            sysBlocks.push({ hash: sha256(text), tokens: Math.ceil(text.length / 4), position: pos++, cached: !!block?.cache_control, source: 'system' });
          }
        }
        const bpIdx = sysBlocks.flatMap((b, i) => b.cached ? [i] : []);
        if (bpIdx.length > 0) {
          let seg = 0;
          for (const bp of bpIdx) { for (let i = seg; i < bp; i++) sysBlocks[i].cached = true; seg = bp + 1; }
        }
        blocks.push(...sysBlocks);
      }
    } else {
      // OpenAI/Google wire format: system in messages array, tools after system.
      let pos = 0;
      const systemMsg = (params.messages ?? []).find((m: any) => m.role === 'system');
      if (systemMsg) {
        const content = systemMsg.content;
        if (typeof content === 'string') {
          blocks.push({ hash: sha256(content), tokens: Math.ceil(content.length / 4), position: pos++, cached: false, source: 'system' });
        } else if (Array.isArray(content)) {
          for (let i = 0; i < content.length; i++) {
            const item = content[i];
            const text = typeof item === 'string' ? item : (item?.text ?? '');
            if (text) blocks.push({ hash: sha256(text), tokens: Math.ceil(text.length / 4), position: pos++, cached: false, source: 'system' });
          }
        }
      }
      // Tools after system for OpenAI/Google
      if (Array.isArray(tools)) {
        for (let i = 0; i < tools.length; i++) {
          const { cache_control: _cc, ...toolClean } = tools[i] ?? {};
          const serialized = sortedStringify(toolClean);
          if (serialized) {
            blocks.push({ hash: sha256(serialized), tokens: Math.ceil(serialized.length / 4), position: pos++, cached: false, source: 'tool' });
          }
        }
      }
    }

    return blocks;
  }

  private extractUserMessage(params: Record<string, any>): string {
    const messages = params.messages ?? [];
    const userMsgs = messages.filter((m: any) => m.role === 'user');
    return userMsgs.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  }

  private computeFingerprint(blocks: TelemetryBlock[], userMessage: string = ''): string | null {
    if (blocks.length === 0) return null;
    const ordered = [...blocks].sort((a, b) => a.position - b.position);
    let combined = ordered.map(b => b.hash).join('+');
    if (userMessage) combined += '+' + sha256(userMessage);
    return sha256(combined);
  }

  private extractUsage(response: any, provider: string): { input: number; output: number; cacheWrite: number; cacheRead: number } {
    if (typeof response !== 'object' || !response) return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

    if ('usageMetadata' in response) {
      const meta = response.usageMetadata ?? {};
      return { input: meta.promptTokenCount ?? 0, output: meta.candidatesTokenCount ?? 0, cacheWrite: 0, cacheRead: meta.cachedContentTokenCount ?? 0 };
    }

    const usage = response.usage ?? {};
    if ('input_tokens' in usage) {
      return { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0 };
    }

    const details = usage.prompt_tokens_details ?? {};
    return { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, cacheWrite: 0, cacheRead: details.cached_tokens ?? 0 };
  }

  private findMemoCandidate(provider: string, model: string, fingerprint: string): MemoCandidate | null {
    const manifest = this.manifestData.get(`${provider}/${model}`);
    const candidates = manifest?.memoization?.candidates ?? [];
    return candidates.find(c => c.fingerprint === fingerprint) ?? null;
  }

  private applyOpenAIOrder(params: Record<string, any>, manifest: CacheManifest): Record<string, any> {
    const cacheTrain = manifest.cache_train ?? [];
    if (cacheTrain.length === 0) return params;

    let result: Record<string, any> = params;

    // ── System content blocks ──────────────────────────────────────────
    const messages: any[] = params.messages ?? [];
    const systemIdx = messages.findIndex((m: any) => m.role === 'system');
    if (systemIdx !== -1) {
      const sysMsg = messages[systemIdx];
      const content = sysMsg.content;
      if (Array.isArray(content) && content.length > 1) {
        const orderIndex = new Map(cacheTrain.map((e, i) => [e.hash, i]));
        const sorted = [...content].sort((a: any, b: any) => {
          const aText = typeof a === 'string' ? a : (a?.text ?? '');
          const bText = typeof b === 'string' ? b : (b?.text ?? '');
          const aOrd = orderIndex.get(sha256(aText)) ?? Infinity;
          const bOrd = orderIndex.get(sha256(bText)) ?? Infinity;
          return aOrd - bOrd;
        });
        const newMessages = [...messages];
        newMessages[systemIdx] = { ...sysMsg, content: sorted };
        result = { ...result, messages: newMessages };
      }
    }

    // ── Tool definitions ───────────────────────────────────────────────
    const toolEntries = cacheTrain.filter((e: any) => e.source === 'tool');
    if (Array.isArray(result.tools) && (result.tools as any[]).length > 1 && toolEntries.length > 0) {
      const toolOrder = new Map(toolEntries.map((e: any, i: number) => [e.hash, i]));
      const sorted = [...(result.tools as any[])].sort((a: any, b: any) => {
        const { cache_control: _a, ...aClean } = a;
        const { cache_control: _b, ...bClean } = b;
        const aOrd = toolOrder.get(sha256(sortedStringify(aClean))) ?? Infinity;
        const bOrd = toolOrder.get(sha256(sortedStringify(bClean))) ?? Infinity;
        return aOrd - bOrd;
      });
      result = { ...result, tools: sorted };
    }

    return result;
  }

  private applyAnthropicCache(params: Record<string, any>, manifest: CacheManifest): Record<string, any> {
    const cacheTrain = manifest.cache_train ?? [];
    if (cacheTrain.length === 0) return params;

    const hints = (manifest as any).provider_hints?.anthropic ?? {};
    const cacheType = hints.cache_type ?? 'ephemeral';

    // The server computed which cache_train positions are breakpoints and already
    // validated minimum segment sizes. The SDK's only job is to find each block
    // by hash and inject cache_control on the ones at breakpoint positions.
    // No token counting — if Anthropic changes their prefix order or minimums,
    // the server updates and redeploys; no SDK update required.
    const breakpointPositions = new Set<number>(hints.breakpoint_positions ?? []);
    const hashToPosition = new Map<string, number>(
      cacheTrain.map((e: any) => [e.hash, e.position] as [string, number])
    );
    const isBreakpoint = (hash: string): boolean => {
      const pos = hashToPosition.get(hash);
      return pos !== undefined && breakpointPositions.has(pos);
    };

    let result: Record<string, any> = params;

    // ── Reorder tools by manifest position ─────────────────────────────
    // The server canonically ordered tools→system→messages when building
    // breakpoints. Re-apply that order so Anthropic's cache prefix is
    // identical across calls regardless of how the caller ordered the array.
    const toolEntries = cacheTrain.filter((e: any) => e.source === 'tool');
    if (Array.isArray(result.tools) && (result.tools as any[]).length > 1 && toolEntries.length > 0) {
      const toolOrder = new Map(toolEntries.map((e: any) => [e.hash, e.position] as [string, number]));
      const sorted = [...(result.tools as any[])].sort((a: any, b: any) => {
        const { cache_control: _a, ...aClean } = a;
        const { cache_control: _b, ...bClean } = b;
        const aOrd = toolOrder.get(sha256(sortedStringify(aClean))) ?? Infinity;
        const bOrd = toolOrder.get(sha256(sortedStringify(bClean))) ?? Infinity;
        return aOrd - bOrd;
      });
      result = { ...result, tools: sorted };
    }

    // ── Reorder system blocks by manifest position ──────────────────────
    const sysEntries = cacheTrain.filter((e: any) => e.source === 'system');
    if (Array.isArray(result.system) && (result.system as any[]).length > 1 && sysEntries.length > 0) {
      const sysOrder = new Map(sysEntries.map((e: any) => [e.hash, e.position] as [string, number]));
      const blocks = (result.system as any[]).map((b: any) => typeof b === 'string' ? { type: 'text', text: b } : { ...b });
      blocks.sort((a: any, b: any) => {
        const aOrd = sysOrder.get(sha256(a.text ?? '')) ?? Infinity;
        const bOrd = sysOrder.get(sha256(b.text ?? '')) ?? Infinity;
        return aOrd - bOrd;
      });
      result = { ...result, system: blocks };
    }

    // ── System blocks — inject cache_control ───────────────────────────
    const system = result.system;
    if (system != null) {
      if (typeof system === 'string') {
        if (isBreakpoint(sha256(system))) {
          result = { ...result, system: [{ type: 'text', text: system, cache_control: { type: cacheType } }] };
        }
      } else if (Array.isArray(system)) {
        const blocks = system.map((b: any) => typeof b === 'string' ? { type: 'text', text: b } : { ...b });
        let anyPlaced = false;

        for (let i = 0; i < blocks.length; i++) {
          if ('cache_control' in blocks[i]) {
            const { cache_control, ...rest } = blocks[i];
            blocks[i] = rest;
          }
          const text: string = blocks[i]?.text ?? '';
          if (text && isBreakpoint(sha256(text))) {
            blocks[i] = { ...blocks[i], cache_control: { type: cacheType } };
            anyPlaced = true;
          }
        }

        if (anyPlaced) result = { ...result, system: blocks };
      }
    }

    // ── Tool definitions — inject cache_control ────────────────────────
    if (Array.isArray(result.tools)) {
      const tools = (result.tools as any[]).map((t: any) => {
        const { cache_control, ...clean } = t;
        return clean;
      });
      let anyPlaced = false;
      for (let i = 0; i < tools.length; i++) {
        if (isBreakpoint(sha256(sortedStringify(tools[i])))) {
          tools[i] = { ...tools[i], cache_control: { type: cacheType } };
          anyPlaced = true;
        }
      }
      if (anyPlaced) result = { ...result, tools };
    }

    return result;
  }

  // ── Telemetry queuing ──────────────────────────────────────────────

  private queueTelemetry(optimized: Record<string, any>, response: any): void {
    try {
      let provider: string;
      try {
        provider = this.detectProvider(optimized);
      } catch {
        return; // Unknown provider already warned in call() — skip silently
      }
      const model = Genosis.normalizeModel(String(optimized.model ?? ''));
      const blocks = this.extractBlocks(optimized, provider);
      const userMsg = this.extractUserMessage(optimized);
      const fingerprint = this.computeFingerprint(blocks, userMsg);
      const usage = this.extractUsage(response, provider);
      const manifest = this.manifestData.get(`${provider}/${model}`) ?? {};

      this.buffer.put('telemetry', {
        event_id: randomUUID(),
        timestamp: _nowIso(),
        model,
        provider,
        blocks,
        latency_ms: { sdk_overhead: 0, inference: 0, total: 0 },
        manifest_version: (manifest as any).manifest_version,
        manifest_token: (manifest as any).manifest_token,
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_write_tokens: usage.cacheWrite,
          cache_read_tokens: usage.cacheRead,
        },
        fingerprint,
        worker_id: this.workerId,
        memoized: false,
      });
    } catch (err: any) {
      this.queueError('telemetry queue failed', String(err?.message ?? err), optimized.model);
    }
  }

  private queueMemoizedTelemetry(optimized: Record<string, any>, blocks: TelemetryBlock[], fingerprint: string, approxResponseTokens: number): void {
    try {
      const provider = this.detectProvider(optimized);
      const model = Genosis.normalizeModel(String(optimized.model ?? ''));
      const manifest = this.manifestData.get(`${provider}/${model}`) ?? {};

      this.buffer.put('telemetry', {
        event_id: randomUUID(),
        timestamp: _nowIso(),
        model,
        provider,
        blocks,
        latency_ms: { sdk_overhead: 0, inference: 0, total: 0 },
        manifest_version: (manifest as any).manifest_version,
        manifest_token: (manifest as any).manifest_token,
        usage: { input_tokens: 0, output_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0 },
        fingerprint,
        worker_id: this.workerId,
        memoized: true,
      });
    } catch (err: any) {
      this.queueError('memoized telemetry queue failed', String(err?.message ?? err), optimized.model);
    }
  }

  private queueError(context: string, message: string, model?: any): void {
    console.warn(`genosis SDK error [${context}]: ${message} (model=${model})`);
    try {
      this.buffer.put('error_report', {
        event_id: randomUUID(),
        context,
        message: sanitizeError(message),
        model: model ? String(model) : null,
        timestamp: _nowIso(),
      });
    } catch {}
  }

  // ── Manifest fetching ──────────────────────────────────────────────

  private async getManifest(provider: string, model: string): Promise<CacheManifest | null> {
    const key = `${provider}/${model}`;
    try {
      const result = await this.manifest.get(provider, model);
      if (result.data) {
        const isEmpty = !result.data.cache_train?.length;
        if (isEmpty) {
          const retries = (this.emptyManifestRetries.get(key) ?? 0) + 1;
          this.emptyManifestRetries.set(key, retries);
          if (retries <= FAST_RETRY_MAX && this.manifestRefreshInterval > 0) {
            // Expire the fetch timestamp early so optimize() retries in ~60s
            const normalMs = this.manifestRefreshInterval * 1000;
            const fastMs = Math.min(FAST_RETRY_INTERVAL_MS, normalMs);
            this.lastManifestFetch.set(key, Date.now() - normalMs + fastMs - 100);
          } else {
            this.lastManifestFetch.set(key, Date.now());
          }
          // Never overwrite a non-empty manifest with an empty one.
          // A stale manifest is always better than no manifest — if the blocks
          // are present in the request, caching them is correct regardless of
          // manifest age. This prevents a race where a background fetch from
          // early traffic resolves after a fresh manifest has been loaded.
          const existing = this.manifestData.get(key);
          if (!existing?.cache_train?.length) {
            this.manifestData.set(key, result.data);
          }
        } else {
          // Non-empty manifest arrived — stop fast-retrying
          this.emptyManifestRetries.delete(key);
          this.lastManifestFetch.set(key, Date.now());
          this.manifestData.set(key, result.data);
        }
        this.ackManifest(result.data);
        return result.data;
      }
      this.lastManifestFetch.set(key, Date.now());
      return this.manifestData.get(key) ?? null;
    } catch (err: any) {
      this.queueError('manifest fetch failed', String(err?.message ?? err), model);
      return this.manifestData.get(key) ?? null;
    }
  }

  private ackManifest(manifest: CacheManifest): void {
    try {
      const version = manifest.manifest_version;
      const token = manifest.manifest_token;
      if (version && token) {
        this.buffer.put('manifest_ack', { event_id: randomUUID(), manifest_version: version, manifest_token: token });
      }
    } catch (err: any) {
      this.queueError('manifest ack failed', String(err?.message ?? err));
    }
  }

  private triggerBackgroundRefresh(provider: string, model: string): void {
    const key = `${provider}/${model}`;
    if (this.refreshInProgress.has(key)) return;
    this.refreshInProgress.add(key);

    (async () => {
      try {
        try { await this.optimization.trigger(provider, model); } catch (err: any) {
          this.queueError('background optimization trigger failed', String(err?.message ?? err), model);
        }
        const result = await this.manifest.get(provider, model);
        if (result.data) {
          const isEmpty = !result.data.cache_train?.length;
          if (isEmpty) {
            const retries = (this.emptyManifestRetries.get(key) ?? 0) + 1;
            this.emptyManifestRetries.set(key, retries);
            if (retries <= FAST_RETRY_MAX && this.manifestRefreshInterval > 0) {
              const normalMs = this.manifestRefreshInterval * 1000;
              const fastMs = Math.min(FAST_RETRY_INTERVAL_MS, normalMs);
              this.lastManifestFetch.set(key, Date.now() - normalMs + fastMs - 100);
            } else {
              this.lastManifestFetch.set(key, Date.now());
            }
          } else {
            this.emptyManifestRetries.delete(key);
            this.lastManifestFetch.set(key, Date.now());
          }
          this.manifestData.set(key, result.data);
          this.ackManifest(result.data);
        } else {
          this.lastManifestFetch.set(key, Date.now());
        }
      } catch (err: any) {
        this.queueError('background manifest refresh failed', String(err?.message ?? err), model);
      } finally {
        this.refreshInProgress.delete(key);
      }
    })();
  }
}
