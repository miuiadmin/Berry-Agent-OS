/**
 * L3 lsp 单元测试 — 单服务器连接生命周期（握手/文档同步/诊断等待/关停/崩溃）。
 *
 * 子进程 = PassThrough 流对假件（结构覆盖 SpawnedProcess）；桥 = 本地假桥
 * （实现 JsonRpcLike——本模块测试不 import mcp；真桥协议面由 mcp/jsonrpc.test
 * 覆盖，帧层由 framing.test 覆盖，此处验证 client 的接线与语义）；「服务器」
 * = 脚本化应答器（Content-Length 帧收发——真帧层参与解码）。
 *
 * 时钟敏感用例（诊断等待竞速/握手超时）用真实短超时（50-300ms 级）——只断言
 * 结算值与次序，不碰 Date.now 断言形态。
 */

import { PassThrough } from 'node:stream';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, LSP_CONNECT_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { connectLspServer, type JsonRpcLike, type LspConnectDeps, type SpawnedProcess } from './client.js';
import { createFrameDecoder, encodeFrame } from './framing.js';
import type { LspServerConfig } from './types.js';

/* ---------------- 假子进程 + 脚本化 LSP 服务器 ---------------- */

/** 脚本化 LSP 服务器（读 stdin 帧 / 往 stdout 写帧——测试手工驱动应答） */
interface FakeLspServer {
  child: SpawnedProcess;
  /** 服务器侧收到的全部消息（帧已解码的 JSON 对象） */
  frames: Array<Record<string, unknown>>;
  /** 手工发一条消息到客户端方向（自动包帧） */
  send: (obj: unknown) => void;
  /** 应答 result（自动包帧） */
  sendResult: (id: unknown, result: unknown) => void;
  /** 向客户端方向写原始字节（不包帧——坏帧注入用；类型面 SpawnedProcess.stdout 只读） */
  writeRaw: (chunk: string) => void;
  /** 模拟子进程退出（可重复触发；stdout 只真关一次） */
  die: (code: number | null) => void;
}

/** 造一台假 LSP 服务器（pid 可指定——killTree 录制断言锚） */
function makeFakeLspServer(pid = 5501): FakeLspServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('error', () => undefined); // 客户端停读后写侧 EPIPE 不算失败
  const closeCbs: Array<(code: number | null, signal: string | null) => void> = [];
  const frames: Array<Record<string, unknown>> = [];
  let stdoutEnded = false;
  const child: SpawnedProcess = {
    pid,
    stdin: {
      write: (chunk: string) => stdin.write(chunk),
      end: () => stdin.end(),
      on: () => undefined,
    },
    stdout,
    stderr: { on: (ev, cb) => stderr.on(ev, cb) },
    on: (event, cb) => {
      if (event === 'close') closeCbs.push(cb);
    },
  };
  const send = (obj: unknown): void => {
    stdout.write(encodeFrame(JSON.stringify(obj)));
  };
  // 服务器侧帧解码（真帧层——与客户端读面同构，任意分块安全）
  const feedServer = createFrameDecoder((json) => {
    try {
      frames.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      /* 烂帧忽略 */
    }
  });
  stdin.on('data', (chunk: Buffer | string) => feedServer(chunk));
  return {
    child,
    frames,
    send,
    sendResult: (id, result) => send({ jsonrpc: '2.0', id, result }),
    writeRaw: (chunk) => stdout.write(chunk),
    die: (code) => {
      if (!stdoutEnded) {
        stdoutEnded = true;
        stdout.end();
      }
      for (const cb of [...closeCbs]) cb(code, null);
    },
  };
}

/* ---------------- 测试基建（假桥 = JsonRpcLike 本地实现） ---------------- */

/** pending 结算簿记（假桥的 id 关联表——与真桥同构） */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 测试环境：假子进程 + 假桥记录 + killTree 录制 + tmp 工作区根 */
interface Harness {
  server: FakeLspServer;
  /** 假桥发出的全部 JSON 消息（request/notify 双腿） */
  bridgeSent: string[];
  deps: LspConnectDeps;
  kills: number[];
  root: string;
}

/** 新临时目录（realpath 防 macOS /var 符号链接漂移） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/**
 * 搭环境：newConnection 注入假桥（帧无关契约的本地实现——id 关联 + 超时
 * 尊重 timeoutCode + 通知腿派回 onNotification，与 mcp 真桥语义同构）。
 */
function makeHarness(pid?: number): Harness {
  const server = makeFakeLspServer(pid);
  const bridgeSent: string[] = [];
  const kills: number[] = [];
  /** pending 簿（假桥 id 关联表） */
  const pending = new Map<number, Pending>();
  const deps: LspConnectDeps = {
    spawnServer: async () => server.child,
    killTree: (killedPid) => kills.push(killedPid),
    logger: { debug: () => undefined, warn: () => undefined },
    newConnection: (opts) => {
      /** 双腿共用写面：记录 + 委派真 writeLine（帧层由 client 包头） */
      const write = (line: string): void => {
        bridgeSent.push(line);
        opts.writeLine(line);
      };
      const bridge: JsonRpcLike = {
        request: (method, params, callOpts) =>
          new Promise<unknown>((resolve, reject) => {
            const id = pending.size + 1;
            const entry: Pending = {
              resolve,
              reject,
              // 超时码尊重注入（握手钟 LSP_CONNECT_FAILED / 调用钟 TOOL_TIMEOUT——与真桥同构）
              timer: setTimeout(() => {
                pending.delete(id);
                reject(new AppError(callOpts?.timeoutCode ?? TOOL_TIMEOUT, `假桥超时：${method}`));
              }, callOpts?.timeoutMs ?? 5000),
            };
            pending.set(id, entry);
            write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }));
          }),
        notify: (method, params) => {
          write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }));
        },
        close: (reason) => {
          // close 语义：全部 pending 以 close reason 拒绝（结清——不再结算）
          for (const [, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`假桥关闭：${reason}`));
          }
          pending.clear();
        },
        get isClosed() {
          return false; // 假桥不模拟关闭态（close 路径由 pending 结清覆盖）
        },
        feed: (line) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return;
          }
          // 响应腿：结 pending
          if (msg['id'] !== undefined && ('result' in msg || 'error' in msg)) {
            const entry = pending.get(msg['id'] as number);
            if (entry === undefined) return;
            clearTimeout(entry.timer);
            pending.delete(msg['id'] as number);
            if ('error' in msg) entry.reject(new Error(String((msg['error'] as { message?: string }).message)));
            else entry.resolve(msg['result']);
            return;
          }
          // 通知腿：派 onNotification（client 的 publishDiagnostics 消费口）
          if (msg['method'] !== undefined) {
            opts.onNotification?.(String(msg['method']), msg['params']);
          }
        },
      };
      return bridge;
    },
  };
  return { server, bridgeSent, deps, kills, root: makeTempDir('lsp-client-') };
}

/** 标准配置（绝对路径 command——相对路径拦截测试的过关形态） */
const CONFIG: LspServerConfig = { command: '/fake/bin/typescript-language-server', args: ['--stdio'] };

/** 全部在飞连接的清理登记（afterEach 统一回卷） */
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of [...cleanup]) fn();
  cleanup.length = 0;
});

/** 连接并完成握手（见到 initialize 帧即应答——服务器侧手工驱动） */
async function connect(harness: Harness): Promise<ReturnType<typeof connectLspServer>> {
  const connPromise = connectLspServer('ts', CONFIG, harness.root, harness.deps);
  await vi.waitFor(() => {
    expect(harness.server.frames.some((f) => f['method'] === 'initialize')).toBe(true);
  });
  const init = harness.server.frames.find((f) => f['method'] === 'initialize')!;
  harness.server.sendResult(init['id'], { capabilities: {}, serverInfo: { name: 'fake-lsp' } });
  const conn = await connPromise;
  cleanup.push(() => harness.server.die(0));
  return conn;
}

/* ---------------- connect 期 ---------------- */

describe('lsp client — connect 期', () => {
  it('相对路径 command 在 spawn 前拦下：LSP_CONNECT_FAILED（零消息发出）', async () => {
    const harness = makeHarness();
    await expect(connectLspServer('ts', { command: 'npx' }, harness.root, harness.deps)).rejects.toMatchObject({
      code: LSP_CONNECT_FAILED,
    });
    expect(harness.bridgeSent).toHaveLength(0); // 未 spawn 未建桥——零消息
  });

  it('spawn 失败一码收口 LSP_CONNECT_FAILED（cause 保真）', async () => {
    const harness = makeHarness();
    const failing: LspConnectDeps = {
      ...harness.deps,
      spawnServer: async () => {
        throw new Error('ENOENT: no such file');
      },
    };
    await expect(connectLspServer('ts', CONFIG, harness.root, failing)).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === LSP_CONNECT_FAILED && String(err).includes('ENOENT'),
    );
  });

  it('握手参数最小面：initialize 含 protocolVersion/rootUri/capabilities + initialized 通知随后', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const init = harness.server.frames.find((f) => f['method'] === 'initialize');
    expect(init).toBeDefined();
    const params = init!['params'] as Record<string, unknown>;
    expect(params['protocolVersion']).toBe('3.17.0');
    expect(String(params['rootUri'])).toBe(`file://${harness.root}`);
    expect(params['capabilities']).toEqual({ textDocument: { synchronization: { dynamicRegistration: false } } });
    expect(harness.server.frames.some((f) => f['method'] === 'initialized')).toBe(true);
    expect(conn.server).toBe('ts');
  });

  it('startup 超时：LSP_CONNECT_FAILED（握手钟码不串成 TOOL_TIMEOUT）+ 树杀不留挂起', async () => {
    const harness = makeHarness();
    // 不应答 initialize——让握手钟（0.05s）超时
    const promise = connectLspServer('ts', { ...CONFIG, startup_timeout_sec: 0.05 }, harness.root, harness.deps);
    await expect(promise).rejects.toMatchObject({ code: LSP_CONNECT_FAILED });
    expect(harness.kills).toHaveLength(1); // 握手失败即树杀
    cleanup.push(() => harness.server.die(0));
  });
});

/* ---------------- 文档同步（盘真相 + version 账） ---------------- */

describe('lsp client — syncDocument/closeDocument', () => {
  it('首触 didOpen（version 1 + languageId + 全文）；再触 didChange（version 2 + Full 全文）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'a.ts');
    writeFileSync(file, 'const x: number = 1;\n', 'utf8');
    await conn.syncDocument(file);
    await writeFile(file, 'const x: string = "s";\n', 'utf8');
    await conn.syncDocument(file);
    const opens = harness.server.frames.filter((f) => f['method'] === 'textDocument/didOpen');
    const changes = harness.server.frames.filter((f) => f['method'] === 'textDocument/didChange');
    expect(opens).toHaveLength(1);
    expect(changes).toHaveLength(1);
    const openDoc = (opens[0]!['params'] as { textDocument: Record<string, unknown> }).textDocument;
    expect(openDoc['version']).toBe(1);
    expect(openDoc['languageId']).toBe('typescript');
    expect(String(openDoc['text'])).toContain('number'); // 盘真相：全文即所读
    const changeParams = changes[0]!['params'] as {
      textDocument: Record<string, unknown>;
      contentChanges: [{ text: string }];
    };
    expect(changeParams.textDocument['version']).toBe(2); // per-URI 单调递增
    expect(changeParams.contentChanges[0]!.text).toContain('string'); // Full 全文替换体
  });

  it('盘上文件已不在（曾 open）：返 undefined + didClose 告别', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'gone.ts');
    writeFileSync(file, 'x\n', 'utf8');
    await conn.syncDocument(file); // open
    rmSync(file);
    const version = await conn.syncDocument(file); // 盘缺路径
    expect(version).toBeUndefined();
    expect(harness.server.frames.some((f) => f['method'] === 'textDocument/didClose')).toBe(true);
  });

  it('closeDocument：未 open 过的删除无告别（服务器不知此文档）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    conn.closeDocument(join(harness.root, 'never-opened.ts'));
    expect(harness.server.frames.some((f) => f['method'] === 'textDocument/didClose')).toBe(false);
  });

  it('close 后再 open：version 继续递增（旧 version 迟到诊断不误醒新 waiter 的账面前提）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'reopen.ts');
    writeFileSync(file, 'a\n', 'utf8');
    const v1 = await conn.syncDocument(file);
    conn.closeDocument(file);
    const v2 = await conn.syncDocument(file);
    expect(v1).toBe(1);
    expect(v2).toBe(2); // 不回 1——账本继续递增
  });
});

/* ---------------- 诊断等待（version 对齐 + 超时降级） ---------------- */

describe('lsp client — waitForDiagnostics', () => {
  it('publish version ≥ 门槛即唤醒并携带诊断集', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'd.ts');
    writeFileSync(file, 'bad code\n', 'utf8');
    const version = await conn.syncDocument(file);
    const waiting = conn.waitForDiagnostics(file, version!, 1000);
    // 服务器推送该版诊断（真帧 + 假桥通知腿 → handlePublish）
    harness.server.send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: `file://${file}`,
        version: version!,
        diagnostics: [
          {
            message: '类型不匹配',
            severity: 1,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          },
        ],
      },
    });
    const diags = await waiting;
    expect(diags).toHaveLength(1);
    expect(diags![0]!.message).toBe('类型不匹配');
  });

  it('旧 version 迟到诊断不唤醒新 waiter（version 对齐——批内连续两次写同文件）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'race.ts');
    writeFileSync(file, 'one\n', 'utf8');
    await conn.syncDocument(file); // version 1
    await writeFile(file, 'two\n', 'utf8');
    const v2 = await conn.syncDocument(file); // version 2
    const waiting = conn.waitForDiagnostics(file, v2!, 300);
    // 迟到的 v1 诊断先到——不该唤醒 v2 waiter
    harness.server.send({
      method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${file}`, version: 1, diagnostics: [{ message: '过期诊断' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 80)); // 留窗证明未醒
    // v2 诊断到——此刻唤醒
    harness.server.send({
      method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${file}`, version: v2!, diagnostics: [] },
    });
    const diags = await waiting;
    expect(diags).toEqual([]); // 唤醒值 = v2 空集（非 v1 过期集）
  });

  it('服务器不带 version 视为最新直接解锁（协议该字段可选）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'noversion.ts');
    writeFileSync(file, 'x\n', 'utf8');
    const version = await conn.syncDocument(file);
    const waiting = conn.waitForDiagnostics(file, version! + 5, 1000); // 门槛抬高——无 version 仍解锁
    harness.server.send({
      method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${file}`, diagnostics: [{ message: '无版本诊断' }] },
    });
    const diags = await waiting;
    expect(diags).toHaveLength(1);
  });

  it('超时结算 undefined（降级信号不算失败）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'slow.ts');
    writeFileSync(file, 'x\n', 'utf8');
    const version = await conn.syncDocument(file);
    const diags = await conn.waitForDiagnostics(file, version!, 60); // 不推诊断——超钟
    expect(diags).toBeUndefined();
  });

  it('快查缓存：version 已达的诊断集直返（零等待）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'cached.ts');
    writeFileSync(file, 'x\n', 'utf8');
    const version = await conn.syncDocument(file);
    harness.server.send({
      method: 'textDocument/publishDiagnostics',
      params: { uri: `file://${file}`, version: version!, diagnostics: [{ message: '缓存诊断' }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 30)); // 派发落地
    const diags = await conn.waitForDiagnostics(file, version!, 1000);
    expect(diags).toHaveLength(1);
    expect(diags![0]!.message).toBe('缓存诊断');
  });
});

/* ---------------- 运行期退出与关停 ---------------- */

describe('lsp client — 崩溃与关停', () => {
  it('子进程退出：waiter 降级 undefined + onExit fire + pending 请求拒绝', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const file = join(harness.root, 'crash.ts');
    writeFileSync(file, 'x\n', 'utf8');
    const version = await conn.syncDocument(file);
    const waiting = conn.waitForDiagnostics(file, version!, 5000);
    const exits: string[] = [];
    conn.onExit((reason) => exits.push(reason));
    // 挂起请求（documentSymbol 不应答）+ 同步崩溃
    const pendingCall = conn.request('textDocument/documentSymbol', {}, 5000).catch((err: unknown) => err);
    harness.server.die(1);
    expect(await waiting).toBeUndefined(); // 降级非失败
    expect(exits).toHaveLength(1);
    expect(String(await pendingCall)).toContain('退出'); // pending 以 close reason 拒绝
  });

  it('坏帧 crash 后随到的 close 事件不双计（复盘 L-1 回归锁：一次进程事故恰计一败）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const exits: string[] = [];
    conn.onExit((reason) => exits.push(reason));
    // 坏帧（帧头缺 Content-Length）：连接不可信，crash 先结算
    harness.server.writeRaw('Garbage: 1\r\n\r\n');
    await vi.waitFor(() => {
      expect(exits).toHaveLength(1); // 坏帧腿先 fire
    });
    // 子进程随后才退（真实时序：解码器先于进程死）——close 事件不得再 fire 一败
    harness.server.die(1);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toContain('帧解码失败'); // 首因保留（后续 close 不改写归因）
  });

  it('坏帧路径子进程未退即同步树杀（复盘 L-1 回归锁：防永久孤儿）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const exits: string[] = [];
    conn.onExit((reason) => exits.push(reason));
    // 坏帧时子进程仍活（不 die——孤儿现场：件层 onExit 清实例与登记簿后无人再杀它）
    harness.server.writeRaw('Garbage: 1\r\n\r\n');
    await vi.waitFor(() => {
      expect(exits).toHaveLength(1);
    });
    expect(harness.kills).toContain(5501); // crash 内同步树杀，不等宽限
  });

  it('dispose：shutdown 请求 → exit 通知 → 自退收尾（幂等；兜底树杀恒在）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const disposePromise = conn.dispose();
    // 见 shutdown 帧即应答（否则 exit 通知不会发出——握手阻塞解除）
    await vi.waitFor(() => {
      expect(harness.server.frames.some((f) => f['method'] === 'shutdown')).toBe(true);
    });
    const shutdown = harness.server.frames.find((f) => f['method'] === 'shutdown')!;
    harness.server.sendResult(shutdown['id'], null);
    // shutdown 应答后 exit 通知即发
    await vi.waitFor(() => {
      expect(harness.server.frames.some((f) => f['method'] === 'exit')).toBe(true);
    });
    harness.server.die(0); // 宽限内自退（竞速赢树杀钟）
    await disposePromise;
    expect(harness.kills.length).toBeGreaterThanOrEqual(1); // 兜底树杀恒调用（已退即幂等内吞）
    await conn.dispose(); // 幂等——第二刀空转
  });

  it('request 调用期超时码 = TOOL_TIMEOUT（与管道同码——桥钟缓冲让管道先执法）', async () => {
    const harness = makeHarness();
    const conn = await connect(harness);
    const err = await conn.request('textDocument/documentSymbol', {}, 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(TOOL_TIMEOUT);
    cleanup.push(() => harness.server.die(0));
  });
});
