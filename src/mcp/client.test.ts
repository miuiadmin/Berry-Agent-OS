/**
 * L3 mcp 单元测试 — 单服务器连接生命周期（握手/发现/调用/关停/运行期退出）。
 *
 * 子进程 = PassThrough 流对假件（结构覆盖 SpawnedChild——注入面收窄的红利）；
 * 「服务器」= 脚本化应答器（读 child.stdin 行、往 child.stdout 写响应行）。
 * killTree 全程录制不真杀；协议层（JsonRpcConnection）全真。
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AppError, MCP_CONNECT_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { connectMcpServer, type McpConnectDeps, type SpawnedChild } from './client.js';
import type { McpServerConfig } from './types.js';

/* ---------------- 假子进程 + 脚本化服务器 ---------------- */

/** 脚本化 MCP 服务器（读请求行 / 写响应行的测试替身） */
interface FakeServer {
  child: SpawnedChild;
  /** 服务器侧看到的全部请求帧 */
  frames: Array<Record<string, unknown>>;
  /** 手工写一行到桥（服务器→客户端方向） */
  send: (obj: unknown) => void;
  /** 模拟子进程退出（可重复触发——dispose 竞速用）；stdout 只真关一次 */
  die: (code: number | null) => void;
  /** stderr 直写面（诊断日志路径用） */
  emitStderr: (chunk: string) => void;
  /** 标准应答器：initialize/tools-list/tools-call 自动响应（分页/错误/挂起可配） */
  auto: (opts?: { tools?: string[]; pageSize?: number; callError?: boolean; hangCalls?: boolean }) => void;
}

/** 造一台假子进程 + 应答器（spawnServer 闭包返回值） */
function makeFakeServer(pid = 4242): FakeServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('error', () => undefined); // 重复 end 的无害化（die 可多次触发）
  const closeCbs: Array<(code: number | null, signal: string | null) => void> = [];
  const frames: Array<Record<string, unknown>> = [];
  let stdoutEnded = false;
  const child: SpawnedChild = {
    pid,
    // PassThrough 是 Duplex——桥写来的行服务器侧可读；end 代理可被用例替换
    stdin: {
      write: (chunk: string) => stdin.write(chunk),
      end: () => stdin.end(),
      on: (_ev: 'error', _cb: (err: Error) => void) => undefined,
    },
    stdout,
    // stderr 假件真接线（client 的诊断订阅要收到数据）
    stderr: {
      on: (ev: 'data', cb: (chunk: Buffer | string) => void) => {
        stderr.on(ev, cb);
      },
    },
    on: (event: 'close', cb: (code: number | null, signal: string | null) => void) => {
      if (event === 'close') closeCbs.push(cb);
    },
  };
  /** 应答 result 帧的捷径（提升到闭包顶） */
  const sendResult = (id: unknown, result: unknown): void => {
    stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  // 服务器侧消费桥写来的每一行（帧记录 + auto 应答器共用监听）
  stdin.on('data', (chunk: Buffer | string) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() === '') continue;
      try {
        frames.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        /* 桥不发烂行——忽略 */
      }
    }
  });
  return {
    child,
    frames,
    send: (obj) => stdout.write(`${JSON.stringify(obj)}\n`),
    die: (code) => {
      if (!stdoutEnded) {
        stdoutEnded = true;
        stdout.end();
      }
      for (const cb of [...closeCbs]) cb(code, null);
    },
    emitStderr: (chunk) => stderr.write(chunk),
    /** 标准应答器：按帧 method 自动回包（默认零工具单页） */
    auto: (opts) => {
      const tools = opts?.tools ?? [];
      const pageSize = opts?.pageSize ?? 1000;
      stdin.on('data', (chunk: Buffer | string) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim() === '') continue;
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const id = frame['id'];
          if (id === undefined) continue; // 通知不答
          const method = String(frame['method'] ?? '');
          if (method === 'initialize') {
            sendResult(id, {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'fake', version: '0' },
            });
          } else if (method === 'tools/list') {
            const cursor = (frame['params'] as { cursor?: string } | undefined)?.cursor;
            const start = cursor === undefined ? 0 : Number(cursor);
            const page = tools.slice(start, start + pageSize).map((name) => ({ name, description: `工具 ${name}` }));
            const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
            sendResult(id, next === undefined ? { tools: page } : { tools: page, nextCursor: next });
          } else if (method === 'tools/call') {
            // callError：应答 JSON-RPC error 帧；hangCalls：不应答（挂到调用超时）
            if (opts?.hangCalls === true) continue;
            if (opts?.callError === true) {
              stdout.write(
                `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: '工具内部炸了' } })}\n`,
              );
              continue;
            }
            sendResult(id, { content: [{ type: 'text', text: `ran:${(frame['params'] as { name: string }).name}` }] });
          } else {
            sendResult(id, {});
          }
        }
      });
    },
  };
}

/** 最小服务器配置（绝对路径过关） */
const CONFIG: McpServerConfig = { command: '/usr/local/bin/fake-mcp' };

/** 依赖束工厂：killTree 录制不真杀；onSpawned 可选注入（spawn 即写钩子用例） */
function makeDeps(
  spawn: (config: McpServerConfig) => Promise<SpawnedChild>,
  onSpawned?: (childPid: number) => () => void,
) {
  const kills: Array<{ pid: number }> = [];
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const deps: McpConnectDeps = {
    spawnServer: spawn,
    killTree: (pid) => kills.push({ pid }),
    logger,
    ...(onSpawned === undefined ? {} : { onSpawned }),
  };
  return { deps, kills, logger };
}

describe('connectMcpServer — connect 期一码收口', () => {
  it('相对路径在 spawn 前拦下：MCP_CONNECT_FAILED 且零 spawn', async () => {
    let spawned = 0;
    const { deps } = makeDeps(async () => {
      spawned += 1;
      return makeFakeServer().child;
    });
    await expect(connectMcpServer('srv', { command: 'npx' }, deps)).rejects.toMatchObject({
      code: MCP_CONNECT_FAILED,
    });
    expect(spawned).toBe(0);
  });

  it('spawn 失败（ENOENT 等）→ MCP_CONNECT_FAILED，cause 保真', async () => {
    const { deps } = makeDeps(async () => {
      throw new Error('spawn ENOENT');
    });
    await expect(connectMcpServer('srv', CONFIG, deps)).rejects.toSatisfy((err: unknown) => {
      return err instanceof AppError && err.code === MCP_CONNECT_FAILED && String(err.message).includes('未启动');
    });
  });

  it('握手成功：initialize 帧形状正确 + initialized 通知已发', async () => {
    const server = makeFakeServer();
    server.auto();
    const { deps } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    expect(conn.server).toBe('srv');
    expect(conn.childPid).toBe(4242);
    const init = server.frames.find((f) => f['method'] === 'initialize');
    expect(init).toBeDefined();
    expect((init!['params'] as Record<string, unknown>)['protocolVersion']).toBe('2025-06-18');
    expect(server.frames.some((f) => f['method'] === 'notifications/initialized')).toBe(true);
    // 收尾：服务器自退 → dispose 即刻结算
    const p = conn.dispose();
    server.die(0);
    await p;
  });

  it('握手超时 → MCP_CONNECT_FAILED + 无条件树杀（不留挂起进程）', async () => {
    const server = makeFakeServer(); // 不装应答器——永不响应 initialize
    const { deps, kills } = makeDeps(async () => server.child);
    await expect(connectMcpServer('srv', { ...CONFIG, startup_timeout_sec: 0.01 }, deps)).rejects.toMatchObject({
      code: MCP_CONNECT_FAILED,
    });
    expect(kills).toEqual([{ pid: 4242 }]); // 无条件杀（F-2 修后守卫参数已退役）
  });

  it('spawn 即写钩子：spawn 返回 pid 的同步点调用，握手失败路对称撤销（遗漏大扫 20260902-b #7）', async () => {
    const server = makeFakeServer(); // 聋——initialize 永不应答
    const events: string[] = [];
    const { deps } = makeDeps(
      async () => server.child,
      (childPid) => {
        events.push(`add:${childPid}`);
        return () => events.push(`remove:${childPid}`);
      },
    );
    const pending = connectMcpServer('srv', { ...CONFIG, startup_timeout_sec: 0.2 }, deps);
    // 握手窗内（0.2s 超时未到）：钩子已 fired——登记先于握手完成（修前此面不存在）
    await vi.waitFor(() => expect(events).toEqual(['add:4242']));
    await expect(pending).rejects.toMatchObject({ code: MCP_CONNECT_FAILED });
    expect(events).toEqual(['add:4242', 'remove:4242']); // 失败路撤销面调用
  });

  it('握手收到服务器错误响应 → 包装为 MCP_CONNECT_FAILED + 树杀', async () => {
    const server = makeFakeServer();
    const { deps, kills } = makeDeps(async () => server.child);
    // connect 不 await——先等 initialize 帧到达，再以 error 应答
    const pending = connectMcpServer('srv', { ...CONFIG, startup_timeout_sec: 1 }, deps);
    await vi.waitFor(() => {
      expect(server.frames.some((f) => f['method'] === 'initialize')).toBe(true);
    });
    const init = server.frames.find((f) => f['method'] === 'initialize')!;
    server.send({ jsonrpc: '2.0', id: init['id'], error: { code: -32000, message: '初始化拒绝' } });
    await expect(pending).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === MCP_CONNECT_FAILED,
    );
    expect(kills).toEqual([{ pid: 4242 }]);
  });
});

describe('connectMcpServer — 发现与调用', () => {
  it('discover 跟 nextCursor 至尽（分页不丢工具）', async () => {
    const server = makeFakeServer();
    server.auto({ tools: ['a', 'b', 'c', 'd', 'e'], pageSize: 2 });
    const { deps } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    const tools = await conn.discover();
    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const p = conn.dispose();
    server.die(0);
    await p;
  });

  it('call：text 内容直取 + isError 透传', async () => {
    const server = makeFakeServer();
    server.auto({ tools: ['echo'] });
    const { deps } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    const out = await conn.call('echo', { x: 1 }, 1000);
    expect(out).toEqual({ text: 'ran:echo', isError: false });
    const p = conn.dispose();
    server.die(0);
    await p;
  });

  it('call 服务器 JSON-RPC error → 抛普通 Error（调用方转结果 error 不升 AppError）', async () => {
    const server = makeFakeServer();
    server.auto({ tools: ['boom'], callError: true });
    const { deps } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    const err: unknown = await conn.call('boom', {}, 1000).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
    const p = conn.dispose();
    server.die(0);
    await p;
  });

  it('call 超时 → AppError TOOL_TIMEOUT 且子进程不杀（契约篇 §6.6）', async () => {
    const server = makeFakeServer();
    // 握手/发现照常应答、tools/call 挂起不应答——超时腿触发
    server.auto({ tools: ['slow'], hangCalls: true });
    const { deps, kills } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    await expect(conn.call('slow', {}, 10)).rejects.toMatchObject({ code: TOOL_TIMEOUT });
    expect(kills).toEqual([]); // 超时不杀子进程
    const p = conn.dispose();
    server.die(0);
    await p;
  });

  it('非文本内容块计数注记（v1 只过文本）', async () => {
    const server = makeFakeServer();
    server.auto({ hangCalls: true }); // 调用挂起——手工应答混合内容
    const { deps } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    const pending = conn.call('img', {}, 1000);
    await vi.waitFor(() => {
      expect(server.frames.some((f) => f['method'] === 'tools/call')).toBe(true);
    });
    const call = server.frames.find((f) => f['method'] === 'tools/call')!;
    server.send({
      jsonrpc: '2.0',
      id: call['id'],
      result: {
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', data: '...' },
          { type: 'text', text: '第二段' },
        ],
      },
    });
    const out = await pending;
    expect(out.text).toBe('看图\n第二段\n（1 个非文本内容块未透传）');
    const p = conn.dispose();
    server.die(0);
    await p;
  });
});

describe('connectMcpServer — 运行期退出与关停', () => {
  it('运行期 close：pending 结清 + exitListeners 带归因触发 + 可退订', async () => {
    const server = makeFakeServer();
    server.auto({ hangCalls: true }); // 调用挂起等 close 结清
    const { deps } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    const exits: string[] = [];
    const off = conn.onExit((reason) => exits.push(reason));
    // 挂起一个调用后子进程死
    const pending = conn.call('slow', {}, 5000).then(
      () => undefined,
      (e: unknown) => e,
    );
    server.die(1);
    const err = await pending;
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(MCP_CONNECT_FAILED);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toContain('code=1');
    off();
    server.die(1); // 重复 close 不再触发已退订监听
    expect(exits).toHaveLength(1);
  });

  it('dispose：stdin 告别 → 子进程自退 → 宽限内即结算（不等 3s 树杀腿）', async () => {
    const server = makeFakeServer();
    server.auto();
    const { deps } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    // 服务器惯例：stdin 关即自退（替换 child.stdin.end 面拦截告别）
    const origEnd = server.child.stdin.end.bind(server.child.stdin);
    server.child.stdin.end = () => {
      origEnd();
      server.die(0);
    };
    const startedAt = Date.now();
    await conn.dispose();
    // 自退路径不等宽限（毫秒级结算；树杀腿的 3s 计时器被 clearTimeout）
    expect(Date.now() - startedAt).toBeLessThan(1500);
    // 收尾的幂等树杀仍会发（已退进程——真 killpg 打 ESRCH 内吞；假件只录调用）
    expect(deps.killTree).toBeDefined();
  });

  it('dispose 幂等（回卷与运行期退出竞速双调无害）', async () => {
    const server = makeFakeServer();
    server.auto();
    const { deps } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    const origEnd = server.child.stdin.end.bind(server.child.stdin);
    server.child.stdin.end = () => {
      origEnd();
      server.die(0);
    };
    await Promise.all([conn.dispose(), conn.dispose()]);
  });

  it('服务器不理告别：宽限到点树杀（假定时器快进）', async () => {
    vi.useFakeTimers();
    try {
      const server = makeFakeServer();
      server.auto(); // 握手要成——否则 connect 在假时钟下挂死
      const { deps, kills } = makeDeps(async () => server.child);
      const conn = await connectMcpServer('srv', { ...CONFIG, startup_timeout_sec: 1 }, deps);
      void conn.dispose();
      // 快进关停宽限 + 竞速余量——树杀腿触发
      await vi.advanceTimersByTimeAsync(3400);
      expect(kills.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stderr 行 → logger.debug（MCP 惯例日志不进上下文）', async () => {
    const server = makeFakeServer();
    server.auto();
    const { deps, logger } = makeDeps(async () => server.child);
    const conn = await connectMcpServer('srv', CONFIG, deps);
    server.emitStderr('server: ready\n');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('stderr'));
    const p = conn.dispose();
    server.die(0);
    await p;
  });
});
