import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeInfo } from '../contracts/daemon-protocol.js';

const execFileAsync = promisify(execFile);

interface RuntimeDetection {
  name: string;
  commands: string[];
  versionFlag?: string;
  capabilities: string[];
}

const KNOWN_RUNTIMES: RuntimeDetection[] = [
  {
    name: 'claude-code',
    commands: ['claude'],
    versionFlag: '--version',
    capabilities: ['streaming', 'session-resume', 'tool-use'],
  },
  {
    name: 'opencode',
    commands: ['opencode'],
    versionFlag: '--version',
    capabilities: ['streaming', 'tool-use'],
  },
];

export async function discoverRuntimes(overrides?: Record<string, { command?: string; enabled?: boolean }>): Promise<RuntimeInfo[]> {
  const results: RuntimeInfo[] = [];

  for (const rt of KNOWN_RUNTIMES) {
    const override = overrides?.[rt.name];
    if (override?.enabled === false) continue;

    const command = override?.command ?? await findCommand(rt.commands);
    if (!command) continue;

    const version = await detectVersion(command, rt.versionFlag);
    if (!version) continue;

    results.push({
      name: rt.name,
      version,
      command,
      capabilities: rt.capabilities,
    });
  }

  return results;
}

async function findCommand(candidates: string[]): Promise<string | null> {
  for (const cmd of candidates) {
    try {
      const { stdout } = await execFileAsync('which', [cmd], { timeout: 5000 });
      const path = stdout.trim();
      if (path) return path;
    } catch {
      // not found
    }
  }
  return null;
}

async function detectVersion(command: string, flag?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, [flag ?? '--version'], { timeout: 10_000 });
    const version = stdout.trim().split('\n')[0];
    return version || null;
  } catch {
    return null;
  }
}
