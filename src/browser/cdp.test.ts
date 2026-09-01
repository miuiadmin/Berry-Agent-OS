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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcConnection } from '../mcp/index.js';
import type { AppLogger } from '../contracts/app.js';
import { AppError, BROWSER_ENGINE_NOT_FOUND, describeError } from '../contracts/errors.js';
import type { ToolDefinition } from '../contracts/tools.js';
import { CdpConnection, disposeSessionContext, fetchVersionInfo, openSessionContext } from './cdp.js';
import { discoverEngine } from './discover.js';
import { BrowserEngine } from './engine.js';
import { applyCaptureEvent, ConsoleRing, SessionCapture } from './capture.js';
import { renderAccessibilitySnapshot, type FlatDocNode } from './a11y.js';
import { saveScreenshot, SCREENSHOTS_KEEP } from './screenshots.js';
import { registerBrowserTools } from './tools.js';

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
  /** 应答扣押表（命中 method = 应答暂扣待 releaseHeld() 放行——收场竞速编排用） */
  holdMethods = new Set<string>();
  /** 扣押中的应答放行回调（releaseHeld 一次性全放） */
  private heldReplies: Array<() => void> = [];
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
      // 扣押分支：命中扣押表 = 应答暂存（请求帧已录，回帧待 releaseHeld 统一放行）
      if (this.holdMethods.has(msg.method)) {
        this.heldReplies.push(() => {
          socket.write(encodeTextFrame(JSON.stringify({ id: msg.id, result: {} })));
        });
        return;
      }
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

  /** 放行全部扣押应答（收场竞速编排的「开闸」步） */
  releaseHeld(): void {
    const cbs = this.heldReplies;
    this.heldReplies = [];
    for (const cb of cbs) cb();
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
    /** DevToolsActivePort 端口覆写（死端口腿——指向无人监听端口 connect 必败） */
    portOverride?: number;
    /** 不写 DevToolsActivePort（超帽腿——文件永不出现） */
    noPortFile?: boolean;
    /** 假 child 活性探针（false = 启动即死腿） */
    alive?: () => boolean;
    /** 起链等待帽覆写（缺省 2000——超帽腿注入小值） */
    startupTimeoutMs?: number;
    /** spawn pid 序列（缺省恒 424242——代际竞速腿第二次 spawn 换新 pid） */
    pids?: number[];
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
    // spawn 计数（pid 序列取值游标——代际竞速腿区分两代引擎）
    let spawnCount = 0;
    const engine = new BrowserEngine({
      dataDir: opts.dataDir,
      config: { executablePath: process.execPath }, // 发现序①命中（真可执行——node 本体）
      spawnEngine: ({ args }) => {
        opts.onSpawn?.(args);
        // 假引擎把调试端口文件写进 profile 目录（真 Chrome 的 DevToolsActivePort 语义位）
        const dir = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
        if (opts.noPortFile !== true) {
          writeFileSync(
            join(dir, 'DevToolsActivePort'),
            `${opts.portOverride ?? fake.port}\n/devtools/browser/fake-uuid\n`,
          );
        }
        spawnCount += 1;
        return { pid: opts.pids?.[spawnCount - 1] ?? 424_242, alive: opts.alive ?? (() => true) };
      },
      killTree,
      registry,
      newConnection: (o) => new JsonRpcConnection(o),
      logger,
      notify,
      idleMs: opts.idleMs,
      startupTimeoutMs: opts.startupTimeoutMs ?? 2_000,
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
    // 对照面：spawn 形态收场必发 Browser.close（attach 只断连 ≠ 全形态都不发）
    expect(fake.receivedFrames.filter((f) => f.method === 'Browser.close')).toHaveLength(1);
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

  it('#1 attach 收场只断连：闲置收场不发 Browser.close（只连不杀——契约篇 §6.10）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const engine = new BrowserEngine({
      dataDir,
      config: { cdpEndpoint: `127.0.0.1:${fake.port}` }, // 走 HTTP /json/version 探测腿
      spawnEngine: () => {
        throw new Error('attach 形态不应 spawn');
      },
      killTree: vi.fn(),
      registry: { add: vi.fn(), remove: vi.fn(), sweep: vi.fn(async () => ({ killed: [] as number[] })) },
      newConnection: (o) => new JsonRpcConnection(o),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Pick<AppLogger, 'debug' | 'info' | 'warn'>,
      notify: vi.fn(),
      idleMs: 70,
    });
    await engine.acquireContext('sess-A');
    // 闲置两跳（context ~70ms → 引擎 ~70ms）→ attach 形态收场 = 断链
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(engine.getStatus().state).toBe('closed');
    // 只连不杀：context 级 disposeBrowserContext 可发，引擎级 Browser.close 禁发——
    // 修复前红：收场无差别发 Browser.close = 杀用户自起的浏览器
    const browserCloses = fake.receivedFrames.filter((f) => f.method === 'Browser.close');
    expect(browserCloses).toHaveLength(0);
  });

  it('#2/#7/#9 起链失败即清算（引擎先死腿）：AppError 统一码 + 树杀 + 登记簿净退 + 状态 closed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const { engine, killTree, registry } = makeEngine({
      dataDir,
      idleMs: 60_000,
      alive: () => false, // 假引擎启动即死（alive 探针恒 false）
      noPortFile: true,
    });
    let err: unknown;
    try {
      await engine.acquireContext('sess-A');
    } catch (e) {
      err = e;
    }
    // 连接期统一码：裸 Error 修死为 AppError（修复前红 = instanceof 不成立）
    expect(err).toBeInstanceOf(AppError);
    expect(describeError(err)).toContain('BROWSER_CONNECT_FAILED');
    expect(describeError(err)).toContain('启动即退出');
    // 清算三断言（修复前红：野 Chrome 不杀、登记簿留尸、状态谎报 starting）
    expect(killTree).toHaveBeenCalledWith(424_242, expect.any(Function));
    expect(registry.remove).toHaveBeenCalledWith(424_242);
    expect(engine.getStatus().state).toBe('closed');
  });

  it('#2/#7/#9 起链失败即清算（超帽腿）：DevToolsActivePort 超帽 → AppError + 清算同腿', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const { engine, killTree, registry } = makeEngine({
      dataDir,
      idleMs: 60_000,
      noPortFile: true, // 端口文件永不出现 → 轮询直到超帽
      startupTimeoutMs: 120,
    });
    let err: unknown;
    try {
      await engine.acquireContext('sess-A');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError); // 修复前红：裸 Error
    expect(describeError(err)).toContain('BROWSER_CONNECT_FAILED');
    expect(describeError(err)).toContain('就绪等待超时');
    expect(killTree).toHaveBeenCalledWith(424_242, expect.any(Function)); // 修复前红
    expect(registry.remove).toHaveBeenCalledWith(424_242); // 修复前红
    expect(engine.getStatus().state).toBe('closed'); // 修复前红：谎报 starting
  });

  it('#3 context 建链半途失败回滚：enable 失败不留半捕获——重试走全链重建', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const { engine } = makeEngine({ dataDir, idleMs: 60_000 });
    // Runtime.enable 服务器错误腿 → context 建立中途炸（三表已挂、域未启）
    fake.errorResponders['Runtime.enable'] = { code: -32_000, message: 'boom' };
    await expect(engine.acquireContext('sess-A')).rejects.toThrow('boom');
    delete fake.errorResponders['Runtime.enable'];
    // 重试成功（半捕获态已回滚——不留「session 在表但 Runtime 永未启用」的残废 context）
    const handle = await engine.acquireContext('sess-A');
    expect(handle.session.sessionId).toBe('SESS-1');
    const count = (m: string) => fake.receivedFrames.filter((f) => f.method === m).length;
    expect(count('Target.createBrowserContext')).toBe(2); // 修复前红：残留表内 → 只建一次
    expect(count('Runtime.enable')).toBe(2); // 修复前红：复用残留 session → 不再 enable
    expect(count('Target.disposeBrowserContext')).toBeGreaterThanOrEqual(1); // 修复前红：失败 context 未 dispose
    expect(engine.getStatus().state).toBe('running');
    await engine.dispose();
  });

  it('#3 context 起建失败重武装引擎闲置钟：零活 context 不因失败永久失防', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const { engine, killTree } = makeEngine({ dataDir, idleMs: 70 });
    // openSessionContext 首步即炸（三表未挂——闲置钟被 acquire 入场撤防后无人重武装的腿）
    fake.errorResponders['Target.createBrowserContext'] = { code: -32_000, message: 'no-context' };
    await expect(engine.acquireContext('sess-A')).rejects.toThrow('no-context');
    delete fake.errorResponders['Target.createBrowserContext'];
    // 引擎 running 但零活 context——闲置钟应照常武装（~70ms 后收场树杀）
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(engine.getStatus().state).toBe('closed'); // 修复前红：running 悬死（闲置钟永久失防）
    expect(killTree).toHaveBeenCalledWith(424_242, expect.any(Function));
  });

  it('#17 收场代际护栏：closeEngine await 窗内换代——新引擎不被旧收场误杀', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
    const { engine, killTree } = makeEngine({ dataDir, idleMs: 250, pids: [424_242, 424_243] });
    await engine.acquireContext('sess-A'); // 第一代引擎（pid 424242）
    // 扣押 Browser.close 应答：闲置两跳（~500ms）后 closeEngine 进入 await 窗
    fake.holdMethods.add('Browser.close');
    const until = async (pred: () => boolean, ms = 2_000): Promise<void> => {
      const start = Date.now();
      while (!pred()) {
        if (Date.now() - start > ms) throw new Error('until 轮询超时');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await until(() => fake.receivedFrames.some((f) => f.method === 'Browser.close'));
    expect(engine.getStatus().state).toBe('closed'); // closeEngine 入场已置 closed（await 窗内）
    // await 窗内并发取用：换代新引擎（pid 424243）+ 新 context
    const handle2 = await engine.acquireContext('sess-A');
    expect(handle2.session.sessionId).toBe('SESS-1');
    expect(engine.getStatus()).toMatchObject({ state: 'running', attach: false });
    // 放行旧收场：只结算第一代（修复前红：teardown 读 this.child 现值 → killTree 打到 424243）
    fake.releaseHeld();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(424_242, expect.any(Function));
    expect(engine.getStatus().state).toBe('running'); // 修复前红：新引擎被旧收场拆走
    // 新引擎 context 簿记未被旧收场清走：同 session 复用不重建（新起 context 应答改值不命中）
    fake.responders['Target.createBrowserContext'] = () => ({ browserContextId: 'CTX-9' });
    const again = await engine.acquireContext('sess-A');
    expect(again.session.browserContextId).not.toBe('CTX-9'); // 复用第二代的 CTX-1
    await engine.dispose();
  });
});

/* ---------------- 刀二：捕获态 / a11y / 截图 / 工具面 ---------------- */

describe('browser 捕获态（capture 纯函数）', () => {
  it('ConsoleRing：帽 200 滚动挤出 + 最新在前读取', () => {
    const ring = new ConsoleRing();
    for (let i = 1; i <= 205; i++) {
      ring.push({ kind: 'console', level: 'log', text: `行${i}`, at: i });
    }
    const entries = ring.entries();
    expect(entries).toHaveLength(200);
    expect(entries[0]).toMatchObject({ seq: 205, text: '行205' }); // 最新在前
    expect(entries[199]).toMatchObject({ seq: 6 }); // 头部 5 条被挤出
  });

  it('applyCaptureEvent：console/异常三类入账 + level 归档（闭集外归 log）', () => {
    const capture = new SessionCapture();
    applyCaptureEvent(capture, 'Runtime.consoleAPICalled', {
      type: 'error',
      args: [
        { type: 'string', value: '炸了' },
        { type: 'number', value: 42 },
      ],
      timestamp: 1,
    });
    applyCaptureEvent(capture, 'Runtime.consoleAPICalled', { type: 'table', args: [], timestamp: 2 }); // 闭集外 → log
    applyCaptureEvent(capture, 'Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } },
    });
    const entries = capture.console.entries();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'exception', level: 'error', text: 'TypeError: x is not a function' });
    expect(entries[1]).toMatchObject({ kind: 'console', level: 'log', text: '(空)' });
    expect(entries[2]).toMatchObject({ kind: 'console', level: 'error', text: '炸了 42' });
  });

  it('applyCaptureEvent：dialog 入账 + dismiss 判定（纯函数零协议发送）', () => {
    const capture = new SessionCapture();
    const outcome = applyCaptureEvent(capture, 'Page.javascriptDialogOpening', { message: '确认？', type: 'confirm' });
    expect(outcome).toEqual({ dialog: { message: '确认？', type: 'confirm' } });
    expect(capture.console.entries()[0]).toMatchObject({ kind: 'dialog', text: '[confirm] 确认？（已自动 dismiss）' });
    // 未知事件静默（协议面宽进）
    expect(applyCaptureEvent(capture, 'Network.requestWillBeSent', {})).toBeUndefined();
    expect(capture.console.entries()).toHaveLength(1);
  });
});

describe('browser a11y 快照渲染（纯函数）', () => {
  /** 混合树 fixture：heading/button/匿名 div 套 paragraph/link/input（role/name/剪枝全覆盖） */
  const TREE: FlatDocNode[] = [
    { nodeId: 1, backendNodeId: 100, nodeType: 9, nodeName: '#document' },
    { nodeId: 2, backendNodeId: 101, nodeType: 1, nodeName: 'H1', parentId: 1 },
    { nodeId: 3, backendNodeId: 102, nodeType: 3, nodeName: '#text', nodeValue: 'Hello', parentId: 2 },
    { nodeId: 4, backendNodeId: 103, nodeType: 1, nodeName: 'BUTTON', parentId: 1, attributes: ['aria-label', '提交'] },
    { nodeId: 5, backendNodeId: 104, nodeType: 1, nodeName: 'DIV', parentId: 1 },
    { nodeId: 6, backendNodeId: 105, nodeType: 1, nodeName: 'P', parentId: 5 },
    { nodeId: 7, backendNodeId: 106, nodeType: 3, nodeName: '#text', nodeValue: '内层段落', parentId: 6 },
    { nodeId: 8, backendNodeId: 107, nodeType: 1, nodeName: 'A', parentId: 1, attributes: ['href', 'https://x/'] },
    { nodeId: 9, backendNodeId: 108, nodeType: 3, nodeName: '#text', nodeValue: '链接文字', parentId: 8 },
    {
      nodeId: 10,
      backendNodeId: 109,
      nodeType: 1,
      nodeName: 'INPUT',
      parentId: 1,
      attributes: ['type', 'text', 'placeholder', '搜索词'],
    },
  ];

  it('role/name 推导 + ref 标注 + 匿名 generic 剪枝（子树照递归）', () => {
    const snap = renderAccessibilitySnapshot(TREE);
    expect(snap.text.split('\n')).toEqual([
      'page',
      '  heading "Hello"',
      '  button "提交" @e0',
      '    paragraph "内层段落"', // 匿名 DIV 不出行，子节点照递归（深一层缩进）
      '  link "链接文字" @e1',
      '  textbox "搜索词" @e2', // name 链落 placeholder 档
    ]);
    expect(snap.refs).toEqual([
      { ref: '@e0', backendNodeId: 103, role: 'button', name: '提交' },
      { ref: '@e1', backendNodeId: 107, role: 'link', name: '链接文字' },
      { ref: '@e2', backendNodeId: 109, role: 'textbox', name: '搜索词' },
    ]);
    expect(snap.truncated).toBe(false);
  });

  it('aria role 属性优先于 tag 隐式映射；超帽截断置旗注记', () => {
    const ariaTree: FlatDocNode[] = [
      { nodeId: 1, backendNodeId: 200, nodeType: 9, nodeName: '#document' },
      { nodeId: 2, backendNodeId: 201, nodeType: 1, nodeName: 'DIV', parentId: 1, attributes: ['role', 'button'] },
    ];
    const aria = renderAccessibilitySnapshot(ariaTree);
    expect(aria.text).toContain('button @e0'); // 显式 role 胜过 div→generic
    expect(aria.refs[0]).toMatchObject({ role: 'button' });

    const tiny = renderAccessibilitySnapshot(TREE, 30); // 帽 30 字节——必然截断
    expect(tiny.truncated).toBe(true);
    expect(tiny.text).toContain('已截断');
  });
});

describe('browser 截图落盘（滚动清理）', () => {
  it('saveScreenshot：目录形态 + 保留帽滚动删旧', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-shots-'));
    const key = 'sess-A';
    // 写 22 张（超帽 2 张）——每张字节不同（mtime 同毫秒时 sort 稳定保插入序）
    for (let i = 1; i <= SCREENSHOTS_KEEP + 2; i++) {
      saveScreenshot(dataDir, key, i, Buffer.from(`png-${i}`));
    }
    const dir = join(dataDir, 'browser', 'screenshots', key);
    const files = readdirSync(dir);
    expect(files).toHaveLength(SCREENSHOTS_KEEP);
    // 最旧两张被删（shot-1/shot-2 不在场），最新在场且内容正确
    expect(files).not.toContain('shot-1.png');
    expect(files).not.toContain('shot-2.png');
    expect(readFileSync(join(dir, `shot-${SCREENSHOTS_KEEP + 2}.png`), 'utf8')).toBe(`png-${SCREENSHOTS_KEEP + 2}`);
    // sessionKey 净化（非法字符兜底替换——路径穿越防御位）
    saveScreenshot(dataDir, '../evil', 1, Buffer.from('x'));
    expect(existsSync(join(dataDir, 'browser', 'screenshots', '.._evil'))).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('browser 工具面（假引擎全链——mock 只停服务器边界）', () => {
  let fake: FakeCdpServer;
  let dataDir: string;
  /** 工具表（注册面收容——execute 直调〔管道在组合根测试面覆盖，此处验工具体〕） */
  let defs: Map<string, ToolDefinition>;
  let engine: BrowserEngine;

  beforeEach(async () => {
    fake = new FakeCdpServer();
    await fake.start();
    dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-tools-'));
    fake.responders = {
      'Target.createBrowserContext': () => ({ browserContextId: 'CTX-1' }),
      'Target.createTarget': () => ({ targetId: 'TGT-1' }),
      'Target.attachToTarget': () => ({ sessionId: 'SESS-1' }),
      // 页态读取（navigate/back/forward 结算腿）：完整态单发即结
      'Runtime.evaluate': () => ({
        result: { result: { value: JSON.stringify({ t: 'Example', u: 'https://example.com/page', r: 'complete' }) } },
      }),
    };
    engine = new BrowserEngine({
      dataDir,
      config: { executablePath: process.execPath },
      spawnEngine: ({ args }) => {
        const dir = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
        writeFileSync(join(dir, 'DevToolsActivePort'), `${fake.port}\n/devtools/browser/fake-uuid\n`);
        return { pid: 424_242, alive: () => true };
      },
      killTree: vi.fn(),
      registry: { add: vi.fn(), remove: vi.fn(), sweep: vi.fn(async () => ({ killed: [] })) },
      newConnection: (o) => new JsonRpcConnection(o),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Pick<AppLogger, 'debug' | 'info' | 'warn'>,
      notify: vi.fn(),
      idleMs: 60_000,
      startupTimeoutMs: 2_000,
    });
    defs = new Map();
    registerBrowserTools({
      service: {
        status: () => engine.getStatus(),
        acquireContext: (sessionId) => engine.acquireContext(sessionId),
        dispose: () => engine.dispose(),
      },
      dataDir,
      register: (def) => {
        defs.set(def.name, def);
        return () => defs.delete(def.name);
      },
      // DNS 注入缝（诚实假解析：IP 字面量原样过检〔私网判定走真路径〕，
      // 域名恒解析公网地址——零真网络依赖）
      dnsLookup: async (h) => [{ address: isIP(h) ? h : '93.184.216.34', family: 4 }],
    });
  });

  afterEach(async () => {
    await engine.dispose();
    await fake.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** 工具体直调助手（session 恒 sess-A——per-session 隔离路由同键） */
  const run = (name: string, args: Record<string, unknown> = {}) =>
    defs.get(name)!.execute(args, { toolCallId: 't-1', sessionId: 'sess-A' });

  /** 服务器收到的指定方法帧（params 面断言用） */
  const framesOf = (method: string) => fake.receivedFrames.filter((f) => f.method === method);

  it('注册面：十件齐 + 命名域 browser_ 前缀 + effect 分账（read/write）', () => {
    expect([...defs.keys()].sort()).toEqual([
      'browser_back',
      'browser_click',
      'browser_console',
      'browser_forward',
      'browser_navigate',
      'browser_press',
      'browser_screenshot',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
    ]);
    expect(defs.get('browser_navigate')).toMatchObject({ effect: 'read' });
    expect(defs.get('browser_snapshot')).toMatchObject({ effect: 'read' });
    expect(defs.get('browser_console')).toMatchObject({ effect: 'read' });
    expect(defs.get('browser_click')).toMatchObject({ effect: 'write' });
    expect(defs.get('browser_type')).toMatchObject({ effect: 'write' });
    // 缺省保守位：screenshot 未声明 effect 也应被注册面归一……本件显式声明 read（规范分账）
    expect(defs.get('browser_screenshot')).toMatchObject({ effect: 'read' });
  });

  it('navigate：SSRF 前置两律 + 正例全链（Page.navigate + 页态结算）', async () => {
    // 负例①：非 http(s) scheme → WEB_URL_INVALID（AppError 升——安全拦截身份）
    await expect(run('browser_navigate', { url: 'ftp://example.com/x' })).rejects.toSatisfy((err: unknown) => {
      return err instanceof AppError && err.code === 'WEB_URL_INVALID';
    });
    // 负例②：裸私网 IP → WEB_PRIVATE_TARGET（不经 DNS——IP 直判）
    await expect(run('browser_navigate', { url: 'https://192.168.1.1/admin' })).rejects.toSatisfy(
      (err: unknown) => err instanceof AppError && err.code === 'WEB_PRIVATE_TARGET',
    );
    // 卫生前置零协议帧（两负例不发任何 CDP 请求——拒绝先于引擎取用）
    expect(fake.receivedFrames).toHaveLength(0);

    const ok = await run('browser_navigate', { url: 'https://example.com/page' });
    expect(ok.isError).toBeUndefined();
    expect((ok.content[0] as { text: string }).text).toContain('已导航：https://example.com/page');
    expect((ok.content[0] as { text: string }).text).toContain('Example');
    const nav = framesOf('Page.navigate')[0]!;
    expect(nav.params).toEqual({ url: 'https://example.com/page' });
  });

  it('navigate：errorText 数据面（isError 自纠）；back/forward 历史行走与端点', async () => {
    fake.responders['Page.navigate'] = () => ({ frameId: 'F1', errorText: 'net::ERR_NAME_NOT_RESOLVED' });
    const bad = await run('browser_navigate', { url: 'https://example.com/page' });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toContain('net::ERR_NAME_NOT_RESOLVED');

    fake.responders['Page.navigate'] = () => ({ frameId: 'F1' });
    let currentIndex = 1; // 当前在 entries[1]（id 22）——后退可走、前进可走
    fake.responders['Page.getNavigationHistory'] = () => ({
      currentIndex,
      entries: [
        { id: 11, url: 'https://a/' },
        { id: 22, url: 'https://b/' },
        { id: 33, url: 'https://c/' },
      ],
    });
    const back = await run('browser_back');
    expect((back.content[0] as { text: string }).text).toContain('已后退');
    expect(framesOf('Page.navigateToHistoryEntry')[0]!.params).toEqual({ entryId: 11 });
    const fwd = await run('browser_forward');
    expect((fwd.content[0] as { text: string }).text).toContain('已前进');
    expect(framesOf('Page.navigateToHistoryEntry')[1]!.params).toEqual({ entryId: 33 });
    currentIndex = 2; // 当前在最末 entry——前进即端点
    const stuck = await run('browser_forward');
    expect(stuck.isError).toBe(true);
    expect((stuck.content[0] as { text: string }).text).toContain('历史最末端');
  });

  it('snapshot → click/type 全链：ref 表换代 + 盒中心坐标派', async () => {
    fake.responders['DOM.getFlattenedDocumentTree'] = () => ({
      nodes: [
        { nodeId: 1, backendNodeId: 100, nodeType: 9, nodeName: '#document' },
        {
          nodeId: 4,
          backendNodeId: 103,
          nodeType: 1,
          nodeName: 'BUTTON',
          parentId: 1,
          attributes: ['aria-label', '提交'],
        },
        { nodeId: 10, backendNodeId: 109, nodeType: 1, nodeName: 'INPUT', parentId: 1, attributes: ['type', 'text'] },
      ],
    });
    const snap = await run('browser_snapshot');
    expect((snap.content[0] as { text: string }).text).toContain('button "提交" @e0');
    // ref 表已入捕获态（engine 事件路由同源消费面）
    const handle = await engine.acquireContext('sess-A');
    expect(handle.capture.refs.get('@e0')).toMatchObject({ backendNodeId: 103 });

    fake.responders['DOM.getBoxModel'] = () => ({ model: { quad: [0, 0, 100, 0, 100, 40, 0, 40] } });
    const click = await run('browser_click', { ref: '@e0' });
    expect((click.content[0] as { text: string }).text).toContain('已点击 button "提交"');
    const mice = framesOf('Input.dispatchMouseEvent');
    expect(mice).toHaveLength(2);
    expect(mice[0]!.params).toMatchObject({ type: 'mousePressed', x: 50, y: 20, button: 'left', clickCount: 1 });
    expect(mice[1]!.params).toMatchObject({ type: 'mouseReleased', x: 50, y: 20 });

    const type = await run('browser_type', { ref: '@e1', text: '你好 world' });
    expect((type.content[0] as { text: string }).text).toContain('已向 textbox');
    expect(framesOf('Input.insertText')[0]!.params).toEqual({ text: '你好 world' });

    // ref miss = 语义失败数据面（快照未含 @e9）
    const miss = await run('browser_click', { ref: '@e9' });
    expect(miss.isError).toBe(true);
    expect((miss.content[0] as { text: string }).text).toContain('不在最近快照');
  });

  it('press：白名单执法 + 组合键 modifiers 位 + 三事件合成', async () => {
    const combo = await run('browser_press', { key: 'Control+A' });
    expect(combo.isError).toBeUndefined();
    const keys = framesOf('Input.dispatchKeyEvent');
    expect(keys).toHaveLength(2);
    expect(keys[0]!.params).toMatchObject({ type: 'keyDown', key: 'A', code: 'KeyA', modifiers: 2, text: 'A' });
    expect(keys[1]!.params).toMatchObject({ type: 'keyUp', key: 'A', modifiers: 2 });
    // Enter 走 keyDown + text '\r'（表单提交 keypress 合成）
    fake.receivedFrames.length = 0;
    await run('browser_press', { key: 'Enter' });
    const enter = framesOf('Input.dispatchKeyEvent')[0]!;
    expect(enter.params).toMatchObject({ type: 'keyDown', key: 'Enter', text: '\r' });
    // 白名单外（F 键）= 语义失败数据面
    const bad = await run('browser_press', { key: 'F5' });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toContain('未知键名');
  });

  it('scroll：四向距离派（yDistance 正 = 向下）', async () => {
    const ok = await run('browser_scroll', { direction: 'down' });
    expect((ok.content[0] as { text: string }).text).toContain('向下滚动 600px');
    expect(framesOf('Input.synthesizeScrollGesture')[0]!.params).toMatchObject({ xDistance: 0, yDistance: 600 });
    await run('browser_scroll', { direction: 'left', amount: 300 });
    expect(framesOf('Input.synthesizeScrollGesture')[1]!.params).toMatchObject({ xDistance: 300 });
  });

  it('screenshot：PNG 落盘（字节不进结果）+ 逐会话滚动保留', async () => {
    fake.responders['Page.captureScreenshot'] = () => ({ data: Buffer.from('fakepng').toString('base64') });
    const shot = await run('browser_screenshot');
    const path = (shot.details as { path: string }).path;
    expect(path).toContain(join(dataDir, 'browser', 'screenshots', 'sess-A'));
    expect(readFileSync(path, 'utf8')).toBe('fakepng'); // 字节在盘
    expect((shot.content[0] as { text: string }).text).not.toContain('fakepng'); // 不进对话文本
    // 滚动清理（帽 20——连拍 22 张只余 20）
    for (let i = 0; i < 21; i++) await run('browser_screenshot');
    expect(readdirSync(join(dataDir, 'browser', 'screenshots', 'sess-A'))).toHaveLength(SCREENSHOTS_KEEP);
  });

  it('console：事件路由入账 + dialog 自动 dismiss 回发 + 读取面', async () => {
    // 先起 context（Runtime/Page enable + 捕获态挂载）
    await run('browser_console');
    fake.pushEvent('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: '第一条' }] }, 'SESS-1');
    fake.pushEvent(
      'Runtime.exceptionThrown',
      { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } } },
      'SESS-1',
    );
    fake.pushEvent('Page.javascriptDialogOpening', { message: '确认？', type: 'confirm' }, 'SESS-1');
    // dialog dismiss 回发（引擎路由层持 rpc——accept:false）
    await vi.waitFor(() => expect(framesOf('Page.handleJavaScriptDialog').length).toBe(1));
    expect(framesOf('Page.handleJavaScriptDialog')[0]!.params).toEqual({ accept: false });

    const out = await run('browser_console', { level: 'error' });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('TypeError: boom');
    expect(text).not.toContain('第一条'); // level 过滤
    // 未过滤全量：dialog 记账行在场（最新在前——异常序次最高）
    const all = await run('browser_console');
    const allText = (all.content[0] as { text: string }).text;
    expect(allText.indexOf('dialog')).toBeLessThan(allText.indexOf('exception'));
    expect(allText.indexOf('exception')).toBeLessThan(allText.indexOf('console'));
    // context 建立即 enable 两域（事件源前提）
    expect(framesOf('Runtime.enable')).toHaveLength(1);
    expect(framesOf('Page.enable')).toHaveLength(1);
  });

  it('refs 换代：第二次快照后旧 ref 失效（跨快照混用禁）', async () => {
    fake.responders['DOM.getFlattenedDocumentTree'] = () => ({
      nodes: [
        { nodeId: 1, backendNodeId: 100, nodeType: 9, nodeName: '#document' },
        {
          nodeId: 4,
          backendNodeId: 103,
          nodeType: 1,
          nodeName: 'BUTTON',
          parentId: 1,
          attributes: ['aria-label', '提交'],
        },
      ],
    });
    await run('browser_snapshot');
    fake.responders['DOM.getFlattenedDocumentTree'] = () => ({ nodes: [] }); // 空文档——ref 表清空换代
    await run('browser_snapshot');
    fake.responders['DOM.getBoxModel'] = () => ({ model: { quad: [0, 0, 1, 0, 1, 1, 0, 1] } });
    const stale = await run('browser_click', { ref: '@e0' });
    expect(stale.isError).toBe(true);
    expect((stale.content[0] as { text: string }).text).toContain('不在最近快照');
  });
});
