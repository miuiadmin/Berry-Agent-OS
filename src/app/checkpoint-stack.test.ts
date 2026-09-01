/**
 * L5 app — checkpoint 官方件全栈测试（纵切落码：捕获监听 + per-run 去重 +
 * /rewind 两段事务 + 子代理会话身份判据）。
 *
 * mock 只停在模型层（scripted streamFn），其余全真：真装配（默认层第十一行
 * checkpoint + builtins 注册表）、真工具管道（toAgentTool 三段——捕获监听挂
 * 在 tools_pre_execute 应用行）、真驱动（ConversationDriver run 边界 =
 * RunSettled 旗复位面）、真文件域（workspace 临时目录 + APP_DATA_DIR 隔离的
 * 件数据根）。事件断言走 ctx.sessions 活日志（eventsOfType——与 appendEvent
 * 同账零迟滞）；durable 断言走 persistence.loadSession（fork 内建 flush 屏障）。
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, LlmContext, StreamFn, StreamFnOptions, Usage } from '../contracts/llm.js';
import type { UiBackend } from '../channels/types.js';
import { createRuntime } from './assembly.js';
import type { AppRuntime } from './assembly.js';
import { listSessionManifests, type CheckpointManifest } from '../checkpoint/store.js';
import { canonicalize, serializeWrites } from '../tools/fs.js';

/* ---------------- guard 捕获窗口时序探针（20260901-c #5 回归锁） ---------------- */

/**
 * guard 捕获窗口钩子（vi.hoisted——vi.mock 工厂在 import 相位执行，探针状态
 * 必须先于工厂初始化）。对 captureSnapshot 做**不改行为的包一层**（时序探针
 * 非行为 mock——真捕获照跑）：窗口内拿到确定性控制点，用于「guard 快照进行
 * 中同会话 run 启动」的 TOCTOU 编排。hook 一次性自摘防污染其余捕获。
 */
const guardProbe = vi.hoisted(() => ({ hook: undefined as (() => void | Promise<void>) | undefined }));
vi.mock('../checkpoint/snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../checkpoint/snapshot.js')>();
  return {
    ...actual,
    captureSnapshot: (...args: Parameters<typeof actual.captureSnapshot>) => {
      const hook = guardProbe.hook;
      guardProbe.hook = undefined; // 一次性（下一捕获恢复直通）
      const run = () => actual.captureSnapshot(...args);
      return hook === undefined ? run() : Promise.resolve(hook()).then(run);
    },
  };
});

/* ---------------- 测试基建（与 goal.test / subagent-app.test 同款） ---------------- */

/** 零用量（totalTokens 3——远够不着任何预算帽） */
const NO_USAGE: Usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

const textMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

/** 工具调用 assistant 终值（stopReason=toolUse） */
const toolCallMessage = (name: string, args: Record<string, unknown>): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: `call-${name}-${Math.floor(performance.now())}`, name, arguments: args }],
  usage: NO_USAGE,
  stopReason: 'toolUse',
  timestamp: 1,
});

/** abort 终止事件（error 流事件编码 reason:'aborted'——loop 终值映射 aborted 的输入形；
 * conversation.test 同款——挂起流的 abort 合作收口用） */
const abortEvent = (message: AssistantMessage) => ({
  value: {
    type: 'error' as const,
    reason: 'aborted' as const,
    error: { ...message, stopReason: 'aborted' as const },
  },
  done: false as const,
});

/** 合成流（start → done） */
function syntheticStream(message: AssistantMessage) {
  const events = [
    { type: 'start' as const, partial: { ...message, content: [] } },
    { type: 'done' as const, reason: 'stop' as const, message },
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

/** 脚本化 StreamFn（按调用序推进，末条兜底；记录请求上下文——多轮工具回路可用） */
function scriptedStream(responses: AssistantMessage[]) {
  const contexts: LlmContext[] = [];
  const streamFn: StreamFn = (context: LlmContext, _options: StreamFnOptions) => {
    contexts.push(context);
    const message = responses[Math.min(contexts.length - 1, responses.length - 1)]!;
    return syntheticStream(message);
  };
  return { streamFn, contexts };
}

/** 临时目录（realpath 归一——workspace 根与符号链拼写解耦） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/** 通知录制后端（/rewind 命令回执捕获；confirm 恒 true——审批面不成本用例变量） */
function recordingBackend() {
  const notifies: string[] = [];
  const backend: UiBackend = {
    id: 'rec',
    notify: (text) => notifies.push(text),
    setStatus: () => {},
    confirm: async () => true,
  };
  return { backend, notifies };
}

/** 数据目录隔离（APP_DATA_DIR env——与生产路径完全同构；件数据根 = <env>/apps/checkpoint） */
let envDataDir: string;
let prevDataDir: string | undefined;
beforeAll(() => {
  envDataDir = mkdtempSync(join(tmpdir(), 'app-cpk-data-'));
  prevDataDir = process.env['APP_DATA_DIR'];
  process.env['APP_DATA_DIR'] = envDataDir;
});
afterAll(() => {
  if (prevDataDir === undefined) delete process.env['APP_DATA_DIR'];
  else process.env['APP_DATA_DIR'] = prevDataDir;
  rmSync(envDataDir, { recursive: true, force: true });
});

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏） */
const runtimes: AppRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/** 装配 + 登记（通知后端随装随挂——审批/命令回执两消费面就位）；返回运行时与其工作区根 */
async function assemble(
  overrides: Parameters<typeof createRuntime>[0] = {},
): Promise<{ runtime: AppRuntime; ws: string; notifies: string[] }> {
  const ws = overrides.workspace !== undefined ? String(overrides.workspace) : makeTempDir('app-cpk-ws-');
  const runtime = await createRuntime({ dbPath: ':memory:', workspace: ws, ...overrides });
  const { backend, notifies } = recordingBackend();
  runtime.ui.attach(backend);
  runtimes.push(runtime);
  return { runtime, ws, notifies };
}

/** checkpoint 件数据根（行 id = checkpoint——appDataDirOf 布局单源） */
const cpkDataRoot = (): string => join(envDataDir, 'apps', 'checkpoint');

/** ctx.sessions 活日志面（与 appendEvent 同账——checkpoint 件的消费面同款） */
function sessionsFace(runtime: AppRuntime) {
  return runtime.ctx.get<{
    eventsOfType: (type: string) => Array<{ seq: number; type: string; data: unknown }>;
    currentSessionId: () => string | undefined;
  }>('sessions');
}

/** 快照审计事件载荷形状 */
interface SnapshotAudit {
  id: string;
  triggerTool: string;
  files: number;
  bytes: number;
  guard: boolean;
}

/* ---------------- ① 捕获监听：变更类工具触发、read 不触发 ---------------- */

describe('捕获监听（tools_pre_execute 末位）', () => {
  it('write 工具触发 pre-mutation 捕获：manifest 落件数据域 + 审计事件落会话账', async () => {
    const { streamFn } = scriptedStream([
      toolCallMessage('write', { path: 'a.txt', content: 'v1' }),
      textMessage('写完'),
    ]);
    const { runtime, ws } = await assemble({ streamFn });
    const answer = await runtime.conversation!.submitOnce('请写入 a.txt');
    expect(answer?.status).toBe('completed');
    // 工具真执行（三段管道 + 守门 + 写串行链）
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v1');
    const sid = runtime.session!.header.sessionId;
    // manifest：本会话一条；pre-mutation 语义——捕获先于写，快照内空工作区
    const manifests = await listSessionManifests(cpkDataRoot(), sid);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.triggerTool).toBe('write');
    expect(manifests[0]!.guard).toBe(false);
    expect(manifests[0]!.files).toEqual([]); // 拍的是写入前的工作区
    expect(manifests[0]!.triggerText).toContain('写入 a.txt'); // 回退展示锚 = 触发指令
    // 审计账：log-only 事件与 manifest 同 id（64KiB 纪律——data 只载规模）
    const audits = sessionsFace(runtime).eventsOfType('checkpoint/snapshot');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({ id: manifests[0]!.id, triggerTool: 'write', guard: false });
  });

  it('read 工具不拍：manifest 零条、审计事件零条', async () => {
    const { streamFn } = scriptedStream([toolCallMessage('read', { path: 'existing.txt' }), textMessage('读完了')]);
    const { runtime, ws } = await assemble({ streamFn });
    // 工作区预置（read 目标在场——不经变更工具；预置走宿主直写不触捕获监听）
    writeFileSync(join(ws, 'existing.txt'), '既有内容', 'utf8');
    const answer = await runtime.conversation!.submitOnce('请读取 existing.txt');
    expect(answer?.status).toBe('completed');
    const sid = runtime.session!.header.sessionId;
    expect(await listSessionManifests(cpkDataRoot(), sid)).toEqual([]);
    expect(sessionsFace(runtime).eventsOfType('checkpoint/snapshot')).toEqual([]);
  });
});

/* ---------------- ② per-run 去重 + RunSettled 旗复位 ---------------- */

describe('per-run 去重与旗复位', () => {
  it('同 run 两个变更工具只拍一次；下一 run（旗已复位）再拍', async () => {
    const { streamFn } = scriptedStream([
      toolCallMessage('write', { path: 'b1.txt', content: 'x' }),
      toolCallMessage('write', { path: 'b2.txt', content: 'y' }),
      textMessage('第一批完成'),
      toolCallMessage('write', { path: 'b3.txt', content: 'z' }),
      textMessage('第二批完成'), // run2 闭合文本（末条兜底会重复 toolCall——无限回路）
    ]);
    const { runtime, ws } = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('写第一批两个文件');
    const sid = runtime.session!.header.sessionId;
    // 同 run 两 write = 一条快照（首 write pre-execute 拍下，次 write 免重）
    expect(await listSessionManifests(cpkDataRoot(), sid)).toHaveLength(1);
    // 第二 run：RunSettled 已复位旗——首 write 再拍一条
    await runtime.conversation!.submitOnce('再写第三个');
    const after = await listSessionManifests(cpkDataRoot(), sid);
    expect(after).toHaveLength(2);
    // 两 run 产物齐全（工具全真执行）
    for (const name of ['b1.txt', 'b2.txt', 'b3.txt']) {
      expect(existsSync(join(ws, name))).toBe(true);
    }
  });
});

/* ---------------- ③ /rewind 两段事务（guard → restore → fork+adopt） ---------------- */

describe('/rewind 命令（两段事务 + guard 防误退）', () => {
  it('run2 改档后 /rewind latest：a.txt 回 v1、c.txt 遗留不删、guard 落账、fork+adopt 切新会话', async () => {
    const { streamFn } = scriptedStream([
      toolCallMessage('write', { path: 'a.txt', content: 'v1' }),
      textMessage('首写完成'),
      // run2：read 过再改（CAS 观察态——write 替换既有文件的前置）+ 新建 c.txt
      toolCallMessage('read', { path: 'a.txt' }),
      toolCallMessage('write', { path: 'a.txt', content: 'v2-改' }),
      toolCallMessage('write', { path: 'c.txt', content: '后建' }),
      textMessage('第二批完成'),
    ]);
    const { runtime, ws } = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('写 a.txt 初版');
    await runtime.conversation!.submitOnce('改 a.txt 并新建 c.txt');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2-改');
    const oldId = runtime.session!.header.sessionId;
    // 快照两条：run1 空工作区、run2 {a.txt: v1}（read 不拍、两 write 去重为一拍）
    const before = await listSessionManifests(cpkDataRoot(), oldId);
    expect(before).toHaveLength(2);
    expect(before[0]!.files.map((f) => f.rel)).toEqual(['a.txt']); // latest = run2 捕获

    // /rewind latest：目标 = run2 快照（回退到「改 a.txt 之前」）
    expect(await runtime.channels.commands.dispatch('/rewind latest')).toBe('ok');
    // 文件面：a.txt 回 v1；c.txt 快照后新建 = 遗留不删（无删除铁律）
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v1');
    expect(existsSync(join(ws, 'c.txt'))).toBe(true);
    // manifest 面：guard 快照落账（triggerTool=/rewind、guard=true）
    const after = await listSessionManifests(cpkDataRoot(), oldId);
    expect(after).toHaveLength(3);
    const guard = after[0]!; // 时间降序首 = 最新 = guard
    expect(guard.guard).toBe(true);
    expect(guard.triggerTool).toBe('/rewind');
    // 会话面：旧会话留 checkpoint/rewind 叙事（fork 内建 flush 屏障——立即可读）
    await runtime.persistence!.flush(oldId);
    const old = runtime.persistence!.loadSession(oldId);
    const rewinds = old!.events.filter((e) => e.type === 'checkpoint/rewind');
    expect(rewinds).toHaveLength(1);
    const rewindData = rewinds[0]!.data as { id: string; newSessionId: string; files: number };
    expect(rewindData.id).toBe(before[0]!.id);
    expect(rewindData.files).toBe(1);
    expect(rewindData.newSessionId).not.toBe(oldId);
    // adopt 兑现：路由切新会话
    expect(sessionsFace(runtime).currentSessionId()).toBe(rewindData.newSessionId);
  });

  it('guard 快照窗口期 run 启动 → 二次复验中止回退（20260901-c #5）：文件不动、会话不切、guard 快照保留（修前：TOCTOU 窗内照常回退）', async () => {
    // 前 6 次模型调用 = 两 run 的脚本序；第 7 次（窗口期 run）挂起在流里——
    // running 常真，直到 afterEach shutdown 收口
    const scripted = scriptedStream([
      toolCallMessage('write', { path: 'a.txt', content: 'v1' }),
      textMessage('首写完成'),
      toolCallMessage('read', { path: 'a.txt' }),
      toolCallMessage('write', { path: 'a.txt', content: 'v2-改' }),
      textMessage('改完'),
    ]);
    let calls = 0;
    // 窗口期 run 的流：start 后挂起直到 abort（conversation.test pendingOnceStream
    // 同款 abort 合作形——不合作则 run 永不结算，afterEach shutdown 拖死后续用例）
    const streamFn: StreamFn = (context: LlmContext, options: StreamFnOptions, signal?: AbortSignal) => {
      calls += 1;
      if (calls <= 5) return scripted.streamFn(context, options);
      const message = textMessage('窗口期慢答');
      const events = [{ type: 'start' as const, partial: { ...message, content: [] } }];
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            next: async () => {
              if (index < events.length) return { value: events[index++]!, done: false as const };
              // 已 abort 短路先判（信号只发一次，事后挂监听收不到）
              if (signal?.aborted) return abortEvent(message);
              await new Promise((resolve) => {
                signal?.addEventListener('abort', resolve, { once: true });
              });
              return abortEvent(message);
            },
          };
        },
        // result() 契约：abort 编码进返回消息 stopReason——loop 终态以它为准
        result: async () => (signal?.aborted ? { ...message, stopReason: 'aborted' } : message),
      };
    };
    const { runtime, ws } = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('写 a.txt 初版');
    await runtime.conversation!.submitOnce('改 a.txt');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2-改');
    const oldId = runtime.session!.header.sessionId;
    const busyFace = runtime.ctx.get<{ isBusy: (sessionId?: string) => boolean }>('sessions');

    // TOCTOU 编排：guard 捕获窗口内（webui /submit 同款路径——launch 即 running）
    // 启动同会话 run，确认 running 落位后才放 guard 快照继续
    guardProbe.hook = async () => {
      void runtime.conversation!.submitOnce('窗口期新输入').catch(() => undefined);
      await vi.waitFor(() => expect(busyFace.isBusy(oldId)).toBe(true));
    };
    const { backend: windowBackend, notifies: windowNotifies } = recordingBackend();
    runtime.ui.attach(windowBackend);
    expect(await runtime.channels.commands.dispatch('/rewind latest')).toBe('ok');
    // 诚实中止面：回执点名 run 已启动 + guard 快照保留可重试
    expect(windowNotifies.join('\n')).toContain('guard 快照期间会话 run 已启动——已中止回退');
    // 文件不动（修前：窗口内照常回退——a.txt 回 v1）
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2-改');
    // 会话不切（无 fork+adopt）
    expect(sessionsFace(runtime).currentSessionId()).toBe(oldId);
    // guard 快照保留（第 3 条、guard=true——可重试的撤销点）
    const after = await listSessionManifests(cpkDataRoot(), oldId);
    expect(after).toHaveLength(3);
    expect(after[0]!.guard).toBe(true);
    // 收口挂起 run（abort 合作形流随之结算）——不留在飞 run 拖死 afterEach
    // shutdown（registry 不清 → 后续用例 AGENT_ROLE_EXISTS 连锁红）
    await runtime.conversation!.interrupt();
  });

  it('restore 写段入写串行链（20260901-c #5）：同路径在飞写段持有链时恢复排队其后（修前：裸 writeFile 直接交叠）', async () => {
    const { streamFn } = scriptedStream([
      toolCallMessage('write', { path: 'a.txt', content: 'v1' }),
      textMessage('首写完成'),
      toolCallMessage('read', { path: 'a.txt' }),
      toolCallMessage('write', { path: 'a.txt', content: 'v2-改' }),
      textMessage('改完'),
    ]);
    const { runtime, ws } = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('写 a.txt 初版');
    await runtime.conversation!.submitOnce('改 a.txt');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2-改');

    // 占住 a.txt 的写链（在飞工具写形态——与 write/edit 同键同链）
    const key = await canonicalize(join(ws, 'a.txt'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void serializeWrites([key], () => gate);

    // /rewind latest（目标 = 改前快照 a.txt:v1）：guard 只读不入链、恢复写段
    // 须排队——60ms 余量后仍未覆写即证入链（修前裸写早已落盘）
    const rewound = runtime.channels.commands.dispatch('/rewind latest');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v2-改');
    release();
    expect(await rewound).toBe('ok');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('v1');
  });
});

/* ---------------- ④ 子代理会话身份判据（chainSessionId 真相源） ---------------- */

describe('子代理捕获（身份判据 = chainSessionId ?? routed）', () => {
  it('委派 run 内子代理 write：manifest 记子会话账（forkSeq null）+ 父会话审计免落', async () => {
    const { streamFn } = scriptedStream([
      toolCallMessage('agent', { prompt: '请写 child.txt' }),
      toolCallMessage('write', { path: 'child.txt', content: '子代理所写' }),
      textMessage('子任务完成'),
      textMessage('父收尾'),
    ]);
    const { runtime, ws } = await assemble({ streamFn });
    // delegation fork 的 session_start 走根总线（origin=delegation——子会话 id 采集）
    const delegationStarts: string[] = [];
    runtime.ctx.on('session_start', (payload: unknown) => {
      const data = payload as { sessionId: string; origin?: string };
      if (data.origin === 'delegation') delegationStarts.push(data.sessionId);
    });
    const answer = await runtime.conversation!.submitOnce('委派写文件');
    expect(answer?.status).toBe('completed');
    expect(delegationStarts).toHaveLength(1);
    const childId = delegationStarts[0]!;
    // 子代理 write 真执行（同工作区）
    expect(readFileSync(join(ws, 'child.txt'), 'utf8')).toBe('子代理所写');
    // manifest 记子会话账（键 = 子会话 id——chainSessionId 真相源；修复前 routed
    // 单独用会错记父键）；子会话非注册表路 → forkSeq null（不可回退，只可恢复文件）
    const childManifests = await listSessionManifests(cpkDataRoot(), childId);
    expect(childManifests).toHaveLength(1);
    expect(childManifests[0]!.triggerTool).toBe('write');
    expect(childManifests[0]!.forkSeq).toBeNull();
    // 父会话审计免落（appendEvent 无目标会话参数——落父账即错投，§5.2 S1 路由纪律）
    const parentId = runtime.session!.header.sessionId;
    expect(sessionsFace(runtime).eventsOfType('checkpoint/snapshot')).toEqual([]);
    // 父会话自身无快照（父 run 唯一变更类工具是 agent 委派——捕获记子键不记父键）
    expect(await listSessionManifests(cpkDataRoot(), parentId)).toEqual([]);
  });
});

/** manifest 类型落地引用（导入面完整性——断言均经 CheckpointManifest 结构） */
const typeAnchor = (m: CheckpointManifest): string => m.id;
void typeAnchor;
