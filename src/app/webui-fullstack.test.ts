/**
 * L5 app — Web 通道刀一组合根全栈测试（契约篇 §6.8）：createRuntime({webuiPort})
 * 端到端——mock 只停在模型层（scripted streamFn），HTTP/SSE 面全真。
 *
 * 三断言族：
 * ① --port 注入 = withWebuiPort merge 进 boot 树 → webui 行真监听，五路由
 *    （health/sessions/messages/submit/SSE events）全栈走真客户端；
 * ② 端口被占 = 官方件失败行 → 应用启动断言拒启（fail-at-startup 组合根层）；
 * ③ 对照组：无 webuiPort 时 boot 成功、同时默认端口 7860 被外占 = 缺省
 *    零监听（enabled 缺省 false 的 apply 早退在组合根的证据面）。
 */

import { createServer, get, request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AssistantMessage,
  AssistantStream,
  AssistantStreamEvent,
  LlmContext,
  StreamFn,
  StreamFnOptions,
  Usage,
} from '../contracts/llm.js';
import type { WebuiSseEnvelope } from '../webui/types.js';
import { DEFAULT_WEBUI_PORT } from '../webui/types.js';
import { createRuntime } from './assembly.js';
import type { AppRuntime } from './assembly.js';
import { VERSION } from './version.js';

/* ---------------- 测试基建 ---------------- */

/** 零用量（scripted 终值携带——用量桶断言不在本文件面） */
const NO_USAGE: Usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

/** 文本 assistant 终值（scripted 流唯一应答） */
const textMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** 带升权参数的 bash toolCall（read-only 档下触发审批 ask——chat.test S5 同款；
 * 管道命令剥不出词干 = 无草案，干净命令 = 携带 {tool:'bash',pattern:词干} 草案） */
const bashEscalation = (justification: string, command = 'pwd'): AssistantMessage => ({
  role: 'assistant',
  content: [
    {
      type: 'toolCall',
      id: `call-bash-${justification}`,
      name: 'bash',
      arguments: { command, sandbox_permissions: 'workspace-write', justification },
    },
  ],
  usage: NO_USAGE,
  stopReason: 'toolUse',
  timestamp: 1,
});

/** 合成流：start → done（终值即脚本消息；loop 只消费事件序与 result()） */
function syntheticStream(message: AssistantMessage): AssistantStream {
  const events: AssistantStreamEvent[] = [
    { type: 'start', partial: { ...message, content: [] } },
    { type: 'done', reason: 'stop', message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          index < events.length
            ? Promise.resolve({ value: events[index++]!, done: false as const })
            : Promise.resolve({ value: undefined, done: true as const }),
      };
    },
    result: async () => message,
  };
}

/** 脚本化 StreamFn（恒答同一条文本——本文件只关通道面，不关轮次编排） */
function scriptedStream(responses: AssistantMessage[]): StreamFn {
  let calls = 0;
  return (context: LlmContext, _options: StreamFnOptions) => {
    void context;
    const message = responses[Math.min(calls++, responses.length - 1)]!;
    return syntheticStream(message);
  };
}

/** 临时工作区（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeWorkspace(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-webui-')));
}

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏） */
const runtimes: AppRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
  bearer = undefined; // 鉴权物复位（防跨用例泄漏——401 断言面恒从无 token 起步）
});

/**
 * 当前用例生效的一次性 token（复盘 S-1 勘正：--port 形态件自足鉴权后，非 401
 * 断言的用例恒持 Bearer——armAuth 从 runtime 摘 face 武装；无 token 用例（401
 * 断言面）不武装，helpers 按缺席裸发）
 */
let bearer: string | undefined;

/** 从 runtime 摘一次性鉴权物并武装全部助手（--port 形态 = webui 件自足 token） */
function armAuth(runtime: AppRuntime): void {
  bearer = runtime.webuiEphemeralAuth()?.token;
}

/** 当前请求头鉴权段（bearer 缺席 = 裸发——401 断言面的对照组形态） */
function authHeaders(): Record<string, string> {
  return bearer === undefined ? {} : { authorization: `Bearer ${bearer}` };
}

/** 起一次性探针取一个空闲端口（listen(0) 读回端口号后即关——占而不用） */
function grabPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** 持续占住指定端口（拒启/零监听对照组的占位者——release 前不放） */
function holdPort(port: number): Promise<{ release(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const holder = createServer();
    holder.once('error', reject);
    holder.listen(port, '127.0.0.1', () => {
      resolve({
        release: () =>
          new Promise<void>((resolveRelease) => {
            holder.close(() => resolveRelease());
          }),
      });
    });
  });
}

/** SSE 客户端（node:http get 自动 end——手动面 req.end 纪律在此形态天然满足） */
function openSse(port: number, frames: WebuiSseEnvelope[]): { close(): void; raw(): string } {
  let buf = '';
  const chunks: string[] = [];
  const req = get({ host: '127.0.0.1', port, path: '/api/events', headers: authHeaders() }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      chunks.push(chunk);
      buf += chunk;
      // SSE 帧边界 = 空行；注释行（: connected / : ping）跳过，data 帧整体单次
      // stringify 单行（通道契约）——直接 JSON.parse 切片
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (raw.startsWith('data: ')) frames.push(JSON.parse(raw.slice(6)) as WebuiSseEnvelope);
        idx = buf.indexOf('\n\n');
      }
    });
  });
  // 连接层错误自吞（destroy 时的 ECONNRESET 等）——不毒用例
  req.on('error', () => undefined);
  return {
    close: () => req.destroy(),
    raw: () => chunks.join(''),
  };
}

/** 等待谓词在 SSE 帧流上成立（25ms 轮询；超时抛带已收帧清单的诊断） */
async function waitForFrame(
  frames: WebuiSseEnvelope[],
  pred: (envelope: WebuiSseEnvelope) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (frames.some(pred)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`SSE 帧等待超时（已收 ${frames.length} 帧）：${JSON.stringify(frames.slice(0, 10))}`);
}

/** 等待谓词成立（25ms 轮询；谓词可异步——SSE 帧计数与 GET 轮询共用底座；缺省帽与外层 testTimeout 同宽：并行负载下 5s 帽会先于条件达成本身触顶——2026-09-01 存量 flake 勘正） */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** JSON GET 助手（fetch 全自动收尾——非 SSE 面用 fetch 即可；鉴权随 authHeaders） */
async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: authHeaders() });
  return { status: res.status, body: await res.json() };
}

/** POST submit 助手（手动 node:http 面——显式 Content-Length + req.end 纪律） */
function postSubmit(port: number, sessionId: string, text: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text });
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/sessions/${encodeURIComponent(sessionId)}/submit`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          ...authHeaders(),
        },
      },
      (res: IncomingMessage) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
      },
    );
    req.on('error', reject);
    req.end(payload); // 不 end 不发（本纵切测试实证教训）
  });
}

/** POST JSON 助手（通用面——submit 之外的 POST 端点；显式 Content-Length + req.end 纪律） */
function postJson(port: number, path: string, body: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          ...authHeaders(),
        },
      },
      (res: IncomingMessage) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(body); // 不 end 不发（本纵切测试实证教训）
  });
}

/** 轮询拉投影腿直到消息型序等于期望（submit 后轮次异步结算——轮询等真值） */
async function waitMessages(base: string, sessionId: string, expected: string[], timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await getJson(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages`);
    const kinds = ((res.body as { messages?: { type: string }[] }).messages ?? []).map((m) => m.type);
    if (JSON.stringify(kinds) === JSON.stringify(expected)) return;
    if (Date.now() > deadline)
      throw new Error(`messages 轮询超时（当前型序 ${JSON.stringify(kinds)}，期望 ${JSON.stringify(expected)}）`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ---------------- 用例 ---------------- */

describe('Web 通道组合根全栈（--port 注入 → webui 行真监听）', () => {
  it('复盘 S-1 回归锁：--port 形态件自足鉴权——裸发全 401、Bearer 过门、cookie 桥照常', async () => {
    const port = await grabPort();
    const workspace = makeWorkspace();
    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace,
      interactive: false,
      webuiPort: port,
      streamFn: scriptedStream([textMessage('S-1 锁答')]),
    });
    runtimes.push(runtime);
    const base = `http://127.0.0.1:${port}`;

    // ① face 在场：进程内一次性 token（32 字节 hex）+ 监听坐标（组合根披露面）
    //   —— 修复前此处红：webuiEphemeralAuth 不存在（类型面即拒）
    const face = runtime.webuiEphemeralAuth();
    expect(face).toBeDefined();
    expect(face!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(face!.port).toBe(port);

    // ② 裸发（bearer 未武装的对照组形态）：health 豁免面 200、/api 族其余全 401
    //   —— 修复前此处红：--port 形态免鉴权、写端点裸发可达（S-1 本体）
    const bootId = runtime.session!.header.sessionId;
    expect((await getJson(`${base}/api/health`)).status).toBe(200);
    expect((await getJson(`${base}/api/sessions`)).status).toBe(401);
    expect((await getJson(`${base}/api/sessions/${bootId}/messages`)).status).toBe(401);
    expect((await postSubmit(port, bootId, 'x')).status).toBe(401);
    expect(
      (await postJson(port, '/api/approvals/ghost-id/decide', JSON.stringify({ decision: 'approve' }))).status,
    ).toBe(401);
    expect((await postJson(port, `/api/sessions/${bootId}/interrupt`, JSON.stringify({}))).status).toBe(401);
    // 错 token 同拒（timingSafeEqual 面——不因自足 token 变形）
    const wrong = await fetch(`${base}/api/sessions`, { headers: { authorization: 'Bearer deadbeef' } });
    expect(wrong.status).toBe(401);

    // ③ 武装后过门：清单 200（写读面全解锁）
    armAuth(runtime);
    expect((await getJson(`${base}/api/sessions`)).status).toBe(200);

    // ④ cookie 桥照常：Bearer POST /api/auth → 200 + HttpOnly cookie（SPA 免头
    //   续访的既有机制不因自足 token 变形）
    const authRes = await fetch(`${base}/api/auth`, { method: 'POST', headers: authHeaders() });
    expect(authRes.status).toBe(200);
    expect(authRes.headers.get('set-cookie') ?? '').toContain('daemon_session=');
  });

  it('端到端：health 版本钉死 / sessions 含 boot 会话 / submit 202 落账 / SSE 三族帧', async () => {
    const port = await grabPort();
    const workspace = makeWorkspace();
    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace,
      interactive: false,
      webuiPort: port,
      streamFn: scriptedStream([textMessage('web 通道答')]),
    });
    runtimes.push(runtime);
    armAuth(runtime); // 监听形态武装（S-1 后 /api 族过鉴权——helpers 携 Bearer）
    const base = `http://127.0.0.1:${port}`;

    // 先开 SSE 再做动作（连接即当下——帧序从 connected 起可断言）
    const frames: WebuiSseEnvelope[] = [];
    const sse = openSse(port, frames);
    try {
      // ① health：版本串由组合根注入（webui 边不含 app 模块的接线证据）
      const health = await getJson(`${base}/api/health`);
      expect(health).toEqual({ status: 200, body: { ok: true, version: VERSION } });

      // ② 连接欢迎帧（status 族：connected——payload 是 unknown，谓词内窄化）
      await waitForFrame(
        frames,
        (f) => f.kind === 'status' && (f.payload as { status?: string })?.status === 'connected',
      );

      // ③ sessions：boot 已开默认应用（coder）会话——活条目腿在场
      const sessions = await getJson(`${base}/api/sessions`);
      expect(sessions.status).toBe(200);
      const list = sessions.body as { id: string; appId: string; active: boolean }[];
      expect(list.length).toBeGreaterThanOrEqual(1);
      const boot = list.find((s) => s.active);
      expect(boot?.appId).toBe('coder');
      const bootId = boot!.id;

      // ④ 拉投影腿：boot 会话消息面在册（空会话 = 空数组也是合法形状）
      const before = await getJson(`${base}/api/sessions/${bootId}/messages`);
      expect(before.status).toBe(200);
      expect(Array.isArray((before.body as { messages: unknown[] }).messages)).toBe(true);

      // ⑤ submit：202 入队（fire-and-forget——应答不等轮次）
      const accepted = await postSubmit(port, bootId, '从 web 提交');
      expect(accepted).toEqual({ status: 202, body: { ok: true } });

      // ⑥ 轮次跑完（scripted 模型）：durable 镜像族（session）到 turn/end =
      //    事件已落库（拉投影腿可见 assistant 终值）
      await waitForFrame(frames, (f) => f.kind === 'session' && (f.payload as { type?: string })?.type === 'turn/end');
      const after = await getJson(`${base}/api/sessions/${bootId}/messages`);
      const kinds = ((after.body as { messages: { type: string }[] }).messages ?? []).map((m) => m.type);
      expect(kinds).toEqual(['user', 'assistant']);

      // ⑦ display 族在场（chat 件 front 流经 addDisplay 接线转投 SSE）
      await waitForFrame(frames, (f) => f.kind === 'display');

      // ⑧ 未知会话 submit = 404（仅未退役活条目收——冷读 m3 已闭只读）
      const unknown = await postSubmit(port, 'no-such-session', 'x');
      expect(unknown.status).toBe(404);
    } finally {
      sse.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('刀二全栈：开新驻留切前 / todo 端点两腿 / 已闭会话 store 兜底只读', async () => {
    // 双 boot 同库不同 cwd（双开护栏立法形态）：boot A 落库关停后，boot B 的
    // 注册表只含 B 自己——A 成「已闭会话」（store-only），刀二三端点兜底腿全真走
    const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'app-webui-db-')));
    const dbPath = join(dir, 'two-boot.db');
    const wsA = makeWorkspace();
    const wsB = makeWorkspace();
    let rtA: AppRuntime | undefined;
    try {
      // boot A：submit 一轮（事件落库）后显式关停（write-behind 随 shutdown flush）
      const portA = await grabPort();
      rtA = await createRuntime({
        dbPath,
        workspace: wsA,
        interactive: false,
        webuiPort: portA,
        streamFn: scriptedStream([textMessage('boot A 答')]),
      });
      armAuth(rtA); // boot A 监听形态武装（关停后由 boot B 重武装覆盖）
      const baseA = `http://127.0.0.1:${portA}`;
      const listA = (await getJson(`${baseA}/api/sessions`)).body as { id: string; active: boolean }[];
      const sessionA = listA.find((s) => s.active)!.id;
      expect((await postSubmit(portA, sessionA, 'A 轮')).status).toBe(202);
      await waitMessages(baseA, sessionA, ['user', 'assistant']);
      await rtA.shutdown();
      rtA = undefined;

      // boot B：另一 cwd（无续接对象——boot 开自己的新会话）
      const portB = await grabPort();
      const rtB = await createRuntime({
        dbPath,
        workspace: wsB,
        interactive: false,
        webuiPort: portB,
        streamFn: scriptedStream([textMessage('boot B 答')]),
      });
      runtimes.push(rtB);
      armAuth(rtB);
      const baseB = `http://127.0.0.1:${portB}`;

      // ① 清单：A 以近史行披露 active:false（披露即兑现——点开不再 404）
      const listB = (await getJson(`${baseB}/api/sessions`)).body as { id: string; active: boolean }[];
      expect(listB.find((s) => s.id === sessionA)?.active).toBe(false);
      const sessionB = listB.find((s) => s.active)!.id;

      // ② 已闭 messages：store 装载只读派生（loadSession + deriveMessages 一次即弃）
      const history = await getJson(`${baseB}/api/sessions/${sessionA}/messages`);
      expect(history.status).toBe(200);
      const kindsA = ((history.body as { messages: { type: string }[] }).messages ?? []).map((m) => m.type);
      expect(kindsA).toEqual(['user', 'assistant']);

      // ③ 已闭 todo：store 兜底 fold（无 todo/write → {todo:null} 档）
      expect(await getJson(`${baseB}/api/sessions/${sessionA}/todo`)).toEqual({ status: 200, body: { todo: null } });

      // ④ 已闭 submit：404（只读——复活面挂刀三）
      expect((await postSubmit(portB, sessionA, 'x')).status).toBe(404);

      // ⑤ 开新：201 + 默认应用 coder + 驻留（B 的 boot 条目仍 active）
      const opened = await postJson(portB, '/api/sessions', '{}');
      expect(opened.status).toBe(201);
      const summary = opened.body as { id: string; appId: string; active: boolean };
      expect(summary.active).toBe(true);
      expect(summary.appId).toBe('coder');
      const activeIds = ((await getJson(`${baseB}/api/sessions`)).body as { id: string; active: boolean }[])
        .filter((s) => s.active)
        .map((s) => s.id);
      expect(activeIds).toContain(summary.id);
      expect(activeIds).toContain(sessionB); // 开新不退役既有（/app new 同款驻留语义）

      // ⑥ 新会话 todo {todo:null} 档 + submit 全链（openSession 开的会话真可跑）
      expect(await getJson(`${baseB}/api/sessions/${summary.id}/todo`)).toEqual({ status: 200, body: { todo: null } });
      expect((await postSubmit(portB, summary.id, '新会话首轮')).status).toBe(202);
      await waitMessages(baseB, summary.id, ['user', 'assistant']);
    } finally {
      if (rtA !== undefined) await rtA.shutdown().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      rmSync(wsA, { recursive: true, force: true });
      rmSync(wsB, { recursive: true, force: true });
    }
  });

  it('刀三全栈：审批 web 应答竞速（web 胜单写 / TUI 胜 superseded）+ completions + rewind 帧', async () => {
    const port = await grabPort();
    const workspace = makeWorkspace();
    // 补全第一段靶文件（workspace 真树——files 端点行走锚）
    writeFileSync(join(workspace, 'hello.ts'), 'export const hi = 1;\n');
    // 脚本序：[0] bash 升权·无草案轮（管道命令剥不出词干——web 胜）→ [1] 收尾
    // → [2] bash 升权·带草案轮（pwd 干净词干——TUI 胜）→ [3] 收尾
    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace,
      interactive: true, // confirm 注入开关（驱动 answerer 接线前提——chat.test 同款）
      approvalPolicy: 'ask',
      sandboxMode: 'read-only', // bash 升权必触发 ask
      webuiPort: port,
      streamFn: scriptedStream([
        bashEscalation('web 腿升权理由', 'echo hi | wc'), // 管道 → 无词干草案（always 400 靶）
        textMessage('web 胜收尾'),
        bashEscalation('tui 腿升权理由'), // 缺省 pwd → 草案 {tool:'bash',pattern:'pwd'}
        textMessage('tui 胜收尾'),
      ]),
    });
    runtimes.push(runtime);
    armAuth(runtime);
    const base = `http://127.0.0.1:${port}`;

    // 可控 confirm（TUI 腿闸门）：悬置 deferred = TUI 腿悬置——web 腿独走竞速
    const confirmGates: Array<(answer: boolean) => void> = [];
    runtime.ui.attach({
      id: 'test-confirm',
      notify: () => {},
      setStatus: () => {},
      confirm: (message: string) =>
        new Promise<boolean>((resolve) => {
          void message;
          confirmGates.push(resolve);
        }),
    });

    /** session 族某型帧计数（两轮 turn/end 逐轮递增——waitForFrame 的 some 语义分不开轮次） */
    const countFrames = (type: string): number =>
      frames.filter((f) => f.kind === 'session' && (f.payload as { type?: string })?.type === type).length;

    /** GET 未决清单（轮询体——claim 与 SSE 帧到序存在竞窗，轮询等真值） */
    const pendingList = () =>
      getJson(`${base}/api/approvals`).then(
        (r) =>
          (
            r.body as {
              approvals: {
                approvalId: string;
                summary: string;
                ownership?: { sessionId?: string; appId?: string };
                suggestedEntry?: { tool: string; pattern: string };
              }[];
            }
          ).approvals,
      );

    const frames: WebuiSseEnvelope[] = [];
    const sse = openSse(port, frames);
    try {
      const list = (await getJson(`${base}/api/sessions`)).body as { id: string; active: boolean }[];
      const bootId = list.find((s) => s.active)!.id;
      const session = runtime.session!; // boot 会话活引用（durable 断言锚——本用例无 /new）
      expect(session.header.sessionId).toBe(bootId);

      /* ---- Leg 1：web 腿胜（TUI confirm 悬置 → 竞速由 decide 裁决） ---- */
      expect((await postSubmit(port, bootId, '跑升权一')).status).toBe(202);
      await waitFor(() => countFrames('approval/asked') >= 1);
      // asked 帧载荷（SPA 卡面数据源）：approvalId + 升权 summary（reason 不入
      // durable 载荷——弹窗全文在 answerer 面，账面只记摘要）
      const asked1 = frames
        .map((f) => f.payload as { type?: string; data?: { approvalId?: string; summary?: string } })
        .find((p) => p.type === 'approval/asked');
      expect(asked1?.data?.summary).toContain('沙箱升权');
      const id1 = asked1?.data?.approvalId ?? '';
      expect(id1).toMatch(/.+/);
      // GET 补见：条目在册 + claim 富化键（answerer 时点已 claim——ownership 落
      // boot 会话；claim 与帧到序有竞窗 → 轮询等富化真值）
      await waitFor(async () => {
        const entries = await pendingList();
        return entries.length === 1 && entries[0]?.approvalId === id1 && entries[0]?.ownership?.sessionId === bootId;
      });
      const pending1 = await pendingList();
      expect(pending1[0]?.ownership?.appId).toBe('coder'); // 驱动归属闭包（S5 织入面全栈透传）
      expect(pending1[0]?.suggestedEntry).toBeUndefined(); // 管道命令剥不出词干 → 无草案
      // 值域执法三连：闭集外（cancel）400 / always 无草案 400 / unknown id 404
      expect(
        (await postJson(port, `/api/approvals/${id1}/decide`, JSON.stringify({ decision: 'cancel' }))).status,
      ).toBe(400);
      expect(
        (await postJson(port, `/api/approvals/${id1}/decide`, JSON.stringify({ decision: 'always' }))).status,
      ).toBe(400);
      expect(
        (await postJson(port, '/api/approvals/ghost-id/decide', JSON.stringify({ decision: 'approve' }))).status,
      ).toBe(404);
      // web 应答 = 竞速裁决：200 accepted → bash 真跑（echo|wc）→ 收尾轮 → turn/end
      const approved = await postJson(port, `/api/approvals/${id1}/decide`, JSON.stringify({ decision: 'approve' }));
      expect(approved).toEqual({ status: 200, body: { accepted: true } });
      await waitFor(() => countFrames('turn/end') >= 1);
      // durable：decided 恰一条且值 approve（单写漏斗——decided 由审批服务在竞速
      // 胜者产出时落一次，TUI 腿晚归值被 race 丢弃不二写）
      const decided1 = session.events.filter((e) => e.type === 'approval/decided');
      expect(decided1).toHaveLength(1);
      expect((decided1[0]!.data as { decision: string }).decision).toBe('approve');
      // GET 已决过滤：清单回空
      expect(await pendingList()).toEqual([]);
      confirmGates[0]?.(false); // 败腿卫生结算（race 已收——值无人消费不落账）

      /* ---- Leg 2：TUI 腿胜（confirm 立即允许 → web 迟到应答回 superseded） ---- */
      expect((await postSubmit(port, bootId, '跑升权二')).status).toBe(202);
      await waitFor(() => countFrames('approval/asked') >= 2);
      const id2 =
        frames
          .map((f) => f.payload as { type?: string; data?: { approvalId?: string } })
          .filter((p) => p.type === 'approval/asked')
          .map((p) => p.data?.approvalId)
          .find((aid) => aid !== id1) ?? '';
      expect(id2).toMatch(/.+/);
      // 草案透传：pwd 干净词干 → GET 条目带 {tool:'bash',pattern:'pwd'}（「始终
      // 允许」选项数据源——claim 富化在 ask 派发时点已完成）
      await waitFor(async () => {
        const hit = (await pendingList()).find((e) => e.approvalId === id2);
        return (
          hit?.suggestedEntry !== undefined &&
          hit.suggestedEntry.tool === 'bash' &&
          hit.suggestedEntry.pattern === 'pwd'
        );
      });
      // TUI 立即允许：第二扇 confirm 闸门开（answerer 弹窗在桩）→ true
      await waitFor(() => confirmGates.length >= 2);
      confirmGates[1]!(true);
      await waitFor(() => countFrames('turn/end') >= 2);
      // web 迟到应答 = superseded 幂等回执（不二写）
      const late = await postJson(port, `/api/approvals/${id2}/decide`, JSON.stringify({ decision: 'reject' }));
      expect(late).toEqual({ status: 200, body: { accepted: false, reason: 'superseded' } });
      // durable：两审批对（asked×2 / decided×2），第二条值 approve（TUI 腿值）
      const decided2 = session.events.filter((e) => e.type === 'approval/decided');
      expect(decided2).toHaveLength(2);
      expect((decided2[1]!.data as { decision: string }).decision).toBe('approve');

      /* ---- completions 两端点 ---- */
      // files：workspace 真树前缀过滤（@-mention 第一段全栈）
      const files = await getJson(`${base}/api/workspace/files?prefix=hel`);
      expect(files).toEqual({ status: 200, body: { files: ['hello.ts'] } });
      // symbols：无路由档（无扩展名路径 = routeFor undefined）→ 404 降级
      //（有路由档会 fire-and-forget 起真语言服务器——测试不触，warming 档单测已锁）
      expect(await getJson(`${base}/api/workspace/symbols?path=README`)).toEqual({
        status: 404,
        body: { error: 'no symbols' },
      });

      /* ---- checkpoint 转录行帧（SSE 镜像透传 + 不进投影） ---- */
      session.append('checkpoint/rewind', { id: 'rewind-aaaa-bbbb', newSessionId: 'new-sess-cccc-dddd', files: 2 });
      await waitFor(() => countFrames('checkpoint/rewind') >= 1);
      // 投影不含 rewind（surface 词不进 deriveMessages——SPA 拉腿只见消息族）
      const projected = (
        (await getJson(`${base}/api/sessions/${bootId}/messages`)).body as { messages: { type: string }[] }
      ).messages;
      expect(projected.some((m) => m.type === 'checkpoint/rewind')).toBe(false);
      // 帧载荷三键透传（SPA 转录行数据源）
      const rewindFrame = frames
        .map((f) => f.payload as { type?: string; data?: { id?: string; newSessionId?: string; files?: number } })
        .find((p) => p.type === 'checkpoint/rewind');
      expect(rewindFrame?.data).toEqual({ id: 'rewind-aaaa-bbbb', newSessionId: 'new-sess-cccc-dddd', files: 2 });
    } finally {
      sse.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('刀 A 全栈 (d)：竞速收束撤销败腿——web 胜三态 select 降级链自动收场 + TUI 胜 abort 无副作用', async () => {
    const port = await grabPort();
    const workspace = makeWorkspace();
    // 脚本序：[0] bash 升权·带词干草案（pwd → suggestedEntry 在场 → 三态 select 路）
    // ——web 腿胜 → [1] 收尾；[2] 同款轮——TUI 腿胜 → [3] 收尾
    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace,
      interactive: true,
      approvalPolicy: 'ask',
      sandboxMode: 'read-only',
      webuiPort: port,
      streamFn: scriptedStream([
        bashEscalation('刀A web 腿胜', 'pwd'),
        textMessage('web 胜收尾'),
        bashEscalation('刀A tui 腿胜', 'pwd'),
        textMessage('tui 胜收尾'),
      ]),
    });
    runtimes.push(runtime);
    armAuth(runtime);
    const base = `http://127.0.0.1:${port}`;

    /**
     * 三态可撤销桩：select/confirm 都响应 opts.signal——abort 时结算保守值
     * （''/false，模拟 UiService 层 undefined 收口）；confirm 预置 aborted =
     * 同步 false（§6.8 (a2) 桩面——降级链第二问不上屏）。askLog 只记真实
     * 生效的结算（settled 守卫——abort 落在已应答者上 no-op 不记，镜像
     * prompts.ask 的摘监听不变式）。
     */
    const askLog: string[] = [];
    const gates: Array<() => void> = [];
    runtime.ui.attach({
      id: 'test-three-state',
      notify: () => {},
      setStatus: () => {},
      select: (_message: string, _choices: readonly unknown[], opts?: { signal?: AbortSignal }) =>
        new Promise<string>((resolve) => {
          askLog.push('select-ask');
          let settled = false;
          const settle = (value: string, tag: string) => {
            if (settled) return; // 迟到 abort（已应答）= no-op——与真队列摘监听同律
            settled = true;
            askLog.push(tag);
            resolve(value);
          };
          opts?.signal?.addEventListener('abort', () => settle('', 'select-abort'), { once: true });
          gates.push(() => settle('approve', 'select-answer'));
        }),
      confirm: (_message: string, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal?.aborted) {
          askLog.push('confirm-instant-false'); // 预置 aborted：同步收场不悬置（降级链命中面）
          return Promise.resolve(false);
        }
        return new Promise<boolean>((resolve) => {
          askLog.push('confirm-ask');
          let settled = false;
          const settle = (value: boolean, tag: string) => {
            if (settled) return;
            settled = true;
            askLog.push(tag);
            resolve(value);
          };
          opts?.signal?.addEventListener('abort', () => settle(false, 'confirm-abort'), { once: true });
          gates.push(() => settle(true, 'confirm-answer'));
        });
      },
    });

    const frames: WebuiSseEnvelope[] = [];
    const sse = openSse(port, frames);
    try {
      const list = (await getJson(`${base}/api/sessions`)).body as { id: string; active: boolean }[];
      const bootId = list.find((s) => s.active)!.id;
      const session = runtime.session!;
      const countFrames = (type: string): number =>
        frames.filter((f) => f.kind === 'session' && (f.payload as { type?: string })?.type === type).length;
      const askedIds = () =>
        frames
          .map((f) => f.payload as { type?: string; data?: { approvalId?: string } })
          .filter((p) => p.type === 'approval/asked')
          .map((p) => p.data?.approvalId);

      /* ---- Leg 1：web 腿胜（三态 select 悬置 → decide 裁决 → 败腿自动收场） ---- */
      expect((await postSubmit(port, bootId, '刀A第一轮')).status).toBe(202);
      await waitFor(() => countFrames('approval/asked') >= 1);
      const id1 = askedIds()[0] ?? '';
      // 三态路上屏：suggestedEntry（pwd 词干）在场 → answerApproval 走 select
      await waitFor(() => askLog.includes('select-ask'));
      // web 应答 → race 收 web 值 → finally abort → select 桩 ''（保守收场）+
      // controller.signal.aborted → tuiLeg 直收 'cancel'（interrupt 小刀统一规则：
      // 不再降级发第二条 confirm——'cancel' 不被预置 aborted 的同步 false 换皮成
      // 'reject'）——败腿值被 race 丢弃，decided 单写 web 值
      expect(
        (await postJson(port, `/api/approvals/${id1}/decide`, JSON.stringify({ decision: 'approve' }))).status,
      ).toBe(200);
      await waitFor(() => countFrames('turn/end') >= 1);
      // 败腿收场序：select 撤销即终——全程无第二提问（confirm 全缺席 = 降级面
      // 不复活、无残留占输入框的桩面证据）
      await waitFor(() => askLog.includes('select-abort'));
      expect(askLog).toEqual(['select-ask', 'select-abort']);
      // decided 单写：approve（web 腿值；tuiLeg 直收的 cancel 被 race 丢弃）
      const decided1 = session.events.filter((e) => e.type === 'approval/decided');
      expect(decided1).toHaveLength(1);
      expect((decided1[0]!.data as { decision: string }).decision).toBe('approve');
      expect(gates).toHaveLength(1); // select 闸门挂过、confirm 未挂闸（不再降级）——无悬置腿残留

      /* ---- Leg 2：TUI 腿胜（select 立即应答 → race 收 → abort 无副作用） ---- */
      expect((await postSubmit(port, bootId, '刀A第二轮')).status).toBe(202);
      await waitFor(() => countFrames('approval/asked') >= 2);
      const id2 = askedIds().find((aid) => aid !== id1) ?? '';
      await waitFor(() => askLog.filter((l) => l === 'select-ask').length >= 2);
      gates[1]!(); // TUI 立即允许（select → 'approve'）
      // 等 decided 第二条真值（turn/end 计数会被轮1收尾轮提前满足——decided
      // 是审批结算的真信号；随后 turn/end 帧到位收全链）
      await waitFor(
        () =>
          session.events.filter((e) => e.type === 'approval/decided').length >= 2 && askLog.includes('select-answer'),
      );
      await waitFor(() => countFrames('turn/end') >= 3);
      // race 收束的 finally abort 落在已应答 select 上 = no-op：桩 settled 守卫
      // 不记 'select-abort'（摘监听不变式的桩面镜像）、不触发降级 confirm
      expect(askLog).toEqual(['select-ask', 'select-abort', 'select-ask', 'select-answer']);
      // decided 单写：第二条值 approve（TUI 腿值）；web 迟到应答 superseded 不二写
      const decided2 = session.events.filter((e) => e.type === 'approval/decided');
      expect(decided2).toHaveLength(2);
      expect((decided2[1]!.data as { decision: string }).decision).toBe('approve');
      const late = await postJson(port, `/api/approvals/${id2}/decide`, JSON.stringify({ decision: 'reject' }));
      expect(late).toEqual({ status: 200, body: { accepted: false, reason: 'superseded' } });
      expect(session.events.filter((e) => e.type === 'approval/decided')).toHaveLength(2); // 仍两条
    } finally {
      sse.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('端口被占 → 应用启动断言拒启（fail-at-startup 组合根层：webui 失败行非空即拒）', async () => {
    const heldPort = await grabPort();
    const held = await holdPort(heldPort);
    const workspace = makeWorkspace();
    try {
      // 官方件失败行非空 = boot 拒启（宁拒绝不误读）：聚合清单带 webui 行与
      // WEBUI_PORT_IN_USE 码（apply 内 EADDRINUSE 映射的最终消费面）
      await expect(
        createRuntime({
          dbPath: ':memory:',
          workspace,
          interactive: false,
          webuiPort: heldPort,
          streamFn: scriptedStream([textMessage('答')]),
        }),
      ).rejects.toThrow(/webui 端口被占用/);
    } finally {
      await held.release();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('对照组：无 webuiPort boot 成功、默认端口 7860 被外占 = 缺省零监听', async (ctx) => {
    // 占住缺省端口（若环境里 7860 已被真实例占用则跳过——零监听断言无法隔离跑）
    let held: { release(): Promise<void> };
    try {
      held = await holdPort(DEFAULT_WEBUI_PORT);
    } catch {
      ctx.skip();
      return;
    }
    const workspace = makeWorkspace();
    try {
      const runtime = await createRuntime({
        dbPath: ':memory:',
        workspace,
        interactive: false,
        streamFn: scriptedStream([textMessage('答')]),
      });
      runtimes.push(runtime);
      // webui 行 activated（默认层第十四行在场）但零监听——若缺省真监听 7860
      // 会 EADDRINUSE 拒启；boot 成功 + 行激活 = enabled 缺省 false 的惰性证据
      expect(runtime.appsService.list().some((row) => row.id === 'webui' && row.status === 'activated')).toBe(true);
    } finally {
      await held.release();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
