export interface CallResult {
  response: any;
  memoized: boolean;
}

export interface TelemetryBlock {
  hash: string;
  tokens: number;
  position: number;
  cached: boolean;
  source?: 'system' | 'tool';
}

export interface CacheManifest {
  manifest_version?: string;
  manifest_token?: string;
  cache_train?: Array<{ hash: string; tokens: number; priority: number; position: number; source?: 'system' | 'tool' }>;
  memoization?: {
    enabled: boolean;
    max_ttl_seconds?: number;
    candidates?: MemoCandidate[];
  };
  mode?: { suspend_memoization?: boolean };
  provider_hints?: any;
}

export interface MemoCandidate {
  fingerprint: string;
  ttl_seconds: number;
  block_hashes: string[];
  estimated_savings_per_hit: number;
  max_response_tokens?: number;
}

export interface MemoStorage {
  get(fingerprint: string): any | null;
  set(fingerprint: string, response: any, ttlSeconds: number): void;
}

export class InMemoryMemoStorage implements MemoStorage {
  private map = new Map<string, { response: any; expiresAt: number }>();
  private maxEntries: number;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
  }

  get(fingerprint: string): any | null {
    const entry = this.map.get(fingerprint);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(fingerprint);
      return null;
    }
    // Move to end (LRU)
    this.map.delete(fingerprint);
    this.map.set(fingerprint, entry);
    return entry.response;
  }

  set(fingerprint: string, response: any, ttlSeconds: number): void {
    this.map.set(fingerprint, { response, expiresAt: Date.now() + ttlSeconds * 1000 });
    // Evict oldest if over limit
    while (this.map.size > this.maxEntries) {
      const firstKey = this.map.keys().next().value;
      if (firstKey) this.map.delete(firstKey);
    }
  }

  get size(): number { return this.map.size; }
}

export interface GenosisOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeout?: number;
  manifestRefreshInterval?: number;
  memoizationEnabled?: boolean;
  memoizationMaxEntries?: number;
  memoStorage?: MemoStorage;
  bufferPath?: string;
  bufferMaxSize?: number;
  /**
   * Map of deployment names to provider strings.
   * Use this for Azure OpenAI or any custom deployment where the model name
   * doesn't follow a recognized pattern (e.g. "my-gpt4-prod" → "openai").
   * Takes precedence over all other detection.
   *
   * @example
   * providerMap: { 'my-gpt4-deployment': 'openai', 'my-claude-prod': 'anthropic' }
   */
  providerMap?: Record<string, string>;
  /**
   * Fallback provider when model name is unrecognized and no providerMap entry exists.
   * Useful when all deployments in your Azure endpoint are from the same provider.
   *
   * @example
   * defaultProvider: 'openai'
   */
  defaultProvider?: string;
}
