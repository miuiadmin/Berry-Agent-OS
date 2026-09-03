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
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { AppLogger } from '../contracts/app.js';
import { createWebuiServer } from './server.js';
import { WebuiChannel } from './channel.js';
import { createPendingApprovals, type PendingApprovals } from './approvals.js';
import type { WebuiAppDeps } from './types.js';

/** logger 桩（复盘 E-2：服务面兜底 500 留痕的断言锚——传入数组时 error/warn 全落账） */
function stubLogger(collected?: string[]): AppLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg) => collected?.push(`warn:${msg}`),
    error: (msg, fields) => collected?.push(`error:${msg}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`),
  };
}

/** 占位依赖束（各取数腿返回测试常量——路由面只管转发；override 供单用例改写单腿） */
function stubDeps(override?: Partial<WebuiAppDeps>): WebuiAppDeps {
  return {
    addDisplay: () => undefined,
    submitTo: (id) => id === 'live',
    historyFor: (id) => (id === 'live' ? [{ role: 'user', text: 'hi' }] : undefined),
    sessionsFor: () => [{ id: 'live', appId: 'chat', active: true }],
    openSession: async () => ({ id: 'opened', appId: 'berrycode', active: true }),
    todoFor: (id) =>
      id === 'live'
        ? [{ content: '做一件事', status: 'in_progress', activeForm: '正在做' }]
        : id === 'closed'
          ? null
          : undefined,
    approvals: {
      // claim 挂载桩：apply 面测试占位（服务面只消费 registry 本体）
      mountClaim: () => () => undefined,
    },
    workspaceRoot: () => '',
    symbolsFor: () => Promise.resolve(undefined),
    ui: () => {
      throw new Error('服务面测试不触 ui 腿');
    },
    version: 'test-1.0.0',
    ...override,
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
  /** 刀三 registry 真身（审批两端点消费——非 mock，全分支走真簿） */
  let approvals: PendingApprovals;
  /** 刀三文件补全行走锚（真文件树——前缀过滤面真 IO） */
  let filesRoot: string;

  beforeAll(async () => {
    port = await grabPort();
    channel = new WebuiChannel();
    approvals = createPendingApprovals();
    staticRoot = mkdtempSync(join(tmpdir(), 'webui-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>index</html>');
    writeFileSync(join(staticRoot, 'app.js'), 'console.log(1)');
    mkdirSync(join(staticRoot, 'sub'));
    writeFileSync(join(staticRoot, 'sub', 'page.html'), '<html>sub</html>');
    // 穿越靶：根外邻文件（reachable 只应 404 永不触达）
    writeFileSync(join(staticRoot, '..', 'secret-outside.txt'), 'SECRET');
    // 文件补全真树：前缀命中 / 不命中 / gitignore 剪枝三分面
    filesRoot = mkdtempSync(join(tmpdir(), 'webui-files-'));
    writeFileSync(join(filesRoot, 'alpha.ts'), 'export const a = 1;');
    writeFileSync(join(filesRoot, 'beta.md'), '# b');
    mkdirSync(join(filesRoot, 'src'));
    writeFileSync(join(filesRoot, 'src', 'gamma.ts'), 'export {}');
    writeFileSync(join(filesRoot, '.gitignore'), 'skip-dir/\n');
    mkdirSync(join(filesRoot, 'skip-dir'));
    writeFileSync(join(filesRoot, 'skip-dir', 'hidden.ts'), 'export {}');
    ({ server, close } = createWebuiServer({
      port,
      host: '127.0.0.1',
      deps: stubDeps({
        workspaceRoot: () => filesRoot,
        // 符号补全三档桩：real.ts 有符号 / warm.ts 预热中 / 其余 404 降级
        symbolsFor: (path) =>
          path === 'real.ts'
            ? Promise.resolve({ symbols: [{ name: 'answer', kind: 12, line: 42 }] })
            : path === 'warm.ts'
              ? Promise.resolve({ symbols: [], warming: true })
              : Promise.resolve(undefined),
      }),
      channel,
      approvals,
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
    rmSync(filesRoot, { recursive: true, force: true });
  });

  it('/api/health → 200 {ok, version, memory}', async () => {
    const r = await send(port, { method: 'GET', path: '/api/health' });
    expect(r.status).toBe(200);
    // memory 恒在场（基建大扫 #49——进程零依赖自报；活值只断形状禁精确数）
    expect(JSON.parse(r.text)).toEqual({
      ok: true,
      version: 'test-1.0.0',
      memory: { rss: expect.any(Number), heapUsed: expect.any(Number), uptimeMs: expect.any(Number) },
    });
  });

  it('health writeBehind 运行态键（基建大扫 #27）：注入三值活取 → 应答携带；未注入 → 键缺席', async () => {
    // 独立小 server（文件级单例 deps 固定不带 writeBehindStats——键缺席正断言）
    const wbPort = await grabPort();
    const wbChannel = new WebuiChannel();
    let statsCalls = 0;
    const { server: wbServer, close: wbClose } = createWebuiServer({
      port: wbPort,
      host: '127.0.0.1',
      deps: stubDeps({
        // 活取语义：每次请求重读（闩态翻转后下一次 health 即新值）
        writeBehindStats: () => {
          statsCalls += 1;
          return { paused: true, sessions: 2, events: 5 };
        },
      }),
      channel: wbChannel,
      approvals: createPendingApprovals(),
      staticRoot: import.meta.dirname,
      version: 'test-1.0.0',
      logger: stubLogger(),
    });
    try {
      await new Promise<void>((resolve) => wbServer.listen(wbPort, '127.0.0.1', () => resolve()));
      const hit = await send(wbPort, { method: 'GET', path: '/api/health' });
      expect(JSON.parse(hit.text)).toEqual({
        ok: true,
        version: 'test-1.0.0',
        memory: { rss: expect.any(Number), heapUsed: expect.any(Number), uptimeMs: expect.any(Number) },
        writeBehind: { paused: true, sessions: 2, events: 5 },
      });
      expect(statsCalls).toBe(1); // 应答时点活取一次
    } finally {
      wbChannel.dispose();
      await wbClose();
    }
    // 缺席形态：文件级单例（stubDeps 不带该键）→ 应答无 writeBehind 键
    const miss = await send(port, { method: 'GET', path: '/api/health' });
    expect(JSON.parse(miss.text)).not.toHaveProperty('writeBehind');
  });

  it('health obs 观测健康键（成熟度扫描 20260901 P1-11）：注入活取 → 应答携带 ingesting/lastFlushAt；未注入 → 键缺席', async () => {
    // 独立小 server（文件级单例 deps 不带 obsHealth——键缺席正断言）
    const obsPort = await grabPort();
    const obsChannel = new WebuiChannel();
    let stopped = false; // 闩态翻转后下一次 health 即新值（活取语义）
    const { server: obsServer, close: obsClose } = createWebuiServer({
      port: obsPort,
      host: '127.0.0.1',
      deps: stubDeps({
        obsHealth: () => ({ ingesting: !stopped, lastFlushAt: 1_700_000_000_000 }),
      }),
      channel: obsChannel,
      approvals: createPendingApprovals(),
      staticRoot: import.meta.dirname,
      version: 'test-1.0.0',
      logger: stubLogger(),
    });
    try {
      await new Promise<void>((resolve) => obsServer.listen(obsPort, '127.0.0.1', () => resolve()));
      const okHit = await send(obsPort, { method: 'GET', path: '/api/health' });
      expect(JSON.parse(okHit.text)).toMatchObject({ obs: { ingesting: true, lastFlushAt: 1_700_000_000_000 } });
      stopped = true;
      const stoppedHit = await send(obsPort, { method: 'GET', path: '/api/health' });
      expect(JSON.parse(stoppedHit.text)).toMatchObject({ obs: { ingesting: false } });
    } finally {
      obsChannel.dispose();
      await obsClose();
    }
    // 缺席形态：文件级单例（stubDeps 不带该键）→ 应答无 obs 键（obs 行未装/重装窗
    // ——「无信息」不冒充「健康」也不冒充「停摆」，doctor 侧键缺席不报红）
    const miss = await send(port, { method: 'GET', path: '/api/health' });
    expect(JSON.parse(miss.text)).not.toHaveProperty('obs');
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

  it('POST /api/sessions：201 清单条目原样转发 / 空 body 合法 / 坏 JSON 400', async () => {
    const created = await send(port, {
      method: 'POST',
      path: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.text)).toEqual({ id: 'opened', appId: 'berrycode', active: true });
    // 空 body（无 Content-Length 的裸 POST）——readBody 归一 '{}' 同 submit 管线
    const bare = await send(port, { method: 'POST', path: '/api/sessions' });
    expect(bare.status).toBe(201);
    const bad = await send(port, {
      method: 'POST',
      path: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(bad.status).toBe(400);
  });

  it('POST /api/sessions：openSession 开不出 → 503（服务降级非 404）', async () => {
    const port2 = await grabPort();
    const chan2 = new WebuiChannel();
    const deps = stubDeps({ openSession: async () => undefined }); // 两因严合：无持久层/默认应用兜底态
    const { server: s2, close: c2 } = createWebuiServer({
      port: port2,
      host: '127.0.0.1',
      deps,
      channel: chan2,
      approvals: createPendingApprovals(),
      staticRoot: join(tmpdir(), 'webui-absent-root-xyz'),
      version: 't',
      logger: stubLogger(),
    });
    await new Promise<void>((resolve) => s2.listen(port2, '127.0.0.1', () => resolve()));
    const r = await send(port2, { method: 'POST', path: '/api/sessions', body: '{}' });
    expect(r.status).toBe(503);
    chan2.dispose();
    await c2();
  });

  it('/api/sessions/:id/todo：条目 200 / 无表 null 200 / 未知 404', async () => {
    const withItems = await send(port, { method: 'GET', path: '/api/sessions/live/todo' });
    expect(withItems.status).toBe(200);
    expect(JSON.parse(withItems.text)).toEqual({
      todo: [{ content: '做一件事', status: 'in_progress', activeForm: '正在做' }],
    });
    const empty = await send(port, { method: 'GET', path: '/api/sessions/closed/todo' });
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.text)).toEqual({ todo: null });
    const miss = await send(port, { method: 'GET', path: '/api/sessions/ghost/todo' });
    expect(miss.status).toBe(404);
  });

  /* ---------------- 刀三：审批两端点 + 工作区补全两端点 ---------------- */

  it('GET /api/approvals：镜像注册后吐未决；decide 后即过滤（恢复面数据源）', async () => {
    // 真 registry 镜像注册（asked 信封形状与总线载荷同构）
    approvals.onMirror({
      sessionId: 'sess-x',
      event: { type: 'approval/asked', data: { approvalId: 'srv-l1', summary: '写文件' } },
    });
    const r = await send(port, { method: 'GET', path: '/api/approvals' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({
      approvals: [{ approvalId: 'srv-l1', sessionId: 'sess-x', summary: '写文件' }],
    });
    // 标决（镜像路）后 GET 不再吐（已决过滤——刷新/晚连接恢复面只见未决）
    approvals.onMirror({
      sessionId: 'sess-x',
      event: { type: 'approval/decided', data: { approvalId: 'srv-l1', decision: 'approve' } },
    });
    const after = await send(port, { method: 'GET', path: '/api/approvals' });
    expect(JSON.parse(after.text)).toEqual({ approvals: [] });
  });

  it('POST /api/approvals/:id/decide：claim 后应答 200 accepted；二次 superseded；unknown 404', async () => {
    // claim 挂 web 腿（answerer 竞速时点——enriched 载荷）
    const promise = approvals.claim('srv-d1', {
      summary: 'bash 升权',
      reason: 'workspace-write',
      ownership: { appId: 'berrycode', sessionId: 'sess-x' },
    });
    expect(promise).toBeInstanceOf(Promise);
    const ok = await send(port, {
      method: 'POST',
      path: '/api/approvals/srv-d1/decide',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toEqual({ accepted: true });
    await expect(promise).resolves.toBe('approve'); // web 腿真消费值
    // 二次 decide（幂等回执——不二写）
    const again = await send(port, {
      method: 'POST',
      path: '/api/approvals/srv-d1/decide',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });
    expect(again.status).toBe(200);
    expect(JSON.parse(again.text)).toEqual({ accepted: false, reason: 'superseded' });
    // 槽从未存在
    const ghost = await send(port, {
      method: 'POST',
      path: '/api/approvals/nope/decide',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(ghost.status).toBe(404);
  });

  it('POST decide 请求体校验：坏 JSON 400 / 缺 decision 400 / 闭集外 400（含 cancel）', async () => {
    approvals.onMirror({
      sessionId: 's',
      event: { type: 'approval/asked', data: { approvalId: 'srv-v1', summary: '校验靶' } },
    });
    const badJson = await send(port, {
      method: 'POST',
      path: '/api/approvals/srv-v1/decide',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(badJson.status).toBe(400);
    const missing = await send(port, {
      method: 'POST',
      path: '/api/approvals/srv-v1/decide',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(400);
    // 闭集外：cancel 无 web 产出面（spec 钉死）——与任意串同 400
    for (const decision of ['cancel', 'yes', '']) {
      const out = await send(port, {
        method: 'POST',
        path: '/api/approvals/srv-v1/decide',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      expect(out.status).toBe(400);
    }
    // 校验失败不落决（条目仍可后续应答）
    const ok = await send(port, {
      method: 'POST',
      path: '/api/approvals/srv-v1/decide',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject' }),
    });
    expect(JSON.parse(ok.text)).toEqual({ accepted: true });
  });

  it('POST decide always：无 suggestedEntry 恒 400；草案在场 200', async () => {
    // 无草案条目（bash 升权形态——safety 不携带 suggestedEntry）
    approvals.claim('srv-al1', { summary: '无草案' });
    const no = await send(port, {
      method: 'POST',
      path: '/api/approvals/srv-al1/decide',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'always' }),
    });
    expect(no.status).toBe(400);
    // 有草案条目（carve-out 写审批形态）
    approvals.claim('srv-al2', {
      summary: '有草案',
      suggestedEntry: { tool: 'write_file', pattern: '/tmp/a.txt' },
    });
    const yes = await send(port, {
      method: 'POST',
      path: '/api/approvals/srv-al2/decide',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'always' }),
    });
    expect(yes.status).toBe(200);
    expect(JSON.parse(yes.text)).toEqual({ accepted: true });
  });

  it('GET /api/workspace/files?prefix=：真树前缀过滤 + gitignore 剪枝 + 空前缀全量', async () => {
    const all = await send(port, { method: 'GET', path: '/api/workspace/files' });
    expect(all.status).toBe(200);
    // .gitignore 自身不被自身样式命中（真 git 语义同款）——在列；目录条目携
    // 尾 '/'（TUI-7：与 pi-tui 本地腿目录形一致）
    expect(JSON.parse(all.text)).toEqual({
      files: ['.gitignore', 'alpha.ts', 'beta.md', 'src/', 'src/gamma.ts'],
    });
    const scoped = await send(port, { method: 'GET', path: '/api/workspace/files?prefix=al' });
    expect(JSON.parse(scoped.text)).toEqual({ files: ['alpha.ts'] });
    const dir = await send(port, { method: 'GET', path: '/api/workspace/files?prefix=src' });
    expect(JSON.parse(dir.text)).toEqual({ files: ['src/', 'src/gamma.ts'] });
  });

  it('GET /api/workspace/symbols?path=：三档（有符号 200 / warming 200 / 无路由 404）', async () => {
    const real = await send(port, { method: 'GET', path: '/api/workspace/symbols?path=real.ts' });
    expect(real.status).toBe(200);
    expect(JSON.parse(real.text)).toEqual({ symbols: [{ name: 'answer', kind: 12, line: 42 }] });
    const warm = await send(port, { method: 'GET', path: '/api/workspace/symbols?path=warm.ts' });
    expect(warm.status).toBe(200);
    expect(JSON.parse(warm.text)).toEqual({ symbols: [], warming: true });
    const miss = await send(port, { method: 'GET', path: '/api/workspace/symbols?path=ghost.ts' });
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
      approvals: createPendingApprovals(),
      staticRoot: join(tmpdir(), 'webui-absent-root-xyz'),
      version: 't',
      logger: stubLogger(),
    });
    await new Promise<void>((resolve) => s2.listen(port2, '127.0.0.1', () => resolve()));
    const r = await send(port2, { method: 'GET', path: '/' });
    expect(r.status).toBe(404);
    expect(r.text).toContain('webui assets not built');
    chan2.dispose();
    await c2();
  });

  /* ---------------- 复盘 20260901 回归锁（L-2 / E-2） ---------------- */

  it('静态回发源流错误收口干净应答（复盘 L-2：读错不再以 uncaughtException 打死宿主）', async (context) => {
    // root 下 chmod 000 仍可 open（测不到 open 拒）——跳过（零误报前提）
    if (process.getuid?.() === 0) context.skip();
    const port2 = await grabPort();
    const chan2 = new WebuiChannel();
    const root2 = mkdtempSync(join(tmpdir(), 'webui-eio-'));
    writeFileSync(join(root2, 'locked.js'), 'console.log(1)');
    chmodSync(join(root2, 'locked.js'), 0o000); // stat 过（isFile 真）、open 拒——读腿错误现场（TOCTOU 同面）
    const logs: string[] = [];
    const { server: s2, close: c2 } = createWebuiServer({
      port: port2,
      host: '127.0.0.1',
      deps: stubDeps(),
      channel: chan2,
      approvals: createPendingApprovals(),
      staticRoot: root2,
      version: 't',
      logger: stubLogger(logs),
    });
    await new Promise<void>((resolve) => s2.listen(port2, '127.0.0.1', () => resolve()));
    const r = await send(port2, { method: 'GET', path: '/locked.js' });
    expect(r.status).toBe(500); // 头未冲 = 干净 JSON 应答（修复前：uncaughtException + 请求悬死）
    expect(JSON.parse(r.text)).toEqual({ error: 'static read failed' });
    expect(logs.length).toBeGreaterThan(0); // warn 留痕（头已冲腿同留）
    chan2.dispose();
    await c2();
    rmSync(root2, { recursive: true, force: true });
  });

  it('微路由兜底 500 留痕（复盘 E-2：未预期异常 error 级落 stack，不再零痕迹黑盒）', async () => {
    const port2 = await grabPort();
    const chan2 = new WebuiChannel();
    const logs: string[] = [];
    const { server: s2, close: c2 } = createWebuiServer({
      port: port2,
      host: '127.0.0.1',
      deps: stubDeps({
        sessionsFor: () => {
          throw new Error('boom-500');
        },
      }),
      channel: chan2,
      approvals: createPendingApprovals(),
      staticRoot: join(tmpdir(), 'webui-absent-root-xyz'),
      version: 't',
      logger: stubLogger(logs),
    });
    await new Promise<void>((resolve) => s2.listen(port2, '127.0.0.1', () => resolve()));
    const r = await send(port2, { method: 'GET', path: '/api/sessions' });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text)).toEqual({ error: 'internal' });
    expect(logs).toHaveLength(1); // 修复前：err 整只 void 丢弃——零留痕
    expect(logs[0]).toContain('boom-500'); // stack 在场（error instanceof Error 腿）
    chan2.dispose();
    await c2();
  });

  it('close() 先杀空闲 keep-alive 连接（复盘 L-2 顺带：closeIdleConnections——关停不干等 keepAliveTimeout）', async () => {
    const port2 = await grabPort();
    const chan2 = new WebuiChannel();
    const { server: s2, close: c2 } = createWebuiServer({
      port: port2,
      host: '127.0.0.1',
      deps: stubDeps(),
      channel: chan2,
      approvals: createPendingApprovals(),
      staticRoot: join(tmpdir(), 'webui-absent-root-xyz'),
      version: 't',
      logger: stubLogger(),
    });
    await new Promise<void>((resolve) => s2.listen(port2, '127.0.0.1', () => resolve()));
    // 一条完整应答后的闲置 keep-alive 连接（不关 socket——close() 的干等源）
    await new Promise<void>((resolve, reject) => {
      const sock = connect(port2, '127.0.0.1', () => {
        sock.write(`GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${port2}\r\nConnection: keep-alive\r\n\r\n`);
        // 收到完整应答即闲置（等一拍让应答写完）
        sock.once('data', () => setTimeout(resolve, 50));
      });
      sock.on('error', reject);
    });
    const startedAt = Date.now();
    await c2();
    // 修复前：close() 干等 keepAliveTimeout（缺省 5s）才放行
    expect(Date.now() - startedAt).toBeLessThan(1500);
    chan2.dispose();
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

/* ------------------------------------------------------------------ */
/* daemon 刀一（契约篇 §6.8）：token 鉴权门 / cookie 桥 / SSE 401 前置   */
/* / cordon 拒面 / requestId 去重 / interrupt 端点——独立 auth 服务器     */
/* ------------------------------------------------------------------ */

describe('webui 服务面：daemon 形态鉴权与协议正确性层', () => {
  /** 鉴权 token（任意串——服务面只做常时比对不问格式） */
  const TOKEN = 'unit-daemon-token-0123456789abcdef';
  const AUTH = { authorization: `Bearer ${TOKEN}` };

  let port: number;
  let chan: WebuiChannel;
  let close: () => Promise<void>;
  /** cordon 闩（闭包翻转——D6 拒面在活服务器上开合） */
  let cordoned = false;
  /** submit 投递账（requestId 去重断言面：真投递次数 vs 应答次数） */
  const delivered: string[] = [];

  beforeAll(async () => {
    port = await grabPort();
    chan = new WebuiChannel();
    const staticRoot = mkdtempSync(join(tmpdir(), 'webui-auth-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>shell</html>');
    const { server, close: closeFn } = createWebuiServer({
      port,
      host: '127.0.0.1',
      auth: { token: TOKEN },
      deps: stubDeps({
        submitTo: (id, text) => {
          delivered.push(`${id}:${text}`);
          return id === 'live';
        },
        cordoned: () => cordoned,
        interruptFor: (id) => id === 'live',
      }),
      channel: chan,
      approvals: createPendingApprovals(),
      staticRoot,
      version: 'test-1.0.0',
      logger: stubLogger(),
    });
    close = closeFn;
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  });

  afterAll(async () => {
    chan.dispose();
    await close();
  });

  it('鉴权门：无 token 401 / 错 token 401 / Bearer 200；health 公开探活豁免', async () => {
    // health 两语义分立（M4）：无证可达的最小载荷——不构成活证
    const health = await send(port, { method: 'GET', path: '/api/health' });
    expect(health.status).toBe(200);
    expect(health.text).toContain('"ok":true');
    // /api 族无证 401
    expect((await send(port, { method: 'GET', path: '/api/sessions' })).status).toBe(401);
    // 错 token 同 401（不披露判据差异）
    expect(
      (await send(port, { method: 'GET', path: '/api/sessions', headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    // 对 token 200
    expect((await send(port, { method: 'GET', path: '/api/sessions', headers: AUTH })).status).toBe(200);
    // SPA 壳静态不鉴权（M1 ①：先上屏、贴 token 换 cookie 的一次性引导面）
    const shell = await send(port, { method: 'GET', path: '/' });
    expect(shell.status).toBe(200);
    expect(shell.text).toContain('shell');
  });

  it('cookie 桥：POST /api/auth 过鉴权签发 HttpOnly cookie，cookie 单源可达 /api 面', async () => {
    // 错 token 不签发
    const bad = await send(port, {
      method: 'POST',
      path: '/api/auth',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(401);
    expect(bad.headers['set-cookie']).toBeUndefined();
    // 对 token 签发：值 = token 本身 + HttpOnly/SameSite=Strict/Path=/ 全家
    const ok = await send(port, {
      method: 'POST',
      path: '/api/auth',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(ok.status).toBe(200);
    const cookie = (ok.headers['set-cookie'] ?? []).join(';');
    expect(cookie).toContain(`daemon_session=${TOKEN}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // cookie 单源（无 Bearer）达 /api 面——SPA 桥成立的物证
    const viaCookie = await send(port, {
      method: 'GET',
      path: '/api/sessions',
      headers: { cookie: `daemon_session=${TOKEN}` },
    });
    expect(viaCookie.status).toBe(200);
    // 坏 cookie 值 401
    const badCookie = await send(port, {
      method: 'GET',
      path: '/api/sessions',
      headers: { cookie: 'daemon_session=nope' },
    });
    expect(badCookie.status).toBe(401);
  });

  it('SSE 鉴权前置：无 token 的 /api/events 401 JSON（不占连接帽不升级流）', async () => {
    const res = await send(port, { method: 'GET', path: '/api/events' });
    expect(res.status).toBe(401);
    // 应答是 JSON 面非 event-stream（升级未发生）
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.text).toContain('unauthorized');
  });

  it('requestId 去重：同键重试 200 去重回执不双投；404 路不记账；LRU 超帽逐出最旧', async () => {
    const post = (body: string) =>
      send(port, {
        method: 'POST',
        path: '/api/sessions/live/submit',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body,
      });
    // 首投 202（真投递）
    expect((await post(JSON.stringify({ text: '第一投', requestId: 'r-1' }))).status).toBe(202);
    // 同键重试：200 去重回执 + 不双投
    const retry = await post(JSON.stringify({ text: '第一投', requestId: 'r-1' }));
    expect(retry.status).toBe(200);
    expect(JSON.parse(retry.text)).toEqual({ ok: true, deduplicated: true });
    expect(delivered.filter((d) => d.endsWith('第一投')).length).toBe(1);
    // 404 路不记账：未知会话同键投递 404 后，活会话重投同键 = 新投递（202 非去重）
    expect(
      (
        await send(port, {
          method: 'POST',
          path: '/api/sessions/ghost/submit',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'x', requestId: 'r-2' }),
        })
      ).status,
    ).toBe(404);
    const second = await post(JSON.stringify({ text: '二投', requestId: 'r-2' }));
    expect(second.status).toBe(202);
    expect(JSON.parse(second.text)).toEqual({ ok: true });
    // LRU：r-1/r-2 在册 → 再投 127 个新键即 129 超 128 帽，逐出最旧 r-1
    for (let i = 0; i < 127; i += 1) {
      await post(JSON.stringify({ text: `fill-${i}`, requestId: `f-${i}` }));
    }
    // r-1 已被逐出：重投同键 = 新投递（202 非去重回执）
    const rePost = await post(JSON.stringify({ text: '第一投', requestId: 'r-1' }));
    expect(rePost.status).toBe(202);
    expect(delivered.filter((d) => d.endsWith('第一投')).length).toBe(2);
  });

  it('cordon 拒面（D6）：写意图 503 / 读面不拒 / health 披露 degraded', async () => {
    cordoned = true;
    try {
      // 开新会话与 submit 两写意图拒 503（「服务看着在、账必丢」不如响亮拒）
      const open = await send(port, {
        method: 'POST',
        path: '/api/sessions',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(open.status).toBe(503);
      expect(open.text).toContain('cordoned');
      const submit = await send(port, {
        method: 'POST',
        path: '/api/sessions/live/submit',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '降级期投递' }),
      });
      expect(submit.status).toBe(503);
      // 读面（清单）不拒——operator 收场面保全
      expect((await send(port, { method: 'GET', path: '/api/sessions', headers: AUTH })).status).toBe(200);
      // health：ok 仍 true（进程活）+ degraded 披露降级因（memory 恒在场形状断）
      const health = await send(port, { method: 'GET', path: '/api/health' });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.text)).toEqual({
        ok: true,
        version: 'test-1.0.0',
        degraded: 'persistence',
        memory: { rss: expect.any(Number), heapUsed: expect.any(Number), uptimeMs: expect.any(Number) },
      });
    } finally {
      cordoned = false;
    }
    // 闩复位即恢复收写
    const recovered = await send(port, {
      method: 'POST',
      path: '/api/sessions/live/submit',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '恢复后投递', requestId: 'after-cordon' }),
    });
    expect(recovered.status).toBe(202);
  });

  it('interrupt 端点：命中 200 {interrupted:true} / 不在册 404', async () => {
    const hit = await send(port, { method: 'POST', path: '/api/sessions/live/interrupt', headers: AUTH });
    expect(hit.status).toBe(200);
    expect(JSON.parse(hit.text)).toEqual({ interrupted: true });
    const miss = await send(port, { method: 'POST', path: '/api/sessions/ghost/interrupt', headers: AUTH });
    expect(miss.status).toBe(404);
  });
});

/* ---------------- 端点计数锚（全面复盘 20260902 G-3③） ---------------- */

describe('端点计数锚（全面复盘 20260902 G-3③——公开面「微路由 N 端点」宣称对照）', () => {
  it('路由分发面端点数与两公开文档宣称同源一致（增删端点不滚文案即红）', () => {
    // 代码真值 = server.ts 分发面两形路由声明：字面量形（pathname === '/api/x'
    // && req.method === 'M'）与正则形（const n = /…/.exec(pathname) 紧随
    // if (n !== null && req.method === 'M')）——新增端点必然落两形之一，
    // 结构性可见、零登记清单。每形零命中 = 声明面写法漂移，锚失效 fail-loud
    const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const literals = [...src.matchAll(/pathname === '(\/api\/[a-z/]+)' && req\.method === '([A-Z]+)'/g)];
    const regexes = [
      ...src.matchAll(
        /const (\w+) = \/[^;\n]+\.exec\(pathname\);\n\s*if \(\1 !== null && req\.method === '([A-Z]+)'\)/g,
      ),
    ];
    expect(literals.length).toBeGreaterThan(0);
    expect(regexes.length).toBeGreaterThan(0);
    const total = literals.length + regexes.length;
    // 中文数字映射（端点数 20 内——超界即此数组越 IndexError 红出，改锚时醒目）
    const cn = [
      '一',
      '二',
      '三',
      '四',
      '五',
      '六',
      '七',
      '八',
      '九',
      '十',
      '十一',
      '十二',
      '十三',
      '十四',
      '十五',
      '十六',
      '十七',
      '十八',
      '十九',
      '二十',
    ][total - 1]!;
    // 两公开文档的「微路由 N 端点」宣称——计数控件随端点增删同笔滚
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    for (const doc of ['docs/架构总览.md', 'docs/使用指南.md']) {
      const text = readFileSync(join(root, doc), 'utf8');
      expect(text, doc).toContain(`微路由${cn}端点`);
    }
  });

  it("路由形状闭集执法：全部 '/api/' 字面量出现处必落两形或登记豁免（第三形即红——计数锚 fail-open 收口，全面复盘 20260903 #24）", () => {
    // 计数锚只数两形（字面量/正则 exec）——新端点若写成第三形（如判法换序
    // req.method === 'GET' && pathname === …、或新增 startsWith 前缀路由），
    // 两形计数零变化、锚静默绿——公开文档「微路由 N 端点」宣称失真无人点名
    //（探针实证：server.ts 注入换序形后计数锚照绿）。本形状断言扫全部单引号
    // '/api/…' 字符串出现处逐处核形状：任何落不进已知形/豁免的出现即红。
    const src = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const hits = [...src.matchAll(/'(\/api\/[^']*)'/g)];
    expect(hits.length).toBeGreaterThan(0); // 扫描面退化（零命中）先红
    /** startsWith 豁免计数（今日恰 2：auth gate 前缀检查 + 404 fallback——皆非端点路由） */
    let startsWithCount = 0;
    for (const hit of hits) {
      const before = src.slice(Math.max(0, hit.index - 32), hit.index);
      const after = src.slice(hit.index + hit[0].length, hit.index + hit[0].length + 48);
      if (/pathname\s*!==\s*$/.test(before)) continue; // auth gate 比较豁免（health/auth 两处）
      if (/pathname\s*\.\s*startsWith\s*\(\s*$/.test(before)) {
        startsWithCount += 1; // 前缀形非端点——计数上限断言兜住（新增前缀路由即超限红）
        continue;
      }
      // 形一（字面量端点）：pathname === '/api/x' 紧随 && req.method === 'M'——
      // 换序/断行/裸比较皆不匹配即红（正则 exec 形的 /api/ 在正则字面量内非字符串，不进本扫描）
      const ok = /pathname\s*===\s*$/.test(before) && /^\s*&&\s*req\.method\s*===\s*'[A-Z]+'/.test(after);
      expect(
        ok,
        `第三形路由或写法漂移：${hit[0]}（前后文 …${before.slice(-24)}|${after.slice(0, 24)}…）——须落字面量端点形（pathname === '/api/x' && req.method === 'M'）或登记豁免`,
      ).toBe(true);
    }
    // startsWith 豁免面上限：auth gate + 404 fallback 恰 2——第三处 startsWith
    // 即未登记前缀路由（计数锚对其失明）
    expect(startsWithCount).toBe(2);
  });
});
