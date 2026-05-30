import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SocketServer } from './socket-server.js';

function createTempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'berry-socket-test-'));
  return join(dir, 'test.sock');
}

function sendRequest(socketPath: string, request: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(request) + '\n');
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk.toString(); });
    client.on('end', () => resolve(data));
    client.on('error', reject);
    setTimeout(() => { client.end(); resolve(data); }, 200);
  });
}

describe('SocketServer', () => {
  let server: SocketServer;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = createTempSocketPath();
    server = new SocketServer(socketPath);
  });

  afterEach(() => {
    server.stop();
  });

  it('starts listening and handles registered type', async () => {
    server.register('ping', (req, socket) => {
      socket.write(JSON.stringify({ pong: true }) + '\n');
    });
    await server.start();

    const response = await sendRequest(socketPath, { type: 'ping' });
    expect(JSON.parse(response.trim())).toEqual({ pong: true });
  });

  it('returns error for unknown request type', async () => {
    await server.start();

    const response = await sendRequest(socketPath, { type: 'nonexistent' });
    const parsed = JSON.parse(response.trim());
    expect(parsed.error).toBeTruthy();
  });

  it('handles invalid JSON gracefully', async () => {
    await server.start();

    const response = await new Promise<string>((resolve) => {
      const client = createConnection(socketPath, () => {
        client.write('not-json\n');
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk.toString(); });
      setTimeout(() => { client.end(); resolve(data); }, 200);
    });

    const parsed = JSON.parse(response.trim());
    expect(parsed.error).toBeTruthy();
  });

  it('stop cleans up socket file', async () => {
    await server.start();
    expect(existsSync(socketPath)).toBe(true);
    server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('passes request payload to handler', async () => {
    let received: any;
    server.register('echo', (req, socket) => {
      received = req;
      socket.write(JSON.stringify({ ok: true }) + '\n');
    });
    await server.start();

    await sendRequest(socketPath, { type: 'echo', data: 'hello' });
    expect(received).toEqual({ type: 'echo', data: 'hello' });
  });
});
