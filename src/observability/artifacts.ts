import { mkdirSync, openSync, createWriteStream, type WriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getAppHome } from '../utils/paths.js';
import { genId } from '../utils/id.js';
import { redact } from './redaction.js';
import type { LogLevel, LogEvent, ConsoleFrame, RunArtifact } from './types.js';
import type Database from 'better-sqlite3';

const LARGE_OUTPUT_THRESHOLD = 64 * 1024;

export interface RunContextOptions {
  level?: LogLevel;
  kind?: RunArtifact['kind'];
  sessionId?: string;
  db?: Database.Database | null;
}

export interface LargeOutputResult {
  stored: boolean;
  path?: string;
  hash?: string;
  size: number;
  preview: string;
  content?: string;
}

export class RunContext {
  readonly runId: string;
  readonly artifactDir: string;
  readonly startedAt: number;
  private logStream: WriteStream;
  private consoleStream: WriteStream;
  private stdoutStream: WriteStream;
  private stderrStream: WriteStream;
  private level: LogLevel;
  private kind: RunArtifact['kind'];
  private sessionId?: string;
  private command: string;
  private db: Database.Database | null;
  private frameSeq = 0;

  constructor(command: string, options: RunContextOptions = {}) {
    this.runId = genId('run');
    this.startedAt = Date.now();
    this.level = options.level ?? 'info';
    this.kind = options.kind ?? 'cli';
    this.sessionId = options.sessionId;
    this.command = command;
    this.db = options.db ?? null;

    this.artifactDir = join(getAppHome(), 'runs', this.runId);
    mkdirSync(this.artifactDir, { recursive: true });

    const logPath = join(this.artifactDir, 'berry.log.jsonl');
    const consolePath = join(this.artifactDir, 'console.jsonl');
    const stdoutPath = join(this.artifactDir, 'stdout.log');
    const stderrPath = join(this.artifactDir, 'stderr.log');

    this.logStream = createWriteStream(logPath, { fd: openSync(logPath, 'w') });
    this.consoleStream = createWriteStream(consolePath, { fd: openSync(consolePath, 'w') });
    this.stdoutStream = createWriteStream(stdoutPath, { fd: openSync(stdoutPath, 'w') });
    this.stderrStream = createWriteStream(stderrPath, { fd: openSync(stderrPath, 'w') });

    this.persistRunStart();
  }

  private shouldLog(level: LogLevel): boolean {
    const priority: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
    return priority[level] <= priority[this.level];
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  log(level: LogLevel, module: string, msg: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const event: LogEvent = {
      ts: Date.now(),
      level,
      module,
      msg,
      data: data ? (redact(data) as Record<string, unknown>) : undefined,
      runId: this.runId,
    };
    const line = JSON.stringify(event) + '\n';
    this.logStream.write(line);
    this.persistLogEvent(event);
  }

  writeConsole(stream: 'stdout' | 'stderr', text: string, source = 'cli'): void {
    const seq = this.frameSeq++;
    const frame: ConsoleFrame = {
      ts: Date.now(),
      seq,
      stream,
      source,
      isJson: false,
      text,
      runId: this.runId,
    };
    this.consoleStream.write(JSON.stringify(frame) + '\n');
    if (stream === 'stdout') {
      this.stdoutStream.write(text);
    } else {
      this.stderrStream.write(text);
    }
    this.persistConsoleFrame(frame);
  }

  writeArtifact(filename: string, content: string): void {
    const stream = createWriteStream(join(this.artifactDir, filename), { flags: 'a' });
    stream.write(content);
    stream.end();
  }

  async handleLargeOutput(label: string, content: string, thresholdBytes = LARGE_OUTPUT_THRESHOLD): Promise<LargeOutputResult> {
    const size = Buffer.byteLength(content, 'utf-8');
    const preview = content.slice(0, 500);

    if (size <= thresholdBytes) {
      return { stored: false, size, preview, content };
    }

    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const filename = `${label}-${hash.slice(0, 8)}.txt`;
    const path = join(this.artifactDir, filename);
    await writeFile(path, content);

    return { stored: true, path, hash, size, preview };
  }

  async close(exitCode?: number): Promise<RunArtifact> {
    const status = exitCode === 0 || exitCode === undefined ? 'passed' : 'failed';
    const artifact: RunArtifact = {
      runId: this.runId,
      kind: this.kind,
      sessionId: this.sessionId,
      command: this.command,
      artifactDir: this.artifactDir,
      logLevel: this.level,
      status,
      startedAt: this.startedAt,
      finishedAt: Date.now(),
    };
    await writeFile(
      join(this.artifactDir, 'result.json'),
      JSON.stringify(artifact, null, 2),
    );
    await Promise.all([
      endStream(this.logStream),
      endStream(this.consoleStream),
      endStream(this.stdoutStream),
      endStream(this.stderrStream),
    ]);
    this.persistRunEnd(artifact);
    return artifact;
  }

  private persistRunStart(): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO run_artifacts (id, kind, session_id, artifact_dir, log_level, command, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
      `).run(this.runId, this.kind, this.sessionId ?? null, this.artifactDir, this.level, this.command, this.startedAt);
    } catch {
      // graceful fallback if table doesn't exist
    }
  }

  private persistRunEnd(artifact: RunArtifact): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        UPDATE run_artifacts SET status = ?, finished_at = ? WHERE id = ?
      `).run(artifact.status, artifact.finishedAt, this.runId);
    } catch {
      // graceful fallback
    }
  }

  private persistLogEvent(event: LogEvent): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO log_events (id, run_id, session_id, level, module, message, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('log'),
        this.runId,
        this.sessionId ?? null,
        event.level,
        event.module,
        event.msg,
        event.data ? JSON.stringify(event.data) : '{}',
        event.ts,
      );
    } catch {
      // graceful fallback
    }
  }

  private persistConsoleFrame(frame: ConsoleFrame): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO console_frames (id, run_id, session_id, seq, stream, source, level, is_json, text, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        genId('cf'),
        this.runId,
        this.sessionId ?? null,
        frame.seq,
        frame.stream,
        frame.source,
        frame.level ?? null,
        frame.isJson ? 1 : 0,
        frame.text ?? null,
        frame.payload ? JSON.stringify(frame.payload) : null,
        frame.ts,
      );
    } catch {
      // graceful fallback
    }
  }
}

let activeRun: RunContext | null = null;

function endStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(resolve);
  });
}

export function startRun(command: string, level?: LogLevel, options?: Omit<RunContextOptions, 'level'>): RunContext {
  activeRun = new RunContext(command, { ...options, level });
  return activeRun;
}

export function getActiveRun(): RunContext | null {
  return activeRun;
}

export async function endRun(exitCode?: number): Promise<RunArtifact | null> {
  if (!activeRun) return null;
  const artifact = await activeRun.close(exitCode);
  activeRun = null;
  return artifact;
}
