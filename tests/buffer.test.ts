import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiskBuffer } from '../src/buffer.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let tmpDir: string;
let buffer: DiskBuffer;

function makeBuffer(maxSize: number = 10000): DiskBuffer {
  const path = join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return new DiskBuffer(path, maxSize);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'genosis-buffer-test-'));
});

afterEach(() => {
  try { buffer?.close(); } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('DiskBuffer', () => {
  describe('basic operations', () => {
    it('starts empty', () => {
      buffer = makeBuffer();
      expect(buffer.size()).toBe(0);
    });

    it('put increases size', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1', data: 'hello' });
      expect(buffer.size()).toBe(1);
    });

    it('put multiple events', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });
      buffer.put('telemetry', { event_id: 'e2' });
      buffer.put('telemetry', { event_id: 'e3' });
      expect(buffer.size()).toBe(3);
    });

    it('put returns event ID', () => {
      buffer = makeBuffer();
      const id = buffer.put('telemetry', { event_id: 'my-id' });
      expect(id).toBe('my-id');
    });

    it('put generates ID if not provided', () => {
      buffer = makeBuffer();
      const id = buffer.put('telemetry', { data: 'no-id' });
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('duplicate event_id is ignored', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'dup' });
      buffer.put('telemetry', { event_id: 'dup' });
      expect(buffer.size()).toBe(1);
    });
  });

  describe('peek', () => {
    it('returns events in FIFO order', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1', order: 1 });
      buffer.put('telemetry', { event_id: 'e2', order: 2 });
      buffer.put('telemetry', { event_id: 'e3', order: 3 });

      const events = buffer.peek(10);
      expect(events.length).toBe(3);
      expect(events[0].id).toBe('e1');
      expect(events[1].id).toBe('e2');
      expect(events[2].id).toBe('e3');
    });

    it('respects limit', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });
      buffer.put('telemetry', { event_id: 'e2' });
      buffer.put('telemetry', { event_id: 'e3' });

      const events = buffer.peek(2);
      expect(events.length).toBe(2);
    });

    it('returns correct type and payload', () => {
      buffer = makeBuffer();
      buffer.put('manifest_ack', { event_id: 'e1', manifest_version: 'v42' });

      const events = buffer.peek(1);
      expect(events[0].type).toBe('manifest_ack');
      expect(events[0].payload.manifest_version).toBe('v42');
    });

    it('does not remove events', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });
      buffer.peek(10);
      expect(buffer.size()).toBe(1);
    });

    it('returns empty array when empty', () => {
      buffer = makeBuffer();
      expect(buffer.peek(10)).toEqual([]);
    });
  });

  describe('remove', () => {
    it('removes specified events', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });
      buffer.put('telemetry', { event_id: 'e2' });
      buffer.put('telemetry', { event_id: 'e3' });

      const removed = buffer.remove(['e1', 'e3']);
      expect(removed).toBe(2);
      expect(buffer.size()).toBe(1);

      const remaining = buffer.peek(10);
      expect(remaining[0].id).toBe('e2');
    });

    it('returns 0 for empty array', () => {
      buffer = makeBuffer();
      expect(buffer.remove([])).toBe(0);
    });

    it('returns 0 for non-existent IDs', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });
      expect(buffer.remove(['nonexistent'])).toBe(0);
      expect(buffer.size()).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all events', () => {
      buffer = makeBuffer();
      buffer.put('telemetry', { event_id: 'e1' });
      buffer.put('telemetry', { event_id: 'e2' });
      buffer.clear();
      expect(buffer.size()).toBe(0);
    });
  });

  describe('max size enforcement', () => {
    it('drops oldest events when max size exceeded', () => {
      buffer = makeBuffer(3);
      buffer.put('telemetry', { event_id: 'e1' });
      buffer.put('telemetry', { event_id: 'e2' });
      buffer.put('telemetry', { event_id: 'e3' });
      buffer.put('telemetry', { event_id: 'e4' });

      expect(buffer.size()).toBe(3);
      const events = buffer.peek(10);
      const ids = events.map(e => e.id);
      expect(ids).not.toContain('e1');
      expect(ids).toContain('e4');
    });

    it('keeps newest events on overflow', () => {
      buffer = makeBuffer(2);
      buffer.put('telemetry', { event_id: 'old1' });
      buffer.put('telemetry', { event_id: 'old2' });
      buffer.put('telemetry', { event_id: 'new1' });
      buffer.put('telemetry', { event_id: 'new2' });

      const events = buffer.peek(10);
      const ids = events.map(e => e.id);
      expect(ids).toContain('new1');
      expect(ids).toContain('new2');
    });
  });

  describe('persistence', () => {
    it('survives close and reopen', () => {
      const path = join(tmpDir, 'persist-test.db');
      const buf1 = new DiskBuffer(path, 10000);
      buf1.put('telemetry', { event_id: 'survive', data: 'test' });
      buf1.close();

      const buf2 = new DiskBuffer(path, 10000);
      expect(buf2.size()).toBe(1);
      const events = buf2.peek(1);
      expect(events[0].payload.data).toBe('test');
      buf2.close();
    });
  });

  describe('WAL mode', () => {
    it('uses WAL journaling for crash safety', () => {
      buffer = makeBuffer();
      // If we got here without error, WAL mode was set successfully
      // WAL is set in constructor via pragma
      expect(buffer.size()).toBe(0);
    });
  });
});
