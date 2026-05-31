import { DaemonProcess } from './daemon-process.js';
import { DEFAULT_DAEMON_CONFIG, type DaemonConfig } from './config.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDaemonConfig(): DaemonConfig {
  if (process.env.DAEMON_CONFIG_JSON) {
    try {
      return { ...DEFAULT_DAEMON_CONFIG, ...JSON.parse(process.env.DAEMON_CONFIG_JSON) };
    } catch (err) {
      console.warn(`[daemon] Failed to parse DAEMON_CONFIG_JSON: ${err instanceof Error ? err.message : err}`);
    }
  }

  const configPath = process.env.DAEMON_CONFIG_PATH ?? resolve(process.env.HOME ?? '', '.berry', 'daemon.json');

  if (configPath && existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      return { ...DEFAULT_DAEMON_CONFIG, ...JSON.parse(raw) };
    } catch (err) {
      console.warn(`[daemon] Failed to load config from ${configPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return DEFAULT_DAEMON_CONFIG;
}

function getSocketPath(): string {
  return process.env.DAEMON_SOCKET_PATH ?? resolve(process.env.HOME ?? '', '.berry', 'run', 'agent.sock');
}

async function main(): Promise<void> {
  const config = loadDaemonConfig();
  const socketPath = getSocketPath();

  const daemon = new DaemonProcess(config, socketPath);

  process.on('SIGTERM', async () => {
    await daemon.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await daemon.stop();
    process.exit(0);
  });

  await daemon.start();
}

main().catch((err) => {
  process.stderr.write(`Daemon failed to start: ${err.message}\n`);
  process.exit(1);
});
