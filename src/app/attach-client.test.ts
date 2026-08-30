/**
 * L5 app — attach 客户端纯逻辑半边测试（daemon 刀二，契约篇 §6.8 attach 形态）。
 *
 * 覆盖四面：
 * ① 目标解析 + token 只读（daemon.json 取 port/--port 覆盖；readAttachToken
 *    缺席/空/trim；**禁 ensure 写**——客户端不造态文件）；
 * ② 微端点客户端（本地真 HTTP server：Bearer 鉴权/JSON 直解/401/非 JSON 体/
 *    连接失败 undefined/files 404 = undefined）；
 * ③ SSE 流读（帧解析：注释行/坏 JSON/CRLF 容错；指数退避重连 + 成功复位；
 *    401 自停不再重连；close 总闸）；
 * ④ 会话选择律 pickAttachSession（active 过滤/cwd 优先/recency 取最新）。
 *
 * 纪律：数据目录钉临时目录；server 每用例起关（端口 listen 0 零冲突）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachRequest,
  fetchDaemonHealth,
  fetchWorkspaceFiles,
  listApprovals,
  listSessions,
  readAttachToken,
  resolveAttachTarget,
  startAttachStream,
  submitText,
  type AttachStreamHandle,
} from './attach-client.js';
import { pickAttachSession } from './attach-main.js';
import type { WebuiSessionSummary } from '../webui/index.js';
import { acquireDaemonState, daemonDirOf, daemonTokenPath } from './daemon-state.js';

/* ---------------- 基建 ---------------- */

/** 文件级数据目录钉扎（G1 教训——测试不污染真实 ~/.berry） */
const dataRoot = mkdtempSync(join(realpathSync(tmpdir()), 'attach-cli-data-'));
afterEach(() => {
  rmSync(daemonDirOf(dataRoot), { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 造一份持有态（pid/processStartId 由用例注入） */
function writeState(pid: number, processStartId: string, port: number): void {
  acquireDaemonState(
    dataRoot,
    { pid, processStartId, bootId: 'boot-a', port, heldSessions: [] },
    {
      startId: () => undefined,
    },
  );
}

/** 本地真 server 工厂：路由表分派（path 前缀/方法），回显请求头供鉴权断言 */
interface SeenRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: unknown;
}
async function startServer(
  routes: (req: SeenRequest, res: ServerResponse) => void,
): Promise<{ server: Server; port: number; seen: SeenRequest[] }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const seen: SeenRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        authorization: req.headers['authorization'],
        ...(chunks.length > 0 ? { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) } : {}),
      };
      seenRef.push(seen);
      routes(seen, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const seenRef: SeenRequest[] = [];
  return { server, port, seen: seenRef };
}

/** 用例级 server 关停登记 */
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/* ---------------- ① 目标解析 + token 只读 ---------------- */

describe('attach 目标解析 + token 只读', () => {
  it('无 daemon.json → undefined；有则取记录 port；--port 覆盖压过记录值', () => {
    expect(resolveAttachTarget(dataRoot)).toBeUndefined();
    writeState(4321, 'attach-start', 7860);
    const target = resolveAttachTarget(dataRoot);
    expect(target?.port).toBe(7860);
    expect(target?.state.pid).toBe(4321);
    expect(resolveAttachTarget(dataRoot, 9999)?.port).toBe(9999);
  });

  it('readAttachToken：缺席/空白 = undefined、trim 收边；**不造文件**（客户端禁 ensure）', () => {
    const path = daemonTokenPath(dataRoot);
    expect(readAttachToken(dataRoot)).toBeUndefined();
    expect(existsSync(path)).toBe(false); // 只读不造（doctor ③ 同律）
    mkdirSync(daemonDirOf(dataRoot), { recursive: true }); // token 写盘前置目录（acquire 未跑时 daemon/ 缺席）
    writeFileSync(path, '  tok-123 \n');
    expect(readAttachToken(dataRoot)).toBe('tok-123');
    writeFileSync(path, '   ');
    expect(readAttachToken(dataRoot)).toBeUndefined();
  });
});

/* ---------------- ② 微端点客户端（真 server） ---------------- */

describe('attach 微端点客户端：鉴权/直解/分诊', () => {
  it('Bearer 头随行 + JSON 直解（sessions/submit/approvals）；非 JSON 体保留 status 面', async () => {
    const { server, port, seen } = await startServer((req, res) => {
      if (req.path === '/api/sessions') {
        if (req.authorization !== 'Bearer tok') {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessions: [{ id: 's1' }] }));
        return;
      }
      if (req.path.startsWith('/api/sessions/s1/submit')) {
        res.writeHead(202).end(JSON.stringify({ deduplicated: false }));
        return;
      }
      if (req.path === '/api/approvals') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('not-json'); // 非 JSON 体
        return;
      }
      res.writeHead(404).end();
    });
    servers.push(server);

    // 401 面：token 不符 → status 401（调用方分诊，不抛）
    const denied = await listSessions(port, 'wrong');
    expect(denied?.status).toBe(401);
    // 200 面：Bearer 真到服务端 + sessions 直解（seen[0] 是先发的 401 面——按鉴权行定位）
    const ok = await listSessions(port, 'tok');
    expect(ok?.status).toBe(200);
    expect(ok?.sessions).toEqual([{ id: 's1' }]);
    expect(seen.find((r) => r.path === '/api/sessions' && r.authorization === 'Bearer tok')).toBeTruthy();
    // submit：POST body JSON 序列化 + requestId 字段在场
    const submitted = await submitText(port, 'tok', 's1', '你好', 'req-1');
    expect(submitted).toEqual({ status: 202, deduplicated: false });
    expect(seen.find((r) => r.path.includes('submit'))?.body).toEqual({ text: '你好', requestId: 'req-1' });
    // 非 JSON 体：status 面保留、字段 undefined
    const approvals = await listApprovals(port, 'tok');
    expect(approvals).toEqual({ status: 200 });
  });

  it('连接失败（端口无监听）= undefined；health 公开探活无鉴权头', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200).end(JSON.stringify({ version: 'v9', degraded: 'cordon' }));
    });
    servers.push(server);
    const health = await fetchDaemonHealth(port);
    expect(health).toEqual({ version: 'v9', degraded: 'cordon' });
    server.closeAllConnections?.();
    server.close();
    // 端口已关：连接失败 → undefined（与 httpProbe 同形——调用方走「连不上」指引）
    await new Promise<void>((resolve) => server.once('close', resolve));
    expect(
      await attachRequest({ port, token: 'tok', method: 'GET', path: '/api/sessions', timeoutMs: 500 }),
    ).toBeUndefined();
    expect(await fetchDaemonHealth(port)).toBeUndefined();
  });

  it('workspace files：200 直解；404/非 200 = undefined（无弹层——诚实收窄）', async () => {
    const { server, port } = await startServer((req, res) => {
      if (req.path.startsWith('/api/workspace/files')) {
        if (req.path.includes('prefix=src')) {
          res.writeHead(200).end(JSON.stringify({ files: ['src/a.ts'] }));
          return;
        }
      }
      res.writeHead(404).end();
    });
    servers.push(server);
    expect(await fetchWorkspaceFiles(port, 'tok', 'src')).toEqual({ files: ['src/a.ts'] });
    expect(await fetchWorkspaceFiles(port, 'tok', 'nope')).toBeUndefined();
  });
});

/* ---------------- ③ SSE 流读（真 server） ---------------- */

describe('attach SSE 流：帧解析 + 退避重连 + 401 自停', () => {
  /** SSE 帧写帮手（服务端钉死单帧单写——本测故意掺注释/坏帧/CRLF 验容错） */
  function sseFrame(res: ServerResponse, payload: string): void {
    res.write(`data: ${payload}\n\n`);
  }

  it('帧解析：data 帧回调 / 注释行与坏 JSON 忽略 / CRLF 容错；onConnected 首连即发', async () => {
    const envelopes: unknown[] = [];
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n'); // 注释行（心跳）——不产帧
      sseFrame(res, JSON.stringify({ kind: 'status', sessionId: null, payload: { status: '跑' } }));
      res.write('data: {broken\n\n'); // 坏 JSON——静默忽略
      res.write(`data: ${JSON.stringify({ kind: 'notify', sessionId: null, payload: { message: 'crlf' } })}\r\n\r\n`); // CRLF 容错
    });
    servers.push(server);
    let connected = 0;
    const handle = startAttachStream({
      port,
      token: 'tok',
      onEnvelope: (envelope) => envelopes.push(envelope),
      onConnected: () => {
        connected += 1;
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    handle.close();
    expect(connected).toBe(1); // 首连即发（repull 三发驱动）
    expect(envelopes).toEqual([
      { kind: 'status', sessionId: null, payload: { status: '跑' } },
      { kind: 'notify', sessionId: null, payload: { message: 'crlf' } },
    ]);
  });

  it('断线 → 指数退避重连（连接成功复位退避）；重连后继续收帧', async () => {
    let generation = 0; // 0 = 初代（收帧即杀）；1 = 重连代（持续供帧）
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const gen = (generation += 1);
      if (gen === 1) {
        sseFrame(res, JSON.stringify({ kind: 'notify', sessionId: null, payload: { message: '一代' } }));
        res.end(); // 立即断——逼重连
        return;
      }
      sseFrame(res, JSON.stringify({ kind: 'notify', sessionId: null, payload: { message: '二代' } }));
      // 持续供帧（不 end）——连接保持
    });
    servers.push(server);
    const messages: string[] = [];
    let connects = 0;
    let disconnected = 0;
    const handle: AttachStreamHandle = startAttachStream({
      port,
      token: 'tok',
      initialBackoffMs: 20, // 测试注小值——重连快进
      onEnvelope: (envelope) => {
        const payload = envelope.payload as { message?: string };
        if (typeof payload?.message === 'string') messages.push(payload.message);
      },
      onConnected: () => {
        connects += 1;
      },
      onDisconnected: () => {
        disconnected += 1;
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    handle.close();
    expect(connects).toBe(2); // 首连 + 重连各一
    expect(disconnected).toBeGreaterThanOrEqual(1);
    expect(messages).toEqual(['一代', '二代']); // 两代帧都收到（重连不断流语义）
  });

  it('401 → onAuthFailure 后自停（不再重连——token 轮换竞窗重连无意义）', async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(401).end();
    });
    servers.push(server);
    let authFailed = 0;
    let connects = 0;
    startAttachStream({
      port,
      token: 'stale',
      initialBackoffMs: 20,
      onEnvelope: () => undefined,
      onConnected: () => {
        connects += 1;
      },
      onAuthFailure: () => {
        authFailed += 1;
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(authFailed).toBe(1);
    expect(connects).toBe(0); // 401 不算连接成功（无 repull）
    expect(hits).toBe(1); // **只打一次**——自停后零重连
  });

  it('close 总闸：断线态下 close → 清重连定时器（不再尝试连接）', async () => {
    let hits = 0;
    const { server, port } = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(); // 即连即断——制造退避窗口
    });
    servers.push(server);
    const handle = startAttachStream({
      port,
      token: 'tok',
      initialBackoffMs: 150, // 大于 close 前的等待——close 必落在退避窗内
      onEnvelope: () => undefined,
      onConnected: () => undefined,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 100)); // 首连已断、退避定时器在飞
    handle.close();
    const hitsAtClose = hits;
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(hits).toBe(hitsAtClose); // 退避定时器被清——零新连接
  });
});

/* ---------------- ④ 会话选择律 ---------------- */

describe('pickAttachSession：active 过滤 + cwd 优先 + recency', () => {
  /** 清单行速造（createdAt/updatedAt = epoch 毫秒——recency 数值比较用） */
  function row(id: string, over: Partial<WebuiSessionSummary> = {}): WebuiSessionSummary {
    return { id, appId: 'chat', active: true, cwd: '/w', createdAt: 1_000, ...over };
  }

  it('无 active → undefined；有 cwd 匹配者优先（哪怕更旧）', () => {
    expect(pickAttachSession([], '/w')).toBeUndefined();
    expect(pickAttachSession([row('a', { active: false })], '/w')).toBeUndefined();
    const elsewhere = row('new', { cwd: '/other', updatedAt: 900 });
    const local = row('old', { cwd: '/w', updatedAt: 100 });
    expect(pickAttachSession([elsewhere, local], '/w')?.id).toBe('old');
  });

  it('无 cwd 匹配 → active 里取最新（recency = updatedAt ?? createdAt）', () => {
    const a = row('a', { cwd: '/x', updatedAt: 300 });
    const b = row('b', { cwd: '/y', updatedAt: 900 });
    expect(pickAttachSession([a, b], '/w')?.id).toBe('b');
    // updatedAt 缺席 → createdAt 兜底比较
    const c = row('c', { cwd: '/z', createdAt: 9_999 });
    expect(pickAttachSession([b, c], '/w')?.id).toBe('c');
  });
});
