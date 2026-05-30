import { getConsoleRenderer } from '../observability/console.js';

export interface CapturedOutput {
  stream: 'stdout' | 'stderr';
  text: string;
  ts: number;
}

export class ConsoleCapture {
  private entries: CapturedOutput[] = [];
  private startTime = Date.now();

  install(): void {
    getConsoleRenderer().attachRun({
      writeConsole: (stream: string, text: string) => {
        this.entries.push({
          stream: stream as 'stdout' | 'stderr',
          text,
          ts: Date.now() - this.startTime,
        });
      },
    } as any);
  }

  uninstall(): void {
    getConsoleRenderer().attachRun(null as any);
  }

  getAll(): CapturedOutput[] {
    return this.entries;
  }

  getStdout(): string {
    return this.entries.filter(e => e.stream === 'stdout').map(e => e.text).join('');
  }

  getStderr(): string {
    return this.entries.filter(e => e.stream === 'stderr').map(e => e.text).join('');
  }

  assertContains(text: string, stream?: 'stdout' | 'stderr'): void {
    const content = stream
      ? this.entries.filter(e => e.stream === stream).map(e => e.text).join('')
      : this.getStdout() + this.getStderr();
    if (!content.includes(text)) {
      throw new Error(`Console output${stream ? ` (${stream})` : ''} does not contain "${text}"`);
    }
  }

  assertNotContains(text: string, stream?: 'stdout' | 'stderr'): void {
    const content = stream
      ? this.entries.filter(e => e.stream === stream).map(e => e.text).join('')
      : this.getStdout() + this.getStderr();
    if (content.includes(text)) {
      throw new Error(`Console output${stream ? ` (${stream})` : ''} unexpectedly contains "${text}"`);
    }
  }

  reset(): void {
    this.entries.length = 0;
    this.startTime = Date.now();
  }
}
