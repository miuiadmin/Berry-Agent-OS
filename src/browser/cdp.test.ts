/**
 * L3 browser 刀一测试（契约篇 §6.10 验收两轨——假 CDP 服务器 WS 帧层约百行，
 * DAG 豁免先例：测试文件不走模块 DAG）。
 *
 * 假 CDP 服务器 = node:http + 手写 WS 握手与帧编解码（RFC 6455 最小面：文本
 * 帧收发 + close 处理）——不经任何 WS 库，正是「CDP 手写零依赖」验收轨的
 * 自证：本测试即桥核的协议真值层。
 *
 * 三层覆盖：
 * - cdp 层：/json/version 探测 / WS 连接与请求-响应 / sessionId 帧附着 /
 *   事件 sessionId 分流 / 会话层三连 / 服务器错误腿；
 * - discover 层：发现序四级 + 回退自述 + 诚实缺席（注入缝做确定性缺席）；
 * - engine 层：全链起（发现→spawn→DevToolsActivePort→连接→context 建立）/
 *   两级闲置回收 / dispose 永久关停 / 回卷后拒用。
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcConnection } from '../mcp/index.js';
import type { AppLogger } from '../contracts/app.js';
import { AppError, BROWSER_ENGINE_NOT_FOUND, describeError } from '../contracts/errors.js';
import { CdpConnection, disposeSessionContext, fetchVersionInfo, openSessionContext } from './cdp.js';
import { discoverEngine } from './discover.js';
import { BrowserEngine } from './engine.js';

/* ---------------- 手写 WS 帧编解码（服务器侧最小面） ---------------- */

/** WS GUID（RFC 6455 握手常量） */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 编一条服务器→客户端文本帧（不掩码——服务器方向豁免） */
function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 解一条客户端→服务器帧（必掩码——RFC 6455 客户端到服务器强制） */
function* decodeFrames(data: Uint8Array): Generator<{ opcode: number; payload: Buffer; rest: Buffer }> {
  let buf: Buffer = data as Buffer; // 调用方恒传 Buffer（socket chunk concat 产物）——视图复用零拷贝
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0]! & 0x0f;
    const masked = (buf[1]! & 0x80) !== 0;
    let len = buf[1]! & 0x7f;
    let cursor = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      cursor = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      cursor = 10;
    }
    let mask: Buffer | undefined;
    if (masked) {
      if (buf.length < cursor + 4) break;
      mask = buf.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (buf.length < cursor + len) break; // 半帧等续
    let payload = buf.subarray(cursor, cursor + len);
    if (mask !== undefined) {
      const unmasked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ mask[i % 4]!;
      payload = unmasked;
    }
    yield { opcode, payload, rest: buf.subarray(cursor + len) };
    buf = buf.subarray(cursor + len);
  }
}

/* ---------------- 假 CDP 服务器 ---------------- */

/**
 * 假 CDP 服务器：HTTP /json/version + WS 升级 + 帧级应答器。
 * 应答器表 method → result（缺省 {}）；receivedFrames 记录全部入站请求帧
 * （sessionId 附着断言面）；pushEvent 推 target 级事件（带 sessionId 分流）。
 */
class FakeCdpServer {
  private readonly server: Server;
  private readonly sockets = new Set<Duplex>();
  private readonly frameBuf = new WeakMap<Duplex, Uint8Array>();
  /** 入站请求帧全录（顶层字段原样——sessionId 断言面） */
  readonly receivedFrames: Array<Record<string, unknown>> = [];
  /** 应答器表（method → result 工厂；未列方法应答 {}） */
  responders: Record<string, (params: Record<string, unknown>) => unknown> = {};
  /** 错误应答表（method → CDP error 帧——优先于 responders；服务器错误腿测试） */
  errorResponders: Record<string, { code: number; message: string }> = {};
  port = 0;

  constructor() {
    this.server = createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            Browser: 'FakeChrome/131.0.0.0',
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/fake-uuid`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.sockets.add(socket);
      this.frameBuf.set(socket, Buffer.alloc(0));
      socket.on('data', (chunk: Buffer) => {
        const buf: Buffer = Buffer.concat([this.frameBuf.get(socket) ?? Buffer.alloc(0), chunk]);
        let rest: Buffer = buf;
        for (const frame of decodeFrames(buf)) {
          rest = frame.rest;
          this.handleFrame(socket, frame);
        }
        this.frameBuf.set(socket, rest);
      });
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => this.sockets.delete(socket));
    });
  }

  /** 单帧处理：close 帧回 close 拆链；文本帧按 JSON-RPC 应答 */
  private handleFrame(socket: Duplex, frame: { opcode: number; payload: Buffer }): void {
    if (frame.opcode === 0x8) {
      socket.end(Buffer.from([0x88, 0x00])); // close 帧 echo（礼貌拆链）
      return;
    }
    if (frame.opcode !== 0x1) return; // ping/binary 最小面不处理
    const msg = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.receivedFrames.push(msg);
      const errFor = this.errorResponders[msg.method];
      if (errFor !== undefined) {
        socket.write(encodeTextFrame(JSON.stringify({ id: msg.id, error: errFor })));
        return;
      }
      const respond = this.responders[msg.method];
      // 应答器抛错不炸传输层（真 CDP 语义：handler 失败回 error 帧不拆链）——
      // 否则未捕获异常悬死 socket，请求永不结清（测试即真值：服务器失败 = 错误应答）
      let result: unknown = {};
      try {
        result = respond === undefined ? {} : respond((msg.params ?? {}) as Record<string, unknown>);
      } catch (err) {
        socket.write(
          encodeTextFrame(JSON.stringify({ id: msg.id, error: { code: -32_000, message: (err as Error).message } })),
        );
        return;
      }
      socket.write(encodeTextFrame(JSON.stringify({ id: msg.id, result })));
    }
  }

  /** 推一条 target 级事件（sessionId 在场 = 分流语义） */
  pushEvent(method: string, params: unknown, sessionId?: string): void {
    const frame = { method, params, ...(sessionId === undefined ? {} : { sessionId }) };
    const encoded = encodeTextFrame(JSON.stringify(frame));
    for (const socket of this.sockets) socket.write(encoded);
  }

  /** 起服（127.0.0.1 随机端口） */
  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as { port: number }).port;
  }

  /** 停服（全 socket 强拆——测试收尾不悬挂） */
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/* ---------------- cdp 层 ---------------- */

describe('browser cdp 层（假 CDP 服务器 WS 帧层）', () => {
  let fake: FakeCdpServer;

  beforeEach(async () => {
    fake = new FakeCdpServer();
    await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  /** 桥工厂（真 JsonRpcConnection——本测试正是其第三消费面〔帧无关〕的协议真值验证） */
  const newConnection = (opts: ConstructorParameters<typeof JsonRpcConnection>[0]): JsonRpcConnection =>
    new JsonRpcConnection(opts);

  it('fetchVersionInfo：host:port 探 /json/version 取 ws 端点', async () => {
    const info = await fetchVersionInfo(`127.0.0.1:${fake.port}`);
    expect(info.browser).toBe('FakeChrome/131.0.0.0');
    expect(info.webSocketDebuggerUrl).toContain(`127.0.0.1:${fake.port}`);
  });

  it('fetchVersionInfo：ws url 直用（零 HTTP 探测）；端点死 → BROWSER_CONNECT_FAILED', async () => {
    const direct = await fetchVersionInfo(`ws://127.0.0.1:${fake.port}/devtools/browser/x`);
    expect(direct.webSocketDebuggerUrl).toContain('/devtools/browser/x');
    // 死端口（探测面）：端口 1 保留位——连接必拒即验码
    await expect(fetchVersionInfo('127.0.0.1:1', 500)).rejects.toSatisfy((err: unknown) => {
      return err instanceof AppError && err.code === 'BROWSER_CONNECT_FAILED';
    });
  });

  it('WS 连接 + 请求-响应：真 JsonRpcConnection 走 WS 文本帧（第三消费面自证）', async () => {
    fake.responders = { 'Browser.getVersion': () => ({ product: 'FakeChrome/131.0.0.0' }) };
    const conn = await CdpConnection.connect(`ws://127.0.0.1:${fake.port}/devtools/browser/fake-uuid`, newConnection);
    try {
      const version = (await conn.rpc.request('Browser.getVersion')) as { product: string };
      expect(version.product).toBe('FakeChrome/131.0.0.0');
    } finally {
      conn.close('测试收尾');
    }
  });

  it('请求帧顶层 sessionId 附着（CDP 加法面①）——服务器收到带 sessionId 的帧', async () => {
    const conn = await CdpConnection.connect(`ws://127.0.0.1:${fake.port}/devtools/browser/fake-uuid`, newConnection);
    try {
      await conn.rpc.request('Page.navigate', { url: 'https://example.com' }, { sessionId: 'SESS-1' });
      const frame = fake.receivedFrames.at(-1)!;
      expect(frame.method).toBe('Page.navigate');
      expect(frame.sessionId).toBe('SESS-1'); // 帧顶层附着（Chrome 端按字段名解析）
    } finally {
      conn.close('测试收尾');
    }
  });

  it('事件按 sessionId 分流（CDP 加法面②）——onEvent 第三参透传', async () => {
    const events: Array<{ method: string; sessionId?: string }> = [];
    const conn = await CdpConnection.connect(`ws://127.0.0.1:${fake.port}/devtools/browser/fake-uuid`, newConnection, {
      onEvent: (method, _params, sessionId) =>
        events.push({ method, ...(sessionId === undefined ? {} : { sessionId }) }),
    });
    try {
      fake.pushEvent('Runtime.consoleAPICalled', { type: 'log' }, 'SESS-1');
      fake.pushEvent('Target.targetCreated', { targetInfo: {} }); // browser 级事件（无 sessionId）
      await new Promise((resolve) => setTimeout(resolve, 50)); // 帧到达窗
      expect(events).toEqual([
        { method: 'Runtime.consoleAPICalled', sessionId: 'SESS-1' },
        { method: 'Target.targetCreated' },
      ]);
    } finally {
      conn.close('测试收尾');
    }
  });

  it('会话层三连：createBrowserContext → createTarget → attachToTarget(flatten) → sessionId', async () => {
    fake.responders = {
      'Target.createBrowserContext': () => ({ browserContextId: 'CTX-1' }),
      'Target.createTarget': () => ({ targetId: 'TGT-1' }),
      'Target.attachToTarget': () => ({ sessionId: 'SESS-ATTACHED' }),
    };
    const conn = await CdpConnection.connect(`ws://127.0.0.1:${fake.port}/devtools/browser/fake-uuid`, newConnection);
    try {
      const state = await openSessionContext(conn.rpc);
      expect(state).toEqual({ browserContextId: 'CTX-1', targetId: 'TGT-1', sessionId: 'SESS-ATTACHED' });
      // createTarget 收到 browserContextId 钉容器；attachToTarget 带 targetId + flatten:true
      const createTargetFrame = fake.receivedFrames.find((f) => f.method === 'Target.createTarget')!;
      expect((createTargetFrame.params as Record<string, unknown>).browserContextId).toBe('CTX-1');
      const attachFrame = fake.receivedFrames.find((f) => f.method === 'Target.attachToTarget')!;
      expect((attachFrame.params as Record<string, unknown>).targetId).toBe('TGT-1');
      expect((attachFrame.params as Record<string, unknown>).flatten).toBe(true);
      // 终结幂等：服务器侧回 error 应答也吞（dispose 收场失败不外抛——错误腿真值）
      fake.responders = {
        'Target.disposeBrowserContext': () => {
          throw new Error('已死');
        },
      };
      await expect(disposeSessionContext(conn.rpc, 'CTX-1')).resolves.toBeUndefined();
    } finally {
      conn.close('测试收尾');
    }
  });

  it('服务器错误腿：CDP error 应答以普通 Error 上抛（不裹 AppError——数据非故障）', async () => {
    fake.errorResponders['Target.createTarget'] = { code: -32_000, message: 'boom: target 无法创建' };
    const conn = await CdpConnection.connect(`ws://127.0.0.1:${fake.port}/devtools/browser/fake-uuid`, newConnection);
    try {
      await expect(conn.rpc.request('Target.createTarget', { url: 'about:blank' })).rejects.toSatisfy(
        (err: unknown) => err instanceof Error && !(err instanceof AppError) && err.message.includes('boom'),
      );
    } finally {
      conn.close('测试收尾');
    }
  });

  it('服务器死亡感知：连接拆除 → onDead 回调触发 + pending 结清', async () => {
    const dead: string[] = [];
    const conn = await CdpConnection.connect(`ws://127.0.0.1:${fake.port}/devtools/browser/fake-uuid`, newConnection);
    conn.onDead((reason) => dead.push(reason));
    const pending = conn.rpc.request('Target.createTarget', { url: 'about:blank' }, { timeoutMs: 5_000 });
    await fake.stop(); // 物理拆除（服务器侧全 socket destroy）
    await expect(pending).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === 'BROWSER_CONNECT_FAILED',
    );
    expect(dead).toHaveLength(1);
  });
});

/* ---------------- discover 层 ---------------- */

describe('browser 引擎发现序', () => {
  /** 临时目录（每用例新开——测试污染隔离纪律：绝不触真 ~/.berry） */
  const makeTmp = (): string => mkdtempSync(join(tmpdir(), 'berry-browser-test-'));

  /** 造一个可执行文件（discover 判据 = X_OK；嵌套路径先建目录——CfT 布局多层深） */
  const makeExecutable = (dir: string, rel: string): string => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
    return path;
  };

  it('① config 显式位命中 → source=config 零回退自述', () => {
    const dir = makeTmp();
    const exe = makeExecutable(dir, 'chrome-fake');
    const found = discoverEngine({ executablePath: exe }, join(dir, 'engine'), { systemPaths: [], pathEnv: '' });
    expect(found).toEqual({ path: exe, source: 'config' });
  });

  it('① 显式位缺席 → 落次级 + fallbackWarning 诚实披露（不 fail-loud）', () => {
    const dir = makeTmp();
    const downloaded = makeExecutable(dir, join('engine', '131.0.0.0', 'chrome-linux64', 'chrome'));
    const found = discoverEngine({ executablePath: join(dir, 'absent-chrome') }, join(dir, 'engine'), {
      systemPaths: [],
      pathEnv: '',
    });
    expect(found.source).toBe('downloaded');
    expect(found.path).toBe(downloaded);
    expect(found.fallbackWarning).toContain('absent-chrome');
  });

  it('② 系统知名位命中 → source=system', () => {
    const dir = makeTmp();
    const exe = makeExecutable(dir, 'system-chrome');
    const found = discoverEngine({}, join(dir, 'engine'), { systemPaths: [exe], pathEnv: '' });
    expect(found).toEqual({ path: exe, source: 'system' });
  });

  it('② PATH 腿命中 → source=system（逐目录 X_OK 探测）', () => {
    const dir = makeTmp();
    const exe = makeExecutable(dir, 'google-chrome');
    const found = discoverEngine({}, join(dir, 'engine'), { systemPaths: [], pathEnv: dir });
    expect(found).toEqual({ path: exe, source: 'system' });
  });

  it('env APP_BROWSER_PATH 同义位命中 → source=config', () => {
    const dir = makeTmp();
    const exe = makeExecutable(dir, 'env-chrome');
    const prev = process.env.APP_BROWSER_PATH;
    process.env.APP_BROWSER_PATH = exe;
    try {
      const found = discoverEngine({}, join(dir, 'engine'), { systemPaths: [], pathEnv: '' });
      expect(found).toEqual({ path: exe, source: 'config' });
    } finally {
      if (prev === undefined) delete process.env.APP_BROWSER_PATH;
      else process.env.APP_BROWSER_PATH = prev;
    }
  });

  it('④ 全缺席 → BROWSER_ENGINE_NOT_FOUND 附安装指引（不自动下载）', () => {
    const dir = makeTmp();
    try {
      discoverEngine({}, join(dir, 'engine'), { systemPaths: [], pathEnv: '' });
      expect.unreachable('应诚实缺席');
    } catch (err) {
      expect((err as AppError).code).toBe(BROWSER_ENGINE_NOT_FOUND); // registerErrorCode 返字符串码本值
      expect(describeError(err)).toContain('BROWSER_ENGINE_NOT_FOUND');
      expect(describeError(err)).toContain('/browser install');
    }
  });
});

/* ---------------- engine 层（假 spawn + 假 CDP 服务器全链） ---------------- */

describe('browser 引擎生命周期', () => {
  let fake: FakeCdpServer;

  beforeEach(async () => {
    fake = new FakeCdpServer();
    await fake.start();
    fake.responders = {
      'Target.createBrowserContext': () => ({ browserContextId: 'CTX-1' }),
      'Target.createTarget': () => ({ targetId: 'TGT-1' }),
      'Target.attachToTarget': () => ({ sessionId: 'SESS-1' }),
    };
  });

  afterEach(async () => {
    await fake.stop();
  });

  /** 引擎依赖束组装（假 spawn 写假 DevToolsActivePort——真 Chrome 语义位） */
  const makeEngine = (opts: {
    dataDir: string;
    idleMs: number;
    onSpawn?: (args: readonly string[]) => void;
  }): {
    engine: BrowserEngine;
    killTree: ReturnType<typeof vi.fn>;
    registry: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; sweep: ReturnType<typeof vi.fn> };
    notify: ReturnType<typeof vi.fn>;
  } => {
    const killTree = vi.fn();
    const registry = {
      add: vi.fn(),
      remove: vi.fn(),
      sweep: vi.fn(async () => ({ killed: [] as number[] })),
    };
    const notify = vi.fn();
    // 日志 stub（AppLogger 三键结构投影——引擎不消费真实落盘面）
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Pick<
      AppLogger,
      'debug' | 'info' | 'warn'
    >;
    const engine = new BrowserEngine({
      dataDir: opts.dataDir,
      config: { executablePath: process.execPath }, // 发现序①命中（真可执行——node 本体）
      spawnEngine: ({ args }) => {
        opts.onSpawn?.(args);
        // 假引擎把调试端口文件写进 profile 目录（真 Chrome 的 DevToolsActivePort 语义位）
        const dir = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
        writeFileSync(join(dir, 'DevToolsActivePort'), `${fake.port}\n/devtools/browser/fake-uuid\n`);
        return { pid: 424_242, alive: () => true };
      },
      killTree,
      registry,
      newConnection: (o) => new JsonRpcConnection(o),
      logger,
      notify,
      idleMs: opts.idleMs,
      startupTimeoutMs: 2_000,
    });
    return { engine, killTree, registry, notify };
  };

  it('全链起：发现→spawn→DevToolsActivePort→WS 连接→context 建立（登记簿入册）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const spawnArgs: string[][] = [];
    const { engine, registry, notify } = makeEngine({
      dataDir,
      idleMs: 60_000,
      onSpawn: (args) => spawnArgs.push([...args]),
    });

    // 起前惰性：status idle、零 spawn
    expect(engine.getStatus().state).toBe('idle');

    const handle = await engine.acquireContext('sess-A');
    expect(handle.session).toEqual({ browserContextId: 'CTX-1', targetId: 'TGT-1', sessionId: 'SESS-1' });
    expect(engine.getStatus().state).toBe('running');
    expect(engine.getStatus()).toMatchObject({ attach: false });

    // spawn 参数面：remote-debugging-port=0 + user-data-dir 钉数据域 + headless=new 缺省
    const args = spawnArgs[0]!;
    expect(args).toContain('--remote-debugging-port=0');
    expect(args.find((a) => a.startsWith('--user-data-dir='))).toContain(join(dataDir, 'browser', 'profile-'));
    expect(args).toContain('--headless=new');
    expect(registry.add).toHaveBeenCalledWith(
      expect.objectContaining({ childPid: 424_242, server: 'browser-engine', command: process.execPath }),
    );
    // 单参通知（无 opts 也可——vitest anything 不匹配缺席参数，故不占位断言）
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('浏览器引擎已启动'));

    // 同 session 复用（不重建 context——服务器 createBrowserContext 只跑一次）
    const again = await engine.acquireContext('sess-A');
    expect(again.session.sessionId).toBe('SESS-1');
    const ctxCreates = fake.receivedFrames.filter((f) => f.method === 'Target.createBrowserContext');
    expect(ctxCreates).toHaveLength(1);

    // 异 session 隔离（第二个 context）
    fake.responders['Target.createBrowserContext'] = () => ({ browserContextId: 'CTX-2' });
    const other = await engine.acquireContext('sess-B');
    expect(other.session.browserContextId).toBe('CTX-2');

    await engine.dispose();
  });

  it('两级闲置回收：context 闲置 dispose → 零活 context 引擎闲置收场（树杀+净退）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const { engine, killTree, registry } = makeEngine({ dataDir, idleMs: 70 });
    await engine.acquireContext('sess-A');
    expect(engine.getStatus().state).toBe('running');

    // context 级闲置（~70ms）→ dispose context；引擎闲置钟起算（再 ~70ms）→ 引擎收场
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(engine.getStatus().state).toBe('closed');
    expect(killTree).toHaveBeenCalledWith(424_242, expect.any(Function));
    expect(registry.remove).toHaveBeenCalledWith(424_242);

    // disposeBrowserContext 已发（context 回收腿物证）
    const disposes = fake.receivedFrames.filter((f) => f.method === 'Target.disposeBrowserContext');
    expect(disposes).toHaveLength(1);
  });

  it('续命语义：反复取用只续命本 session——他 session 不被牵连闲置', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const { engine } = makeEngine({ dataDir, idleMs: 150 });
    await engine.acquireContext('sess-A');
    fake.responders['Target.createBrowserContext'] = () => ({ browserContextId: 'CTX-2' });
    await engine.acquireContext('sess-B');
    // A 到点（150ms）**前**续命 A（~80ms 时点）：A 钟重置至 ~230ms，B 钟不动（~150ms 到点）
    await new Promise((resolve) => setTimeout(resolve, 80));
    await engine.acquireContext('sess-A');
    // 过 B 的到点、不过 A 的新到点（80+120=200ms < 230ms）——仅 B 回收
    await new Promise((resolve) => setTimeout(resolve, 120));
    const disposes = fake.receivedFrames.filter((f) => f.method === 'Target.disposeBrowserContext');
    expect(disposes).toHaveLength(1); // 仅 B 回收
    await engine.dispose();
  });

  it('dispose 永久关停：回卷后取用响亮拒绝（不静默复活）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const { engine } = makeEngine({ dataDir, idleMs: 60_000 });
    await engine.acquireContext('sess-A');
    await engine.dispose();
    expect(engine.getStatus().state).toBe('closed');
    await expect(engine.acquireContext('sess-A')).rejects.toThrow('已回卷');
  });

  it('attach 形态：只连不杀（零 spawn/登记簿/树杀）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const killTree = vi.fn();
    const registry = { add: vi.fn(), remove: vi.fn(), sweep: vi.fn(async () => ({ killed: [] as number[] })) };
    const engine = new BrowserEngine({
      dataDir,
      config: { cdpEndpoint: `127.0.0.1:${fake.port}` }, // 走 HTTP /json/version 探测腿
      spawnEngine: () => {
        throw new Error('attach 形态不应 spawn');
      },
      killTree,
      registry,
      newConnection: (o) => new JsonRpcConnection(o),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Pick<AppLogger, 'debug' | 'info' | 'warn'>,
      notify: vi.fn(),
    });
    const handle = await engine.acquireContext('sess-A');
    expect(handle.session.sessionId).toBe('SESS-1');
    expect(engine.getStatus()).toMatchObject({ state: 'running', attach: true });
    await engine.dispose();
    expect(killTree).not.toHaveBeenCalled();
    expect(registry.add).not.toHaveBeenCalled();
  });
});
