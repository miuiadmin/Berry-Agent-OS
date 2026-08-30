/**
 * L3 webui — 官方件 apply 单元测试（惰性零监听 / 拒启两码 / 成功 + 回卷）。
 *
 * 只 import 本模块与 vitest + node 内建（+ contracts 错误面类型）。ctx 用
 * 手搓窄桩（on/effect 两面——apply 全部触点）；端口真占用真监听（EADDRINUSE
 * 与成功路径都是真实 kernel 行为，不 mock 中间层）。
 */

import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppContext } from '../contracts/app.js';
import { AppError, WEBUI_BIND_FORBIDDEN, WEBUI_PORT_IN_USE } from '../contracts/errors.js';
import { createWebuiApp } from './app.js';
import type { WebuiAppDeps } from './types.js';

/** 手搓作用域桩：收 on 订阅与 effect 回卷器（apply 全部 ctx 触点就这两面） */
function stubContext(): {
  ctx: AppContext;
  /** 已注册回卷器（LIFO 序倒序执行由真 context 保证——桩面按注册序收） */
  runDisposers: () => void;
  subscriptionCount: () => number;
} {
  const disposers: Array<() => void> = [];
  const subscriptions: unknown[] = [];
  const ctx = {
    on: (_event: string, handler: unknown) => {
      subscriptions.push(handler);
      return () => {
        const idx = subscriptions.indexOf(handler);
        if (idx >= 0) subscriptions.splice(idx, 1);
      };
    },
    effect: (fn: () => () => void) => {
      disposers.push(fn());
      return () => undefined;
    },
  } as unknown as AppContext;
  return { ctx, runDisposers: () => disposers.forEach((d) => d()), subscriptionCount: () => subscriptions.length };
}

/** 依赖桩：全部腿记调用次数（apply 触达面由此断言）+ ui 桩可注入 */
function stubDeps(): {
  deps: WebuiAppDeps;
  calls: {
    addDisplay: number;
    ui: number;
    submitTo: number;
    historyFor: number;
    sessionsFor: number;
    openSession: number;
    todoFor: number;
    mountClaim: number;
    /** claim 桥摘除器执行次数（刀三回卷序断言——LIFO 首位） */
    unmountClaim: number;
  };
} {
  const calls = {
    addDisplay: 0,
    ui: 0,
    submitTo: 0,
    historyFor: 0,
    sessionsFor: 0,
    openSession: 0,
    todoFor: 0,
    mountClaim: 0,
    unmountClaim: 0,
  };
  const deps: WebuiAppDeps = {
    addDisplay: () => {
      calls.addDisplay += 1;
    },
    submitTo: () => {
      calls.submitTo += 1;
      return false;
    },
    historyFor: () => {
      calls.historyFor += 1;
      return undefined;
    },
    sessionsFor: () => {
      calls.sessionsFor += 1;
      return [];
    },
    openSession: async () => {
      calls.openSession += 1;
      return undefined;
    },
    todoFor: () => {
      calls.todoFor += 1;
      return undefined;
    },
    approvals: {
      // claim 桥挂载桩：挂载/摘除各记一次（刀三晚绑桥回卷证据面）
      mountClaim: () => {
        calls.mountClaim += 1;
        return () => {
          calls.unmountClaim += 1;
        };
      },
    },
    workspaceRoot: () => '',
    symbolsFor: () => Promise.resolve(undefined),
    ui: () => {
      calls.ui += 1;
      // UiService 桩面：只 attach 一键（成功路径断言目标）——unknown 中转免全键
      return { attach: () => () => undefined } as unknown as ReturnType<WebuiAppDeps['ui']>;
    },
    version: 'test',
  };
  return { deps, calls };
}

/** 占住一个空闲端口并保持占用（EADDRINUSE 靶） */
function occupyPort(): Promise<{ server: Server; port: number; release: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, release: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

/** 取一个空闲端口（占用后立即释放——真监听前无竞争窗口的近似） */
async function freePort(): Promise<number> {
  const { port, release } = await occupyPort();
  await release();
  return port;
}

describe('webui 官方件 apply', () => {
  it('config 缺省 = 行惰性零监听：零接线零触达（deps/ctx 全不碰）', async () => {
    const { ctx, subscriptionCount } = stubContext();
    const { deps, calls } = stubDeps();
    const app = createWebuiApp(deps);
    await app.apply(ctx);
    expect(calls.addDisplay).toBe(0);
    expect(calls.ui).toBe(0);
    expect(subscriptionCount()).toBe(0);
  });

  it('enabled:false 显式关面同款惰性零监听', async () => {
    const { ctx } = stubContext();
    const { deps, calls } = stubDeps();
    const app = createWebuiApp(deps);
    await app.apply(ctx, { enabled: false });
    expect(calls.ui).toBe(0);
  });

  it('非回环 host → WEBUI_BIND_FORBIDDEN 拒启（fail-at-startup，接线前执法）', async () => {
    const { ctx } = stubContext();
    const { deps, calls } = stubDeps();
    const app = createWebuiApp(deps);
    await expect(app.apply(ctx, { enabled: true, host: '0.0.0.0' })).rejects.toMatchObject({
      code: WEBUI_BIND_FORBIDDEN,
    });
    expect(calls.addDisplay).toBe(0); // 绑定防线先于一切接线
  });

  it('端口被占 → WEBUI_PORT_IN_USE 拒启；已注册回卷器可干净执行（loader 回卷路径）', async () => {
    const occupied = await occupyPort();
    const { ctx, runDisposers } = stubContext();
    const { deps } = stubDeps();
    const app = createWebuiApp(deps);
    const rejection = app.apply(ctx, { enabled: true, port: occupied.port });
    await expect(rejection).rejects.toBeInstanceOf(AppError);
    await expect(rejection).rejects.toMatchObject({ code: WEBUI_PORT_IN_USE });
    // loader 对 failed 行回卷行作用域 → effect 栈回卷（未监听 server 的 close 无害）
    expect(() => runDisposers()).not.toThrow();
    await occupied.release();
  });

  it('成功路径：三族接线就位 + 真监听应答 health；回卷后端口关闭', async () => {
    const port = await freePort();
    const { ctx, runDisposers, subscriptionCount } = stubContext();
    const { deps, calls } = stubDeps();
    const app = createWebuiApp(deps);
    await app.apply(ctx, { enabled: true, port });
    // 接线四面（刀三 +1）：session/event 订阅 + display 入列 + ui attach +
    // claim 桥挂真身（answerer 竞速的 web 腿自此可达）
    expect(subscriptionCount()).toBe(1);
    expect(calls.addDisplay).toBe(1);
    expect(calls.ui).toBe(1);
    expect(calls.mountClaim).toBe(1);
    expect(calls.unmountClaim).toBe(0);
    // 真监听应答（Host 头按白名单三值拼装——客户端自动带 127.0.0.1:port）
    const health = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api/health' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toEqual({ ok: true, version: 'test' });
    // 回卷编舞（LIFO 首位摘 claim 桥 → settleAll → detach → channel.dispose →
    // server.close）：端口随即不可达
    runDisposers();
    expect(calls.unmountClaim).toBe(1); // 晚绑桥回卷证据面：摘除器恰执行一次
    await new Promise((r) => setTimeout(r, 100));
    const closed = await new Promise<boolean>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api/health' }, () => resolve(false));
      req.on('error', () => resolve(true));
      req.end();
    });
    expect(closed).toBe(true);
  });
});
