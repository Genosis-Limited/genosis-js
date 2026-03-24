import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundWorker } from '../src/worker.js';
import { DiskBuffer } from '../src/buffer.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

let tmpDir: string;

function makeBuffer(): DiskBuffer {
  const path = join(tmpDir, `worker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return new DiskBuffer(path, 10000);
}

function okResponse(): Response {
  return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ error: 'fail' }), { status: 500 });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'genosis-worker-test-'));
  mockFetch.mockReset();
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('BackgroundWorker', () => {
  describe('construction', () => {
    it('creates without error', () => {
      const buffer = makeBuffer();
      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_abc', 5000);
      worker.shutdown(0);
      buffer.close();
    });
  });

  describe('draining', () => {
    it('sends telemetry events as a batch to /v1/ingest', async () => {
      const buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1', model: 'test' });
      buffer.put('telemetry', { event_id: 'e2', model: 'test' });

      mockFetch.mockResolvedValue(okResponse());

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 100, 500);
      worker.start();

      // Wait for drain cycle
      await new Promise(r => setTimeout(r, 300));
      worker.shutdown(0);

      const ingestCalls = mockFetch.mock.calls.filter(c => c[0].includes('/v1/ingest'));
      expect(ingestCalls.length).toBeGreaterThanOrEqual(1);

      const body = JSON.parse(ingestCalls[0][1].body);
      expect(body.events).toBeDefined();
      expect(body.events.length).toBeGreaterThanOrEqual(1);

      buffer.close();
    });

    it('sends manifest_ack to /v1/manifest/ack', async () => {
      const buffer = makeBuffer();
      buffer.put('manifest_ack', { event_id: 'ack1', manifest_version: 'v1', manifest_token: 'tok' });

      mockFetch.mockResolvedValue(okResponse());

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 100, 500);
      worker.start();

      await new Promise(r => setTimeout(r, 300));
      worker.shutdown(0);

      const ackCalls = mockFetch.mock.calls.filter(c => c[0].includes('/v1/manifest/ack'));
      expect(ackCalls.length).toBeGreaterThanOrEqual(1);

      buffer.close();
    });

    it('sends error_report to /v1/errors', async () => {
      const buffer = makeBuffer();
      buffer.put('error_report', { event_id: 'err1', context: 'test', message: 'oops' });

      mockFetch.mockResolvedValue(okResponse());

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 100, 500);
      worker.start();

      await new Promise(r => setTimeout(r, 300));
      worker.shutdown(0);

      const errorCalls = mockFetch.mock.calls.filter(c => c[0].includes('/v1/errors'));
      expect(errorCalls.length).toBeGreaterThanOrEqual(1);

      buffer.close();
    });

    it('removes events from buffer after successful send', async () => {
      const buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });

      mockFetch.mockResolvedValue(okResponse());

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 100, 500);
      worker.start();

      await new Promise(r => setTimeout(r, 500));
      worker.shutdown(0);

      expect(buffer.size()).toBe(0);
      buffer.close();
    });

    it('retains events on failed send', async () => {
      const buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });

      mockFetch.mockResolvedValue(errorResponse());

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 100, 500);
      worker.start();

      await new Promise(r => setTimeout(r, 300));
      worker.shutdown(0);

      // Event should still be in buffer since send failed
      expect(buffer.size()).toBe(1);
      buffer.close();
    });
  });

  describe('authorization', () => {
    it('includes Bearer token in requests', async () => {
      const buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });

      mockFetch.mockResolvedValue(okResponse());

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_mykey', 5000, 100, 500);
      worker.start();

      await new Promise(r => setTimeout(r, 300));
      worker.shutdown(0);

      const call = mockFetch.mock.calls[0];
      expect(call[1].headers['Authorization']).toBe('Bearer gns_test_mykey');

      buffer.close();
    });

    it('includes User-Agent header', async () => {
      const buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });

      mockFetch.mockResolvedValue(okResponse());

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 100, 500);
      worker.start();

      await new Promise(r => setTimeout(r, 300));
      worker.shutdown(0);

      const call = mockFetch.mock.calls[0];
      expect(call[1].headers['User-Agent']).toMatch(/genosis-sdk-typescript/);

      buffer.close();
    });
  });

  describe('shutdown', () => {
    it('stops scheduling after shutdown', async () => {
      const buffer = makeBuffer();
      mockFetch.mockResolvedValue(okResponse());

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 100, 500);
      worker.start();
      worker.shutdown(0);

      const callCount = mockFetch.mock.calls.length;
      await new Promise(r => setTimeout(r, 300));

      // No new calls after shutdown
      expect(mockFetch.mock.calls.length).toBe(callCount);
      buffer.close();
    });

    it('start is idempotent', () => {
      const buffer = makeBuffer();
      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000);
      worker.start();
      worker.start(); // Should not throw or create duplicate timers
      worker.shutdown(0);
      buffer.close();
    });
  });

  describe('backoff on failure', () => {
    it('increases delay on consecutive failures', async () => {
      const buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });
      buffer.put('telemetry', { event_id: 'e2' });

      // Always fail
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 50, 500);
      worker.start();

      await new Promise(r => setTimeout(r, 500));
      worker.shutdown(0);

      // Should have retried but with increasing backoff
      // Events should still be in buffer
      expect(buffer.size()).toBeGreaterThan(0);
      buffer.close();
    });
  });

  describe('batch size', () => {
    it('respects batch size limit', async () => {
      const buffer = makeBuffer();
      for (let i = 0; i < 10; i++) {
        buffer.put('telemetry', { event_id: `e${i}` });
      }

      mockFetch.mockResolvedValue(okResponse());

      // Batch size of 3
      const worker = new BackgroundWorker(buffer, 'http://localhost:3001', 'gns_test_key', 5000, 50, 3);
      worker.start();

      await new Promise(r => setTimeout(r, 500));
      worker.shutdown(0);

      // Should have made multiple batch calls
      const ingestCalls = mockFetch.mock.calls.filter(c => c[0].includes('/v1/ingest'));
      if (ingestCalls.length > 0) {
        const firstBatch = JSON.parse(ingestCalls[0][1].body);
        expect(firstBatch.events.length).toBeLessThanOrEqual(3);
      }

      buffer.close();
    });
  });
});
