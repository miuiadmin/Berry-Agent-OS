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
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
});

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
  const req = get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
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
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (frames.some(pred)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`SSE 帧等待超时（已收 ${frames.length} 帧）：${JSON.stringify(frames.slice(0, 10))}`);
}

/** JSON GET 助手（fetch 全自动收尾——非 SSE 面用 fetch 即可） */
async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
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
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
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
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
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
