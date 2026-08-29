/**
 * L3 webui — HTTP 服务面集成测试（真 listen + node:http 手控请求）。
 *
 * 只 import 本模块与 vitest + node 内建。端口两段式取值（临时服务器占 0 号
 * 端口拿动态值 → 关停 → webui 用该端口起监听）——Host/Origin 白名单在构造期
 * 与 port 同源拼装，必须先知端口。手控头面（Host/Origin 改写）走 node:http
 * 原生请求而非 fetch（undici 对受限头的行为不作假设）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createWebuiServer } from './server.js';
import { WebuiChannel } from './channel.js';
import type { WebuiAppDeps } from './types.js';

/** 占位依赖束（各取数腿返回测试常量——路由面只管转发） */
function stubDeps(): WebuiAppDeps {
  return {
    addDisplay: () => undefined,
    submitTo: (id) => id === 'live',
    historyFor: (id) => (id === 'live' ? [{ role: 'user', text: 'hi' }] : undefined),
    sessionsFor: () => [{ id: 'live', appId: 'chat', active: true }],
    ui: () => {
      throw new Error('服务面测试不触 ui 腿');
    },
    version: 'test-1.0.0',
  };
}

/** 临时取一个空闲端口（listen 0 → 读动态端口 → 关停） */
async function grabPort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/** 单请求应答采集（手控方法/路径/头/体——Host/Origin 改写面全开放） */
function send(
  port: number,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: IncomingMessage['headers']; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe('webui 服务面：全端点 + 三防线 + 静态分发', () => {
  let port: number;
  let server: Server;
  let close: () => Promise<void>;
  let channel: WebuiChannel;
  let staticRoot: string;

  beforeAll(async () => {
    port = await grabPort();
    channel = new WebuiChannel();
    staticRoot = mkdtempSync(join(tmpdir(), 'webui-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>index</html>');
    writeFileSync(join(staticRoot, 'app.js'), 'console.log(1)');
    mkdirSync(join(staticRoot, 'sub'));
    writeFileSync(join(staticRoot, 'sub', 'page.html'), '<html>sub</html>');
    // 穿越靶：根外邻文件（reachable 只应 404 永不触达）
    writeFileSync(join(staticRoot, '..', 'secret-outside.txt'), 'SECRET');
    ({ server, close } = createWebuiServer({
      port,
      host: '127.0.0.1',
      deps: stubDeps(),
      channel,
      staticRoot,
      version: 'test-1.0.0',
    }));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  });

  afterAll(async () => {
    channel.dispose();
    await close();
    rmSync(staticRoot, { recursive: true, force: true });
  });

  it('/api/health → 200 {ok, version}', async () => {
    const r = await send(port, { method: 'GET', path: '/api/health' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, version: 'test-1.0.0' });
  });

  it('/api/sessions → 200 清单载荷原样转发', async () => {
    const r = await send(port, { method: 'GET', path: '/api/sessions' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual([{ id: 'live', appId: 'chat', active: true }]);
  });

  it('/api/sessions/:id/messages：在场 200 投影 / 未知 404', async () => {
    const hit = await send(port, { method: 'GET', path: '/api/sessions/live/messages' });
    expect(hit.status).toBe(200);
    expect(JSON.parse(hit.text)).toEqual({ messages: [{ role: 'user', text: 'hi' }] });
    const miss = await send(port, { method: 'GET', path: '/api/sessions/ghost/messages' });
    expect(miss.status).toBe(404);
  });

  it('/api/sessions/:id/submit：happy 202 / 未知 404 / 坏 JSON 400 / 空文本 400 / 超帽 413', async () => {
    const ok = await send(port, {
      method: 'POST',
      path: '/api/sessions/live/submit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(ok.status).toBe(202);
    expect(JSON.parse(ok.text)).toEqual({ ok: true });

    const ghost = await send(port, {
      method: 'POST',
      path: '/api/sessions/ghost/submit',
      body: JSON.stringify({ text: 'x' }),
    });
    expect(ghost.status).toBe(404);

    const badJson = await send(port, { method: 'POST', path: '/api/sessions/live/submit', body: 'not-json' });
    expect(badJson.status).toBe(400);

    const emptyText = await send(port, {
      method: 'POST',
      path: '/api/sessions/live/submit',
      body: JSON.stringify({ text: '' }),
    });
    expect(emptyText.status).toBe(400);

    // 256KiB+1 字节体 → 413（字节帽——文本面远小于此，超帽即拒）
    const huge = await send(port, {
      method: 'POST',
      path: '/api/sessions/live/submit',
      body: JSON.stringify({ text: 'x'.repeat(256 * 1024) }),
    });
    expect(huge.status).toBe(413);
  });

  it('/api/events：SSE 升级（头族 + connected 注释行 + hello 帧）', async () => {
    const text = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/api/events' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          const joined = Buffer.concat(chunks).toString('utf8');
          // hello 帧（kind:status connected）到达即收——不等待长活流终结
          if (joined.includes('"status":"connected"')) {
            req.destroy();
            resolve(joined);
          }
        });
        void res;
      });
      req.on('error', (err) => {
        // destroy 触发的 ECONNRESET 不是失败——已 resolve 的路径忽略
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      // http.request 不 end 不发（与 send() 助手的差异点——手动面必须显式收尾）
      req.end();
    });
    expect(channel.size).toBe(1);
    expect(text).toContain(': connected');
    expect(text).toContain('data: ');
    // 客户端 destroy 后连接摘除（close 面收口）
    await new Promise((r) => setTimeout(r, 100));
    expect(channel.size).toBe(0);
  });

  it('防线② Host：白名单外 403 / [::1] 对称放行 / 缺失 403', async () => {
    const evil = await send(port, { method: 'GET', path: '/api/health', headers: { host: 'evil.example.com' } });
    expect(evil.status).toBe(403);
    // rebinding 面常见形态：攻击者域名字面 + 原端口
    const evilPort = await send(port, {
      method: 'GET',
      path: '/api/health',
      headers: { host: `evil.example.com:${port}` },
    });
    expect(evilPort.status).toBe(403);
    // [::1] 白名单值（B2 对称勘正——显式 IPv6 回环绑定下同源 SPA 不死）
    const v6 = await send(port, { method: 'GET', path: '/api/health', headers: { host: `[::1]:${port}` } });
    expect(v6.status).toBe(200);
    // localhost 形态放行
    const lh = await send(port, { method: 'GET', path: '/api/health', headers: { host: `localhost:${port}` } });
    expect(lh.status).toBe(200);
    // 缺失 Host（HTTP/1.0 形态）= 拒（本面无浏览器正当场景）
    const none = await httpRequestRawNoHost(port, '/api/health');
    expect(none.status).toBe(403);
  });

  it('防线③ Origin：跨源 403 / 同源放行 / 无头放行（curl 面）', async () => {
    const evil = await send(port, {
      method: 'GET',
      path: '/api/health',
      headers: { origin: 'http://evil.example.com' },
    });
    expect(evil.status).toBe(403);
    const same = await send(port, {
      method: 'GET',
      path: '/api/health',
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(same.status).toBe(200);
    const none = await send(port, { method: 'GET', path: '/api/health' });
    expect(none.status).toBe(200);
  });

  it('未知 /api/* → JSON 404（不落静态回落）', async () => {
    const r = await send(port, { method: 'GET', path: '/api/unknown' });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text)).toEqual({ error: 'not found' });
  });

  it('静态分发：/ → index.html、扩展名 Content-Type、SPA 回落、子目录命中', async () => {
    const index = await send(port, { method: 'GET', path: '/' });
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.text).toBe('<html>index</html>');

    const js = await send(port, { method: 'GET', path: '/app.js' });
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');

    const sub = await send(port, { method: 'GET', path: '/sub/page.html' });
    expect(sub.status).toBe(200);
    expect(sub.text).toBe('<html>sub</html>');

    // SPA 路由路径未命中 → 回落 index.html
    const spa = await send(port, { method: 'GET', path: '/some/client/route' });
    expect(spa.status).toBe(200);
    expect(spa.text).toBe('<html>index</html>');

    // HEAD：头同型无体
    const head = await send(port, { method: 'HEAD', path: '/' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
  });

  it('穿越载荷不触根外文件（.. 段 / null 字节 / 根包含越界）', async () => {
    // %2E 形态：WHATWG URL 在解析期即按 dot-segment 归一（到达路由已无 .. 段）
    // → 落 SPA 回落 200——安全性质断言 = 根外文件内容永不出现
    const dotdot = await send(port, { method: 'GET', path: '/%2e%2e/secret-outside.txt' });
    expect(dotdot.status).toBe(200);
    expect(dotdot.text).not.toContain('SECRET');
    // %2F 形态：URL 不归一、decodeURIComponent 后现 '..' 段 → 显式拒绝分支 404
    const encoded = await send(port, { method: 'GET', path: '/sub/..%2F..%2Fsecret-outside.txt' });
    expect(encoded.status).toBe(404);
    expect(encoded.text).not.toContain('SECRET');
    const nullByte = await send(port, { method: 'GET', path: '/%00x' });
    expect(nullByte.status).toBe(404);
    const rawDots = await send(port, { method: 'GET', path: '/../secret-outside.txt' });
    // node:http 客户端会归一化 ../ 相对段——请求实际落到 /secret-outside.txt
    //（未命中回落 index.html，同样永不触根外）
    expect([200, 404]).toContain(rawDots.status);
    expect(rawDots.text).not.toContain('SECRET');
  });

  it('静态根缺席（dev 未构建形态）→ 404 诊断态不炸', async () => {
    const port2 = await grabPort();
    const chan2 = new WebuiChannel();
    const { server: s2, close: c2 } = createWebuiServer({
      port: port2,
      host: '127.0.0.1',
      deps: stubDeps(),
      channel: chan2,
      staticRoot: join(tmpdir(), 'webui-absent-root-xyz'),
      version: 't',
    });
    await new Promise<void>((resolve) => s2.listen(port2, '127.0.0.1', () => resolve()));
    const r = await send(port2, { method: 'GET', path: '/' });
    expect(r.status).toBe(404);
    expect(r.text).toContain('webui assets not built');
    chan2.dispose();
    await c2();
  });
});

/** 不带 Host 头的裸请求（原始 socket HTTP/1.0——node 客户端恒自动补 Host，缺失面只有裸 socket 可测） */
function httpRequestRawNoHost(port: number, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (c: Buffer) => {
      data += c.toString('utf8');
    });
    socket.on('end', () => resolve({ status: Number.parseInt(data.split(' ')[1] ?? '0', 10) }));
    socket.on('error', reject);
  });
}
