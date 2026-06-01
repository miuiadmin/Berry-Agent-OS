import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import type { Command } from 'commander';
import { getAppHome, getPidPath, getSocketPath, getWatchdogPidPath, getWatchdogStatePath, setAppHome } from '../utils/paths.js';
import { POLL_INTERVAL_MS, DRAIN_TIMEOUT_MS } from '../lib/time-constants.js';
import { getConsoleRenderer } from '../observability/console.js';

export function registerServiceCommands(program: Command): void {
  const service = program.command('service').description('管理 Berry 后台服务');

  service
    .command('start')
    .description('启动 Berry 服务')
    .option('--test', '测试模式（使用 mock LLM，临时数据目录）')
    .option('--foreground', '前台运行（不 detach）')
    .option('--data-dir <path>', '覆盖 SERVICE_HOME 数据目录')
    .option('--socket <path>', '覆盖 socket 路径')
    .option('--log-level <level>', '日志级别 (error|warn|info|debug)', 'info')
    .option('--debug', 'debug 模式（等价于 --log-level debug）')
    .option('--port <number>', '覆盖 Web API 端口（默认 3888）')
    .option('--host <addr>', '覆盖 Web 绑定地址（默认 127.0.0.1）')
    .option('--json', '以 JSON 格式输出启动信息')
    .action(async (opts: { test?: boolean; foreground?: boolean; dataDir?: string; socket?: string; logLevel?: string; debug?: boolean; port?: number; host?: string; json?: boolean }) => {
      const effectiveLogLevel = opts.debug ? 'debug' : (opts.logLevel ?? 'info');
      process.env.APP_CLI_LOG_LEVEL = effectiveLogLevel;
      if (opts.port) process.env.APP_PORT = String(opts.port);
      if (opts.host) process.env.APP_HOST = opts.host;

      const renderer = getConsoleRenderer();
      if (opts.json) renderer.setMode('json');

      if (!opts.json) {
        renderer.info(`日志级别: ${effectiveLogLevel}`);
      }
      const env = buildServiceEnv(opts);
      applyServiceEnvToCurrentProcess(env);
      const appHome = env.SERVICE_HOME ?? getAppHome();

      if (opts.test && !opts.json) {
        renderer.info(`测试模式: 数据目录 ${appHome}`);
      }

      if (opts.foreground) {
        process.env.APP_TERMINAL_MODE = 'human';
        const { CoreService } = await import('../kernel/core-service.js');
        const coreService = new CoreService();

        process.on('SIGTERM', async () => { await coreService.stop(); process.exit(0); });
        process.on('SIGINT', async () => { await coreService.stop(); process.exit(0); });

        await coreService.start();
        writeServiceStartResult(renderer, {
          ok: true,
          mode: 'foreground',
          pid: process.pid,
          appHome,
          socketPath: env.SERVICE_SOCKET_PATH ?? getSocketPath(),
          test: opts.test === true,
        }, opts.json === true);
        return;
      }

      // 检查是否已在运行（优先检查看护进程 PID）
      const watchdogPidPath = getWatchdogPidPath();
      if (existsSync(watchdogPidPath)) {
        const wPid = parseInt(readFileSync(watchdogPidPath, 'utf-8').trim(), 10);
        try {
          process.kill(wPid, 0);
          writeServiceStartResult(renderer, {
            ok: true,
            mode: 'detached',
            alreadyRunning: true,
            pid: wPid,
            appHome,
            socketPath: env.SERVICE_SOCKET_PATH ?? getSocketPath(),
            test: opts.test === true,
          }, opts.json === true);
          return;
        } catch {
          unlinkSync(watchdogPidPath);
        }
      }

      // 兼容：检查旧版（无看护进程）的 PID 文件
      const pidPath = getPidPath();
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
        try {
          process.kill(pid, 0);
          writeServiceStartResult(renderer, {
            ok: true,
            mode: 'detached',
            alreadyRunning: true,
            pid,
            appHome,
            socketPath: env.SERVICE_SOCKET_PATH ?? getSocketPath(),
            test: opts.test === true,
          }, opts.json === true);
          return;
        } catch {
          unlinkSync(pidPath);
        }
      }

      // 启动看护进程（双重 detach）
      const currentFile = fileURLToPath(import.meta.url);
      const entryScript = resolve(dirname(currentFile), '..', 'index.js');

      const isTsx = currentFile.endsWith('.ts');
      const execPath = isTsx
        ? resolve(dirname(currentFile), '..', '..', 'node_modules', '.bin', 'tsx')
        : 'node';

      const watchdogEnv = {
        ...env,
        __WATCHDOG_MODE: '1',
      };

      const child = spawn(execPath, [entryScript], {
        detached: true,
        stdio: 'ignore',
        env: watchdogEnv,
      });

      child.unref();
      writeServiceStartResult(renderer, {
        ok: true,
        mode: 'detached',
        pid: child.pid ?? null,
        appHome,
        socketPath: env.SERVICE_SOCKET_PATH ?? getSocketPath(),
        test: opts.test === true,
      }, opts.json === true);
    });

  service
    .command('stop')
    .description('停止 Berry 服务')
    .action(async () => {
      const renderer = getConsoleRenderer();

      // 优先停止看护进程（它会转发 SIGTERM 给 CoreService）
      const watchdogPidPath = getWatchdogPidPath();
      if (existsSync(watchdogPidPath)) {
        const wPid = parseInt(readFileSync(watchdogPidPath, 'utf-8').trim(), 10);
        try {
          process.kill(wPid, 'SIGTERM');
          renderer.info(`正在停止看护进程 (PID: ${wPid})...`);
          // 验证进程实际退出
          let waited = 0;
          while (waited < 10_000) {
            try {
              process.kill(wPid, 0);
              await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
              waited += POLL_INTERVAL_MS;
            } catch {
              renderer.info('服务已停止');
              return;
            }
          }
          renderer.warn('看护进程未在超时内退出，可能需要手动清理');
        } catch {
          unlinkSync(watchdogPidPath);
          renderer.info('看护进程未在运行（PID 文件已过期）');
        }
        return;
      }

      // 兼容旧版：直接停 CoreService
      const pidPath = getPidPath();
      if (!existsSync(pidPath)) {
        renderer.info('Berry 服务未在运行');
        return;
      }

      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      try {
        process.kill(pid, 'SIGTERM');
        renderer.info(`正在停止 Berry 服务 (PID: ${pid})...`);
        await new Promise(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS));
        renderer.info('Berry 服务已停止');
      } catch {
        renderer.info('Berry 服务未在运行（PID 文件已过期）');
        unlinkSync(pidPath);
      }
    });

  service
    .command('status')
    .description('查看 Berry 服务状态')
    .option('--json', '以 JSON 格式输出')
    .action(async (opts) => {
      const renderer = getConsoleRenderer();
      const socketPath = getSocketPath();
      if (!existsSync(socketPath)) {
        if (opts.json) {
          renderer.json({ running: false });
        } else {
          renderer.info('Berry 服务未在运行');
        }
        return;
      }

      try {
        const response = await socketRequest(socketPath, { type: 'status' });
        if (opts.json) {
          renderer.json({ running: true, ...response });
        } else {
          renderer.info('Berry 服务运行中');
          // 显示看护进程信息
          const statePath = getWatchdogStatePath();
          if (existsSync(statePath)) {
            try {
              const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { pid: number; childPid: number | null; restartCount: number; startedAt: string };
              const uptime = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000);
              const minutes = Math.floor(uptime / 60);
              const seconds = uptime % 60;
              renderer.info(`  看护进程: PID ${state.pid}，运行 ${minutes}m${seconds}s，重启 ${state.restartCount} 次`);
            } catch { /* ignore */ }
          }
          if (response.status) {
            for (const [name, info] of Object.entries(response.status as Record<string, { status: string; pid: number }>)) {
              renderer.info(`  ${name}: ${info.status} (PID: ${info.pid})`);
            }
          }
        }
      } catch {
        if (opts.json) {
          renderer.json({ running: false });
        } else {
          renderer.info('Berry 服务未响应');
        }
      }
    });
}

export interface ServiceStartOptions {
  test?: boolean;
  foreground?: boolean;
  dataDir?: string;
  socket?: string;
  logLevel?: string;
  debug?: boolean;
  port?: number;
  host?: string;
  json?: boolean;
}

export interface ServiceStartResult {
  ok: boolean;
  mode: 'foreground' | 'detached';
  pid: number | null;
  appHome: string;
  socketPath: string;
  test: boolean;
  alreadyRunning?: boolean;
}

export function buildServiceEnv(opts: ServiceStartOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (opts.dataDir) {
    env.SERVICE_HOME = opts.dataDir;
  }
  if (opts.socket) {
    env.SERVICE_SOCKET_PATH = opts.socket;
  }
  if (opts.test) {
    env.APP_LLM_MODE = 'mock';
    if (!opts.dataDir) {
      env.SERVICE_HOME = mkdtempSync(join(tmpdir(), 'agent-test-'));
    }
  }
  if (opts.port) {
    env.APP_PORT = String(opts.port);
  }
  if (opts.host) {
    env.APP_HOST = opts.host;
  }

  return env;
}

export function applyServiceEnvToCurrentProcess(env: NodeJS.ProcessEnv): void {
  if (env.SERVICE_HOME) {
    process.env.SERVICE_HOME = env.SERVICE_HOME;
    setAppHome(env.SERVICE_HOME);
  }
  if (env.SERVICE_SOCKET_PATH) {
    process.env.SERVICE_SOCKET_PATH = env.SERVICE_SOCKET_PATH;
  } else {
    delete process.env.SERVICE_SOCKET_PATH;
  }
  if (env.APP_LLM_MODE) {
    process.env.APP_LLM_MODE = env.APP_LLM_MODE;
  }
  if (env.APP_PORT) {
    process.env.APP_PORT = env.APP_PORT;
  }
  if (env.APP_HOST) {
    process.env.APP_HOST = env.APP_HOST;
  }
}

function writeServiceStartResult(
  renderer: ReturnType<typeof getConsoleRenderer>,
  result: ServiceStartResult,
  json: boolean,
): void {
  if (json) {
    renderer.json(result);
    return;
  }

  if (result.alreadyRunning) {
    renderer.info(`Berry 服务已在运行中 (PID: ${result.pid})`);
    return;
  }

  if (result.mode === 'foreground') {
    // TerminalRenderer handles output in foreground mode
  } else {
    renderer.info(`Berry 服务启动中 (PID: ${result.pid})`);
  }
}

export function socketRequest(socketPath: string, data: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(data) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            socket.end();
            resolve(JSON.parse(line));
          } catch (e) {
            reject(e);
          }
          return;
        }
      }
    });

    socket.on('error', reject);
    socket.setTimeout(120000, () => {
      socket.destroy();
      reject(new Error('Socket timeout'));
    });
  });
}

export async function ensureServiceRunning(): Promise<void> {
  const socketPath = getSocketPath();
  if (existsSync(socketPath)) {
    try {
      await socketRequest(socketPath, { type: 'health' });
      return;
    } catch {
      // socket exists but not responding, start service
    }
  }

  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      await waitForSocket(socketPath, 5000);
      return;
    } catch {
      unlinkSync(pidPath);
    }
  }

  const currentFile = fileURLToPath(import.meta.url);
  const ext = currentFile.endsWith('.ts') ? '.ts' : '.js';
  const coreScript = resolve(dirname(currentFile), '..', 'kernel', `core-service${ext}`);

  const isTsx = ext === '.ts';
  const execPath = isTsx
    ? resolve(dirname(currentFile), '..', '..', 'node_modules', '.bin', 'tsx')
    : 'node';

  const child = spawn(execPath, [coreScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  await waitForSocket(socketPath, 10000);
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(socketPath)) {
      try {
        await socketRequest(socketPath, { type: 'health' });
        return;
      } catch {
        // not ready yet
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('服务启动超时');
}
