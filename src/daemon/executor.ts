import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RuntimeAdapter } from './adapters/types.js';
import type { NormalizedExternalEvent } from '../contracts/daemon-events.js';
import type { DaemonTaskInput } from '../contracts/daemon-protocol.js';
import { killProcessSafely } from '../lib/process-utils.js';

export interface ExecutionResult {
  ok: boolean;
  output: string;
  error?: string;
  sessionId?: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  durationMs: number;
  toolCallCount: number;
}

export type ProgressCallback = (event: NormalizedExternalEvent) => void;

export class Executor {
  private adapter: RuntimeAdapter;
  private process: ChildProcess | null = null;
  private abortController: AbortController;

  constructor(adapter: RuntimeAdapter) {
    this.adapter = adapter;
    this.abortController = new AbortController();
  }

  async execute(input: DaemonTaskInput, onProgress: ProgressCallback, timeoutMs: number): Promise<ExecutionResult> {
    const startTime = Date.now();
    const spec = this.adapter.buildCommand(input);

    const env = { ...process.env, ...spec.env };
    const child = spawn(spec.cmd, spec.args, {
      cwd: input.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: this.abortController.signal,
    });
    this.process = child;

    let output = '';
    let toolCallCount = 0;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let lastError: string | undefined;
    let timedOut = false;
    const stderrChunks: string[] = [];

    const timeout = setTimeout(() => {
      timedOut = true;
      this.cancel('timeout');
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrChunks.length < 50) {
        stderrChunks.push(chunk.toString());
      }
    });

    child.on('error', (err) => {
      if (!lastError) lastError = err.message;
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('error', (err) => {
      if (!lastError) lastError = err.message;
    });

    try {
      for await (const line of rl) {
        const parsed = this.adapter.parseLine(line);
        if (!parsed) continue;

        const events = Array.isArray(parsed) ? parsed : [parsed];
        for (const event of events) {
          onProgress(event);

          switch (event.data.kind) {
            case 'text':
              output += event.data.text;
              break;
            case 'tool_call':
              toolCallCount++;
              break;
            case 'usage':
              if (event.data.inputTokens >= 0 && event.data.inputTokens <= 10_000_000) {
                usage.inputTokens += event.data.inputTokens;
              }
              if (event.data.outputTokens >= 0 && event.data.outputTokens <= 10_000_000) {
                usage.outputTokens += event.data.outputTokens;
              }
              usage.cacheReadTokens += Math.max(0, Math.min(event.data.cacheReadTokens ?? 0, 10_000_000));
              usage.cacheWriteTokens += Math.max(0, Math.min(event.data.cacheWriteTokens ?? 0, 10_000_000));
              break;
            case 'error':
              lastError = event.data.message;
              break;
            case 'completion':
              if (event.data.text) output = event.data.text;
              break;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      rl.close();
      child.stderr?.removeAllListeners();
      child.removeAllListeners('error');
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
      } else {
        child.once('exit', (code) => resolve(code));
      }
    });

    this.process = null;
    const durationMs = Date.now() - startTime;
    const sessionId = this.adapter.extractSessionId();

    const ok = exitCode === 0 && !lastError && !timedOut;

    let error: string | undefined;
    if (timedOut) {
      error = `Task timed out after ${Math.round(durationMs / 1000)}s`;
    } else if (lastError) {
      error = lastError;
    } else if (exitCode !== 0) {
      const stderr = stderrChunks.join('').trim();
      error = stderr
        ? `Process exited with code ${exitCode}: ${stderr.slice(0, 500)}`
        : `Process exited with code ${exitCode}`;
    }

    return {
      ok,
      output,
      error,
      sessionId,
      usage,
      durationMs,
      toolCallCount,
    };
  }

  cancel(reason?: string): void {
    this.abortController.abort(reason);
    if (this.process && !this.process.killed) {
      killProcessSafely(this.process.pid!, 'SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          killProcessSafely(this.process.pid!, 'SIGKILL');
        }
      }, 5000);
    }
  }

  get pid(): number | undefined {
    return this.process?.pid ?? undefined;
  }
}
