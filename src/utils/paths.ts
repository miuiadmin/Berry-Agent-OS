import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

let appHome = process.env.SERVICE_HOME ?? join(homedir(), '.agent-home');

export function getAppHome(): string {
  return appHome;
}

export function setAppHome(path: string): void {
  appHome = path;
}

export function getSocketPath(): string {
  return process.env.SERVICE_SOCKET_PATH ?? join(getAppHome(), 'run', 'agent.sock');
}

export function getPidPath(): string {
  return join(getAppHome(), 'run', 'agent.pid');
}

export function getWatchdogPidPath(): string {
  return join(getAppHome(), 'run', 'watchdog.pid');
}

export function getWatchdogStatePath(): string {
  return join(getAppHome(), 'run', 'watchdog-state.json');
}

export function getDbPath(): string {
  return join(getAppHome(), 'data', 'agent.db');
}

export function getLogDir(): string {
  return join(getAppHome(), 'logs');
}

export function getRunsDir(): string {
  return join(getAppHome(), 'runs');
}

export function getSkillsDir(): string {
  return join(getAppHome(), 'skills');
}

export function getPluginsDir(): string {
  return join(getAppHome(), 'plugins');
}

export function getEvolutionDir(): string {
  return join(getAppHome(), 'evolution');
}

export function getUserAgentsDir(): string {
  return join(getAppHome(), 'agents');
}

export function getConfigPath(): string {
  return join(getAppHome(), 'config.yaml');
}

export function ensureDirs(): void {
  mkdirSync(join(getAppHome(), 'run'), { recursive: true });
  mkdirSync(join(getAppHome(), 'data'), { recursive: true });
  mkdirSync(join(getAppHome(), 'logs'), { recursive: true });
  mkdirSync(join(getAppHome(), 'runs'), { recursive: true });
  mkdirSync(getSkillsDir(), { recursive: true });
  mkdirSync(getPluginsDir(), { recursive: true });
  mkdirSync(getEvolutionDir(), { recursive: true });
  mkdirSync(getUserAgentsDir(), { recursive: true });
}
