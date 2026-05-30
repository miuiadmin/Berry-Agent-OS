import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { EventBus } from '../contracts/infrastructure.js';
import { SqlitePluginStorage } from './storage.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { metrics } from '../observability/metrics.js';

const logger = getLogger('plugin-worker');
const WORKER_HOST = resolve(dirname(fileURLToPath(import.meta.url)), 'worker-host.js');

export interface IsolatedPluginExecutorDeps {
  db?: Database;
  eventBus?: EventBus;
  allowedHosts?: string[];
  pluginsDir?: string;
}

export class IsolatedPluginExecutor {
  private workers = new Map<string, Worker>();
  private deps: IsolatedPluginExecutorDeps;

  constructor(deps?: IsolatedPluginExecutorDeps) {
    this.deps = deps ?? {};
  }

  async spawn(pluginName: string, entryPath: string): Promise<void> {
    if (this.workers.has(pluginName)) return;
    this.validateEntryPath(entryPath, pluginName);

    const worker = new Worker(WORKER_HOST, {
      workerData: { entryPath, pluginName },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });

    this.setupContextProxy(worker, pluginName);

    await new Promise<void>((resolve, reject) => {
      worker.once('message', (msg) => {
        if (msg.type === 'ready') resolve();
      });
      worker.once('error', reject);
    });
    this.workers.set(pluginName, worker);
    logger.info({ pluginName }, '插件 Worker 已启动');
  }

  async execute(
    pluginName: string,
    toolName: string,
    input: unknown,
    timeoutMs = 30000,
    config?: Record<string, unknown>,
  ): Promise<{ ok: boolean; output?: unknown; error?: string }> {
    const worker = this.workers.get(pluginName);
    if (!worker) return { ok: false, error: '插件未加载' };

    const id = genId('wexec');
    const t0 = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.terminate();
        this.workers.delete(pluginName);
        const durationMs = Date.now() - t0;
        metrics.counter('plugin_executions_total').inc({ plugin: pluginName, status: 'timeout' });
        metrics.histogram('plugin_execution_duration_ms').observe(durationMs, { plugin: pluginName });
        logger.warn({ pluginName, toolName, durationMs }, '插件执行超时，已终止 Worker');
        resolve({ ok: false, error: '插件执行超时' });
      }, timeoutMs);

      const handler = (msg: { type: string; id: string; ok: boolean; output?: unknown; error?: string }) => {
        if (msg.type !== 'result' || msg.id !== id) return;
        clearTimeout(timer);
        worker.off('message', handler);
        const durationMs = Date.now() - t0;
        const status = msg.ok ? 'ok' : 'error';
        metrics.counter('plugin_executions_total').inc({ plugin: pluginName, status });
        metrics.histogram('plugin_execution_duration_ms').observe(durationMs, { plugin: pluginName });
        resolve(msg.ok ? { ok: true, output: msg.output } : { ok: false, error: msg.error });
      };
      worker.on('message', handler);
      worker.postMessage({ type: 'exec', id, toolName, input, config: config ?? {} });
    });
  }

  async terminate(pluginName: string): Promise<void> {
    const worker = this.workers.get(pluginName);
    if (!worker) return;
    await worker.terminate();
    this.workers.delete(pluginName);
  }

  async terminateAll(): Promise<void> {
    for (const [, w] of this.workers) await w.terminate();
    this.workers.clear();
  }

  private setupContextProxy(worker: Worker, pluginName: string): void {
    worker.on('message', async (msg: Record<string, unknown>) => {
      if (msg.type === 'ctx_request') {
        const { reqId, method, args } = msg as { reqId: string; method: string; args: unknown[] };
        try {
          const result = await this.handleContextRequest(pluginName, method, args);
          worker.postMessage({ type: 'ctx_response', reqId, result });
        } catch (err) {
          worker.postMessage({ type: 'ctx_response', reqId, error: (err as Error).message });
        }
      } else if (msg.type === 'log') {
        const { level, msg: logMsg, data } = msg as { level: string; msg: string; data?: Record<string, unknown> };
        logger[level as 'debug' | 'info' | 'warn' | 'error']?.({ plugin: pluginName, ...data }, logMsg as string);
      } else if (msg.type === 'emit') {
        const { event, payload } = msg as { event: string; payload: Record<string, unknown> };
        this.deps.eventBus?.emit(`plugin.${pluginName}.${event}` as never, payload as never);
      }
    });
  }

  private async handleContextRequest(pluginName: string, method: string, args: unknown[]): Promise<unknown> {
    if (method.startsWith('storage.')) {
      if (!this.deps.db) throw new Error('Storage not available');
      const storage = new SqlitePluginStorage(this.deps.db, pluginName);
      const op = method.slice('storage.'.length);
      switch (op) {
        case 'get': return storage.get(args[0] as string);
        case 'set': return storage.set(args[0] as string, args[1] as string);
        case 'delete': return storage.delete(args[0] as string);
        case 'list': return storage.list(args[0] as string | undefined);
        default: throw new Error(`Unknown storage op: ${op}`);
      }
    }

    if (method === 'fetch') {
      const [url, init] = args as [string, RequestInit | undefined];
      this.validateFetchUrl(url);
      const response = await fetch(url, init);
      const body = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    }

    throw new Error(`Unknown context method: ${method}`);
  }

  private validateFetchUrl(url: string): void {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`不允许的协议: ${parsed.protocol}`);
    }
    if (this.deps.allowedHosts && this.deps.allowedHosts.length > 0) {
      if (!this.deps.allowedHosts.includes(parsed.hostname)) {
        throw new Error(`不允许的域名: ${parsed.hostname}`);
      }
    }
  }

  private validateEntryPath(entryPath: string, pluginName: string): void {
    if (!isAbsolute(entryPath)) {
      throw new Error(`插件入口路径必须为绝对路径: ${pluginName}`);
    }
    if (this.deps.pluginsDir) {
      const rel = relative(this.deps.pluginsDir, entryPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`插件入口路径越界: ${pluginName} (${entryPath} 不在 ${this.deps.pluginsDir} 下)`);
      }
    }
  }
}
