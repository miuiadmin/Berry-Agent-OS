import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { PluginContext, PluginLogger, PluginStorage } from './sdk.js';

const moduleUrl = pathToFileURL(workerData.entryPath).href;
const mod = await import(moduleUrl);
const definition = mod.default ?? mod;
const tools: Record<string, Function> = definition.tools ?? {};

let requestCounter = 0;
const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function sendRequest(method: string, args: unknown[]): Promise<unknown> {
  const reqId = `wreq_${++requestCounter}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(reqId, { resolve, reject });
    parentPort!.postMessage({ type: 'ctx_request', reqId, method, args });
  });
}

function createProxyLogger(pluginName: string): PluginLogger {
  const log = (level: string) => (msg: string, data?: Record<string, unknown>) => {
    parentPort!.postMessage({ type: 'log', level, pluginName, msg, data });
  };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

function createProxyStorage(): PluginStorage {
  return {
    get: (key: string) => sendRequest('storage.get', [key]) as Promise<string | null>,
    set: (key: string, value: string) => sendRequest('storage.set', [key, value]) as Promise<void>,
    delete: (key: string) => sendRequest('storage.delete', [key]) as Promise<void>,
    list: (prefix?: string) => sendRequest('storage.list', [prefix]) as Promise<string[]>,
  };
}

async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  const result = await sendRequest('fetch', [url, init]) as {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  };
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

function createCodeContext(): PluginContext {
  return {
    pluginName: workerData.pluginName,
    toolName: '__code_exec__',
    log: createProxyLogger(workerData.pluginName),
    storage: createProxyStorage(),
    config: {},
    fetch: proxyFetch,
    emit: (event: string, payload: Record<string, unknown>) => {
      parentPort!.postMessage({ type: 'emit', event, payload, pluginName: workerData.pluginName });
    },
  };
}

parentPort!.on('message', async (msg: Record<string, unknown>) => {
  if (msg.type === 'exec') {
    const { id, toolName, input, config } = msg as {
      id: string;
      toolName: string;
      input: unknown;
      config: Record<string, unknown>;
    };
    try {
      if (toolName === '__code_exec__') {
        const handler = definition.default ?? definition;
        if (typeof handler !== 'function') throw new Error('Code facet requires a default export function');
        const result = await handler(input, createCodeContext());
        parentPort!.postMessage({ type: 'result', id, ok: true, output: result });
        return;
      }

      if (toolName === '__service_tick__') {
        if (typeof definition.onTick === 'function') {
          await definition.onTick();
        }
        parentPort!.postMessage({ type: 'result', id, ok: true, output: {} });
        return;
      }

      const handler = tools[toolName as string];
      if (!handler) throw new Error(`工具 ${toolName} 不存在`);

      const ctx: PluginContext = {
        pluginName: workerData.pluginName,
        toolName: toolName as string,
        log: createProxyLogger(workerData.pluginName),
        storage: createProxyStorage(),
        config: config ?? {},
        fetch: proxyFetch,
        emit: (event: string, payload: Record<string, unknown>) => {
          parentPort!.postMessage({ type: 'emit', event, payload, pluginName: workerData.pluginName });
        },
      };

      const result = await handler(input, ctx);
      parentPort!.postMessage({ type: 'result', id, ok: true, output: result });
    } catch (err) {
      parentPort!.postMessage({ type: 'result', id, ok: false, error: (err as Error).message });
    }
  } else if (msg.type === 'ctx_response') {
    const { reqId, result, error } = msg as { reqId: string; result: unknown; error?: string };
    const pending = pendingRequests.get(reqId);
    if (pending) {
      pendingRequests.delete(reqId);
      if (error) pending.reject(new Error(error));
      else pending.resolve(result);
    }
  }
});

if (definition.init) {
  await definition.init();
}

parentPort!.postMessage({ type: 'ready' });
