import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const DEFAULT_MAX_SIZE = 10_000;
const DEFAULT_DB_PATH = join(homedir(), '.genosis', 'buffer.db');

export interface BufferEvent {
  id: string;
  type: string;
  payload: Record<string, any>;
}

export class DiskBuffer {
  private db: Database.Database;
  private maxSize: number;

  constructor(path?: string, maxSize: number = DEFAULT_MAX_SIZE) {
    const dbPath = path ?? DEFAULT_DB_PATH;
    this.maxSize = maxSize;

    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  put(eventType: string, payload: Record<string, any>): string {
    const eventId = (payload.event_id as string) ?? randomUUID();
    this.db.prepare(
      'INSERT OR IGNORE INTO pending (id, type, payload) VALUES (?, ?, ?)'
    ).run(eventId, eventType, JSON.stringify(payload));
    this.enforceMaxSize();
    return eventId;
  }

  peek(limit: number = 50): BufferEvent[] {
    const rows = this.db.prepare(
      'SELECT id, type, payload FROM pending ORDER BY created_at ASC LIMIT ?'
    ).all(limit) as Array<{ id: string; type: string; payload: string }>;

    return rows.map(row => ({
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload),
    }));
  }

  remove(eventIds: string[]): number {
    if (eventIds.length === 0) return 0;
    const placeholders = eventIds.map(() => '?').join(',');
    const result = this.db.prepare(
      `DELETE FROM pending WHERE id IN (${placeholders})`
    ).run(...eventIds);
    return result.changes;
  }

  size(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM pending').get() as { count: number };
    return row.count;
  }

  clear(): void {
    this.db.exec('DELETE FROM pending');
  }

  close(): void {
    this.db.close();
  }

  private enforceMaxSize(): void {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM pending').get() as { count: number };
    if (row.count > this.maxSize) {
      const excess = row.count - this.maxSize;
      this.db.prepare(
        'DELETE FROM pending WHERE id IN (SELECT id FROM pending ORDER BY created_at ASC LIMIT ?)'
      ).run(excess);
    }
  }
}
