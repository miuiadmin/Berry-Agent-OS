/**
 * L4 chat — todo 机器单元测试（骨架篇 §6.7「todo 落码形态定稿」2026-08-30 纵切；
 * 第三十九批刀二扩面：goal 段词汇 + 计划态跨轮 fold + gates 双执法位）。
 *
 * 回归面：
 * - fold 纯函数全语义：run-scoped 边界（steer 同边界）/ last-write-wins /
 *   空表 / 遮蔽同判据 / 坏条目归一；
 * - 刀二 fold：goal-scoped 锚两律（user/message 非边界——计划表跨轮存活；
 *   seq < 锚不越界）+ 锚 null 诚实降级 run-scoped + goal 段遮蔽同守 +
 *   扩字段读侧守形；
 * - 渲染与回执：四态 marker（deferred [-] + ⇢ 复活条件 / 用户·前缀）+ 缓办计数；
 * - 工具件：append 落账 + 一行回执 + schema 上限护栏（裁决⑨）+ effect 'read'；
 * - 刀二执法段：非 goal 段词汇申报即拒 / goal 段约束（deferred 必携复活条件、
 *   completed 二择一）/ gates 申报期准入 + 验证期 fail-closed（不过零落账）；
 * - 注入件：瀑布 handler 三放行（miss / 空表 / 异常）与非空尾追注入 + 角色
 *   hidden 双面（toLlm → user / render 不进时间线）+ goal 锚注入段切换即时。
 *
 * 全栈链（驱动注册 → 模型调工具 → 次轮请求见注入 → 新用户输入后清空）归
 * src/app/chat.test.ts（mock 只停在模型层）；gates 验证器分类矩阵归
 * todo-gates.test.ts。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Value } from '../contracts/typebox.js'; // 再导出面（memory/tools.test 同款，防双实例）
import { AppError, GOAL_GATE_FAILED, GOAL_TODO_SCOPE } from '../contracts/errors.js';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import { getMessageRoleDefinition } from '../contracts/messages.js';
import type { SessionEvent } from '../contracts/events.js';
import { Session } from '../session/session.js';
import {
  buildTodoReceipt,
  createTodoTool,
  foldCurrentTodo,
  registerTodoInjection,
  renderTodoTable,
  type TodoItem,
  type TodoRegistryFace,
} from './todo.js';

/* ---------------- 测试基建 ---------------- */

/** 造一条会话事件（seq 由 Session.append 分配——构造真日志面；appender 返回值不消费） */
function sessionWith(...appends: Array<(session: Session) => unknown>): Session {
  const session = new Session({ sessionId: 's-test' });
  for (const append of appends) append(session);
  return session;
}

const userSays = (session: Session) => session.append('user/message', { content: '干活' });
const writeTodo = (items: TodoItem[] | unknown[]) => (session: Session) => session.append('todo/write', { items });
const assistantSays = (session: Session) =>
  session.append('assistant/message', { content: [], usage: {}, stopReason: 'stop' });

/* ---------------- fold：run-scoped 倒扫 ---------------- */

describe('foldCurrentTodo（run-scoped 倒扫纯函数）', () => {
  it('空日志 / 无 todo 段 → null（run 首轮天然无表）', () => {
    expect(foldCurrentTodo([])).toBeNull();
    expect(foldCurrentTodo(sessionWith(userSays, assistantSays).events)).toBeNull();
  });

  it('user/message 之后最后一条 todo/write 胜出（last-write-wins）', () => {
    const session = sessionWith(
      userSays,
      writeTodo([{ content: '旧表', status: 'pending' }]),
      writeTodo([
        { content: '落码', status: 'in_progress' },
        { content: '测试', status: 'pending' },
      ]),
    );
    expect(foldCurrentTodo(session.events)).toEqual([
      { content: '落码', status: 'in_progress', writtenAt: expect.any(Number) },
      { content: '测试', status: 'pending', writtenAt: expect.any(Number) },
    ]);
  });

  it('新 user/message 即段边界——段前旧表不越界（run 重置由推导规则承载）', () => {
    const session = sessionWith(
      userSays,
      writeTodo([{ content: '上一轮的表', status: 'pending' }]),
      userSays,
      assistantSays,
    );
    expect(foldCurrentTodo(session.events)).toBeNull();
  });

  it('items=[] → 空数组非 null（合法清空——注入侧据此不注入）', () => {
    const session = sessionWith(userSays, writeTodo([]));
    expect(foldCurrentTodo(session.events)).toEqual([]);
  });

  it('遮蔽段与 derive 同判据：被遮蔽的 todo/write 越过、被遮蔽的 user/message 不作边界', () => {
    // seq: 0=user, 1=todo(旧), 2=user(被遮蔽), 3=todo(新), 4=遮蔽指令载体
    const session = sessionWith(userSays, writeTodo([{ content: '旧', status: 'completed' }]));
    const occludedUser = session.append('user/message', { content: '压实段' });
    session.append('todo/write', { items: [{ content: '现行表', status: 'pending' }] });
    // 载体事件遮蔽 [occludedUser.seq, occludedUser.seq]——段内 user 不作边界（sourceEventSeqs 溯源覆盖区间）
    session.append(
      'assistant/message',
      { content: [] },
      {
        surfaceOp: { op: 'replace', start: occludedUser.seq, end: occludedUser.seq },
        sourceEventSeqs: [occludedUser.seq],
      },
    );
    expect(foldCurrentTodo(session.events)).toEqual([
      { content: '现行表', status: 'pending', writtenAt: expect.any(Number) },
    ]);
  });

  it('坏条目防御归一：非对象 / 缺 content / 坏 status 丢弃，activeForm 保留', () => {
    const session = sessionWith(
      userSays,
      writeTodo([
        '裸字符串（坏）',
        null,
        { status: 'pending' },
        { content: '', status: 'pending' },
        { content: '坏状态', status: 'done' },
        { content: '好条目', status: 'in_progress', activeForm: '正在落码' },
      ]),
    );
    expect(foldCurrentTodo(session.events)).toEqual([
      { content: '好条目', status: 'in_progress', activeForm: '正在落码', writtenAt: expect.any(Number) },
    ]);
  });

  it('判窗锚盖章（刀三）：每项 writtenAt = 命中 todo/write 事件信封 time（相对形 resumeWhen 起算点）', () => {
    const session = sessionWith(userSays);
    const written = session.append('todo/write', {
      items: [{ content: '缓办项', status: 'deferred', resumeWhen: 'after@+2h' }],
    });
    expect(foldCurrentTodo(session.events)).toEqual([
      { content: '缓办项', status: 'deferred', resumeWhen: 'after@+2h', writtenAt: written.time },
    ]);
  });
});

/* ---------------- fold：goal-scoped 计划态跨轮（刀二 T2-A） ---------------- */

describe('foldCurrentTodo·goal 段（激活锚两律）', () => {
  it('user/message 不再是边界——计划表跨轮存活；锚 null = 诚实降级 run-scoped', () => {
    // seq: 0=user, 1=todo(表), 2=user(新一轮输入), 3=assistant
    const session = sessionWith(
      userSays,
      writeTodo([{ content: '计划表', status: 'in_progress' }]),
      userSays,
      assistantSays,
    );
    // run-scoped（无锚 / null）：新 user/message 切段 → 表不可见
    expect(foldCurrentTodo(session.events)).toBeNull();
    expect(foldCurrentTodo(session.events, null)).toBeNull();
    // goal-scoped（锚 ≤ 表 seq）：user/message 非边界 → 同一张计划表跨轮回显
    expect(foldCurrentTodo(session.events, 1)).toEqual([
      { content: '计划表', status: 'in_progress', writtenAt: expect.any(Number) },
    ]);
  });

  it('锚下界：seq < 锚的事件不越界（goal 激活前的表不参与）', () => {
    const session = sessionWith(
      userSays,
      writeTodo([{ content: '激活前的旧表', status: 'pending' }]),
      userSays,
      assistantSays,
    );
    // 锚 2（> 表 seq 1）：倒扫首触 seq<锚即收——激活点之后无表 → null
    expect(foldCurrentTodo(session.events, 2)).toBeNull();
    // 锚 1（= 表 seq）：表恰在激活点之后 → 可见（跨轮存活对照）
    expect(foldCurrentTodo(session.events, 1)).toEqual([
      { content: '激活前的旧表', status: 'pending', writtenAt: expect.any(Number) },
    ]);
  });

  it('goal 段遮蔽跳过同守（CR-15——compaction 遮蔽段是「已消化」语义）', () => {
    // seq: 0=user, 1=todo(现行表), 2=todo(被遮蔽), 3=遮蔽指令载体
    const session = sessionWith(userSays, writeTodo([{ content: '现行表', status: 'pending' }]));
    const occluded = session.append('todo/write', { items: [{ content: '被遮蔽表', status: 'completed' }] });
    session.append(
      'assistant/message',
      { content: [] },
      {
        surfaceOp: { op: 'replace', start: occluded.seq, end: occluded.seq },
        sourceEventSeqs: [occluded.seq],
      },
    );
    expect(foldCurrentTodo(session.events, 0)).toEqual([
      { content: '现行表', status: 'pending', writtenAt: expect.any(Number) },
    ]);
  });

  it('goal 段扩字段读侧守形：合法字段保留 / 坏形字段丢弃（条目不弃）', () => {
    const session = sessionWith(
      userSays,
      writeTodo([
        { content: '全字段', status: 'deferred', role: 'user', taskClass: '重构', resumeWhen: 'after@+2h' },
        { content: '有后继', status: 'completed', followUp: '收尾文档', gate: { kind: 'files', spec: ['a.ts'] } },
        { content: '无后继', status: 'completed', noFollowUp: true },
        { content: '坏角色', status: 'pending', role: 'boss' }, // role 二值外 → 字段丢弃
        { content: '坏门', status: 'pending', gate: { kind: 'files', spec: [] } }, // spec 空清单 → gate 丢弃
        { content: '坏复活', status: 'deferred', resumeWhen: '' }, // 空串 → 字段丢弃
      ]),
    );
    expect(foldCurrentTodo(session.events)).toEqual([
      {
        content: '全字段',
        status: 'deferred',
        role: 'user',
        taskClass: '重构',
        resumeWhen: 'after@+2h',
        writtenAt: expect.any(Number),
      },
      {
        content: '有后继',
        status: 'completed',
        followUp: '收尾文档',
        gate: { kind: 'files', spec: ['a.ts'] },
        writtenAt: expect.any(Number),
      },
      { content: '无后继', status: 'completed', noFollowUp: true, writtenAt: expect.any(Number) },
      { content: '坏角色', status: 'pending', writtenAt: expect.any(Number) },
      { content: '坏门', status: 'pending', writtenAt: expect.any(Number) },
      { content: '坏复活', status: 'deferred', writtenAt: expect.any(Number) },
    ]);
  });
});

/* ---------------- 渲染：注入正文与回执 ---------------- */

describe('renderTodoTable / buildTodoReceipt', () => {
  it('三态 marker + in_progress 行优先 activeForm', () => {
    const table = renderTodoTable([
      { content: '写规范', status: 'completed' },
      { content: '落码', status: 'in_progress', activeForm: '正在落码 todo 机器' },
      { content: '测试', status: 'pending' },
    ]);
    expect(table).toBe('- [x] 写规范\n- [~] 正在落码 todo 机器\n- [ ] 测试');
  });

  it('刀二渲染扩面：deferred [-] 标记 + ⇢ 复活条件后缀 + 用户令办「用户·」前缀', () => {
    const table = renderTodoTable([
      { content: '重构持久层', status: 'deferred', role: 'user', resumeWhen: 'after@+2h' },
      { content: '模型自设', status: 'deferred', resumeWhen: 'after@2026-09-01T09:00:00Z' },
    ]);
    expect(table).toBe('- [-] 用户·重构持久层 ⇢ after@+2h\n- [-] 模型自设 ⇢ after@2026-09-01T09:00:00Z');
  });

  it('回执 = 一行计数；空表 = 清空文案；缓办计数仅在场时追加', () => {
    expect(
      buildTodoReceipt([
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'completed' },
        { content: 'd', status: 'completed' },
      ]),
    ).toBe('已更新任务清单：4 项（待办 1 · 进行中 1 · 完成 2）');
    expect(buildTodoReceipt([])).toBe('已清空任务清单');
    expect(
      buildTodoReceipt([
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'deferred' },
        { content: 'c', status: 'deferred' },
      ]),
    ).toBe('已更新任务清单：3 项（待办 1 · 进行中 0 · 完成 0 · 缓办 2）');
  });
});

/* ---------------- 工具件 ---------------- */

describe('createTodoTool', () => {
  it('execute = append todo/write + 一行计数回执；effect read / 名 todo', async () => {
    const appended: Array<{ type: string; data: unknown }> = [];
    const session = new Session({ sessionId: 's-tool' });
    const def = createTodoTool({
      append: (type, data) => {
        appended.push({ type, data });
        return session.append(type, data);
      },
    });
    expect(def.name).toBe('todo');
    expect(def.effect).toBe('read'); // goal 续跑轮按 read 类自动收留（裁决⑪）
    const result = await def.execute({ items: [{ content: '第一步', status: 'in_progress' }] }, {
      toolCallId: 'tc-1',
    } as never);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.type).toBe('todo/write');
    expect(appended[0]!.data).toEqual({ items: [{ content: '第一步', status: 'in_progress' }] });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('已更新任务清单：1 项');
  });

  it('schema 上限护栏（裁决⑨）：51 项 / 161 字符拒绝，合法形状放行', () => {
    const { parameters } = createTodoTool({ append: (() => ({})) as never });
    const check = (items: unknown[]): boolean => Value.Check(parameters as never, { items });
    expect(check([{ content: 'x', status: 'pending' }])).toBe(true);
    expect(check(Array.from({ length: 51 }, () => ({ content: 'x', status: 'pending' })))).toBe(false);
    expect(check([{ content: 'x'.repeat(161), status: 'pending' }])).toBe(false);
    expect(check([{ content: 'x', status: 'done' }])).toBe(false);
    expect(check([])).toBe(true); // 空表 = 合法清空（裁决⑧）
  });

  it('刀二 schema 扩面：四值 status + goal 段字段形状与上限', () => {
    const { parameters } = createTodoTool({ append: (() => ({})) as never });
    const check = (items: unknown[]): boolean => Value.Check(parameters as never, { items });
    // 四值 status 与 goal 段字段全放行（形状面——段语义归 execute 执法）
    expect(
      check([{ content: 'x', status: 'deferred', resumeWhen: 'after@+1h', role: 'user', taskClass: '重构' }]),
    ).toBe(true);
    expect(check([{ content: 'x', status: 'completed', followUp: '收尾', noFollowUp: true }])).toBe(true); // schema 不裁二择一
    expect(check([{ content: 'x', status: 'pending', gate: { kind: 'command', spec: 'npm test' } }])).toBe(true);
    expect(check([{ content: 'x', status: 'pending', gate: { kind: 'files', spec: ['a.ts'] } }])).toBe(true);
    // 上限与形状护栏：role 二值外 / taskClass 超 40 / gate spec 空清单 / 坏 kind
    expect(check([{ content: 'x', status: 'pending', role: 'boss' }])).toBe(false);
    expect(check([{ content: 'x', status: 'pending', taskClass: 'x'.repeat(41) }])).toBe(false);
    expect(check([{ content: 'x', status: 'pending', gate: { kind: 'files', spec: [] } }])).toBe(false);
    expect(check([{ content: 'x', status: 'pending', gate: { kind: 'shell', spec: 'x' } }])).toBe(false);
  });
});

/* ---------------- 序列化字节预算（第九轮全面复盘 20260903 #21——⑨ 算术修死） ---------------- */

describe('createTodoTool·序列化字节预算（第九轮 #21——schema 静态道算术被 ⑬ 扩面击穿后的 execute 动态道）', () => {
  /** goal 段执法桩（gates 面在场最小形——needsWrite false 不触发申报期面缺席拒绝） */
  const enforcement = { scope: () => ({ active: true as const, activatedSeq: 1, needsWrite: false }) };

  it('goal 段合法 gate 形态超 60KiB 内容预算 → execute 段响亮拒 TODO_WRITE_TOO_LARGE，不落到 append 抛错段', async () => {
    const session = new Session({ sessionId: 's-budget' });
    const def = createTodoTool(session, enforcement as never);
    // ⑬ 合法形态：50 项 × gate 数组 20×500 字符（schema 段全放行——实测序列化
    // ~500KB+，CJK 更大；修前落到 session.append 抛 SESSION_EVENT_TOO_LARGE，
    // 与原注释「不落到 append 抛错」相反）
    const items = Array.from({ length: 50 }, (_, i) => ({
      content: `第${i}步`,
      status: 'pending' as const,
      gate: { kind: 'files' as const, spec: Array.from({ length: 20 }, () => 'e'.repeat(500)) },
    }));
    await expect(def.execute({ items }, { toolCallId: 'tc' } as never)).rejects.toMatchObject({
      code: 'TODO_WRITE_TOO_LARGE',
    });
    // fail-closed 零落账（与段约束/gates 同拒绝语义——模型收窄重写后重试）
    expect(session.events.filter((e) => e.type === 'todo/write')).toHaveLength(0);
  });

  it('预算内常规表照常落账（动态道零成本快路径不破既有语义）', async () => {
    const session = new Session({ sessionId: 's-budget-ok' });
    const def = createTodoTool(session, enforcement as never);
    // 预算内 goal 段合法带 gate 形态（declareGateFailure files 形状配对通过）
    const items = [
      { content: '正常步骤', status: 'pending' as const, gate: { kind: 'files' as const, spec: ['a.ts'] } },
    ];
    const result = await def.execute({ items }, { toolCallId: 'tc' } as never);
    expect(result.isError).toBeUndefined();
    expect(session.events.filter((e) => e.type === 'todo/write')).toHaveLength(1);
  });
});

/* ---------------- 工具件：刀二执法段（goal 段约束 + gates） ---------------- */

/** 造临时工作区根（files gate 端到端——真 stat 非 mock） */
const gateRoot = mkdtempSync(join(tmpdir(), 'todo-tool-'));
afterAll(() => {
  rmSync(gateRoot, { recursive: true, force: true });
});

describe('createTodoTool·执法段（goal 段词汇 + gates 双执法位）', () => {
  /** goal 段执法桩（锚/needsWrite 可调；runCommand 成功形缺省） */
  const goalScope = (needsWrite: boolean) => ({ active: true as const, activatedSeq: 1, needsWrite });
  /** 执行辅助：跑 def.execute 并捕获 AppError（分类断言用） */
  const run = async (def: ReturnType<typeof createTodoTool>, items: readonly unknown[]) => {
    try {
      return { ok: true as const, result: await def.execute({ items }, { toolCallId: 'tc' } as never) };
    } catch (err) {
      return { ok: false as const, err: err as AppError };
    }
  };

  it('非 goal 段（enforcement 缺席）：goal 段词汇申报即拒 GOAL_TODO_SCOPE——零落账', async () => {
    const session = new Session({ sessionId: 's-ng' });
    const def = createTodoTool(session); // 诊断装配形态——执法面缺席 = 非 goal 段执法
    const rejected = await run(def, [{ content: 'a', status: 'deferred', resumeWhen: 'after@+1h' }]);
    expect(rejected.ok).toBe(false);
    expect((rejected as { err: AppError }).err.code).toBe(GOAL_TODO_SCOPE);
    expect(session.events.filter((e) => e.type === 'todo/write')).toHaveLength(0); // fail-closed 零落账
  });

  it('goal 段约束：deferred 缺复活条件 / completed 缺二择一 → 拒；合法扩字段落账保留', async () => {
    const session = new Session({ sessionId: 's-g1' });
    const def = createTodoTool(session, { scope: () => goalScope(true), workspaceRoot: gateRoot });
    const noResume = await run(def, [{ content: '缓办无窗', status: 'deferred' }]);
    expect(noResume.ok).toBe(false);
    expect((noResume as { err: AppError }).err.code).toBe(GOAL_TODO_SCOPE);
    const noFollow = await run(def, [{ content: '完成无后继', status: 'completed' }]);
    expect(noFollow.ok).toBe(false);
    expect((noFollow as { err: AppError }).err.code).toBe(GOAL_TODO_SCOPE);
    expect(session.events.filter((e) => e.type === 'todo/write')).toHaveLength(0);
    // 合法全字段：落账 = 事件载荷保留扩字段（durable 事实源）
    const ok = await run(def, [
      { content: '缓办', status: 'deferred', role: 'user', resumeWhen: 'after@+2h' },
      { content: '完成', status: 'completed', noFollowUp: true },
    ]);
    expect(ok.ok).toBe(true);
    const written = session.events.filter((e) => e.type === 'todo/write');
    expect(written).toHaveLength(1);
    expect(written[0]!.data).toEqual({
      items: [
        { content: '缓办', status: 'deferred', role: 'user', resumeWhen: 'after@+2h' },
        { content: '完成', status: 'completed', noFollowUp: true },
      ],
    });
  });

  it('gates 申报期准入：command gate 无 needsWrite = denied（GOAL_GATE_FAILED 当场拒）', async () => {
    const session = new Session({ sessionId: 's-g2' });
    const def = createTodoTool(session, {
      scope: () => goalScope(false), // 只读档 goal
      workspaceRoot: gateRoot,
      runCommand: async () => ({ exitCode: 0, isError: false, text: 'ok' }),
    });
    const rejected = await run(def, [
      { content: '验命令', status: 'pending', gate: { kind: 'command', spec: 'npm test' } },
    ]);
    expect(rejected.ok).toBe(false);
    const err = (rejected as { err: AppError }).err;
    expect(err.code).toBe(GOAL_GATE_FAILED);
    expect(err.message).toContain('kind=command reason=denied');
    expect(session.events.filter((e) => e.type === 'todo/write')).toHaveLength(0);
  });

  it('gates 验证期 fail-closed：置 completed 且验证不过 = 整笔不落账（结构化回执）', async () => {
    const session = new Session({ sessionId: 's-g3' });
    const def = createTodoTool(session, {
      scope: () => goalScope(true),
      workspaceRoot: gateRoot,
      runCommand: async () => ({ exitCode: 1, isError: true, text: 'exit code: 1\nFAIL 测试红' }),
    });
    const rejected = await run(def, [
      { content: '测试全绿', status: 'completed', noFollowUp: true, gate: { kind: 'command', spec: 'npm test' } },
    ]);
    expect(rejected.ok).toBe(false);
    const err = (rejected as { err: AppError }).err;
    expect(err.code).toBe(GOAL_GATE_FAILED);
    expect(err.message).toContain('kind=command reason=nonzero');
    expect(err.message).toContain('「测试全绿」');
    expect(session.events.filter((e) => e.type === 'todo/write')).toHaveLength(0);
    // 同场 pending 项带 gate 不触发验证（未到验收点）——置 completed 才验
    const pending = await run(def, [
      { content: '未验', status: 'pending', gate: { kind: 'command', spec: 'npm test' } },
    ]);
    expect(pending.ok).toBe(true);
    expect(session.events.filter((e) => e.type === 'todo/write')).toHaveLength(1);
  });

  it('files gate 端到端（真 stat）：缺文件拒 / 在场非空过', async () => {
    writeFileSync(join(gateRoot, 'present.ts'), 'export {};\n');
    const session = new Session({ sessionId: 's-g4' });
    const def = createTodoTool(session, { scope: () => goalScope(false), workspaceRoot: gateRoot });
    const rejected = await run(def, [
      { content: '落码在场', status: 'completed', noFollowUp: true, gate: { kind: 'files', spec: ['absent.ts'] } },
    ]);
    expect(rejected.ok).toBe(false);
    expect((rejected as { err: AppError }).err.message).toContain('kind=files reason=missing');
    const ok = await run(def, [
      { content: '落码在场', status: 'completed', noFollowUp: true, gate: { kind: 'files', spec: ['present.ts'] } },
    ]);
    expect(ok.ok).toBe(true);
  });
});

/* ---------------- 注入件：context_transform 瀑布 ---------------- */

/** 建 ctx + 注册注入件 + 挂一个会话挂进伪注册表（goalBoundaryFor = 刀二锚查询注入） */
function setupInjection(
  session: Session | undefined,
  sessionId = 's-inject',
  goalBoundaryFor?: (sessionId: string) => number | null | undefined,
) {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const entries = new Map<string, { session: Session }>();
  if (session !== undefined) entries.set(sessionId, { session });
  const registry: TodoRegistryFace = { entries };
  registerTodoInjection(ctx, registry, goalBoundaryFor);
  const run = async (messages: unknown[], key: unknown = sessionId) =>
    (await ctx.waterfall('context_transform', messages, key, (final: unknown) => final)) as Array<{
      role: string;
      content: unknown;
      timestamp: number;
    }>;
  return { ctx, run };
}

describe('registerTodoInjection（瀑布 handler + 角色）', () => {
  it('非空表尾追注入：框架句 + 全表文本，role = chat/todo；sessionId 逐参透传', async () => {
    const session = sessionWith(
      userSays,
      writeTodo([{ content: '落码', status: 'in_progress', activeForm: '正在落码' }]),
    );
    const { ctx, run } = setupInjection(session);
    const out = await run([{ role: 'user', content: '继续', timestamp: 1 }]);
    const injected = out.at(-1)!;
    // 角色双面在 dispose 前取（回卷即注销角色）：toLlm → user 消息；render hidden 不进时间线
    const definition = getMessageRoleDefinition('chat/todo')!;
    const llmMessage = definition.toLlm!(injected as never) as { role: string };
    await ctx.dispose(); // 先回卷后断言——角色注册挂 effect 栈，断言失败也不泄漏给后续用例
    expect(out).toHaveLength(2);
    expect(injected.role).toBe('chat/todo');
    expect(String(injected.content)).toContain('非本次用户指令'); // 防注入框架句
    expect(String(injected.content)).toContain('- [~] 正在落码'); // in_progress 优先 activeForm
    expect(llmMessage.role).toBe('user');
    expect(definition.render).toMatchObject({ intent: 'hidden' });
  });

  it('三放行：registry miss / 空表（run 首轮与已清空）/ 非 string sessionId', async () => {
    // 每景先跑后回卷再断言（角色注册全局表——泄漏即连坐后续用例）
    const passthroughLen = async (session: Session | undefined, key?: unknown): Promise<number> => {
      const h = setupInjection(session);
      const out = await h.run([{ role: 'user', content: 'x', timestamp: 1 }], key);
      await h.ctx.dispose();
      return out.length;
    };
    expect(await passthroughLen(undefined)).toBe(1); // miss：sessionId 无条目（非本件会话——子代理等）
    expect(await passthroughLen(sessionWith(userSays, assistantSays))).toBe(1); // 段内无表（run 首轮）
    expect(await passthroughLen(sessionWith(userSays, writeTodo([])))).toBe(1); // items=[]（已清空）
    expect(await passthroughLen(sessionWith(userSays, writeTodo([{ content: 'a', status: 'pending' }])), 42)).toBe(1); // 非 string key 透传
  });

  it('handler 异常放行原请求（铁律 3——todo 是增强不是循环的一拍）', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    // entries.get 抛错模拟读面故障：handler 必须吞掉并放行，run 不为此失败
    const exploding: TodoRegistryFace = {
      entries: new Map([
        [
          's-boom',
          {
            get session(): { events: readonly SessionEvent[] } {
              throw new Error('读面故障');
            },
          } as never,
        ],
      ]),
    };
    registerTodoInjection(ctx, exploding);
    const out = (await ctx.waterfall(
      'context_transform',
      [{ role: 'user', content: 'x', timestamp: 1 }],
      's-boom',
      (final: unknown) => final,
    )) as unknown[];
    await ctx.dispose();
    expect(out).toHaveLength(1); // 原样放行
  });

  it('注册面幂等纪律：件重挂（/reload 重入 apply）撞名响亮拒——装载面回卷后重挂是正路', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    registerTodoInjection(ctx, { entries: new Map() });
    // 同 ctx 二次注册 = 撞名（真实路径是回卷后新作用域重挂——app.ts apply 幂等注释）
    expect(() => registerTodoInjection(ctx, { entries: new Map() })).toThrowError(/chat\/todo/);
    await ctx.dispose();
  });

  it('goal 锚注入（刀二）：锚缺席 run-scoped 无表 / 锚在场同日志注入——段切换即时生效', async () => {
    // seq: 0=user, 1=todo(计划表), 2=user(新一轮), 3=assistant
    const session = sessionWith(
      userSays,
      writeTodo([{ content: '计划项', status: 'in_progress' }]),
      userSays,
      assistantSays,
    );
    // 锚活取（闭包变量——模拟 goal 激活/停掉，注入时点重查切段）
    let anchor: number | null | undefined = undefined;
    const h = setupInjection(session, 's-inject', () => anchor);
    const before = await h.run([{ role: 'user', content: 'x', timestamp: 1 }]);
    anchor = 1; // goal 激活：锚 1 ≤ 表 seq → 计划表跨轮回显
    const after = await h.run([{ role: 'user', content: 'x', timestamp: 2 }]);
    anchor = null; // 停掉 goal：诚实降级 run-scoped
    const stopped = await h.run([{ role: 'user', content: 'x', timestamp: 3 }]);
    await h.ctx.dispose(); // 先回卷后断言（角色注册挂 effect 栈）
    expect(before).toHaveLength(1); // run-scoped：新 user/message 已切段 → 无表不注入
    expect(after).toHaveLength(2);
    expect(String(after.at(-1)!.content)).toContain('- [~] 计划项');
    expect(stopped).toHaveLength(1); // 停掉后即时回切（无缓存陈旧性）
  });
});
