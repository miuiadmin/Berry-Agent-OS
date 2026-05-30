import { ipcMain } from 'electron';

const SERVER_URL = 'http://localhost:3721';

export function registerIpcHandlers() {
  ipcMain.handle('api:request', async (_event, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  });

  ipcMain.handle('api:health', async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`);
      return await res.json();
    } catch {
      return { ok: false, error: 'Server unreachable' };
    }
  });
}
