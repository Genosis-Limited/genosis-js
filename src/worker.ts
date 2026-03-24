import type { DiskBuffer, BufferEvent } from './buffer.js';

const DEFAULT_DRAIN_INTERVAL = 1000;
const DEFAULT_BATCH_SIZE = 500;
const RETRY_BACKOFF_BASE = 2000;
const MAX_RETRY_BACKOFF = 60000;
const VERSION = '1.0.0';

export class BackgroundWorker {
  private buffer: DiskBuffer;
  private baseUrl: string;
  private apiKey: string;
  private timeout: number;
  private drainInterval: number;
  private batchSize: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private consecutiveFailures = 0;

  constructor(
    buffer: DiskBuffer,
    baseUrl: string,
    apiKey: string,
    timeout: number = 30000,
    drainInterval: number = DEFAULT_DRAIN_INTERVAL,
    batchSize: number = DEFAULT_BATCH_SIZE,
  ) {
    this.buffer = buffer;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.drainInterval = drainInterval;
    this.batchSize = batchSize;

    // beforeExit: Node.js keeps the process alive while async work is pending,
    // so firing an async drain here flushes the buffer before exit in serverless
    // and short-lived script environments.
    process.on('beforeExit', () => { if (!this.stopped) this.drainAndStop(); });

    // SIGTERM: drain then exit explicitly (Docker/K8s sends SIGTERM before SIGKILL).
    // 30s window — generous for containerized environments with graceful shutdown.
    try {
      process.on('SIGTERM', () => {
        this.drainAndStop(30000).then(() => process.exit(0)).catch(() => process.exit(0));
      });
    } catch {}
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.scheduleNext(0);
  }

  shutdown(timeout: number = 60000): void {
    // Stops the worker timer. Leftover events persist in SQLite and replay on next startup.
    // For explicit async drain before exit, the process.on('beforeExit') handler handles it,
    // or call genosis.flush() directly in serverless handlers before returning.
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private async drainAndStop(timeoutMs = 30000): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const start = Date.now();
    while (this.buffer.size() > 0 && Date.now() - start < timeoutMs) {
      try {
        if (!(await this.drainOnce())) break;
      } catch {
        break;
      }
    }
  }

  private scheduleNext(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        const drained = await this.drainOnce();
        if (drained) {
          this.consecutiveFailures = 0;
          this.scheduleNext(0); // Drain again immediately
        } else {
          this.scheduleNext(this.drainInterval);
        }
      } catch {
        this.consecutiveFailures++;
        const backoff = Math.min(RETRY_BACKOFF_BASE * Math.pow(2, this.consecutiveFailures - 1), MAX_RETRY_BACKOFF);
        this.scheduleNext(backoff);
      }
    }, delay);
    // Prevent timer from keeping the process alive
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as any).unref();
    }
  }

  private async drainOnce(): Promise<boolean> {
    const batch = this.buffer.peek(this.batchSize);
    if (batch.length === 0) return false;

    const telemetryEvents = batch.filter(e => e.type === 'telemetry');
    const otherEvents = batch.filter(e => e.type !== 'telemetry');
    const confirmedIds: string[] = [];

    if (telemetryEvents.length > 0) {
      const acked = await this.sendTelemetryBatch(telemetryEvents);
      confirmedIds.push(...acked);
    }

    for (const event of otherEvents) {
      if (await this.sendSingle(event)) {
        confirmedIds.push(event.id);
      }
    }

    if (confirmedIds.length > 0) {
      this.buffer.remove(confirmedIds);
    }

    return confirmedIds.length > 0;
  }

  private async sendTelemetryBatch(events: BufferEvent[]): Promise<string[]> {
    const payloads = events.map(e => e.payload);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      const resp = await fetch(`${this.baseUrl}/v1/ingest`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': `genosis-sdk-typescript/${VERSION}`,
        },
        body: JSON.stringify({ events: payloads }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (resp.ok) return events.map(e => e.id);
      return [];
    } catch {
      return [];
    }
  }

  private async sendSingle(event: BufferEvent): Promise<boolean> {
    const pathMap: Record<string, string> = {
      manifest_ack: '/v1/manifest/ack',
      error_report: '/v1/errors',
      optimization_trigger: '/v1/optimize',
    };
    const path = pathMap[event.type];
    if (!path) return true; // Discard unknown types

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': `genosis-sdk-typescript/${VERSION}`,
        },
        body: JSON.stringify(event.payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return resp.ok;
    } catch {
      return false;
    }
  }
}
