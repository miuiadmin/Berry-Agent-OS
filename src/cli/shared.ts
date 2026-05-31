import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { initDb, closeDb, getDb } from '../memory/index.js';
import { getDbPath } from '../utils/paths.js';
import { getConsoleRenderer } from '../observability/console.js';

export function socketRequest(socketPath: string, data: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify(data) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split('\n').find((item) => item.trim());
      if (!line) return;
      socket.end();
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    socket.on('error', reject);
    socket.on('end', () => {
      if (!buffer.trim()) reject(new Error('服务未返回数据'));
    });
    socket.setTimeout(120000, () => {
      socket.destroy();
      reject(new Error('Socket timeout'));
    });
  });
}

export function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  if (!existsSync(getDbPath())) initDb(getDbPath());
  else initDb();
  try {
    return fn(getDb());
  } finally {
    closeDb();
  }
}

export function writeOutput(isJson: boolean, payload: unknown, humanMessage: string): void {
  const renderer = getConsoleRenderer();
  if (isJson) renderer.json(payload);
  else renderer.info(humanMessage);
}
