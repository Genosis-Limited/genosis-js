import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient } from '../src/http.js';
import {
  GenosisError, BadRequestError, AuthenticationError, NotFoundError,
  RateLimitError, InternalServerError, ConnectionError, TimeoutError,
} from '../src/errors.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: any, status: number = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function errorResponse(status: number, message: string, code: string = 'ERROR'): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('HttpClient', () => {
  describe('constructor', () => {
    it('requires HTTPS for non-localhost', () => {
      expect(() => new HttpClient('gns_test_abc', 'http://example.com')).toThrow('HTTPS');
    });

    it('allows HTTP for localhost', () => {
      expect(() => new HttpClient('gns_test_abc', 'http://localhost:3001')).not.toThrow();
    });

    it('allows HTTP for 127.0.0.1', () => {
      expect(() => new HttpClient('gns_test_abc', 'http://127.0.0.1:3001')).not.toThrow();
    });

    it('allows HTTPS', () => {
      expect(() => new HttpClient('gns_test_abc', 'https://api.usegenosis.ai')).not.toThrow();
    });

    it('strips trailing slash from base URL', () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001/');
      mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
      client.get('/v1/test');
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3001/v1/test');
    });
  });

  describe('request methods', () => {
    const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 0);

    it('GET sends correct headers', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: 'ok' }));
      await client.get('/v1/test');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('GET');
      expect(opts.headers['Authorization']).toBe('Bearer gns_test_abc');
      expect(opts.headers['User-Agent']).toMatch(/genosis-sdk-typescript/);
    });

    it('POST sends JSON body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ created: true }));
      await client.post('/v1/test', { key: 'value' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.body).toBe(JSON.stringify({ key: 'value' }));
    });

    it('DELETE sends no body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ deleted: true }));
      await client.delete('/v1/test/123');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('DELETE');
      expect(opts.body).toBeUndefined();
    });

    it('PUT sends JSON body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ updated: true }));
      await client.put('/v1/test', { name: 'new' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.method).toBe('PUT');
      expect(opts.body).toBe(JSON.stringify({ name: 'new' }));
    });

    it('GET with extra headers', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await client.get('/v1/test', { 'If-None-Match': '"v1"' });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['If-None-Match']).toBe('"v1"');
    });

    it('returns parsed JSON data', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: '123', name: 'test' }));
      const resp = await client.get('/v1/test');
      expect(resp.data).toEqual({ id: '123', name: 'test' });
      expect(resp.status).toBe(200);
    });

    it('handles 304 Not Modified', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
      const resp = await client.get('/v1/test');
      expect(resp.status).toBe(304);
      expect(resp.data).toBeNull();
    });
  });

  describe('error handling', () => {
    const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 0);

    it('throws BadRequestError on 400', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(400, 'Bad input'));
      await expect(client.get('/v1/test')).rejects.toThrow(BadRequestError);
    });

    it('throws AuthenticationError on 401', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401, 'Invalid key'));
      await expect(client.get('/v1/test')).rejects.toThrow(AuthenticationError);
    });

    it('throws NotFoundError on 404', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not found'));
      await expect(client.get('/v1/test')).rejects.toThrow(NotFoundError);
    });

    it('throws RateLimitError on 429', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(429, 'Too many requests'));
      await expect(client.get('/v1/test')).rejects.toThrow(RateLimitError);
    });

    it('throws InternalServerError on 500', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Server error'));
      await expect(client.get('/v1/test')).rejects.toThrow(InternalServerError);
    });

    it('error includes status and code', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Manifest not found', 'NOT_FOUND'));
      try {
        await client.get('/v1/test');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError);
        expect((err as GenosisError).status).toBe(404);
        expect((err as GenosisError).code).toBe('NOT_FOUND');
      }
    });

    it('throws ConnectionError on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(client.get('/v1/test')).rejects.toThrow(ConnectionError);
    });

    it('throws TimeoutError on abort', async () => {
      mockFetch.mockImplementationOnce(() => {
        const err: any = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });
      await expect(client.get('/v1/test')).rejects.toThrow(TimeoutError);
    });
  });

  describe('retries', () => {
    it('retries on 500', async () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 1, 60000);
      mockFetch
        .mockResolvedValueOnce(errorResponse(500, 'Server error'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const resp = await client.get('/v1/test');
      expect(resp.data).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on 429', async () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 1, 60000);
      mockFetch
        .mockResolvedValueOnce(errorResponse(429, 'Rate limited'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const resp = await client.get('/v1/test');
      expect(resp.data).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on 502', async () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 1, 60000);
      mockFetch
        .mockResolvedValueOnce(errorResponse(502, 'Bad gateway'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const resp = await client.get('/v1/test');
      expect(resp.data).toEqual({ ok: true });
    });

    it('does NOT retry on 400', async () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 2, 60000);
      mockFetch.mockResolvedValueOnce(errorResponse(400, 'Bad request'));

      await expect(client.get('/v1/test')).rejects.toThrow(BadRequestError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 401', async () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 2, 60000);
      mockFetch.mockResolvedValueOnce(errorResponse(401, 'Unauthorized'));

      await expect(client.get('/v1/test')).rejects.toThrow(AuthenticationError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 404', async () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 2, 60000);
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not found'));

      await expect(client.get('/v1/test')).rejects.toThrow(NotFoundError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws after exhausting retries', async () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 1, 60000);
      mockFetch
        .mockResolvedValueOnce(errorResponse(500, 'Server error'))
        .mockResolvedValueOnce(errorResponse(500, 'Server error'));

      await expect(client.get('/v1/test')).rejects.toThrow(InternalServerError);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on connection error', async () => {
      const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 1, 60000);
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      const resp = await client.get('/v1/test');
      expect(resp.data).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    describe('Retry-After header', () => {
      afterEach(() => { vi.restoreAllMocks(); });

      function spyOnSetTimeout(): number[] {
        const delays: number[] = [];
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number) => {
          delays.push(ms ?? 0);
          (fn as () => void)();
          return 0 as any;
        });
        return delays;
      }

      it('uses Retry-After header value as minimum delay on 429', async () => {
        const delays = spyOnSetTimeout();
        const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 1, 60000);

        mockFetch
          .mockResolvedValueOnce(new Response(
            JSON.stringify({ error: { message: 'rate limited', code: 'RATE_LIMITED' } }),
            { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '30' } },
          ))
          .mockResolvedValueOnce(jsonResponse({ ok: true }));

        await client.get('/v1/test');

        // Abort timeouts are exactly 60000ms; the retry backoff influenced by
        // Retry-After: 30 should be >= 30000ms and clearly < 60000ms.
        expect(delays.some(d => d >= 30000 && d < 60000)).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('uses normal exponential backoff when Retry-After is absent', async () => {
        const delays = spyOnSetTimeout();
        const client = new HttpClient('gns_test_abc', 'http://localhost:3001', 1, 60000);

        mockFetch
          .mockResolvedValueOnce(errorResponse(429, 'Rate limited'))
          .mockResolvedValueOnce(jsonResponse({ ok: true }));

        await client.get('/v1/test');

        // Normal backoff for attempt=1: 500ms + up to 500ms jitter = [500, 1000]ms.
        // No delay should be >= 5000ms and < 60000ms (those only arise from Retry-After).
        expect(delays.some(d => d >= 5000 && d < 60000)).toBe(false);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('GenosisError.fromStatus', () => {
    it('maps all known status codes', () => {
      expect(GenosisError.fromStatus(400, 'msg', 'code')).toBeInstanceOf(BadRequestError);
      expect(GenosisError.fromStatus(401, 'msg', 'code')).toBeInstanceOf(AuthenticationError);
      expect(GenosisError.fromStatus(404, 'msg', 'code')).toBeInstanceOf(NotFoundError);
      expect(GenosisError.fromStatus(429, 'msg', 'code')).toBeInstanceOf(RateLimitError);
      expect(GenosisError.fromStatus(500, 'msg', 'code')).toBeInstanceOf(InternalServerError);
      expect(GenosisError.fromStatus(503, 'msg', 'code')).toBeInstanceOf(InternalServerError);
    });

    it('returns base GenosisError for unknown status', () => {
      const err = GenosisError.fromStatus(418, "I'm a teapot", 'TEAPOT');
      expect(err).toBeInstanceOf(GenosisError);
      expect(err.status).toBe(418);
    });
  });
});
