import { IpcChildChannel } from '../kernel/ipc.js';
import { initDb, getDb } from '../memory/index.js';
import { createLlmClient } from '../llm/index.js';
import { resolveConfig } from '../config/resolver.js';
import { getConfigPath } from '../utils/paths.js';
import { createProviderRegistry } from '../providers/registry.js';
import type { AppConfig } from '../contracts/config.js';
import type { LlmClient } from '../llm/index.js';
import type { Database } from 'better-sqlite3';

export interface ResidentAgentContext {
  name: string;
  config: AppConfig;
  ipc: IpcChildChannel;
  llm: LlmClient;
  db: Database;
}

export function startResidentAgent(setup: (ctx: ResidentAgentContext) => void): void {
  const name = process.env.AGENT_NAME;
  if (!name) throw new Error('AGENT_NAME 环境变量未设置');

  const config = resolveConfig(getConfigPath());
  initDb();
  const db = getDb();
  const ipc = new IpcChildChannel(name);
  const providerRegistry = createProviderRegistry(config.llm, config.llm.channelsConfig);
  const llm = createLlmClient(config.llm, { db, ipc, defaultAgent: name, providerRegistry: providerRegistry ?? undefined });

  ipc.send('agent.register', 'core', { name, pid: process.pid });

  const heartbeatInterval = setInterval(() => {
    ipc.send('agent.heartbeat', 'core', { name, uptime: process.uptime() });
  }, config.heartbeatIntervalMs);

  setup({ name, config, ipc, llm, db });

  const cleanup = () => {
    clearInterval(heartbeatInterval);
    ipc.destroy();
    process.exit(0);
  };

  ipc.onMessage('agent.shutdown', cleanup);
  process.on('SIGTERM', cleanup);

  process.on('uncaughtException', (err) => {
    process.stderr.write(`[${name}] uncaughtException: ${err?.message ?? err}\n`);
    cleanup();
  });

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[${name}] unhandledRejection: ${reason}\n`);
  });
}
