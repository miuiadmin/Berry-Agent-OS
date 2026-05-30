import type { RuntimeAdapter } from './types.js';
import { ClaudeAdapter } from './claude-adapter.js';
import { OpenCodeAdapter } from './opencode-adapter.js';

const adapters = new Map<string, new (command: string) => RuntimeAdapter>();

adapters.set('claude-code', ClaudeAdapter);
adapters.set('opencode', OpenCodeAdapter);

export function createAdapter(runtimeName: string, command: string): RuntimeAdapter {
  const Ctor = adapters.get(runtimeName);
  if (!Ctor) {
    throw new Error(`No adapter registered for runtime: ${runtimeName}`);
  }
  return new Ctor(command);
}

export function listSupportedRuntimes(): string[] {
  return [...adapters.keys()];
}
