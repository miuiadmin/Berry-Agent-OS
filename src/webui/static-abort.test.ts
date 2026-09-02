/**
 * L3 webui — 静态分发客户端中止腿回归锁（遗漏大扫 20260902 #6）。
 *
 * 现场复刻：大资产（稀疏 256MiB）流式回发中客户端原始 socket 停读（背压把
 * 服务端源流泵进暂停态）后中止——修前 pipe 语义只对 dest unpipe 不销毁
 * source，fs.ReadStream 的 fd 与已缓冲数据无限期驻留（daemon 常驻形态反复
 * 中止可累积）；修后 res 'close' 即刻 source.destroy()。
 *
 * 观测缝：vi.mock('node:fs') 仅包一层 createReadStream 把实例记录进测试侧
 * ——流本体全真（真文件真 fd 真背压），destroy 语义零改动；其余导出原样
 * 透传（importOriginal 展开）。独立成文件正因 vi.mock 是文件级 hoist——并入
 * server.test.ts 会把包装波及全文件所有用例。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppLogger } from '../contracts/app.js';
import { createWebuiServer } from './server.js';
import { WebuiChannel } from './channel.js';
import { createPendingApprovals } from './approvals.js';
import type { WebuiAppDeps } from './types.js';

/** 观测记录（hoisted——vi.mock 工厂与用例两侧共享的模块级容器） */
const probe = vi.hoisted(() => ({ streams: [] as import('node:stream').Readable[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args);
      probe.streams.push(stream);
      return stream;
    },
  };
});

/** logger 桩（本锁不断言日志面——占位满足构造签名） */
function stubLogger(): AppLogger {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
}

/** 占位依赖束（静态腿不触任何取数腿——路由兜底面只求不炸） */
function stubDeps(): WebuiAppDeps {
  return {
    addDisplay: () => undefined,
    submitTo: () => false,
    historyFor: () => undefined,
    sessionsFor: () => [],
    openSession: async () => ({ id: 'opened', appId: 'berrycode', active: true }),
    todoFor: () => undefined,
    approvals: { mountClaim: () => () => undefined },
    workspaceRoot: () => '',
    symbolsFor: () => Promise.resolve(undefined),
    ui: () => {
      throw new Error('静态中止腿不触 ui 腿');
    },
    version: 'test-1.0.0',
  };
}

/** 临时取一个空闲端口（listen 0 → 读动态端口 → 关停） */
async function grabPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

describe('webui 静态分发：客户端中止腿源流销毁（遗漏大扫 20260902 #6）', () => {
  let server: Server;
  let close: () => Promise<void>;
  let channel: WebuiChannel;
  let staticRoot: string;
  let port: number;

  beforeAll(async () => {
    port = await grabPort();
    channel = new WebuiChannel();
    staticRoot = mkdtempSync(join(tmpdir(), 'webui-abort-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>index</html>');
    // 稀疏 256MiB：内核 + Node 两级缓冲远小于此——客户端停读后背压必把源流
    // 泵进暂停态（中止腿的现场前提；稀疏洞读零盘 IO 不拖慢测试）
    const big = join(staticRoot, 'big.bin');
    writeFileSync(big, 'x');
    truncateSync(big, 256 * 1024 * 1024);
    ({ server, close } = createWebuiServer({
      port,
      host: '127.0.0.1',
      deps: stubDeps(),
      channel,
      approvals: createPendingApprovals(),
      staticRoot,
      version: 'test-1.0.0',
      logger: stubLogger(),
    }));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  });

  afterAll(async () => {
    channel.dispose();
    await close();
    rmSync(staticRoot, { recursive: true, force: true });
    probe.streams.length = 0;
  });

  it('大资产传输中途断开 → res close 即刻销毁源流（fd 不驻留）', async () => {
    // 原始 socket 手控：发出 GET → 收到首块（头已冲、传输进行中）→ 停读制造背压
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => sock.once('connect', resolve));
    sock.write(`GET /big.bin HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    const firstChunk = await new Promise<Buffer>((resolve) => sock.once('data', (c: Buffer) => resolve(c)));
    expect(firstChunk.length).toBeGreaterThan(0);
    sock.pause(); // 停读 → 服务端写缓冲涨满 → 源流暂停持 fd
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等泵进暂停态

    const source = probe.streams.at(-1)!;
    expect(source).toBeTruthy(); // 静态腿源流已建立
    expect(source.destroyed).toBe(false); // 背压暂停态（非完成态——中止腿现场前提）

    sock.destroy(); // 客户端中止
    // 修前红位：源流无人销毁（pipe 只 unpipe 不 destroy）——destroyed 恒 false
    // 直至 waitFor 超时；修后：res 'close' 同步触发 destroy
    await vi.waitFor(() => expect(source.destroyed).toBe(true), { timeout: 2_000, interval: 20 });
    sock.destroy(); // 幂等收尾（防句柄外泄挂碍 afterAll）
  });
});
