import { mkdirSync, createWriteStream, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { getAppHome, getLogDir } from '../utils/paths.js';
import { genId } from '../utils/id.js';
import { addLogListener } from './logger.js';

// --- Types ---

export interface CaptureEvent {
  ts: number;
  level?: string;
  module?: string;
  msg: string;
  data?: unknown;
}

export interface CaptureResult {
  captureId: string;
  path: string;
  durationMs: number;
  eventCount: number;
  size: number;
}

export interface CaptureStatus {
  active: boolean;
  captureId?: string;
  startedAt?: number;
}

// --- Module state ---

let activeSession: CaptureSession | null = null;

function getCapturesDir(): string {
  return join(getAppHome(), 'captures');
}

// --- Route registration ---

type RouteRegistrar = (method: string, path: string, handler: (req: unknown, res: ServerResponse, url: URL, params: Record<string, string>) => void | Promise<void>) => void;
type JsonResponder = (res: ServerResponse, data: unknown, status?: number) => void;

export function registerCaptureRoutes(route: RouteRegistrar, json: JsonResponder): void {
  route('POST', '/debug/capture/start', (_req, res) => {
    try {
      if (activeSession) throw new Error('A capture session is already active');
      activeSession = new CaptureSession();
      activeSession.start();
      json(res, { captureId: activeSession.captureId, path: activeSession.captureDir });
    } catch (err) {
      json(res, { error: (err as Error).message }, 409);
    }
  });

  route('POST', '/debug/capture/stop', (_req, res) => {
    if (!activeSession) {
      json(res, { error: 'No active capture' }, 404);
      return;
    }
    const result = activeSession.stop();
    activeSession = null;
    json(res, result);
  });

  route('GET', '/debug/capture/status', (_req, res) => {
    if (!activeSession) {
      json(res, { active: false });
      return;
    }
    json(res, { active: true, captureId: activeSession.captureId, startedAt: activeSession.startedAt });
  });
}

// --- CaptureSession ---

class CaptureSession {
  readonly captureId: string;
  readonly captureDir: string;
  readonly startedAt: number;
  private stream: WriteStream | null = null;
  private eventCount = 0;
  private unsubscribe: (() => void) | null = null;
  private logFileOffset = 0;

  constructor() {
    this.captureId = genId('cap');
    this.captureDir = join(getCapturesDir(), this.captureId);
    this.startedAt = Date.now();
  }

  start(): void {
    mkdirSync(this.captureDir, { recursive: true });
    this.stream = createWriteStream(join(this.captureDir, 'capture.jsonl'), { flags: 'a' });

    // Record current berry.log offset to extract child agent logs on stop
    const logFile = join(getLogDir(), 'berry.log');
    try { this.logFileOffset = statSync(logFile).size; } catch { this.logFileOffset = 0; }

    this.unsubscribe = addLogListener((level, module, msg, data) => {
      this.write({ ts: Date.now(), level, module, msg, data });
    });
  }

  stop(): CaptureResult {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    // Extract the berry.log segment for this capture period (includes all child agent logs)
    this.extractFullLog();

    const stoppedAt = Date.now();
    const durationMs = stoppedAt - this.startedAt;

    const captureFile = join(this.captureDir, 'capture.jsonl');
    const fullLogFile = join(this.captureDir, 'full.log');
    let size = 0;
    try { size = statSync(captureFile).size; } catch {}
    try { size += statSync(fullLogFile).size; } catch {}

    writeFileSync(join(this.captureDir, 'meta.json'), JSON.stringify({
      captureId: this.captureId,
      startedAt: this.startedAt,
      stoppedAt,
      durationMs,
      eventCount: this.eventCount,
      captureDir: this.captureDir,
      files: ['capture.jsonl', 'full.log', 'meta.json'],
    }, null, 2));

    return { captureId: this.captureId, path: this.captureDir, durationMs, eventCount: this.eventCount, size };
  }

  private write(event: CaptureEvent): void {
    if (!this.stream) return;
    this.eventCount++;
    this.stream.write(JSON.stringify(event) + '\n');
  }

  private extractFullLog(): void {
    const logFile = join(getLogDir(), 'berry.log');
    const outputFile = join(this.captureDir, 'full.log');
    const MAX_EXTRACT = 50 * 1024 * 1024; // 50MB cap
    try {
      const currentSize = statSync(logFile).size;
      let offset = this.logFileOffset;
      let length = currentSize - offset;
      if (length <= 0) { writeFileSync(outputFile, ''); return; }
      if (length > MAX_EXTRACT) {
        offset = currentSize - MAX_EXTRACT;
        length = MAX_EXTRACT;
      }
      const buffer = Buffer.alloc(length);
      const fd = openSync(logFile, 'r');
      readSync(fd, buffer, 0, length, offset);
      closeSync(fd);
      writeFileSync(outputFile, buffer);
    } catch {
      writeFileSync(outputFile, '');
    }
  }
}
