import type { NormalizedExternalEvent } from '../../contracts/daemon-events.js';
import type { DaemonTaskInput } from '../../contracts/daemon-protocol.js';

export interface RuntimeAdapter {
  readonly name: string;

  buildCommand(input: DaemonTaskInput): CommandSpec;

  parseLine(line: string): NormalizedExternalEvent | NormalizedExternalEvent[] | null;

  extractSessionId(): string | undefined;
}

export interface CommandSpec {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}
