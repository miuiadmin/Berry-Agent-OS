import type { RunContext } from './artifacts.js';
import { redact } from './redaction.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LS_RE = new RegExp(LS, 'g');
const PS_RE = new RegExp(PS, 'g');

export function safeStringify(value: unknown): string {
  const safe = redact(value);
  return JSON.stringify(safe)
    .replace(LS_RE, '\\u2028')
    .replace(PS_RE, '\\u2029');
}

export function stdoutGuard(): () => void {
  const originalWrite = process.stdout.write.bind(process.stdout);

  const patched = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (isJsonLine(trimmed)) {
        originalWrite(line + '\n');
      } else {
        process.stderr.write(`[stdout-guard] ${line}\n`);
      }
    }

    if (typeof encodingOrCb === 'function') encodingOrCb();
    else if (cb) cb();
    return true;
  } as typeof process.stdout.write;

  process.stdout.write = patched;

  return () => {
    process.stdout.write = originalWrite;
  };
}

export function installCapture(run: RunContext): () => void {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    run.writeConsole('stdout', text);
    return originalStdoutWrite(chunk, encodingOrCb as BufferEncoding, cb);
  } as typeof process.stdout.write;

  process.stderr.write = function (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    run.writeConsole('stderr', text);
    return originalStderrWrite(chunk, encodingOrCb as BufferEncoding, cb);
  } as typeof process.stderr.write;

  return () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  };
}

function isJsonLine(line: string): boolean {
  if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
