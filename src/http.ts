import { GenosisError, ConnectionError, TimeoutError } from './errors.js';

const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const VERSION = '1.0.0';

export interface HttpResponse {
  data: any;
  status: number;
  headers: Headers;
}

export class HttpClient {
  private baseUrl: string;
  private apiKey: string;
  private maxRetries: number;
  private timeout: number;

  constructor(apiKey: string, baseUrl: string, maxRetries: number = 2, timeout: number = 60000) {
    baseUrl = baseUrl.replace(/\/$/, '');
    if (!baseUrl.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl)) {
      throw new Error('base_url must use HTTPS. API keys must not be transmitted over plaintext HTTP.');
    }
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.maxRetries = maxRetries;
    this.timeout = timeout;
  }

  async get(path: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return this.request('GET', path, undefined, headers);
  }

  async post(path: string, body?: any): Promise<HttpResponse> {
    return this.request('POST', path, body);
  }

  async put(path: string, body?: any): Promise<HttpResponse> {
    return this.request('PUT', path, body);
  }

  async delete(path: string): Promise<HttpResponse> {
    return this.request('DELETE', path);
  }

  private async request(method: string, path: string, body?: any, extraHeaders?: Record<string, string>): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'User-Agent': `genosis-sdk-typescript/${VERSION}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;
    let lastRetryAfter: string | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(500 * Math.pow(2, attempt - 1), 8000) + Math.random() * 500;
        const retryAfterMs = lastRetryAfter !== null ? parseFloat(lastRetryAfter) * 1000 : NaN;
        const delay = !isNaN(retryAfterMs) ? Math.max(backoff, retryAfterMs) : backoff;
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const resp = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (resp.status === 304) {
          return { data: null, status: 304, headers: resp.headers };
        }

        let jsonData: any = {};
        try { jsonData = await resp.json(); } catch {}

        if (!resp.ok) {
          const errBody = jsonData?.error ?? {};
          const message = errBody.message ?? `HTTP ${resp.status}`;
          const code = errBody.code ?? 'UNKNOWN';

          if (RETRYABLE_STATUS_CODES.has(resp.status) && attempt < this.maxRetries) {
            lastError = GenosisError.fromStatus(resp.status, message, code);
            lastRetryAfter = resp.headers.get('retry-after');
            continue;
          }
          throw GenosisError.fromStatus(resp.status, message, code);
        }

        return { data: jsonData, status: resp.status, headers: resp.headers };
      } catch (err: any) {
        if (err instanceof GenosisError) throw err;
        if (err?.name === 'AbortError') {
          const msg = `Request timed out after ${this.timeout}ms`;
          if (attempt < this.maxRetries) { lastError = new TimeoutError(msg); continue; }
          throw new TimeoutError(msg);
        }
        const msg = err?.message ?? 'Connection failed';
        if (attempt < this.maxRetries) { lastError = new ConnectionError(msg); continue; }
        throw new ConnectionError(msg);
      }
    }

    throw lastError ?? new ConnectionError('Request failed');
  }
}
