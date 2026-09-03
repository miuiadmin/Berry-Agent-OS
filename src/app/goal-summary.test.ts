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

function setup(processKind?: 'tui' | 'run' | 'tick' | 'daemon'): Harness {
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

  // 模型窗口判据源：request/header 末条 config.model + getModel 元数据（生产
  // 形状——chat 件 writeHeader 落账形；修前夹具 `{ model }` 顶层键是照病读点
  // 反推的非生产形状，第十一轮遗漏大扫 20260904-b CB2 拆共谋随笔）
  session.append('request/header', {
    config: { model: 'test-model', sandbox: 'default' },
    systemPrompt: '系统提示词',
    toolSchemas: [],
    reason: 'initial',
  });

  // processKind 透传（tick 形态豁免用例——遗漏大扫 20260902-c #5；条件展开
  // 保持缺省 undefined = 非 tick 的既有行为面）
  void createGoalApp({
    connection: db.connection,
    getSessionId: () => session.header.sessionId,
    ...(processKind !== undefined ? { processKind } : {}),
  }).apply(ctx as never, ctx.config);

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

  it('complete 抛错（LLM_BUDGET_EXCEEDED 形）：无 goal/summary，goal 保持 active（下次结算重试）+ 【回归锁 第九轮 #20】失败落 goal/summary-failed（不再 debug-only 无痕）', async () => {
    const h = setup();
    const goalId = h.seedGoal();
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setComplete(() => {
      const err = new Error('LLM budget exceeded for background priority');
      return Promise.reject(err);
    });
    h.fire();
    await until(() => h.completeCalls().length === 1);
    await until(() => h.session.events.some((e) => e.type === 'goal/summary-failed'));
    expect(h.session.events.some((e) => e.type === 'goal/summary')).toBe(false);
    expect(h.store.getByGoalId(goalId)!.status).toBe('active');
    expect(h.store.getByGoalId(goalId)!.summary).toBeNull();
    // 修前：catch 只 logger.debug——沉淀失败 durable 无痕、重试无界零账面（违
    // 「只在 debug 出现的分支必须同时是 durable 事件」红线）；修后落失败事件
    // （compaction/failed 先例——载荷 goalId + error 摘要）
    const failed = h.session.events.find((e) => e.type === 'goal/summary-failed')!;
    expect(failed.data).toMatchObject({ goalId });
    expect(String((failed.data as { error: string }).error)).toContain('LLM budget exceeded');
    // error 腿过 2KiB 错误小帽（错误说明非全文）
    expect(Buffer.byteLength(String((failed.data as { error: string }).error), 'utf8')).toBeLessThanOrEqual(
      2 * 1024 + 64,
    );
  });

  it('【回归锁 第九轮 #7②】超 64KiB 摘要过预算刀落账：事件/载体/缓存列三面同刀同文本', async () => {
    const h = setup();
    const goalId = h.seedGoal();
    for (let i = 0; i < 5; i++) h.addTurn();
    // 模型超产 70KiB 摘要（修前 text 全量落 append 抛 SESSION_EVENT_TOO_LARGE
    // → attemptSummary catch → 每次结算后台重烧一次 LLM 单发再失败，零账面）
    h.setComplete(async () => ({
      message: { content: 'G'.repeat(70 * 1024) },
      usage: { input: 100, output: 50 },
    }));
    h.fire();
    await until(() => h.session.events.some((e) => e.type === 'goal/summary'));

    const summary = h.session.events.find((e) => e.type === 'goal/summary')!;
    expect(Buffer.byteLength(JSON.stringify(summary.data), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    const text = (summary.data as { text: string }).text;
    expect(text).toContain('truncated for durable log');
    // 载体 content 同刀同文本（预算一次、三面共用）
    const carrier = h.session.events.find((e) => e.type === 'user/message' && e.surfaceOp !== undefined)!;
    expect(Buffer.byteLength(JSON.stringify(carrier.data), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(String((carrier.data as { content: string }).content)).toContain('truncated for durable log');
    // 缓存列 = 同一截断文本（三面同刀同文本——列只是缓存）
    expect(h.store.getByGoalId(goalId)!.summary).toBe(text);
    // 失败事件不落（成功路——预算刀消灭了越护栏恒败形态）
    expect(h.session.events.some((e) => e.type === 'goal/summary-failed')).toBe(false);
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

  it('【回归锁 20260902-c #5】tick 形态豁免：结算不自激不沉淀——零续跑投递 + 零 goal/summary + 行保持 active', async () => {
    const h = setup('tick');
    const goalId = h.seedGoal();
    // 过阈素材（沉淀腿若未豁免，attemptSummary 会异步起跑）
    for (let i = 0; i < 3; i++) h.addTurn();
    h.fire('completed');
    // 豁免是同步分支：派发波内即决——零续跑投递（修前红：非 tick 路投递在
    // 同步波内落 sent——tick 子进程里这条投递开的新 run 会被 shutdown retire
    // 掐死在出生点，纯浪费）
    expect(h.sent()).toHaveLength(0);
    // 沉淀腿同被跳过：等出异步窗后仍无 goal/summary 事实源事件、无 complete
    // 调用（水位不进 = 下一跳/长命进程触及时代水位重试语义天然兜底）
    await new Promise((r) => setTimeout(r, 150));
    expect(h.session.events.filter((e) => e.type === 'goal/summary')).toHaveLength(0);
    expect(h.completeCalls()).toHaveLength(0);
    // 行不动：active 保持（豁免是跳过派生腿，非终态停——挂钟语义跨 tick 存活）
    expect(h.store.getByGoalId(goalId)!.status).toBe('active');
  });

  it('【回归锁 20260902-c #5】tick 豁免不豁掉同步记账：连续帽满结算 → capped evidence 照落账（willRetry）', () => {
    const h = setup('tick');
    const goalId = h.seedGoal();
    // 连续帽灌满（3 条 self 归因 user/message——wakeGate 连续段判据素材）
    for (let i = 0; i < 3; i++) h.addSelfWake(goalId);
    h.fire('completed');
    // 无投递（豁免分支不 sendUserMessage）
    expect(h.sent()).toHaveLength(0);
    // 记账照走：超帽 evidence 落 durable（纯挂钟喂养的 goal 超帽史仍可判读）
    expect(
      h.session.events.some(
        (e) =>
          e.type === 'goal/evidence' &&
          (e.data as { goalId?: string; reason?: string; willRetry?: boolean }).goalId === goalId &&
          (e.data as { reason?: string }).reason === 'capped' &&
          (e.data as { willRetry?: boolean }).willRetry === true,
      ),
    ).toBe(true);
  });

  it('【回归锁 20260902-c #5 D-1】双守卫落点：stalls 硬停走真码路径对 tick 照落（守卫乙在 capped 块后——不为豁免复刻判据）', () => {
    const h = setup('tick');
    const goalId = h.seedGoal();
    // 停滞素材：连续 3 轮 surface_only（stallsDecision 硬停线——era 无边界全日志即本 era）
    for (let i = 0; i < 3; i++) h.session.append('goal/evidence', { goalId, outcome: 'surface_only' });
    h.fire('completed');
    // stalls 硬停是结算回调前段真码路径：tick 豁免（守卫乙落点在其后）不触及——
    // 纯挂钟喂养的停滞 goal 仍会硬停（修前单早退若上移到 stalls 前即漏此执法）
    expect(h.store.getByGoalId(goalId)!.status).toBe('stopped');
    expect(
      h.session.events.some(
        (e) =>
          e.type === 'goal/evidence' &&
          (e.data as { goalId?: string }).goalId === goalId &&
          (e.data as { reason?: string }).reason === 'stalls',
      ),
    ).toBe(true);
    // 停摆即终点：零投递
    expect(h.sent()).toHaveLength(0);
  });
});
