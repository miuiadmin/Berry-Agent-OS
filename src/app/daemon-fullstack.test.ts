/**
 * L5 app — daemon 刀一组合根全栈测试（契约篇 §6.8 常驻执行体条）：
 * createRuntime({daemon:{token,port}}) 端到端——mock 只停在模型层（scripted
 * streamFn），webui HTTP 面/审批竞速/durable 落账全真。
 *
 * 六断言族：
 * ① M2 扩闸：daemon 形态（无 TUI 腿）审批经 web 腿应答 → decided via 'web'；
 * ② P2 超时腿：无应答到点 fail-closed → decided 'unavailable' via 'timeout'；
 * ③ per-ownership 帽（10/owner）：帽满第 11 ask 即时收场（无 via、不留 pending）；
 * ④ heldSessions 租约：活 daemon 持有 → 他进程拒开；判死/自身豁免 → 放行；
 * ⑤ M8 boot 回放重挂两腿：已过即落账 unavailable / 未到期 claim → web decide
 *    经合成汇流点落 decided（decide handler 绝不写 durable 的形状物证）。
 *
 * 数据目录文件级钉扎（G1 教训）+ dbPath 显式临时文件（双 boot 同库场景）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, request, type IncomingMessage } from 'node:http';
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
import { createRuntime } from './assembly.js';
import type { AppRuntime } from './assembly.js';
import { daemonDirOf, daemonStatePath, daemonTokenPath, defaultProcessProbe } from './daemon-state.js';
import Database from 'better-sqlite3';

/* ---------------- 测试基建 ---------------- */

/** 文件级数据目录钉扎（daemon.json 租约测试读写它；防污染真实 ~/.berry） */
const dataRoot = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-fs-data-'));
process.env['APP_DATA_DIR'] = dataRoot;
/** 文件库目录（双 boot 同库场景的 dbPath 落点） */
const dbDir = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-fs-db-'));
afterEach(() => {
  // 每用例清租约文件（跨用例串扰防线——token 留盘无害）
  rmSync(daemonDirOf(dataRoot), { recursive: true, force: true });
});

/** 零用量（scripted 终值携带——用量断言不在本文件面） */
const NO_USAGE: Usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

/** 文本 assistant 终值（scripted 流应答——会话收场用） */
const textMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** 带升权参数的 bash toolCall（read-only 档下触发审批 ask——chat.test S5 同款） */
const bashEscalation = (tag: string, command = 'pwd'): AssistantMessage => ({
  role: 'assistant',
  content: [
    {
      type: 'toolCall',
      id: `call-bash-${tag}`,
      name: 'bash',
      arguments: { command, sandbox_permissions: 'workspace-write', justification: `测试升权 ${tag}` },
    },
  ],
  usage: NO_USAGE,
  stopReason: 'toolUse',
  timestamp: 1,
});

/** 合成流：start → done（终值即脚本消息） */
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

/** 脚本化 StreamFn（恒答同一条——单会话用例面） */
function scriptedStream(responses: AssistantMessage[]): StreamFn {
  let calls = 0;
  return (context: LlmContext, _options: StreamFnOptions) => {
    void context;
    const message = responses[Math.min(calls++, responses.length - 1)]!;
    return syntheticStream(message);
  };
}

/** 每会话首答升权、后续答文本（帽测试 11 会话共用——按上下文有无 assistant 分档） */
function perSessionEscalateStream(): StreamFn {
  let n = 0;
  return (context: LlmContext) => {
    const hasAssistant = context.messages.some((m) => m.role === 'assistant');
    return syntheticStream(hasAssistant ? textMessage('收工') : bashEscalation(`cap-${(n += 1)}`));
  };
}

/** 临时工作区（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeWorkspace(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'daemon-fs-ws-')));
}

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏） */
const runtimes: AppRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    // 有界关停：红灯用例可能留未决 ask（daemon 形态 settle 挂）——5s 后放弃等待，
    // 防单测红灯级联成 roleRegistry 残留（模块级单例，dispose 不达即角色不卸）
    await Promise.race([runtime.shutdown().catch(() => undefined), new Promise((r) => setTimeout(r, 5_000))]);
  }
});

/** 真子进程登记（租约持有者——afterEach SIGKILL 兜底） */
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

/** 崩溃快报竞速底座：子进程先死则带输出抛，不做空等（waitReady 同款形） */
function raceChildExit<T>(wait: Promise<T>, exited: Promise<number | null>, output: () => string): Promise<T> {
  return Promise.race([
    wait,
    exited.then((code) => {
      throw new Error(`子进程提前退出（${code}）：${output()}`);
    }),
  ]);
}

/** 起空闲端口探针（listen 0 读回即关） */
async function grabPort(): Promise<number> {
  const { createServer } = await import('node:http');
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address() as { port: number };
      probe.close(() => resolve(addr.port));
    });
  });
}

/** 等待谓词成立（25ms 轮询——HTTP/durable 轮询共用底座） */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 8000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** POST JSON 助手（显式 Content-Length + req.end 纪律；鉴权头随行） */
function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        res.setEncoding('utf-8');
        let text = '';
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(payload); // 不 end 不发（实证教训）
  });
}

/** 鉴权 GET JSON 助手（fetch 全自动收尾——非 SSE 面即可用） */
async function getJson(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

/** 未决审批清单（authed——重挂/帽断言的观测面） */
async function approvalsOf(port: number, token: string): Promise<{ approvalId: string }[]> {
  const res = await getJson(port, '/api/approvals', { authorization: `Bearer ${token}` });
  return (res.body as { approvals?: { approvalId: string }[] }).approvals ?? [];
}

/** durable 审批行查询（queryEvents 同 M8 扫描面——落账断言单源） */
function approvalRows(
  rt: AppRuntime,
  type: 'approval/asked' | 'approval/decided',
): { sessionId: string; data: { approvalId?: string; decision?: string; via?: string } }[] {
  const res = rt.persistence!.queryEvents({ types: [type], limit: 1000 });
  // readonly 行集 → 拷贝后断形状（data 为 unknown——按审批面载荷窄化）
  return [...res.rows] as unknown as {
    sessionId: string;
    data: { approvalId?: string; decision?: string; via?: string };
  }[];
}

/** 某 approvalId 的 decided 行（undefined = 未落账） */
function decidedOf(rt: AppRuntime, approvalId: string): { data: { decision?: string; via?: string } } | undefined {
  return approvalRows(rt, 'approval/decided').find((r) => r.data.approvalId === approvalId);
}

/** 某会话的首条 asked 行（帽测试第 11 ask 的定位面） */
function askedOf(rt: AppRuntime, sessionId: string): { data: { approvalId?: string } } | undefined {
  return approvalRows(rt, 'approval/asked').find((r) => r.sessionId === sessionId);
}

/** 全驱动结算谓词（清尾面——decide 后 run 收场才 shutdown 不挂） */
function allSettled(rt: AppRuntime): boolean {
  return [...rt.drivers.entries.values()].every((e) => !e.driver.isRunning);
}

/** daemon 形态 runtime 装配面（六用例共用的选项底座） */
function daemonOpts(over: {
  dbPath: string;
  streamFn: StreamFn;
  approvalTimeoutMs: number;
  workspace?: string;
}): Parameters<typeof createRuntime>[0] {
  return {
    dbPath: over.dbPath,
    workspace: over.workspace ?? makeWorkspace(),
    interactive: false,
    sandboxMode: 'read-only' as const,
    approvalPolicy: 'ask' as const,
    streamFn: over.streamFn,
    approvalTimeoutMs: over.approvalTimeoutMs,
  };
}

/* ---------------- M8 子进程 B（同进程双活被结构性禁止） ---------------- */

/**
 * 同进程双活 runtime 被 roleRegistry（contracts/messages.ts 模块级单例）结构性
 * 禁止——A 活着时 B 的 chat/memory apply 必撞 AGENT_ROLE_EXISTS。M8 的被测语义
 * 本就是「daemon A 死后、daemon B **另一进程**同库 boot 回放」——B 起真子进程
 * 恰是生产形态的最忠实复刻（createRuntime({daemon}) 不 acquire daemon.json，
 * 子进程不撞单实例仲裁；双开护栏由 WAL 多句柄立法承载）。
 */
const REPLAY_CHILD_SCRIPT = `
// M8 回放子进程 B：daemon 形态 boot 同库 → 就绪上报 → 驻留至 exitFile → 退出前再上报
import { accessSync, writeFileSync, constants } from 'node:fs';
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { createRuntime } = await import(cfg.assemblyPath);
// 极简模型面：恒答一条文本（B 的 boot-open 会话不升权不生审批）
const msg = { role: 'assistant', content: [{ type: 'text', text: 'b' }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 }, stopReason: 'stop', timestamp: 1 };
const streamFn = () => {
  const events = [{ type: 'start', partial: { ...msg, content: [] } }, { type: 'done', reason: 'stop', message: msg }];
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: () =>
          i < events.length
            ? Promise.resolve({ value: events[i++], done: false })
            : Promise.resolve({ value: undefined, done: true }),
      };
    },
    result: async () => msg,
  };
};
const rt = await createRuntime({
  dbPath: cfg.dbPath, workspace: cfg.workspace, interactive: false,
  sandboxMode: 'read-only', approvalPolicy: 'ask', streamFn,
  approvalTimeoutMs: cfg.approvalTimeoutMs, daemon: { token: cfg.token, port: cfg.port },
});
// durable 审批行上报（boot 后一次 / 退出前一次——REPORT 行是父进程唯一断言面）
const rows = () => rt.persistence.queryEvents({ types: ['approval/asked', 'approval/decided'], limit: 100 }).rows;
const report = () => console.log('REPORT ' + JSON.stringify(rows().map((r) => ({ t: r.type, d: r.data }))));
report();
// 快照 boot 时的 decided 行数：退出前等它增长（重挂腿——web decide 后汇流点落账
// 完成才上报）或 3s 帽（到期腿 boot 已落账，无增量即立即过）
const decidedAtBoot = rows().filter((r) => r.type === 'approval/decided').length;
writeFileSync(cfg.readyFile, '1');
await new Promise((resolve) => {
  const iv = setInterval(() => {
    try { accessSync(cfg.exitFile, constants.F_OK); clearInterval(iv); resolve(); } catch { /* 未到退出时点 */ }
  }, 50);
});
const deadline = Date.now() + 3000;
for (;;) {
  const now = rows().filter((r) => r.type === 'approval/decided').length;
  if (now > decidedAtBoot || Date.now() > deadline) break;
  await new Promise((r) => setTimeout(r, 50));
}
report();
await rt.shutdown();
process.exit(0);
`;

/** 子进程 B 句柄：就绪等待 + REPORT 轮询 + 退出收口 */
interface ReplayChild {
  /** 等就绪标记（boot 完成——含 M8 回放段全量执行完） */
  waitReady(): Promise<void>;
  /** 最近一次 REPORT 的审批行（无 = 空数组） */
  report(): { t: string; d: { approvalId?: string; decision?: string; via?: string } }[];
  /** 写 exitFile 并等子进程自然退出（5s 帽后 SIGKILL 兜底） */
  finish(): Promise<void>;
}

/** 起 M8 回放子进程 B（tsx 转译内联脚本——repo 无测试专用 fixture 面的取舍） */
function spawnReplayChild(cfg: {
  dbPath: string;
  approvalTimeoutMs: number;
  token: string;
  port: number;
}): ReplayChild {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-child-'));
  const scriptPath = join(dir, 'child-b.mts');
  writeFileSync(scriptPath, REPLAY_CHILD_SCRIPT);
  const readyFile = join(dir, 'ready');
  const exitFile = join(dir, 'exit');
  const stdout: string[] = [];
  const child = spawn(
    process.execPath,
    [
      // repo 内 tsx CLI（src/app → 上两级 = 仓根；dbDir 落在系统 tmp 下不可作锚）
      fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
      scriptPath,
      JSON.stringify({
        ...cfg,
        workspace: makeWorkspace(),
        readyFile,
        exitFile,
        assemblyPath: fileURLToPath(new URL('./assembly.ts', import.meta.url)),
      }),
    ],
    { env: { ...process.env, APP_LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr.setEncoding('utf-8');
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  /** 退出期约（exit 事件不回放——已死者当场判） */
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  return {
    waitReady: () =>
      // 崩溃快报：子进程先死则带输出抛出（否则只看到 20s 超时——不可诊断）
      Promise.race([
        waitFor(() => existsSync(readyFile), 20_000, '子进程 B boot 就绪'),
        exited.then(() => {
          throw new Error(`子进程 B 提前退出：${stdout.join('')}${stderr.join('')}`);
        }),
      ]),
    report: () => {
      const reports = stdout
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('REPORT '))
        .map((line) => JSON.parse(line.slice('REPORT '.length)) as { t: string; d: { approvalId?: string } }[]);
      return reports.at(-1) ?? [];
    },
    finish: async () => {
      writeFileSync(exitFile, '1');
      await exited;
    },
  };
}

/* ---------------- 用例 ---------------- */

describe('daemon 组合根全栈：审批三腿与协议面', () => {
  it('M2 扩闸：无 TUI 腿形态 web 腿应答 → decided via web', async () => {
    const port = await grabPort();
    const token = 'fs-token-m2';
    const rt = await createRuntime({
      ...daemonOpts({
        dbPath: ':memory:',
        streamFn: scriptedStream([bashEscalation('m2'), textMessage('完')]),
        approvalTimeoutMs: 60_000,
      }),
      daemon: { token, port },
    });
    runtimes.push(rt);
    const auth = { authorization: `Bearer ${token}` };

    // boot berrycode 会话（daemon 形态 webui 常开——清单可达即鉴权/开面双证）
    const sessions = (await getJson(port, '/api/sessions', auth)).body as { id: string; active: boolean }[];
    const sid = sessions.find((s) => s.active)!.id;

    // 升权 ask：read-only 档 + workspace-write 请求 → 审批（无 token 面 401 顺证）
    expect((await post(port, `/api/sessions/${sid}/submit`, { text: '跑 pwd' }, auth)).status).toBe(202);
    // web 腿 claim = M2 扩闸物证（interactive:false 且无 TUI 腿，ask 仍有人应答）
    await waitFor(async () => (await approvalsOf(port, token)).length === 1, 8000, 'web 腿 claim');
    const approvalId = (await approvalsOf(port, token))[0]!.approvalId;

    // 网页应答 approve → decided 落账 via 'web'
    expect((await post(port, `/api/approvals/${approvalId}/decide`, { decision: 'approve' }, auth)).status).toBe(200);
    await waitFor(async () => decidedOf(rt, approvalId) !== undefined, 8000, 'decided 落账');
    const row = decidedOf(rt, approvalId)!.data;
    expect(row.decision).toBe('approve');
    expect(row.via).toBe('web');
    // run 收场（approve 后 bash 执行 → 第二轮文本终值）
    await waitFor(() => allSettled(rt), 8000, 'run 结算');
  }, 30_000);

  it('P2 超时腿：无应答到点 fail-closed → decided unavailable via timeout', async () => {
    const port = await grabPort();
    const token = 'fs-token-p2';
    const rt = await createRuntime({
      ...daemonOpts({
        dbPath: ':memory:',
        streamFn: scriptedStream([bashEscalation('p2'), textMessage('完')]),
        approvalTimeoutMs: 400, // 测试注小值（生产缺省 30min——transformTimeoutMs 同款注入面）
      }),
      daemon: { token, port },
    });
    runtimes.push(rt);
    const auth = { authorization: `Bearer ${token}` };

    const sessions = (await getJson(port, '/api/sessions', auth)).body as { id: string; active: boolean }[];
    const sid = sessions.find((s) => s.active)!.id;
    expect((await post(port, `/api/sessions/${sid}/submit`, { text: '跑 pwd' }, auth)).status).toBe(202);
    await waitFor(async () => (await approvalsOf(port, token)).length === 1, 8000, 'ask claim');
    const approvalId = (await approvalsOf(port, token))[0]!.approvalId;

    // 不应答：超时腿到点收场（asked 基准 + setTimeout 单调钟）
    await waitFor(async () => decidedOf(rt, approvalId) !== undefined, 8000, '超时落账');
    const row = decidedOf(rt, approvalId)!.data;
    expect(row.decision).toBe('unavailable');
    expect(row.via).toBe('timeout');
    // 清单随决收面（已决过滤——卡片撤下）
    await waitFor(async () => (await approvalsOf(port, token)).length === 0, 8000, '清单收面');
    // run 收场（超时 = undefined → gate 拒 → 工具结果落账 → 第二轮文本终值）
    await waitFor(() => allSettled(rt), 8000, 'run 结算');
  }, 30_000);

  it('per-ownership 帽：10/owner 帽满 → 第 11 ask 即时 unavailable（无 via、不留 pending）', async () => {
    const port = await grabPort();
    const token = 'fs-token-cap';
    const dbPath = join(dbDir, 'cap.db');
    const rt = await createRuntime({
      ...daemonOpts({ dbPath, streamFn: perSessionEscalateStream(), approvalTimeoutMs: 300_000 }),
      daemon: { token, port },
    });
    runtimes.push(rt);
    const auth = { authorization: `Bearer ${token}` };

    // 开 11 会话（POST /api/sessions 恒开新——结构性不撞租约）
    const sids: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await post(port, '/api/sessions', {}, auth);
      expect(res.status).toBe(201);
      sids.push((res.body as { id: string }).id);
    }
    // 前 10 逐个投递升权 → 等 10 条 claim 在册（帽计数确定性前提）
    for (let i = 0; i < 10; i += 1) {
      expect((await post(port, `/api/sessions/${sids[i]}/submit`, { text: `跑 ${i}` }, auth)).status).toBe(202);
    }
    await waitFor(async () => (await approvalsOf(port, token)).length === 10, 10_000, '10 条 claim');

    // 第 11 投递：ask 即时收场（帽满 fail-closed——不发 claim 不排队）
    expect((await post(port, `/api/sessions/${sids[10]}/submit`, { text: '跑 10' }, auth)).status).toBe(202);
    await waitFor(
      async () => {
        const asked = askedOf(rt, sids[10]!);
        return asked !== undefined && decidedOf(rt, asked.data.approvalId!) !== undefined;
      },
      8000,
      '第 11 ask 即时收场',
    );
    const eleventh = askedOf(rt, sids[10]!)!.data.approvalId!;
    const row = decidedOf(rt, eleventh)!.data;
    expect(row.decision).toBe('unavailable');
    expect(row.via).toBeUndefined(); // 无腿收场无归因（帽满路径不记 via）
    // 清单仍是 10（第 11 从未 claim）
    expect((await approvalsOf(port, token)).length).toBe(10);

    // 清尾：10 条逐一 approve（每会话第二轮文本收场）——全部结算后 shutdown 不挂
    const pending = (await approvalsOf(port, token)).map((a) => a.approvalId);
    for (const id of pending) {
      expect((await post(port, `/api/approvals/${id}/decide`, { decision: 'approve' }, auth)).status).toBe(200);
    }
    await waitFor(() => allSettled(rt), 15_000, '11 会话全结算');
  }, 60_000);
});

describe('daemon 租约与 boot 回放重挂', () => {
  it('heldSessions 租约：活 daemon 持有 → 他进程拒开；判死与自身 pid 豁免 → 放行', async () => {
    const dbPath = join(dbDir, 'lease.db');
    const workspace = makeWorkspace();

    // boot A（非 daemon --port 形态）：落一个会话 S 后关停（flush 后 S 为该 cwd 最新）
    const rtA = await createRuntime({
      dbPath,
      workspace,
      interactive: false,
      resumeSession: true,
      streamFn: scriptedStream([textMessage('a')]),
    });
    const sid = [...rtA.drivers.entries.values()].find((e) => !e.retired)!.session.header.sessionId;
    await rtA.shutdown();

    // 真活持有者子进程 + 其真实进程起始标识（判活判据源）
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    children.push(holder);
    const startId = defaultProcessProbe.startId(holder.pid!)!;
    const writeLease = (pid: number, id: string): void => {
      mkdirSync(daemonDirOf(dataRoot), { recursive: true });
      writeFileSync(
        daemonStatePath(dataRoot),
        JSON.stringify({ pid, processStartId: id, bootId: 'lease-boot', port: 1, heldSessions: [sid] }),
      );
    };
    writeLease(holder.pid!, startId);

    // boot B（同库同 cwd 续接）：活 daemon 持有 S → 拒开（boot 不复活 S）
    const rtB = await createRuntime({
      dbPath,
      workspace,
      interactive: false,
      resumeSession: true,
      streamFn: scriptedStream([textMessage('b')]),
    });
    runtimes.push(rtB);
    expect([...rtB.drivers.entries.keys()]).not.toContain(sid);
    await rtB.shutdown();

    // 判死放行：杀持有者后同参数 boot → 续接 S
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    const rtC = await createRuntime({
      dbPath,
      workspace,
      interactive: false,
      resumeSession: true,
      streamFn: scriptedStream([textMessage('c')]),
    });
    runtimes.push(rtC);
    expect([...rtC.drivers.entries.keys()]).toContain(sid);
    await rtC.shutdown();

    // 自身豁免：daemon.json 写本进程身份 → 不算「他进程持有」→ 放行
    writeLease(process.pid, defaultProcessProbe.startId(process.pid)!);
    const rtD = await createRuntime({
      dbPath,
      workspace,
      interactive: false,
      resumeSession: true,
      streamFn: scriptedStream([textMessage('d')]),
    });
    runtimes.push(rtD);
    expect([...rtD.drivers.entries.keys()]).toContain(sid);
    await rtD.shutdown();
  }, 60_000);

  it('M8 回放·到期腿：boot 扫描已过期 asked → 即时落账 unavailable via timeout', async () => {
    const dbPath = join(dbDir, 'm8-expired.db');
    const portA = await grabPort();
    const tokenA = 'fs-token-m8a';
    // A：daemon 形态留 pending asked（超时腿拉长——run 挂在 ask 上不收场）
    const rtA = await createRuntime({
      ...daemonOpts({
        dbPath,
        streamFn: scriptedStream([bashEscalation('m8x'), textMessage('a-end')]),
        approvalTimeoutMs: 300_000,
      }),
      daemon: { token: tokenA, port: portA },
    });
    runtimes.push(rtA);
    const authA = { authorization: `Bearer ${tokenA}` };
    const sessions = (await getJson(portA, '/api/sessions', authA)).body as { id: string; active: boolean }[];
    const sid = sessions.find((s) => s.active)!.id;
    expect((await post(portA, `/api/sessions/${sid}/submit`, { text: '跑 pwd' }, authA)).status).toBe(202);
    await waitFor(async () => (await approvalsOf(portA, tokenA)).length === 1, 8000, 'A 的 ask claim');
    const approvalId = (await approvalsOf(portA, tokenA))[0]!.approvalId;
    await rtA.persistence!.flush(); // asked 行屏障落盘（B 扫 durable 的前提——A 相当于已死，flush 即死亡前落账）

    // 过窗后 B 子进程同库 boot（不同 cwd 开新会话不撞 A）：asked 已过期 → boot 即落账
    await new Promise((r) => setTimeout(r, 350));
    const portB = await grabPort();
    const childB = spawnReplayChild({ dbPath, approvalTimeoutMs: 200, token: 'fs-token-m8b', port: portB });
    await childB.waitReady();
    // 已过即落账（boot 就绪上报即含 decided 行——REPORT 是唯一断言面）
    const row = childB.report().find((r) => r.t === 'approval/decided' && r.d.approvalId === approvalId)?.d;
    expect(row?.decision).toBe('unavailable');
    expect(row?.via).toBe('timeout');
    await childB.finish();

    // 清尾：A 的 claim 仍挂着——decide 走 A 端点让 A 的 run 结算（防 shutdown 挂）
    expect((await post(portA, `/api/approvals/${approvalId}/decide`, { decision: 'approve' }, authA)).status).toBe(200);
    await waitFor(() => allSettled(rtA), 8000, 'A run 结算');
  }, 60_000);

  it('M8 回放·重挂腿：未到期 claim → web decide 先胜 → 汇流点落 decided via web', async () => {
    const dbPath = join(dbDir, 'm8-live.db');
    const portA = await grabPort();
    const tokenA = 'fs-token-m8c';
    const rtA = await createRuntime({
      ...daemonOpts({
        dbPath,
        streamFn: scriptedStream([bashEscalation('m8w'), textMessage('a-end')]),
        approvalTimeoutMs: 300_000,
      }),
      daemon: { token: tokenA, port: portA },
    });
    runtimes.push(rtA);
    const authA = { authorization: `Bearer ${tokenA}` };
    const sessions = (await getJson(portA, '/api/sessions', authA)).body as { id: string; active: boolean }[];
    const sid = sessions.find((s) => s.active)!.id;
    expect((await post(portA, `/api/sessions/${sid}/submit`, { text: '跑 pwd' }, authA)).status).toBe(202);
    await waitFor(async () => (await approvalsOf(portA, tokenA)).length === 1, 8000, 'A 的 ask claim');
    const approvalId = (await approvalsOf(portA, tokenA))[0]!.approvalId;
    await rtA.persistence!.flush();

    // B 子进程即刻 boot（asked 未到期）：重挂 claim（清单可见）+ 超时腿竞速
    // （超时基准 = A 的 askedAt——子进程起慢 3-5s，帽须放宽：本腿断言 decide 先胜）
    const portB = await grabPort();
    const tokenB = 'fs-token-m8d';
    const childB = spawnReplayChild({ dbPath, approvalTimeoutMs: 30_000, token: tokenB, port: portB });
    await childB.waitReady();
    const authB = { authorization: `Bearer ${tokenB}` };
    // 重挂条目在 B 的清单（operator 可应答——审计洞另一边补全的观测面）
    await waitFor(
      async () => (await approvalsOf(portB, tokenB)).some((a) => a.approvalId === approvalId),
      8000,
      'B 重挂 claim',
    );

    // web decide 先胜（30s 超时腿远未到）→ 汇流点落 decided（decide handler 绝不写
    // durable——落账在重挂路径的物证：B 侧无 run 也无 driver，decided 只可能出自汇流点）
    expect((await post(portB, `/api/approvals/${approvalId}/decide`, { decision: 'reject' }, authB)).status).toBe(200);
    await childB.finish();
    const row = childB.report().find((r) => r.t === 'approval/decided' && r.d.approvalId === approvalId)?.d;
    expect(row?.decision).toBe('reject');
    expect(row?.via).toBe('web');

    // 清尾：A 的 claim 仍挂——approve 走 A 端点结算 A 的 run
    expect((await post(portA, `/api/approvals/${approvalId}/decide`, { decision: 'approve' }, authA)).status).toBe(200);
    await waitFor(() => allSettled(rtA), 8000, 'A run 结算');
  }, 60_000);
});

/* ---------------- 刀二裁决行为锁：F4 reload 禁面 + P2 armed（ask 时点判据） ---------------- */

describe('daemon 刀二行为锁：F4 全量 reload 禁面 + armed SSE 在场不武装', () => {
  it('F4：daemon 形态全量 /reload 拒（error 面两触达面同文案）；单区 --app 过闸放行', async () => {
    const port = await grabPort();
    const token = 'fs-token-f4';
    const rt = await createRuntime({
      ...daemonOpts({
        dbPath: ':memory:',
        streamFn: scriptedStream([textMessage('好')]),
        approvalTimeoutMs: 300_000,
      }),
      daemon: { token, port },
    });
    runtimes.push(rt);
    // 全量：daemon 形态拒绝（在飞会话活账撕裂防线；return 非抛——ReloadResult.error 面）
    const full = await rt.reload();
    expect(full.error).toContain('daemon 形态禁用全量 reload');
    expect(full.error).toContain('--app');
    // 单区：过 F4 闸（闸后报「不在册」而非禁面文案——放行物证；换装链照常可进）
    const zone = await rt.reload('ghost-app');
    expect(zone.error).toContain('不在册');
    expect(zone.error).not.toContain('daemon 形态禁用');
  }, 30_000);

  it('armed：在场持 token SSE 连接 >0 → 超时腿不武装（过帽未决）；web decide 照常收场', async () => {
    const port = await grabPort();
    const token = 'fs-token-armed';
    const rt = await createRuntime({
      ...daemonOpts({
        dbPath: ':memory:',
        streamFn: scriptedStream([bashEscalation('armed'), textMessage('完')]),
        approvalTimeoutMs: 400, // 测试注小值——3 帽等待窗内未决即「未武装」物证
      }),
      daemon: { token, port },
    });
    runtimes.push(rt);
    const auth = { authorization: `Bearer ${token}` };

    // 在场腿：一条持 token 的 SSE 连接（attach/SPA/监控尾同判——attachedCount 计入）
    const sseReq = get({ host: '127.0.0.1', port, path: '/api/events', headers: auth }, (res) => {
      res.setEncoding('utf8');
      res.on('data', () => undefined); // 帧内容不断言（本测锁 armed 判据非帧面）——消费防背压
    });
    sseReq.on('error', () => undefined);

    const sessions = (await getJson(port, '/api/sessions', auth)).body as { id: string; active: boolean }[];
    const sid = sessions.find((s) => s.active)!.id;
    expect((await post(port, `/api/sessions/${sid}/submit`, { text: '跑 pwd' }, auth)).status).toBe(202);
    await waitFor(async () => (await approvalsOf(port, token)).length === 1, 8000, 'ask claim');
    const approvalId = (await approvalsOf(port, token))[0]!.approvalId;

    // 超时腿未武装：400ms 帽 + 3 帽等待仍无 decided（对照 P2 用例无在场腿到点即收）
    await new Promise((r) => setTimeout(r, 1_200));
    expect(decidedOf(rt, approvalId)).toBeUndefined();

    // 在场腿应答收场：armed 只是「不设钟」不是「拒绝应答」——web decide 照常
    expect((await post(port, `/api/approvals/${approvalId}/decide`, { decision: 'approve' }, auth)).status).toBe(200);
    await waitFor(async () => decidedOf(rt, approvalId) !== undefined, 8000, 'decided 落账');
    const row = decidedOf(rt, approvalId)!.data;
    expect(row.decision).toBe('approve');
    expect(row.via).toBe('web');
    await waitFor(() => allSettled(rt), 8000, 'run 结算');
    sseReq.destroy();
  }, 30_000);
});

/* ---------------- 复盘 #30/#32/#35：前台环子进程 + cordon 装配线 + tuiMain P3 ---------------- */

/** 前台环子进程脚本（复盘 #30）：真跑 daemonForegroundMain——acquire → 常驻 → 退出码落 exitFile */
const FOREGROUND_CHILD_SCRIPT = `
import { writeFileSync } from 'node:fs';
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { daemonForegroundMain } = await import(cfg.daemonPath);
daemonForegroundMain(cfg.port, { dataRoot: cfg.dataRoot }).then(
  (code) => { writeFileSync(cfg.exitFile, String(code)); process.exit(code); },
  (err) => { writeFileSync(cfg.exitFile, 'ERR ' + (err?.stack ?? String(err))); process.exit(1); },
);
`;

/** tuiMain 子进程脚本（复盘 #35）：真跑生产 TUI 入口——P3 横幅渲染在 stdout、退出码落 exitFile。
 * 模型层桩不进 cfg（函数不可序列化）：横幅在 boot 期、无 run 发生，streamFn 零调用——空流桩够形。 */
const TUI_CHILD_SCRIPT = `
import { writeFileSync } from 'node:fs';
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { tuiMain } = await import(cfg.tuiMainPath);
const streamFn = async () => ({ async *[Symbol.asyncIterator]() {} });
tuiMain({ dbPath: cfg.dbPath, workspace: cfg.workspace, streamFn }).then(
  (code) => { writeFileSync(cfg.exitFile, String(code)); process.exit(code); },
  (err) => { writeFileSync(cfg.exitFile, 'ERR ' + (err?.stack ?? String(err))); process.exit(1); },
);
`;

describe('daemon 前台环与 cordon 装配线（复盘 #30/#32/#35）', () => {
  it('daemonForegroundMain 前台环：acquire 落账 → heldSessions 随 open 重写 → SIGTERM 优雅退 → release 清账', async () => {
    const workspace = makeWorkspace();
    const port = await grabPort();
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-fg-child-'));
    const scriptPath = join(dir, 'fg.mts');
    writeFileSync(scriptPath, FOREGROUND_CHILD_SCRIPT);
    const exitFile = join(dir, 'exit');
    // 子进程真跑生产前台主循环（berry daemon start spawn 的目标形态）——cwd 钉
    // 临时工作区，APP_DATA_DIR 继承本文件钉扎的 dataRoot（G1 教训：不碰真 ~/.berry）
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        scriptPath,
        JSON.stringify({
          port,
          dataRoot,
          exitFile,
          daemonPath: fileURLToPath(new URL('./daemon.ts', import.meta.url)),
        }),
      ],
      { env: { ...process.env, APP_LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'], cwd: workspace },
    );
    children.push(child);
    const out: string[] = [];
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => out.push(chunk));
    const errOut: string[] = [];
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => errOut.push(chunk));
    const exited = new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
      else child.once('exit', (code) => resolve(code));
    });
    const output = () => out.join('') + errOut.join('');

    // ① acquire 落账 + webui 起面：daemon.json/token 在场 + health 200
    await raceChildExit(
      waitFor(
        () => existsSync(daemonStatePath(dataRoot)) && existsSync(daemonTokenPath(dataRoot)),
        20_000,
        '前台 boot 落账',
      ),
      exited,
      output,
    );
    const token = readFileSync(daemonTokenPath(dataRoot), 'utf8').trim();
    await raceChildExit(
      waitFor(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
          } catch {
            return false; // 未监听即 ECONNREFUSED——轮询继续（不炸等待底座）
          }
        },
        10_000,
        'health 就绪',
      ),
      exited,
      output,
    );
    // ② 真握手正判（生产判据同源）：GET /api/sessions 带 Bearer → 200 裸数组
    const auth = { authorization: `Bearer ${token}` };
    expect((await getJson(port, '/api/sessions', auth)).status).toBe(200);
    // ③ heldSessions 随 open 重写（syncHeldSessions 闭包——onEntriesChange 驱动）：POST 开新 → daemon.json 持有集含新 id
    const opened = (await post(port, '/api/sessions', {}, auth)).body as { id: string };
    await raceChildExit(
      waitFor(
        () => {
          const state = JSON.parse(readFileSync(daemonStatePath(dataRoot), 'utf8')) as { heldSessions: string[] };
          return state.heldSessions.includes(opened.id);
        },
        8_000,
        'heldSessions 同步',
      ),
      exited,
      output,
    );
    // ④ SIGTERM 优雅退：退出码 143（信号记账）+ releaseDaemonState 清账（daemon.json 消失）
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    await waitFor(() => !existsSync(daemonStatePath(dataRoot)), 5_000, 'release 清账');
  }, 60_000);

  it('daemonForegroundMain SIGHUP 实弹：优雅退 129 + release 清账（TUI 第十一轮盲区 4——此前仅静态判读）', async () => {
    // SIGHUP 接线面零实弹：signals.test.ts 单元锁（fake surface）捕不到
    // daemon.ts 接线回归（如漏挂 SIGHUP 监听则前台 daemon 收 HUP 直接默认死
    // ——释放编舞全跳）。真跑生产前台主循环实弹核：记账码 129 + 清账。
    const workspace = makeWorkspace();
    const port = await grabPort();
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-fg-hup-'));
    const scriptPath = join(dir, 'fg-hup.mts');
    writeFileSync(scriptPath, FOREGROUND_CHILD_SCRIPT);
    const exitFile = join(dir, 'exit');
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        scriptPath,
        JSON.stringify({
          port,
          dataRoot,
          exitFile,
          daemonPath: fileURLToPath(new URL('./daemon.ts', import.meta.url)),
        }),
      ],
      { env: { ...process.env, APP_LOG_LEVEL: 'warn' }, stdio: ['ignore', 'pipe', 'pipe'], cwd: workspace },
    );
    children.push(child);
    const out: string[] = [];
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => out.push(chunk));
    const errOut: string[] = [];
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => errOut.push(chunk));
    const exited = new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
      else child.once('exit', (code) => resolve(code));
    });
    const output = () => out.join('') + errOut.join('');

    // ① boot 落账就绪：acquire 落 daemon.json + health 200（后者才是「运行时 +
    // 信号接线齐」的门——acquire 与 installExitSignals 之间有装配窗，窗内
    // SIGHUP 走默认死并残留 daemon.json，由下次 start 的 sweep 判死清扫自愈）
    await raceChildExit(
      waitFor(() => existsSync(daemonStatePath(dataRoot)), 20_000, '前台 boot 落账'),
      exited,
      output,
    );
    await raceChildExit(
      waitFor(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
          } catch {
            return false; // 未监听即 ECONNREFUSED——轮询继续（不炸等待底座）
          }
        },
        10_000,
        'health 就绪',
      ),
      exited,
      output,
    );
    // ② SIGHUP 实弹：优雅退 129（terminate 记账）+ release 清账（与 SIGTERM 同编舞）。
    // 杀目标 = daemon.json 自报 pid（监听面所在进程）——不能杀 spawn 句柄：tsx 是
    // 两层进程（wrapper + worker），wrapper 无 SIGHUP 监听也不转发（探针实证：
    // 杀 wrapper 即默认死 + worker 孤儿化 + daemon.json 残留；SIGTERM 腿靠 tsx
    // 转发碰巧可达）。生产 `berry daemon start` 走 dist 单进程无此层——测试面
    // 按真 pid 直杀才锁得住信号编舞本体
    const daemonPid = (JSON.parse(readFileSync(daemonStatePath(dataRoot), 'utf8')) as { pid: number }).pid;
    try {
      process.kill(daemonPid, 'SIGHUP');
      expect(await exited).toBe(129);
      await waitFor(() => !existsSync(daemonStatePath(dataRoot)), 5_000, 'release 清账');
    } finally {
      // 失败路径兜杀真 pid（杀 wrapper 不达 worker——孤儿 daemon 持共享 dataRoot
      // 会毒化后续测试的 acquire：DAEMON_ALREADY_RUNNING）
      try {
        process.kill(daemonPid, 'SIGKILL');
      } catch {
        // 已退（期望路径）——无孤儿可杀
      }
    }
  }, 60_000);

  it('cordon 装配线（D6 端到端）：write-behind 批落撞锁失败 → cordoned 闩 → health degraded + submit 503', async () => {
    const dbPath = join(dbDir, 'cordon.db');
    const port = await grabPort();
    const token = 'fs-token-cordon';
    const rt = await createRuntime({
      ...daemonOpts({
        dbPath,
        streamFn: scriptedStream([textMessage('ok')]),
        approvalTimeoutMs: 300_000,
      }),
      daemon: { token, port },
    });
    runtimes.push(rt);
    const auth = { authorization: `Bearer ${token}` };
    const sessions = (await getJson(port, '/api/sessions', auth)).body as { id: string; active: boolean }[];
    const sid = sessions.find((s) => s.active)!.id;
    await rt.persistence!.flush(); // 屏障：boot 批全落——锁库前库静（失败只归因 submit 批）
    expect((await getJson(port, '/api/health', {})).body).not.toHaveProperty('degraded');

    // 他连接持写锁（BEGIN IMMEDIATE 即占 WAL 写者位）——runtime 批落必然
    // SQLITE_BUSY → PERSIST_BATCH_WRITE_FAILED → onError（assembly.ts:627）→
    // cordoned 闩（:1578 webui deps 消费）。主连接 busy_timeout 先经公开
    // connection 缝缩到 150ms：实测定档 5s 时单次写尝试在 WAL 多段锁下实堵
    // ~10.5s、submit 后失败链串到 ~70s——缩档不改变 busy 语义（真锁竞争、
    // 真失败路径全保），只把等待时长缩进测试量级（整链 ~1s 内落闩）
    rt.persistence!.store.connection.pragma('busy_timeout = 150');
    const lock = new Database(dbPath);
    lock.pragma('busy_timeout = 100');
    lock.exec('BEGIN IMMEDIATE');
    try {
      expect((await post(port, `/api/sessions/${sid}/submit`, { text: 'x' }, auth)).status).toBe(202);
      // 失败链时长 ≈ 200ms 批窗 + 150ms busy 等待——10s 帽宽裕覆盖
      await waitFor(
        async () => 'degraded' in ((await getJson(port, '/api/health', {})).body as object),
        10_000,
        'cordon 闩落 → health degraded',
      );
      // 写意图面拒收（D6 拒面——server.ts 直翻 deps.cordoned() 的真消费）
      expect((await post(port, `/api/sessions/${sid}/submit`, { text: 'y' }, auth)).status).toBe(503);
    } finally {
      lock.exec('ROLLBACK'); // better-sqlite3 无 .rollback() 方法——SQL 直发
      lock.close();
    }
    // 关停（afterEach）走 close() 显式重试：锁已放，保留批补落——干净关停不挂
  }, 30_000);

  it('tuiMain P3 分支（复盘 #35）：daemon 持有本工作区会话 → 起屏横幅改道指引 + 另开新会话不拒启 + SIGTERM 143', async () => {
    const dbPath = join(dbDir, 'p3-tui.db');
    const workspace = makeWorkspace();
    // 种子 boot A：落一个本工作区会话后关停（flush 后为该 cwd 最新——子进程续接目标）
    const rtA = await createRuntime({
      dbPath,
      workspace,
      interactive: false,
      resumeSession: true,
      streamFn: scriptedStream([textMessage('a')]),
    });
    const sid = [...rtA.drivers.entries.values()].find((e) => !e.retired)!.session.header.sessionId;
    await rtA.shutdown();

    // 活持有者 + daemon.json（判活判据源 = processStartId 双匹配——④ 租约用例同款）
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    children.push(holder);
    const startId = defaultProcessProbe.startId(holder.pid!)!;
    mkdirSync(daemonDirOf(dataRoot), { recursive: true });
    writeFileSync(
      daemonStatePath(dataRoot),
      JSON.stringify({ pid: holder.pid!, processStartId: startId, bootId: 'p3-boot', port: 1, heldSessions: [sid] }),
    );

    // 子进程真跑 tuiMain（生产 TUI 入口）：stdin pipe 不关不 EOF（关了会提前
    // 触发输入收场），横幅经 pi-tui headless 渲染到 stdout——输出即断言面
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-p3-tui-'));
    writeFileSync(join(dir, 'tui.mts'), TUI_CHILD_SCRIPT);
    const exitFile = join(dir, 'exit');
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        join(dir, 'tui.mts'),
        JSON.stringify({
          dbPath,
          workspace,
          exitFile,
          tuiMainPath: fileURLToPath(new URL('./tui-main.ts', import.meta.url)),
        }),
      ],
      { env: { ...process.env, APP_LOG_LEVEL: 'warn' }, stdio: ['pipe', 'pipe', 'pipe'], cwd: workspace },
    );
    children.push(child);
    const out: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => out.push(chunk));
    const errOut: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => errOut.push(chunk));
    const exited = new Promise<number | null>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
      else child.once('exit', (code) => resolve(code));
    });
    const output = () => out.join('') + errOut.join('');

    // ① 拒开物证：boot warn 落 stderr（chat 件 open 撞 heldElsewhere 的响亮留痕）
    await raceChildExit(
      waitFor(() => errOut.join('').includes('被 daemon 持有'), 20_000, 'boot 拒开 warn'),
      exited,
      output,
    );
    // ② P3 分支体物证：另开新会话——同 cwd 会话行从 1 变 2（横幅文案走 notify
    // 进 TUI 滚动区，渲染是 pi-tui 内务、管道伪环境不可断言；分支执行的落库
    // 副作用是行为级真相——与起屏历史同容器同渲染路径，真终端可见性由历史
    // 渲染日常使用背书）
    await raceChildExit(
      waitFor(
        () => {
          // 只读探针句柄即开即关——轮询多轮不堆积（better-sqlite3 句柄不归 GC 管）
          const probe = new Database(dbPath);
          try {
            const rows = probe.prepare('SELECT COUNT(*) AS n FROM sessions WHERE cwd = ?').get(workspace) as {
              n: number;
            };
            return rows.n >= 2;
          } finally {
            probe.close();
          }
        },
        20_000,
        'P3 另开新会话落库',
      ),
      exited,
      output,
    );
    // ③ SIGTERM 优雅退：143（signals 编舞退出码——TUI 入口与前台环同表）。
    // 此步不竞速 exited——退出是预期收场非崩溃（竞速会把 25ms 轮询窗里的
    // exitFile 落盘误报成「提前退出」，全量并行跑时实测踩中）
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    await waitFor(() => existsSync(exitFile), 5_000, '退出码落盘'); // 落盘先于 exit——快照窗口兜底
    expect(readFileSync(exitFile, 'utf8')).toBe('143');
  }, 45_000);
});
