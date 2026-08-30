/**
 * 组合根全栈测试（goal ⑥ 轮间沉淀机器全链——刀四 T6-A）——真 Context + 真
 * Session + 真 GoalStore（:memory: 真库）+ 三服务 stub（agent/llm/tools·
 * channels·ui；模型层是 mock 停靠站——complete 可脚本化，其余全真）。
 *
 * 落位 src/app/（subagent-inprocess.test.ts 先例）：harness 需真 Session 而
 * goal 件拓扑边无 session（checkpoint 结构面同先例——件经 ctx.sessions 消费
 * 不 import session），测试随 harness 需求住组合根。compaction 同款 stub
 * 形态（compaction 持 session 边故其机器测试住件内——两件落位差异即边差异
 * 的镜像）；模型窗口经 request/header 末条 + getModel 元数据注入小值，少量
 * 消息即可过判阈。
 *
 * 锁机器行为：触发链（判阈→规划→水位→单发→三件套落账：goal/summary 事实源
 * 事件 → surfaceOp 载体遮蔽 → 缓存列）+ usage 自报 + 自报越限同笔刹停（不注入
 * 收尾）+ 各 no-op 门（预算尽/未过阈/水位已覆盖）+ complete 抛错让位 + capped
 * 独立沉淀（沉淀不随唤醒拒发而停）。策略纯函数半边在 goal/summary.test.ts。
 */

import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import { openStore, type Store } from '../persist/index.js';
import { Session } from '../session/session.js';
import type { SessionEvent } from '../contracts/events.js';
import type { ProjectedMessage } from '../session/derive.js';
import { GoalStore, migrations } from '../goal/index.js';
import { createGoalApp } from '../goal/app.js';
import { GOAL_SUMMARY_PREFIX, SUMMARY_THRESHOLD_RATIO } from '../goal/summary.js';

/* ---------------- 测试基建 ---------------- */

/** fire-and-forget 沉淀链的结算等待：轮询条件成立或超时（机器内 complete 是 async） */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待条件超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** complete 替身返回形（模型层停靠站契约——usage 可带 totalTokens） */
interface StubCompleteResult {
  readonly message: { readonly content: string };
  readonly usage: { readonly input: number; readonly output: number; readonly totalTokens?: number };
}

/** Harness：真 Session + 真 GoalStore + 三 stub 服务 + 触发面板 */
interface Harness {
  session: Session;
  store: GoalStore;
  db: Store;
  /** 模拟一次 run 结算（派发 onRunSettled 订阅者——status 可覆写） */
  fire: (status?: 'completed' | 'aborted' | 'failed') => void;
  /** complete 收到的调用记录（prompt + priority） */
  completeCalls: () => Array<{ prompt: string; priority?: string }>;
  /** 控制 complete 行为（缺省返回固定摘要；设为 reject 即抛） */
  setComplete: (impl: () => Promise<StubCompleteResult>) => void;
  /** sendUserMessage 收到的调用记录（续跑投递观测面） */
  sent: () => Array<{ content: string; opts?: Record<string, unknown> }>;
  /** ui.notify 文案收集（命令回执观测面） */
  notes: () => string[];
  /** 造一对消息轮（user/assistant 各一，seq 由 Session 自排；content 可注大） */
  addTurn: (content?: string) => void;
  /** 造一条 self 唤醒归因的 user/message（连续帽倒数素材） */
  addSelfWake: (goalId: string) => void;
  /** 激活一个 goal 绑本会话（返回 goalId——activatedSeq 缺省 null = 全域规划） */
  seedGoal: (over?: Partial<{ objective: string; tokenBudget: number; tokensUsed: number }>) => string;
}

/**
 * 建面板：判阈窗口取小值（SMALL_WINDOW × ratio = 阈 tokens → ×4 = 阈 chars）
 * ——约 10 条消息即过阈，无需造大语料。
 */
const SMALL_WINDOW = 500;

function setup(): Harness {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const session = new Session();
  const db = openStore({ path: ':memory:', migrations });
  const store = new GoalStore(db.connection);

  // agent stub：结算订阅表 + 续跑投递记录器
  const settledCbs = new Set<(settled: { status: 'completed' | 'aborted' | 'failed'; sessionId: string }) => void>();
  const sentMessages: Array<{ content: string; opts?: Record<string, unknown> }> = [];
  ctx.provide('agent', {
    onRunSettled(cb: (settled: { status: 'completed' | 'aborted' | 'failed'; sessionId: string }) => void) {
      settledCbs.add(cb);
      return () => settledCbs.delete(cb);
    },
    sendUserMessage(content: string, opts?: Record<string, unknown>) {
      sentMessages.push({ content, opts });
    },
  } as never);

  // sessions stub：宿主面测试侧形态（活引用绑定真 Session；appendWithSurfaceOp
  // = 真 Session.append 直通带遮蔽——四执法点在 assembly 侧另有锁）
  ctx.provide('sessions', {
    appendEvent: (type: string, data: unknown): SessionEvent | undefined => session.append(type, data),
    eventsOfType: (type: string): SessionEvent[] => session.events.filter((e) => e.type === type),
    deriveMessages: (): ProjectedMessage[] => session.deriveMessages(),
    logLength: (): number | undefined => session.length,
    appendWithSurfaceOp: async (carrier: {
      readonly type: 'user/message';
      readonly data: { readonly content: unknown; readonly source: string };
      readonly surfaceOp: { readonly op: 'replace'; readonly start: number; readonly end: number };
      readonly sourceEventSeqs: readonly number[];
    }): Promise<SessionEvent | undefined> =>
      session.append(carrier.type, carrier.data, {
        surfaceOp: { op: 'replace', start: carrier.surfaceOp.start, end: carrier.surfaceOp.end },
        sourceEventSeqs: [...carrier.sourceEventSeqs],
      }),
  } as never);

  // llm stub：complete 可脚本化（模型层停靠站）+ 小窗口元数据（判阈易过）
  const calls: Array<{ prompt: string; priority?: string }> = [];
  const defaultComplete = async (): Promise<StubCompleteResult> => ({
    message: { content: '目标推进摘要：五节文本' },
    usage: { input: 100, output: 50 },
  });
  let completeImpl: () => Promise<StubCompleteResult> = defaultComplete;
  ctx.provide('llm', {
    complete: async (req: { messages: Array<{ content: string }>; priority?: string }) => {
      calls.push({ prompt: req.messages[0]!.content, priority: req.priority });
      return completeImpl();
    },
    getModel: (_id: string): { contextWindow: number } => ({ contextWindow: SMALL_WINDOW }),
  } as never);

  // tools / channels / ui 三面薄壳（本文件不触工具执行与命令面——只满足件 apply
  // 拿面；compositionFor 是续跑投递的工具名单投影源，空面 → 名单仅结算两件）
  const notes: string[] = [];
  ctx.provide('tools', { register: () => () => undefined, compositionFor: () => [] } as never);
  ctx.provide('channels', { registerCommand: () => () => undefined } as never);
  ctx.provide('ui', { notify: (message: string) => notes.push(message) } as never);

  // 模型窗口判据源：request/header 末条 + getModel 元数据
  session.append('request/header', { model: 'test-model' });

  void createGoalApp({ connection: db.connection, getSessionId: () => session.header.sessionId }).apply(
    ctx as never,
    ctx.config,
  );

  return {
    session,
    store,
    db,
    fire: (status = 'completed') => {
      for (const cb of [...settledCbs]) cb({ status, sessionId: session.header.sessionId });
    },
    completeCalls: () => calls,
    setComplete: (impl) => {
      completeImpl = impl;
    },
    sent: () => sentMessages,
    notes: () => notes,
    addTurn: (content = `推进。${'细节'.repeat(40)}`) => {
      session.append('turn/start', {});
      session.append('user/message', { content });
      session.append('assistant/message', {
        content: [{ type: 'text', text: '好的，已推进' }],
        stopReason: 'end_turn',
      });
      session.append('turn/end', { reason: 'completed' });
    },
    addSelfWake: (goalId) => {
      session.append('user/message', {
        content: '自激续跑',
        source: 'app:goal',
        attribution: { goalId, wakePath: 'self' },
      });
    },
    seedGoal: (over = {}) => {
      const row = store.setActive(
        session.header.sessionId,
        over.objective ?? '把 goal 沉淀机器测完',
        over.tokenBudget ?? 10_000,
        false,
        1,
      );
      if (over.tokensUsed !== undefined && over.tokensUsed > 0) {
        store.addUsage(session.header.sessionId, over.tokensUsed, 2);
      }
      return row.goalId;
    },
  };
}

/* ---------------- 触发链：三件套落账 ---------------- */

describe('goal ⑥ 轮间沉淀机器（onRunSettled → runGoalSummary）', () => {
  it('过阈触发沉淀三件套：goal/summary 事件 → 载体遮蔽 → 缓存列 + usage 自报', async () => {
    const h = setup();
    const goalId = h.seedGoal();
    // 10 条消息（head 1 + 中段 3 + tail 6）——JSON 字符量过阈（SMALL_WINDOW × 0.5 × 4 chars）
    for (let i = 0; i < 5; i++) h.addTurn();
    expect(JSON.stringify(h.session.deriveMessages()).length >= SMALL_WINDOW * SUMMARY_THRESHOLD_RATIO * 4).toBe(true); // 前置自证：判阈必过（否则测试素材失效）

    h.fire();
    await until(() => h.session.events.some((e) => e.type === 'goal/summary'));

    // complete 单发：background 道 + objective 锚定（目标原文在场）
    expect(h.completeCalls().length).toBe(1);
    expect(h.completeCalls()[0]!.priority).toBe('background');
    expect(h.completeCalls()[0]!.prompt).toContain('把 goal 沉淀机器测完');

    // ① 事实源事件：goalId/text/summarySeq（载荷 = 规划区间末端）
    const summary = h.session.events.find((e) => e.type === 'goal/summary')!;
    expect(summary.data).toMatchObject({ goalId, text: '目标推进摘要：五节文本' });
    const summarySeq = (summary.data as { summarySeq: number }).summarySeq;

    // ② 载体：user/message + replace + app:goal 归因 + 前缀 + 溯源含摘要事件 seq
    const carrier = h.session.events.find((e) => e.type === 'user/message' && e.surfaceOp !== undefined)!;
    expect(carrier.data).toMatchObject({ source: 'app:goal' });
    expect(
      String((carrier.data as { content: string }).content).startsWith(`${GOAL_SUMMARY_PREFIX} 目标推进摘要`),
    ).toBe(true);
    expect(carrier.surfaceOp).toMatchObject({ op: 'replace' });
    expect(carrier.sourceEventSeqs).toContain(summary.seq);
    // 投影：中段被遮（10 条 → head + 载体 + tail < 10）+ 载体可见
    const msgs = h.session.deriveMessages();
    expect(msgs.some((m) => m.type === 'user' && JSON.stringify(m.content).includes(GOAL_SUMMARY_PREFIX))).toBe(true);
    expect(msgs.length).toBeLessThan(10);

    // ③ 缓存列 + usage 自报（100 + 50 = 150 tokens 计入 goal 账本）
    const row = h.store.getByGoalId(goalId)!;
    expect(row.summary).toBe('目标推进摘要：五节文本');
    expect(row.summarySeq).toBe(summarySeq);
    expect(row.tokensUsed).toBe(150);
  });

  it('水位 no-op：重复结算无新增推进——不重跑 LLM（complete 恰一次）', async () => {
    const h = setup();
    h.seedGoal();
    for (let i = 0; i < 5; i++) h.addTurn();
    h.fire();
    await until(() => h.session.events.some((e) => e.type === 'goal/summary'));
    h.fire(); // 同批消息再结算：plan.end ≤ summarySeq → return
    await new Promise((r) => setTimeout(r, 50));
    expect(h.completeCalls().length).toBe(1);
    expect(h.session.events.filter((e) => e.type === 'goal/summary').length).toBe(1);
  });

  it('预算尽不沉淀（花销侧不追——tokensUsed ≥ tokenBudget 直接让位）', async () => {
    const h = setup();
    h.seedGoal({ tokensUsed: 10_000 });
    for (let i = 0; i < 5; i++) h.addTurn();
    h.fire();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.completeCalls().length).toBe(0);
    expect(h.session.events.some((e) => e.type === 'goal/summary')).toBe(false);
  });

  it('判阈未到不沉淀（消息少——字符量低于窗口半阈）', async () => {
    const h = setup();
    h.seedGoal();
    h.addTurn(); // 2 条消息远低于阈
    h.fire();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.completeCalls().length).toBe(0);
  });

  it('complete 抛错（LLM_BUDGET_EXCEEDED 形）：无事件落账，goal 保持 active（下次结算重试）', async () => {
    const h = setup();
    const goalId = h.seedGoal();
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setComplete(() => {
      const err = new Error('LLM budget exceeded for background priority');
      return Promise.reject(err);
    });
    h.fire();
    await until(() => h.completeCalls().length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.session.events.some((e) => e.type === 'goal/summary')).toBe(false);
    expect(h.store.getByGoalId(goalId)!.status).toBe('active');
    expect(h.store.getByGoalId(goalId)!.summary).toBeNull();
  });

  it('自报越限同笔刹停：stopByBudget + evidence budget + 摘钟回调——不注入收尾提示', async () => {
    const h = setup();
    const goalId = h.seedGoal({ tokenBudget: 200 });
    for (let i = 0; i < 5; i++) h.addTurn();
    // 摘要单发自报 250 tokens ≥ 预算 200 → 越限（totalTokens 在场优先于 input+output）
    h.setComplete(async () => ({
      message: { content: '越限前的最后一份摘要' },
      usage: { input: 150, output: 100, totalTokens: 250 },
    }));
    h.fire();
    await until(() => h.session.events.some((e) => e.type === 'goal/summary'));

    const row = h.store.getByGoalId(goalId)!;
    expect(row.status).toBe('stopped');
    expect(row.stopReason).toBe('budget');
    expect(row.tokensUsed).toBe(250);
    expect(
      h.session.events.some((e) => e.type === 'goal/evidence' && (e.data as { reason: string }).reason === 'budget'),
    ).toBe(true);
    // 不注入收尾：sent 里只有续跑投递（fire 时 goal 尚 active）——无「预算刹车」
    // 收尾提示（其专属开场词不在场；续跑提示自带预算余额段属正常内容）
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sent().length).toBe(1); // 续跑投递恰一次
    expect(h.sent()[0]!.content).not.toContain('预算刹车');
  });

  it('capped 独立沉淀：唤醒帽拒发不影响沉淀（goal/summary 在场 + 无续跑投递 + capped 证据）', async () => {
    const h = setup();
    const goalId = h.seedGoal();
    for (let i = 0; i < 5; i++) h.addTurn();
    // 连续帽素材：尾倒扫 3 条 self 唤醒（≥ MAX_CONSECUTIVE_SELF_WAKES）
    for (let i = 0; i < 3; i++) h.addSelfWake(goalId);
    h.fire();
    await until(() => h.session.events.some((e) => e.type === 'goal/summary'));
    expect(h.sent().length).toBe(0); // 拒发：无续跑投递
    expect(
      h.session.events.some((e) => e.type === 'goal/evidence' && (e.data as { reason: string }).reason === 'capped'),
    ).toBe(true);
    // 沉淀照常三件套（缓存列已回填）
    expect(h.store.getByGoalId(goalId)!.summary).toBe('目标推进摘要：五节文本');
  });
});
