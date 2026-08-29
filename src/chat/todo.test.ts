/**
 * L4 chat — todo 机器单元测试（骨架篇 §6.7「todo 落码形态定稿」2026-08-30 纵切）。
 *
 * 回归面：
 * - fold 纯函数全语义：run-scoped 边界（steer 同边界）/ last-write-wins /
 *   空表 / 遮蔽同判据 / 坏条目归一；
 * - 工具件：append 落账 + 一行回执 + schema 上限护栏（裁决⑨）+ effect 'read'；
 * - 注入件：瀑布 handler 三放行（miss / 空表 / 异常）与非空尾追注入 + 角色
 *   hidden 双面（toLlm → user / render 不进时间线）。
 *
 * 全栈链（驱动注册 → 模型调工具 → 次轮请求见注入 → 新用户输入后清空）归
 * src/app/chat.test.ts（mock 只停在模型层）。
 */

import { describe, expect, it } from 'vitest';
import { Value } from '../contracts/typebox.js'; // 再导出面（memory/tools.test 同款，防双实例）
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
      { content: '落码', status: 'in_progress' },
      { content: '测试', status: 'pending' },
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
    expect(foldCurrentTodo(session.events)).toEqual([{ content: '现行表', status: 'pending' }]);
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
      { content: '好条目', status: 'in_progress', activeForm: '正在落码' },
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

  it('回执 = 一行计数；空表 = 清空文案', () => {
    expect(
      buildTodoReceipt([
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'completed' },
        { content: 'd', status: 'completed' },
      ]),
    ).toBe('已更新任务清单：4 项（待办 1 · 进行中 1 · 完成 2）');
    expect(buildTodoReceipt([])).toBe('已清空任务清单');
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
});

/* ---------------- 注入件：context_transform 瀑布 ---------------- */

/** 建 ctx + 注册注入件 + 挂一个会话进伪注册表 */
function setupInjection(session: Session | undefined, sessionId = 's-inject') {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const entries = new Map<string, { session: Session }>();
  if (session !== undefined) entries.set(sessionId, { session });
  const registry: TodoRegistryFace = { entries };
  registerTodoInjection(ctx, registry);
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
});
