import type { OutputMode } from './types.js';
import type { RunContext } from './artifacts.js';
import { redact } from './redaction.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LS_RE = new RegExp(LS, 'g');
const PS_RE = new RegExp(PS, 'g');

export class ConsoleRenderer {
  private mode: OutputMode;
  private runContext: RunContext | null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerText = '';
  private spinnerFrame = 0;
  private static SPINNER_CHARS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(options?: { mode?: OutputMode; runContext?: RunContext | null }) {
    this.mode = options?.mode ?? 'human';
    this.runContext = options?.runContext ?? null;
  }

  spinner(text: string): void {
    if (this.mode !== 'human' || !process.stderr.isTTY) {
      this.rawWrite('stderr', text + '\n');
      return;
    }
    this.spinnerText = text;
    if (this.spinnerTimer) return;
    this.spinnerFrame = 0;
    this.spinnerTimer = setInterval(() => {
      const char = ConsoleRenderer.SPINNER_CHARS[this.spinnerFrame % ConsoleRenderer.SPINNER_CHARS.length];
      process.stderr.write(`\r\x1b[K${char} ${this.spinnerText}`);
      this.spinnerFrame++;
    }, 80);
  }

  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      if (process.stderr.isTTY) {
        process.stderr.write('\r\x1b[K');
      }
    }
  }

  info(message: string): void {
    if (this.mode === 'human') {
      this.rawWrite('stdout', message + '\n');
    } else {
      this.rawWrite('stderr', message + '\n');
    }
  }

  success(message: string): void {
    if (this.mode === 'human') {
      this.rawWrite('stdout', message + '\n');
    } else {
      this.rawWrite('stderr', message + '\n');
    }
  }

  error(message: string): void {
    this.rawWrite('stderr', message + '\n');
  }

  warn(message: string): void {
    this.rawWrite('stderr', message + '\n');
  }

  json(data: unknown): void {
    const safe = redact(data);
    this.rawWrite('stdout', JSON.stringify(safe) + '\n');
  }

  jsonlEvent(event: unknown): void {
    const safe = redact(event);
    const line = JSON.stringify(safe)
      .replace(LS_RE, '\\u2028')
      .replace(PS_RE, '\\u2029');
    this.rawWrite('stdout', line + '\n');
  }

  write(stream: 'stdout' | 'stderr', text: string): void {
    this.rawWrite(stream, text);
  }

  setMode(mode: OutputMode): void {
    this.mode = mode;
  }

  getMode(): OutputMode {
    return this.mode;
  }

  attachRun(run: RunContext): void {
    this.runContext = run;
  }

  private rawWrite(stream: 'stdout' | 'stderr', text: string): void {
    if (stream === 'stdout') {
      process.stdout.write(text);
    } else {
      process.stderr.write(text);
    }
    this.runContext?.writeConsole(stream, text);
  }
}

let renderer: ConsoleRenderer | null = null;

export function initConsoleRenderer(options?: ConstructorParameters<typeof ConsoleRenderer>[0]): ConsoleRenderer {
  renderer = new ConsoleRenderer(options);
  return renderer;
}

export function getConsoleRenderer(): ConsoleRenderer {
  if (!renderer) {
    renderer = new ConsoleRenderer();
  }
  return renderer;
}
