import { app, BrowserWindow, shell } from 'electron';
import { join } from 'path';
import { fork, type ChildProcess } from 'child_process';
import { is } from '@electron-toolkit/utils';
import { registerIpcHandlers } from './ipc/index.js';

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

function getDbPath(): string {
  const userDataPath = app.getPath('userData');
  return join(userDataPath, 'platform.db');
}

function findSystemNode(): string {
  const paths = ['/opt/homebrew/opt/node@22/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const p of paths) {
    try {
      require('fs').accessSync(p);
      return p;
    } catch { /* skip */ }
  }
  return 'node';
}

function startServerProcess(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverEntry = is.dev
      ? join(__dirname, '../../src/server/standalone.ts')
      : join(__dirname, '../../dist/server/standalone.js');

    const execArgv = is.dev ? ['--import', 'tsx'] : [];

    serverProcess = fork(serverEntry, [getDbPath()], {
      execPath: findSystemNode(),
      execArgv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    serverProcess.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && 'type' in msg && (msg as { type: string }).type === 'ready') {
        resolve();
      }
    });

    serverProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`[server] ${data.toString().trim()}`);
      if (data.toString().includes('listening')) {
        resolve();
      }
    });

    serverProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`[server] ${data.toString().trim()}`);
    });

    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Server process exited with code ${code}`));
      }
    });

    setTimeout(() => resolve(), 3000);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  await startServerProcess();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  serverProcess?.kill();
});
