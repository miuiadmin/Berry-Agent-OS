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
import { afterEach, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcConnection } from '../mcp/index.js';
import type { AppLogger } from '../contracts/app.js';
import type { AppContext } from '../contracts/app.js';
import { AppError, BROWSER_ENGINE_NOT_FOUND, BROWSER_NODE_UNSUPPORTED, describeError } from '../contracts/errors.js';
import type { ToolDefinition } from '../contracts/tools.js';
import { CdpConnection, disposeSessionContext, fetchVersionInfo, openSessionContext } from './cdp.js';
import { discoverEngine } from './discover.js';
import { BrowserEngine, nodeVersionProblem } from './engine.js';
import { applyCaptureEvent, ConsoleRing, SessionCapture } from './capture.js';
import { renderAccessibilitySnapshot, type FlatDocNode } from './a11y.js';
import { saveScreenshot, SCREENSHOTS_KEEP } from './screenshots.js';

/* ---------------- 临时目录登记簿（基建大扫 #16 同族顺手收口） ---------------- */

/**
 * 本测试文件建的临时目录登记簿（berry-browser-engine-* / berry-browser-test-*）：
 * 此前每用例 mkdtemp 后仅少数用例自行 rmSync——全量跑一次漏 30+ 目录（本机实证
 * 48 个在册）。统一模型：建目录一律走登记 helper，文件级 afterAll 全清（vitest
 * 文件级钩子对所有 describe 生效；force 容忍用例内已自清的重复删）。
 */
const browserTmpDirs: string[] = [];

/** 建一个引擎 dataDir 临时根并登记（用例内仍可自行提前 rmSync——重复删无害） */
const makeEngineDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'berry-browser-engine-'));
  browserTmpDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of browserTmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不红测试（残留可容忍——与 smoke 脚本流末清理同拍）
    }
  }
});
import { registerBrowserTools } from './tools.js';
import { createBrowserApp } from './app.js';

/** 测试面 no-op 限流桩（无限流语义——组合根单例共享行为由 builtin-deps 面断言） */
const NOOP_GATES = { acquire: () => Promise.resolve(), release: () => undefined };

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

  /**
   * 推一条 binary 帧（opcode 0x2——定向复扫 20260902 第七轮 L-1 杂音口测试面：
   * CDP 协议恒文本帧，binary 属异常形态，消费侧须走杂音口可见非静默丢弃）。
   * 测试面载荷 ≤125 字节（单帧小长度形——无需扩展长度编码）。
   */
  pushBinary(payload: Buffer): void {
    const frame = Buffer.concat([Buffer.from([0x82, payload.length]), payload]);
    for (const socket of this.sockets) socket.write(frame);
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
    // browser 自报名以 '(endpoint)' 字面量回填（#21 注释-实现对齐锁——直用形态
    // 无 HTTP 探测即无自报名，占位形态是消费面〔attach 通知〕的取值语义）
    expect(direct.browser).toBe('(endpoint)');
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
  /** 临时目录（每用例新开——测试污染隔离纪律：绝不触真 ~/.berry；登记入簿随 afterAll 清） */
  const makeTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'berry-browser-test-'));
    browserTmpDirs.push(dir);
    return dir;
  };

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
    /** spawn pid 序列（缺省恒 424242——代际竞速腿第二次 spawn 换新 pid；元素
     *  显式 undefined = spawn 失败腿〔EACCES/ENOEXEC——child.pid undefined〕，
     *  全面复盘 20260903 #18 红锁用；序列短于 spawn 次数仍回缺省值） */
    pids?: Array<number | undefined>;
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
        // pid 序列取值：显式 undefined 原样透传（spawn 失败腿——不可 ?? 兜底
        // 回真值，否则 #18 红锁测不到失败形态）；序列短于次数回缺省值
        const pidSeq = opts.pids;
        const pid = pidSeq !== undefined && spawnCount - 1 < pidSeq.length ? pidSeq[spawnCount - 1] : 424_242;
        return { pid, alive: opts.alive ?? (() => true) };
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
    const dataDir = makeEngineDir();
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

  it('spawn 无 pid 形（不可执行引擎腿）：不入登记簿、起链失败清算不树杀不净退（全面复盘 20260903 #18——pid 哨兵毒化）', async () => {
    const dataDir = makeEngineDir();
    const { engine, killTree, registry } = makeEngine({
      dataDir,
      idleMs: 60_000,
      pids: [undefined], // spawn 失败腿：引擎路径在盘但 EACCES/ENOEXEC——child.pid undefined
      alive: () => false, // 启动即死：waitForDevToolsPort 首轮即拒（不烧 20s 超帽）
    });
    // 修前红（`?? -1` 哨兵形态）：childPid:-1 入 children.json 死账 + teardown
    // killTree(-1)（POSIX kill(-pid) 收 -1 归一 kill(1) = 杀 init/自身）+
    // remove(-1)；修后（pid undefined 判缺席）三面全静默——契约篇 §6.10 ⑧
    await expect(engine.acquireContext('sess-A')).rejects.toThrow();
    expect(registry.add).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
    expect(registry.remove).not.toHaveBeenCalled();
  });

  it('两级闲置回收：context 闲置 dispose → 零活 context 引擎闲置收场（树杀+净退）', async () => {
    const dataDir = makeEngineDir();
    const { engine, killTree, registry } = makeEngine({ dataDir, idleMs: 70 });
    await engine.acquireContext('sess-A');
    expect(engine.getStatus().state).toBe('running');

    // context 级闲置（~70ms）→ dispose context；引擎闲置钟起算（再 ~70ms）→ 引擎收场
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(engine.getStatus().state).toBe('closed');
    expect(killTree).toHaveBeenCalledWith(424_242);
    expect(registry.remove).toHaveBeenCalledWith(424_242);

    // disposeBrowserContext 已发（context 回收腿物证）
    const disposes = fake.receivedFrames.filter((f) => f.method === 'Target.disposeBrowserContext');
    expect(disposes).toHaveLength(1);
    // 对照面：spawn 形态收场必发 Browser.close（attach 只断连 ≠ 全形态都不发）
    expect(fake.receivedFrames.filter((f) => f.method === 'Browser.close')).toHaveLength(1);
  });

  it('续命语义：反复取用只续命本 session——他 session 不被牵连闲置', async () => {
    const dataDir = makeEngineDir();
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
    const dataDir = makeEngineDir();
    const { engine } = makeEngine({ dataDir, idleMs: 60_000 });
    await engine.acquireContext('sess-A');
    await engine.dispose();
    expect(engine.getStatus().state).toBe('closed');
    await expect(engine.acquireContext('sess-A')).rejects.toThrow('已回卷');
  });

  it('#5 dispose×在飞 bringUp 竞速：起链窗内回卷——起出即收不留僵尸，取用响亮失败', async () => {
    const dataDir = makeEngineDir();
    const killTree = vi.fn();
    const registry = { add: vi.fn(), remove: vi.fn(), sweep: vi.fn(async () => ({ killed: [] as number[] })) };
    // 手动闸：spawn 先发生（child 已在册）但 DevToolsActivePort 延后写——bringUp
    // 停在端口轮询窗（this.starting 在飞、连接未收养——竞速现场的最小复刻）
    let releasePortFile!: () => void;
    const portGate = new Promise<void>((resolve) => (releasePortFile = resolve));
    const engine = new BrowserEngine({
      dataDir,
      config: { executablePath: process.execPath },
      spawnEngine: ({ args }) => {
        const dir = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
        void portGate.then(() => {
          writeFileSync(join(dir, 'DevToolsActivePort'), `${fake.port}\n/devtools/browser/fake-uuid\n`);
        });
        return { pid: 424_242, alive: () => true };
      },
      killTree,
      registry,
      newConnection: (o) => new JsonRpcConnection(o),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Pick<AppLogger, 'debug' | 'info' | 'warn'>,
      notify: vi.fn(),
      idleMs: 60_000, // 拉满——僵尸滞留只能靠竞速收口解决，不靠闲置钟兜底
      startupTimeoutMs: 2_000,
    });

    const acquiring = engine.acquireContext('sess-A'); // 在飞（不 await——停在端口轮询）
    await vi.waitFor(() => expect(registry.add).toHaveBeenCalled()); // spawn 已发生
    const disposing = engine.dispose(); // 回卷（不 await——修后停在 await this.starting；修前即刻返回空转）
    releasePortFile(); // 放行：bringUp 完成（收养连接 → running）
    // 修前红位①：acquireContext 拿到活句柄（向已回卷行返回）——rejects 等不到
    await expect(acquiring).rejects.toThrow('已回卷');
    await disposing;
    // 修前红位②：closeEngine 对未收养连接早退——树杀/净退全空，Chrome 滞留闲置双钟
    expect(killTree).toHaveBeenCalledWith(424_242);
    expect(registry.remove).toHaveBeenCalledWith(424_242);
    expect(engine.getStatus().state).toBe('closed');
  });

  it('attach 形态：只连不杀（零 spawn/登记簿/树杀）', async () => {
    const dataDir = makeEngineDir();
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
    const dataDir = makeEngineDir();
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
    const dataDir = makeEngineDir();
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
    expect(killTree).toHaveBeenCalledWith(424_242);
    expect(registry.remove).toHaveBeenCalledWith(424_242);
    expect(engine.getStatus().state).toBe('closed');
  });

  it('#2/#7/#9 起链失败即清算（超帽腿）：DevToolsActivePort 超帽 → AppError + 清算同腿', async () => {
    const dataDir = makeEngineDir();
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
    expect(killTree).toHaveBeenCalledWith(424_242); // 修复前红
    expect(registry.remove).toHaveBeenCalledWith(424_242); // 修复前红
    expect(engine.getStatus().state).toBe('closed'); // 修复前红：谎报 starting
  });

  it('#3 context 建链半途失败回滚：enable 失败不留半捕获——重试走全链重建', async () => {
    const dataDir = makeEngineDir();
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
    const dataDir = makeEngineDir();
    const { engine, killTree } = makeEngine({ dataDir, idleMs: 70 });
    // openSessionContext 首步即炸（三表未挂——闲置钟被 acquire 入场撤防后无人重武装的腿）
    fake.errorResponders['Target.createBrowserContext'] = { code: -32_000, message: 'no-context' };
    await expect(engine.acquireContext('sess-A')).rejects.toThrow('no-context');
    delete fake.errorResponders['Target.createBrowserContext'];
    // 引擎 running 但零活 context——闲置钟应照常武装（~70ms 后收场树杀）
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(engine.getStatus().state).toBe('closed'); // 修复前红：running 悬死（闲置钟永久失防）
    expect(killTree).toHaveBeenCalledWith(424_242);
  });

  it('#17 收场代际护栏：closeEngine await 窗内换代——新引擎不被旧收场误杀', async () => {
    const dataDir = makeEngineDir();
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
    expect(killTree).toHaveBeenCalledWith(424_242);
    expect(engine.getStatus().state).toBe('running'); // 修复前红：新引擎被旧收场拆走
    // 新引擎 context 簿记未被旧收场清走：同 session 复用不重建（新起 context 应答改值不命中）
    fake.responders['Target.createBrowserContext'] = () => ({ browserContextId: 'CTX-9' });
    const again = await engine.acquireContext('sess-A');
    expect(again.session.browserContextId).not.toBe('CTX-9'); // 复用第二代的 CTX-1
    await engine.dispose();
  });

  // 【遗漏大扫 20260901-c #23】起链失败腿不得抢别代 tornDown 闸位：旧代收场
  // await 窗内并发换代起链失败时，失败腿传 this.connection 现值（= 别代连接）进
  // teardownGeneration——别代连接被标进幂等闸，旧代自身收场两腿（onDead/显式）
  // 均早退，旧 child 的树杀与登记簿净退被吞。修复：失败腿 conn 恒传 undefined
  //（本代从未收养连接）+ 共享引用护栏三判据分立。修复前红：killTree 打不到
  // 424242（旧代漏杀）、remove(424242) 不发生——两代各清各的账。
  it('#23 起链失败腿不抢别代闸位：旧收场窗内新起链失败——两代 child 各自树杀净退', async () => {
    const dataDir = makeEngineDir();
    // 可变配置（makeEngine 的 noPortFile/alive 在 spawnEngine 回调内惰性求值——
    // 两代之间翻面即得「第二代启动即死」形态，第一代照常起）
    const cfg: Parameters<typeof makeEngine>[0] = {
      dataDir,
      idleMs: 250,
      pids: [424_242, 424_243, 424_244],
    };
    const { engine, killTree, registry } = makeEngine(cfg);
    await engine.acquireContext('sess-A'); // 第一代引擎（pid 424242）
    // 扣押 Browser.close 应答：闲置两跳后 closeEngine 进 await 窗（#17 同款编排）
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
    // 窗内并发取用：第二代 spawn 即死（alive 恒 false + 端口文件不写——引擎先死腿）
    cfg.alive = () => false;
    cfg.noPortFile = true;
    let err: unknown;
    try {
      await engine.acquireContext('sess-A');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError); // 第二代失败腿本身清算正确（#2/#9 语义）
    expect(describeError(err)).toContain('BROWSER_CONNECT_FAILED');
    expect(killTree).toHaveBeenCalledWith(424_243); // 本代 child 即杀
    // 放行旧收场：第一代必须仍被清算（修复前红：闸位被失败腿抢占 → 两腿早退，
    // 424242 永不树杀、登记簿留尸）
    fake.releaseHeld();
    await until(() => killTree.mock.calls.some((c) => c[0] === 424_242));
    expect(killTree).toHaveBeenCalledTimes(2); // 两代各恰一次（修复前 = 1：只有 424243）
    expect(killTree).toHaveBeenCalledWith(424_242);
    expect(registry.remove).toHaveBeenCalledWith(424_242);
    expect(registry.remove).toHaveBeenCalledWith(424_243);
    // 引用面收干净（三判据分立的红面：conn 未清会卡 status 复位）
    expect(engine.getStatus().state).toBe('closed');
    // 下一调用照常复活（无楔死）：第三代（pid 424244）正常起
    cfg.alive = () => true;
    cfg.noPortFile = false;
    const handle3 = await engine.acquireContext('sess-A');
    expect(handle3.session.sessionId).toBe('SESS-1');
    expect(engine.getStatus().state).toBe('running');
    await engine.dispose();
  });

  // 【遗漏大扫 20260901-d #17】失败起链腿状态回放：旧代 closeEngine 的
  // Browser.close await 窗（应答扣押）内新代起链失败——复位合取因旧连接在位
  // 不成立，修复前 status 残留新代所置 starting（≤2s 窗诊断面谎报，旧代清算
  // 落位才自愈）。修复：失败腿 teardown 后按 bringUp 入口快照回放（窗内入口值
  // = 旧代先置的 closed）。
  it('#17 失败起链腿状态回放：旧收场 await 窗内新起链失败——窗内不谎报 starting', async () => {
    const dataDir = makeEngineDir();
    const cfg: Parameters<typeof makeEngine>[0] = {
      dataDir,
      idleMs: 250,
      pids: [424_242, 424_243, 424_244],
    };
    const { engine, killTree } = makeEngine(cfg);
    await engine.acquireContext('sess-A'); // 第一代引擎（pid 424242）
    // 扣押 Browser.close 应答：闲置两跳后 closeEngine 进 await 窗（#23 同款编排）
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
    // 窗内并发取用：第二代 spawn 即死（引擎先死腿——首次 poll 即拒，毫秒级快败）
    cfg.alive = () => false;
    cfg.noPortFile = true;
    await expect(engine.acquireContext('sess-A')).rejects.toThrow();
    // ★ 窗内状态面（旧代清算仍扣押未落位）：不得谎报 starting——修复前红
    expect(engine.getStatus().state).toBe('closed');
    // 放行旧收场：第一代照常清算（两代各清各的账——#23 语义不回归）
    fake.releaseHeld();
    await until(() => killTree.mock.calls.some((c) => c[0] === 424_242));
    expect(engine.getStatus().state).toBe('closed');
    // 下一调用照常复活（回放不楔死起链）：第三代正常起
    cfg.alive = () => true;
    cfg.noPortFile = false;
    const handle3 = await engine.acquireContext('sess-A');
    expect(handle3.session.sessionId).toBe('SESS-1');
    expect(engine.getStatus().state).toBe('running');
    await engine.dispose();
  });
  // process.versions.node ≥ 24——不达标落 BROWSER_NODE_UNSUPPORTED，且闸在
  // spawn/连接之前：零野进程、零半建态、status 不谎报 starting（保持 idle，
  // 修复后升级 Node 再调即重试）。修复前红：无闸——spawn 照走，WebSocket
  // 全局缺席以裸 ReferenceError 形态晚爆，留下不可理解的半建现场。
  it('#15 运行时版本闸：Node < 24 起链前拒——BROWSER_NODE_UNSUPPORTED + 零 spawn', async () => {
    const dataDir = makeEngineDir();
    let spawns = 0;
    const { engine } = makeEngine({
      dataDir,
      idleMs: 60_000, // 闸测试不依赖闲置钟——长钟防干扰
      onSpawn: () => {
        spawns += 1;
      },
    });
    // process.versions.node 描述符只读（writable:false，直接赋值静默无操作）——
    // defineProperty 换值（configurable:true），finally 还原防污染同进程后续测试
    const realNode = process.versions.node;
    Object.defineProperty(process.versions, 'node', { value: '20.11.0', configurable: true });
    try {
      await expect(engine.acquireContext('sess-A')).rejects.toSatisfy((e: unknown) => {
        return e instanceof AppError && e.code === BROWSER_NODE_UNSUPPORTED;
      });
      expect(spawns).toBe(0); // 闸先于 spawn——引擎可执行从未起（零野进程）
      expect(engine.getStatus().state).toBe('idle'); // 不谎报 starting——status 原地可重试
    } finally {
      Object.defineProperty(process.versions, 'node', { value: realNode, configurable: true });
    }
    await engine.dispose();
  });

  // 【遗漏大扫 20260901-b #23】并发去重：ensureRunning 以 starting promise 缓存
  // 共享——同时首用只 spawn 一次。修复前红面：去重若失效（如 starting 被同步
  // 清空），双 spawn 双引擎 = profile 双开 + 登记簿双条目。
  it('#23 并发去重：同时首用只 spawn 一次（starting promise 共享）', async () => {
    const dataDir = makeEngineDir();
    const spawnArgs: string[][] = [];
    const { engine } = makeEngine({
      dataDir,
      idleMs: 60_000,
      onSpawn: (args) => spawnArgs.push([...args]),
    });
    // 双路并发首用（同 session 两调用 + 异 session 一路——三路同抢起链窗；
    // 第三路只参与竞抢不断言结果——解构不绑 c）
    const [a, b] = await Promise.all([
      engine.acquireContext('sess-A'),
      engine.acquireContext('sess-A'),
      engine.acquireContext('sess-B'),
    ]);
    expect(spawnArgs).toHaveLength(1); // 只一次 spawn（去重成功）
    expect(a.session.sessionId).toBe('SESS-1');
    expect(b.session.sessionId).toBe('SESS-1'); // 同 session 复用同一 context
    // 三路都拿到活引擎
    expect(engine.getStatus().state).toBe('running');
    await engine.dispose();
  });

  // 【遗漏大扫 20260901-b #23】起链失败重试腿：starting 在 finally 清空——失败
  // 后下一调用照常复活（不是永久失败态）。
  it('#23 起链失败重试：starting 清空——首次引擎先死后第二次照常起链', async () => {
    const dataDir = makeEngineDir();
    // 可变活性开关：第一次 spawn 即死（不写端口文件），第二次写端口文件成功
    let healthy = false;
    let spawnCount = 0;
    const engine = new BrowserEngine({
      dataDir,
      config: { executablePath: process.execPath },
      spawnEngine: ({ args }) => {
        spawnCount += 1;
        const dir = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
        if (healthy) {
          writeFileSync(join(dir, 'DevToolsActivePort'), `${fake.port}\n/devtools/browser/fake-uuid\n`);
        }
        return { pid: 424_242 + spawnCount, alive: () => healthy };
      },
      killTree: vi.fn(),
      registry: { add: vi.fn(), remove: vi.fn(), sweep: vi.fn(async () => ({ killed: [] })) },
      newConnection: (o) => new JsonRpcConnection(o),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Pick<AppLogger, 'debug' | 'info' | 'warn'>,
      notify: vi.fn(),
      idleMs: 60_000,
      startupTimeoutMs: 2_000,
    });
    await expect(engine.acquireContext('sess-A')).rejects.toBeInstanceOf(AppError); // 引擎先死腿
    healthy = true;
    const handle = await engine.acquireContext('sess-A'); // 重试照常复活
    expect(handle.session.sessionId).toBe('SESS-1');
    expect(engine.getStatus().state).toBe('running');
    expect(spawnCount).toBe(2);
    await engine.dispose();
  });

  // 【遗漏大扫 20260901-b #23】多会话事件分流：attachToTarget 按 target 派不同
  // sessionId——B 会话 console 不串入 A（keyByCdpSession 反查表多条目形态）。
  // 修复前不可测形态：responder 恒返单一 sessionId，反查表恒单条目（同键覆盖）。
  it('#23 多会话事件分流：B 会话 console 只进 B 捕获态（反查表多条目）', async () => {
    const dataDir = makeEngineDir();
    const { engine } = makeEngine({ dataDir, idleMs: 60_000 });
    // per-target 派发 sessionId（真 CDP 语义：flat sessionId per attach）
    let tgtSeq = 0;
    fake.responders['Target.createTarget'] = () => ({ targetId: `TGT-${(tgtSeq += 1)}` });
    fake.responders['Target.attachToTarget'] = (p) => ({ sessionId: `SESS-${(p as { targetId: string }).targetId}` });
    const a = await engine.acquireContext('sess-A');
    const b = await engine.acquireContext('sess-B');
    expect(a.session.sessionId).toBe('SESS-TGT-1');
    expect(b.session.sessionId).toBe('SESS-TGT-2'); // 反查表两条目（不再同键覆盖）
    // B 会话事件：只入 B 的捕获态——A 缓冲零串扰（帧到达窗同既有事件测试——
    // WS 帧→桥解析→入账是异步 I/O 链，先等帧落账再断言）
    fake.pushEvent(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'B 的输出' }] },
      'SESS-TGT-2',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bEntries = b.capture.console.entries();
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0]).toMatchObject({ kind: 'console', text: 'B 的输出' });
    expect(a.capture.console.entries()).toHaveLength(0); // 修复前红形态：恒单条目时 B 事件串入 A
    await engine.dispose();
  });

  // 【遗漏大扫 20260901-b #26】双配冲突闸：cdpEndpoint×executablePath 同给 =
  // 配置错 fail-loud（规范条款执法位）。修复前红：静默走 attach 丢弃
  // executablePath——用户自配引擎路径被无声吞掉。
  it('#26 双配冲突闸：cdpEndpoint×executablePath 同给 → BROWSER_CONFIG_CONFLICT + 零 spawn 零连接', async () => {
    const dataDir = makeEngineDir();
    let spawns = 0;
    const engine = new BrowserEngine({
      dataDir,
      config: { cdpEndpoint: `127.0.0.1:${fake.port}`, executablePath: process.execPath }, // 双配
      spawnEngine: () => {
        spawns += 1;
        throw new Error('不应 spawn');
      },
      killTree: vi.fn(),
      registry: { add: vi.fn(), remove: vi.fn(), sweep: vi.fn(async () => ({ killed: [] })) },
      newConnection: (o) => new JsonRpcConnection(o),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Pick<AppLogger, 'debug' | 'info' | 'warn'>,
      notify: vi.fn(),
      idleMs: 60_000,
    });
    await expect(engine.acquireContext('sess-A')).rejects.toSatisfy((e: unknown) => {
      return e instanceof AppError && e.code === 'BROWSER_CONFIG_CONFLICT';
    });
    expect(spawns).toBe(0); // 闸在 spawn/attach 之前——两形态都未触达
    expect(engine.getStatus().state).toBe('idle'); // 不谎报 starting——改配置后原地重试
    // 对照：真 CDP 服务器全程零请求（attach 腿也没走）
    expect(fake.receivedFrames).toHaveLength(0);
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
      gates: NOOP_GATES,
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

  it('snapshot → click/type 全链：ref 表换代 + 盒中心坐标派（真机形状：getFlattenedDocument + border 四角 + 先滚入视口）', async () => {
    fake.responders['DOM.getFlattenedDocument'] = () => ({
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

    // 真 Chrome BoxModel 录制形状（六键 content/padding/border/margin/width/height——无 quad 键；
    // border 四角 [0,0,100,0,100,40,0,40] 中心 = 50,20）——第九轮全面复盘 #3：假服务器照代码反推
    // 造 quad 键 = 测试资产共谋，红锁必须用真机键名
    fake.responders['DOM.getBoxModel'] = () => ({
      model: {
        content: [8, 3, 92, 3, 92, 37, 8, 37],
        padding: [4, 0, 96, 0, 96, 40, 4, 40],
        border: [0, 0, 100, 0, 100, 40, 0, 40],
        margin: [-8, -8, 108, -8, 108, 48, -8, 48],
        width: 100,
        height: 40,
      },
    });
    const click = await run('browser_click', { ref: '@e0' });
    expect((click.content[0] as { text: string }).text).toContain('已点击 button "提交"');
    // #11：点击前先滚入视口（折叠线外 dispatchMouseEvent 真机零派发零报错——静默假成功防线）；
    // backendNodeId 锚 + 帧序在鼠标帧之前
    const scrollIn = framesOf('DOM.scrollIntoViewIfNeeded');
    expect(scrollIn[0]!.params).toEqual({ backendNodeId: 103 });
    const mice = framesOf('Input.dispatchMouseEvent');
    expect(mice).toHaveLength(2);
    expect(fake.receivedFrames.indexOf(scrollIn[0]!)).toBeLessThan(fake.receivedFrames.indexOf(mice[0]!));
    expect(mice[0]!.params).toMatchObject({ type: 'mousePressed', x: 50, y: 20, button: 'left', clickCount: 1 });
    expect(mice[1]!.params).toMatchObject({ type: 'mouseReleased', x: 50, y: 20 });

    const type = await run('browser_type', { ref: '@e1', text: '你好 world' });
    expect((type.content[0] as { text: string }).text).toContain('已向 textbox');
    expect(framesOf('Input.insertText')[0]!.params).toEqual({ text: '你好 world' });
    // type 同律前置滚入视口（@e1 = INPUT 节点 backendNodeId 109）
    expect(framesOf('DOM.scrollIntoViewIfNeeded')[1]!.params).toEqual({ backendNodeId: 109 });

    // ref miss = 语义失败数据面（快照未含 @e9）
    const miss = await run('browser_click', { ref: '@e9' });
    expect(miss.isError).toBe(true);
    expect((miss.content[0] as { text: string }).text).toContain('不在最近快照');
  });

  // 【遗漏大扫 20260901-b #22】无盒模型语义失败分支：ref 仍在表但元素已隐藏/
  // 移除（快照后页面变化——浏览自动化最高频竞态后果路）。修复前红：该 throw
  // 全测试面零触达——若误把坏 quad 当合法坐标，会派 NaN 坐标点击（静默错误
  // 坐标）而非 isError 自纠指引。
  it('#22 click/type 无盒分支：坏 border（空模型/短 border/非数值）→ isError 自纠 + 零鼠标派发', async () => {
    fake.responders['DOM.getFlattenedDocument'] = () => ({
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
    // 三种坏形态逐一（覆盖分支的全部拒绝子条件）：无 border / 长度不足 / 非数值
    for (const model of [{}, { border: [0, 0, 100, 0] }, { border: [0, 0, 100, 0, 100, 40, 0, 'x'] }]) {
      fake.responders['DOM.getBoxModel'] = () => ({ model });
      fake.receivedFrames.length = 0; // 每轮清面——零鼠标派发断言按轮验
      const bad = await run('browser_click', { ref: '@e0' });
      expect(bad.isError).toBe(true);
      expect((bad.content[0] as { text: string }).text).toContain('无盒模型');
      expect((bad.content[0] as { text: string }).text).toContain('重拍快照'); // 自纠指引在场
      expect(framesOf('Input.dispatchMouseEvent')).toHaveLength(0); // 不派 NaN 坐标
    }
    // type 同路（聚焦点击前同一 refBoxCenter——同样拦在鼠标派发之前）
    fake.responders['DOM.getBoxModel'] = () => ({ model: {} });
    const badType = await run('browser_type', { ref: '@e0', text: 'x' });
    expect(badType.isError).toBe(true);
    expect((badType.content[0] as { text: string }).text).toContain('无盒模型');
    expect(framesOf('Input.insertText')).toHaveLength(0);
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

  it('scroll：四向距离派（协议 yDistance 正 = 向上滚——真机勘正 #10）+ 页面锚点回读（#11——规范工具表 scroll 行 title+url 承诺）', async () => {
    const ok = await run('browser_scroll', { direction: 'down' });
    expect((ok.content[0] as { text: string }).text).toContain('向下滚动 600px');
    // #11：滚动后回 title+url（与 navigate/back/forward 同律——模型直拿位置反馈）
    expect((ok.content[0] as { text: string }).text).toContain('Example');
    expect((ok.details as { url?: string; title?: string }).url).toBe('https://example.com/page');
    expect((ok.details as { title?: string }).title).toBe('Example');
    // 协议语义（PDL 原文 + 真机实证，第九轮 #10）：yDistance 正 = 向上滚——
    // direction 是用户语义，映射时 y 轴取负（down 600 = yDistance -600）
    expect(framesOf('Input.synthesizeScrollGesture')[0]!.params).toMatchObject({ xDistance: 0, yDistance: -600 });
    await run('browser_scroll', { direction: 'up', amount: 250 });
    expect(framesOf('Input.synthesizeScrollGesture')[1]!.params).toMatchObject({ yDistance: 250 });
    await run('browser_scroll', { direction: 'left', amount: 300 });
    expect(framesOf('Input.synthesizeScrollGesture')[2]!.params).toMatchObject({ xDistance: 300 });
    await run('browser_scroll', { direction: 'right', amount: 300 });
    expect(framesOf('Input.synthesizeScrollGesture')[3]!.params).toMatchObject({ xDistance: -300 });
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
    // context 建立即 enable 三域（事件源前提 + getFlattenedDocument 门控——真 Chrome 未
    // enable DOM 拒 -32000，第九轮 #2）
    expect(framesOf('Runtime.enable')).toHaveLength(1);
    expect(framesOf('Page.enable')).toHaveLength(1);
    expect(framesOf('DOM.enable')).toHaveLength(1);
  });

  it('refs 换代：第二次快照后旧 ref 失效（跨快照混用禁）', async () => {
    fake.responders['DOM.getFlattenedDocument'] = () => ({
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
    fake.responders['DOM.getFlattenedDocument'] = () => ({ nodes: [] }); // 空文档——ref 表清空换代
    await run('browser_snapshot');
    fake.responders['DOM.getBoxModel'] = () => ({ model: { border: [0, 0, 1, 0, 1, 1, 0, 1] } });
    const stale = await run('browser_click', { ref: '@e0' });
    expect(stale.isError).toBe(true);
    expect((stale.content[0] as { text: string }).text).toContain('不在最近快照');
  });

  // 【遗漏大扫 20260901-b #27】引擎回退披露：发现序回退代（engineNote 在场）
  // 工具结果标 fallbackWarning——规范条款的模型面通道。修复前红：engineNote
  // 组装了但全仓零消费，模型对回退引擎（可能过期的下载引擎）全盲。
  it('#27 引擎回退披露：engineNote 在场 → 结果文本尾附回退自述 + details.fallbackWarning；无回退零标注', async () => {
    // 独立注册面（假 service 携 engineNote——发现序回退的确定性注入位，不依赖
    // 真 FS 缺席形态）
    const noteDefs = new Map<string, ToolDefinition>();
    registerBrowserTools({
      service: {
        status: () => engine.getStatus(),
        acquireContext: async () => ({
          rpc: {} as unknown as import('./cdp.js').CdpRpc, // console 工具不触 rpc——只读捕获态
          session: { browserContextId: 'CTX-1', sessionId: 'SESS-1', targetId: 'TGT-1' },
          capture: new SessionCapture(),
          engineNote: '系统未装 Chrome——使用下载的引擎（版本可能落后于系统渠道）',
        }),
        dispose: async () => undefined,
      },
      dataDir,
      gates: NOOP_GATES,
      register: (def) => {
        noteDefs.set(def.name, def);
        return () => noteDefs.delete(def.name);
      },
    });
    const noted = await noteDefs.get('browser_console')!.execute({}, { toolCallId: 't-1', sessionId: 'sess-A' });
    expect(noted.isError).toBeUndefined();
    expect((noted.content[0] as { text: string }).text).toContain('（引擎回退：系统未装 Chrome');
    expect((noted.details as { fallbackWarning?: string }).fallbackWarning).toContain('落后于系统渠道');
    // 对照：主注册面（engineNote 缺席）零标注——回退披露只在回退代出现
    const plain = await run('browser_console');
    expect((plain.content[0] as { text: string }).text).not.toContain('引擎回退');
    expect((plain.details as { fallbackWarning?: string }).fallbackWarning).toBeUndefined();
  });

  // 【第九轮全面复盘 20260903 #27】console 执行段是十件中唯一无 try/catch 的：
  // acquire（引擎起链/context 建链）抛纯 Error 时直接 reject 出 execute——其余
  // 九件全走 asDataError 数据面自纠，唯 console 把引擎故障当管道异常上抛。
  // 修复前红：本测 rejects 即证（独立注册面注入 acquire 抛错——#27 note 测试同款缝）。
  it('#27 console acquire 失败：纯 Error → isError 数据面自纠（十件同轨）', async () => {
    const errDefs = new Map<string, ToolDefinition>();
    registerBrowserTools({
      service: {
        status: () => engine.getStatus(),
        acquireContext: async () => {
          throw new Error('引擎起链失败：连接超时');
        },
        dispose: async () => undefined,
      },
      dataDir,
      gates: NOOP_GATES,
      register: (def) => {
        errDefs.set(def.name, def);
        return () => errDefs.delete(def.name);
      },
    });
    const bad = await errDefs.get('browser_console')!.execute({}, { toolCallId: 't-1', sessionId: 'sess-A' });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toContain('引擎起链失败');
  });
});

describe('browser 运行时 Node 版本闸（纯函数——遗漏大扫 20260901-b #15）', () => {
  it('达标形态全过闸（边界值 24.0.0 恰过）', () => {
    expect(nodeVersionProblem('24.0.0')).toBeUndefined();
    expect(nodeVersionProblem('24.1.0')).toBeUndefined();
    expect(nodeVersionProblem('25.0.0')).toBeUndefined();
    expect(nodeVersionProblem('30.1.2')).toBeUndefined();
  });
  it('不达标：主/次/补丁三段任一低于线 → 拒绝理由（含当前版本与升级指引）', () => {
    for (const v of ['20.11.0', '21.0.0', '22.0.0', '22.19.1', '23.5.0']) {
      const problem = nodeVersionProblem(v);
      expect(problem, v).toBeDefined();
      expect(problem).toContain(v);
      expect(problem).toContain('24');
      expect(problem).toContain('升级 Node');
    }
  });
  it('非法形态按 0.0.0 兜底判红（fail-closed——未知版本不放行）', () => {
    expect(nodeVersionProblem('garbage')).toBeDefined();
    expect(nodeVersionProblem('')).toBeDefined();
  });
});

/* ---------------- 行 apply 接线（遗漏大扫 20260901-b #24） ---------------- */

describe('browser 行 apply 接线（孤儿清扫——刀一治理面的接线锁）', () => {
  it('#24 apply 期 sweep 先行：kill 探针接线 killTree、清扫命中记 warn、服务注册', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-apply-'));
    const killTree = vi.fn();
    /** sweep 假面：真调传入的 kill 探针（验证探针→killTree 接线）并报两株命中 */
    const sweep = vi.fn(async (probes: { kill: (pid: number) => void }) => {
      probes.kill(111);
      probes.kill(222);
      return { killed: [111, 222] as number[] };
    });
    const registry = { add: vi.fn(), remove: vi.fn(), sweep };
    const warns: string[] = [];
    const uiNotify = vi.fn();
    /** 工具注册面假收容（effect 回调即跑——真 context 语义位） */
    const registered: string[] = [];
    const disposers: Array<() => void> = [];
    // 最小 ctx stub（apply 消费面四键：get ui/tools、provide、effect、logger）
    /** /browser install 命令收容（channels 假面——apply 期注册，本测不触发 handler） */
    const commands: Array<{ name: string; handler: (args: string) => Promise<void> }> = [];
    const ctx = {
      get: (key: string) =>
        key === 'ui'
          ? { notify: uiNotify }
          : key === 'channels'
            ? {
                registerCommand: (cmd: { name: string; handler: (args: string) => Promise<void> }) => (
                  commands.push(cmd),
                  () => undefined
                ),
              }
            : { register: (def: ToolDefinition) => (registered.push(def.name), () => undefined) },
      tryGet: (_key: string) => undefined, // web 件软依赖缺席（本测不走装机路径）
      provide: vi.fn(),
      effect: (fn: () => () => void) => {
        disposers.push(fn());
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: (m: string) => void warns.push(m) },
    } as unknown as AppContext;

    createBrowserApp({
      dataDir,
      spawnEngine: () => {
        throw new Error('apply 期零 spawn——引擎惰性首用才起');
      },
      killTree,
      registry,
      newConnection: (o) => new JsonRpcConnection(o),
      gates: NOOP_GATES,
    }).apply(ctx);

    // 接线三断言（修复前红形态：sweep 被摘或 kill 探针接错——崩溃残留进程永久泄漏且无测试红）
    expect(sweep).toHaveBeenCalledTimes(1); // apply 期恰扫一次（先于一切自家 spawn）
    expect(killTree).toHaveBeenCalledWith(111); // 探针 → killTree(pid)（F-2 修后守卫参数退役）
    expect(killTree).toHaveBeenCalledWith(222);
    // 清扫命中走 warn（人读出口——operator 排障面）
    await new Promise((resolve) => setTimeout(resolve, 0)); // sweep promise .then 结算
    expect(warns.join('\n')).toContain('孤儿引擎清扫 2 株');
    // 服务面 + 工具面十件注册（apply 全接线自证）
    expect(ctx.provide).toHaveBeenCalledWith('browser', expect.anything());
    expect(registered).toHaveLength(10);
    expect(registered).toContain('browser_navigate');
    // /browser install 命令注册（刀三余量——channels 面 apply 期接线）
    expect(commands.map((c) => c.name)).toContain('browser');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('#A2 清扫失败腿：sweep reject 被收口降 warn——fire-and-forget 无 catch 即 unhandledRejection 杀宿主（修前必红）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-apply-a2-'));
    /** sweep 假面：直接 reject（真到达面 = 登记簿损坏 JSON / remove 写失败——sweep 本体同步抛进 async 即 reject） */
    const sweep = vi.fn(async () => {
      throw new Error('registry corrupted (probe)');
    });
    const registry = { add: vi.fn(), remove: vi.fn(), sweep };
    const warns: string[] = [];
    /** 工具注册面假收容（effect 回调即跑——真 context 语义位） */
    const registered: string[] = [];
    const commands: Array<{ name: string; handler: (args: string) => Promise<void> }> = [];
    // 最小 ctx stub（同上一用例四键形状——本测只消费 sweep 失败腿）
    const ctx = {
      get: (key: string) =>
        key === 'ui'
          ? { notify: vi.fn() }
          : key === 'channels'
            ? {
                registerCommand: (cmd: { name: string; handler: (args: string) => Promise<void> }) => (
                  commands.push(cmd),
                  () => undefined
                ),
              }
            : { register: (def: ToolDefinition) => (registered.push(def.name), () => undefined) },
      tryGet: (_key: string) => undefined,
      provide: vi.fn(),
      effect: (fn: () => () => void) => {
        fn();
        return () => undefined;
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: (m: string) => void warns.push(m) },
    } as unknown as AppContext;

    createBrowserApp({
      dataDir,
      spawnEngine: () => {
        throw new Error('apply 期零 spawn');
      },
      killTree: vi.fn(),
      registry,
      newConnection: (o) => new JsonRpcConnection(o),
      gates: NOOP_GATES,
    }).apply(ctx);

    // 结算等待（fire-and-forget promise 的 .then/.catch 走微任务——宏任务一拍即够）
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 修前红位：无 catch——reject 无人收口（unhandledRejection 杀宿主，测试进程
    // 亦被 vitest 报 unhandled error），warn 面恒空。修后：失败降 warn（残局留
    // 待下次启动再扫），boot 不被清扫失败阻死（fire-and-forget 语义兑现）
    expect(warns.join('\n')).toContain('孤儿清扫失败');
    // 失败腿不毒 apply 主线：服务/工具面照常接线（清扫残局 ≠ boot 拒启）
    expect(ctx.provide).toHaveBeenCalledWith('browser', expect.anything());
    expect(registered).toHaveLength(10);
    rmSync(dataDir, { recursive: true, force: true });
  });
});

/* ---------------- 刀三余量：命令面 + provider 占位（apply 面行为锁） ---------------- */

/**
 * apply 面测试基建（providers/命令 handler 共用）：最小 ctx stub + 件 apply。
 * commands 收容 /browser 命令；fetchFace 可注入（tryGet 软依赖的在场形态）。
 */
function applyFace(config: unknown, fetchFace: unknown, uiNotify: ReturnType<typeof vi.fn>) {
  /** 工具注册面假收容（effect 即跑） */
  const registered: string[] = [];
  const commands: Array<{ name: string; description: string; handler: (args: string) => Promise<void> }> = [];
  const ctx = {
    get: (key: string) =>
      key === 'ui'
        ? { notify: uiNotify }
        : key === 'channels'
          ? {
              registerCommand: (cmd: {
                name: string;
                description: string;
                handler: (args: string) => Promise<void>;
              }) => (commands.push(cmd), () => undefined),
            }
          : { register: (def: ToolDefinition) => (registered.push(def.name), () => undefined) },
    tryGet: (key: string) => (key === 'fetch' ? fetchFace : undefined),
    provide: vi.fn(),
    effect: (fn: () => () => void) => {
      fn(); // effect 即跑（收容命令）——返回值弃（测试不回卷）
      return () => undefined;
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  } as unknown as AppContext;
  const dataDir = mkdtempSync(join(tmpdir(), 'berry-browser-cmd-'));
  createBrowserApp({
    dataDir,
    spawnEngine: () => {
      throw new Error('apply 期零 spawn');
    },
    killTree: vi.fn(),
    registry: { add: vi.fn(), remove: vi.fn(), sweep: vi.fn(async () => ({ killed: [] })) },
    newConnection: (o) => new JsonRpcConnection(o),
    gates: NOOP_GATES,
  }).apply(ctx, config as never);
  return {
    commands: commands.filter((c) => c.name === 'browser'),
    dataDir,
    uiNotify,
    rm: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

describe('browser /browser install 命令面 + 云端 provider 占位', () => {
  it('provider 凭证在场 → info 通知一条（占位披露 + 优先级链数据面）+ debug 记链', () => {
    const uiNotify = vi.fn();
    const face = applyFace(
      { providers: { browseruse: { apiKey: 'k1' }, browserbase: { apiKey: 'k2' } } },
      undefined,
      uiNotify,
    );
    face.rm();
    const call = uiNotify.mock.calls.find((c) => String(c[0]).includes('云端 provider 已配置'));
    expect(call).toBeDefined(); // 有凭证才通知（执行面零接——披露不路由）
    expect(call![0]).toContain('browseruse, browserbase');
    expect(call![0]).toContain('BrowserUse > Browserbase > 本地引擎'); // 优先级链数据面
    expect(call![1]).toEqual({ level: 'info' });
  });

  it('无凭证零面（常态——不通知不占线）', () => {
    const uiNotify = vi.fn();
    const face = applyFace(undefined, undefined, uiNotify);
    face.rm();
    expect(uiNotify.mock.calls.some((c) => String(c[0]).includes('云端 provider'))).toBe(false);
  });

  it('非 install 参数 → 用法提示；web 件缺席 → warn 附替代指引（诚实缺席不级联）', async () => {
    const uiNotify = vi.fn();
    const face = applyFace(undefined, undefined, uiNotify);
    const handler = face.commands[0]!.handler;
    await handler('status'); // 参数腿
    expect(String(uiNotify.mock.calls[0]![0])).toContain('用法：/browser install');
    await handler('install'); // web 缺席腿（tryGet → undefined）
    const warnCall = uiNotify.mock.calls[1]!;
    expect(warnCall[0]).toContain('web 件（ctx.fetch 服务）未装载');
    expect(warnCall[1]).toEqual({ level: 'warn' });
    face.rm();
  });

  it('装机成功腿：fetch 双面注假 → installEngine 回执组装 notify（路径+SHA 记档）', async () => {
    const uiNotify = vi.fn();
    // 假 fetch 服务面：manifestFetch 回最小清单、downloadToFile 回假回执（installEngine 本体在 install.test.ts 全锁——此处只锁命令面接线）
    const fetchFace = {
      fetch: async () => ({
        status: 200,
        truncated: false,
        text: JSON.stringify({
          channels: {
            Stable: {
              version: '999.0.0.0',
              downloads: {
                // 四平台键全给（命令面用 process 实测位——测试跑在哪台都命中）
                chrome: ['mac-arm64', 'mac-x64', 'linux64', 'win64'].map((platform) => ({
                  platform,
                  url: 'https://storage.googleapis.com/x.zip',
                })),
              },
            },
          },
        }),
      }),
      // 下载腿写真 zip 档（单 store 条目——extractZip 真跑通；布局细节 install.test.ts 已锁）
      downloadToFile: vi.fn(async (_url: string, opts: { destPath: string }) => {
        const name = 'chrome-mac-arm64/README';
        const nameBuf = Buffer.from(name, 'utf8');
        const data = Buffer.from('x');
        const checksum = createHash('sha1').update(data).digest().readUInt32BE(0); // 任意 crc 值即可（store 无校验执法面）
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt32LE(checksum, 14);
        lh.writeUInt32LE(data.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt32LE(checksum, 16);
        ch.writeUInt32LE(data.length, 20);
        ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(1, 8);
        eocd.writeUInt16LE(1, 10);
        eocd.writeUInt32LE(46 + nameBuf.length, 12);
        eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(opts.destPath, Buffer.concat([lh, nameBuf, data, ch, nameBuf, eocd]));
        return { finalUrl: 'https://storage.googleapis.com/x.zip', bytes: 10, sha256: 'aabbcc'.repeat(11) };
      }),
    };
    const face = applyFace(undefined, fetchFace, uiNotify);
    await face.commands[0]!.handler('install');
    // downloadToFile 接线参数：白名单 = CfT 两域 + caller 归因
    expect(fetchFace.downloadToFile).toHaveBeenCalledWith(
      'https://storage.googleapis.com/x.zip',
      expect.objectContaining({
        allowedHosts: ['googlechromelabs.github.io', 'storage.googleapis.com'],
        caller: 'browser-install',
      }),
    );
    const ok = uiNotify.mock.calls.find((c) => String(c[0]).includes('装机完成'));
    expect(ok).toBeDefined();
    expect(ok![0]).toContain('999.0.0.0');
    face.rm();
  });
});

/* ---------------- 连接期统一码补漏 + binary 帧杂音口（定向复扫 20260902 第七轮） ---------------- */

describe('browser cdp 连接期统一码 + binary 帧杂音口（第七轮 L-1/L-2）', () => {
  let fake: FakeCdpServer;

  beforeEach(async () => {
    fake = new FakeCdpServer();
    await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  /** 桥工厂（与主 describe 同款——真 JsonRpcConnection） */
  const newConnection = (opts: ConstructorParameters<typeof JsonRpcConnection>[0]): JsonRpcConnection =>
    new JsonRpcConnection(opts);

  it('L-2①：fetchVersionInfo 畸形 http 端点 → BROWSER_CONNECT_FAILED（非裸 TypeError）', async () => {
    // 'http://[' —— WHATWG URL 解析同步抛；修前裸 TypeError 逃出统一码面
    await expect(fetchVersionInfo('http://[')).rejects.toSatisfy((err: unknown) => {
      return err instanceof AppError && err.code === 'BROWSER_CONNECT_FAILED';
    });
  });

  it('L-2②：connect 畸形 ws url → BROWSER_CONNECT_FAILED（非裸 TypeError）', async () => {
    // 'ws://[' —— WebSocket 构造器同步抛；修前裸 TypeError 丢连接期统一身份
    await expect(CdpConnection.connect('ws://[', newConnection)).rejects.toSatisfy((err: unknown) => {
      return err instanceof AppError && err.code === 'BROWSER_CONNECT_FAILED';
    });
  });

  it('L-1：binary 帧走杂音口可见（非静默丢弃）', async () => {
    const noise: string[] = [];
    const conn = await CdpConnection.connect(`ws://127.0.0.1:${fake.port}/devtools/browser/fake-uuid`, newConnection, {
      onNoise: (message) => noise.push(message),
    });
    try {
      fake.pushBinary(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      await new Promise((resolve) => setTimeout(resolve, 50)); // 帧到达窗
      // 修前：binary 帧零报告（noise 空）——注释承诺的「异常形态走杂音口」不存在
      expect(noise.length).toBe(1);
      expect(noise[0]).toContain('非文本帧丢弃');
      expect(noise[0]).toContain('4'); // 字节数披露
      // 杂音不炸桥：连接仍可用（文本帧照常协议应答）
      fake.responders = { 'Browser.getVersion': () => ({ product: 'ok' }) };
      const version = (await conn.rpc.request('Browser.getVersion')) as { product: string };
      expect(version.product).toBe('ok');
    } finally {
      conn.close('测试收尾');
    }
  });
});
