/**
 * L3 compaction 集成测试（官方件 apply 全链）——真 Context + 真 Session +
 * 三服务 stub（agent/sessions/llm；模型层是 mock 停靠站——complete 可脚本化，
 * 其余全真）。宿主 ④f 的 appendWithSurfaceOp 四执法点测试在 app/assembly.test.ts
 * （组合根面）；本文件的 sessions stub 是其核心行为薄壳（真 Session.append
 * 直通带遮蔽），锁的是件本体的编排与状态机。
 *
 * 锁纵切行为：触发链（判阈→五步→重播种）/ 降级 / 失败孪生 / 冷却 derive /
 * pendingReseed 推迟补播种 / 防抖 suppress 三轮链。
 */

import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import type { ContextScope } from '../context/types.js';
import { Session } from '../session/session.js';
import type { SessionEvent } from '../contracts/events.js';
import type { ProjectedMessage } from '../session/derive.js';
import { createCompactionApp } from './app.js';
import type { BuiltinAppModule } from '../contracts/app.js';
import { SUMMARY_PREFIX } from './policy.js';

/* ---------------- 测试基建 ---------------- */

/** fire-and-forget 链的结算等待：轮询条件成立或超时（件内 complete 是 async） */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待条件超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Harness：三 stub 服务 + 真 Session + 触发面板 */
interface Harness {
  ctx: ContextScope;
  session: Session;
  /** 模拟一次 run 结算（派发 onRunSettled 订阅者） */
  fire: () => void;
  /** reseedTimeline 调用计数 */
  reseedCalls: () => number;
  /** 控制 reseedTimeline 返回值（false = run 进行中拒改） */
  setReseed: (ok: boolean) => void;
  /** complete 收到的 prompt 序列 */
  prompts: () => string[];
  /** 控制 complete 行为（缺省返回固定摘要；设为 reject 即抛） */
  setComplete: (impl: () => Promise<StubCompleteResult>) => void;
  /** 落一条主 loop usage 笔（callId turn: 前缀——判据只认此笔） */
  setUsage: (input: number) => void;
  /** 造消息轮（user/assistant 各一，seq 由 Session 自排） */
  addTurn: () => void;
  /** 溢出压缩面（第四十五批配套②：恒提供——agent 缺席同） */
  overflow: () => { compactForOverflow(): Promise<'compacted' | 'nothing' | 'failed'> } | undefined;
}

/** complete 替身返回形（模型层停靠站契约） */
interface StubCompleteResult {
  readonly message: { readonly content: string; readonly model: string };
  readonly usage: { readonly input: number; readonly output: number };
}

/** 建 ctx + 三服务 + apply 件（缺省窗口 200_000 / ratio 0.5 → 阈 100_000）；opts.agent=false 建 agent 缺席形态 */
function setup(opts?: { agent?: boolean }): Harness {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const session = new Session();

  // agent stub：订阅表 + 可控重播种
  const settledCbs = new Set<(settled: { sessionId: string }) => void>();
  let reseedOk = true;
  const reseedCalls: string[] = [];
  const prompts: string[] = [];
  const defaultComplete = async (): Promise<StubCompleteResult> => ({
    message: { content: '结构化摘要文本', model: 'test-model' },
    usage: { input: 120, output: 60 },
  });
  let completeImpl: () => Promise<StubCompleteResult> = defaultComplete;

  if (opts?.agent !== false) {
    ctx.provide('agent', {
      onRunSettled(cb: (settled: { sessionId: string }) => void) {
        settledCbs.add(cb);
        return () => settledCbs.delete(cb);
      },
      reseedTimeline(sessionId: string) {
        reseedCalls.push(sessionId);
        return reseedOk;
      },
    });
  }

  // sessions stub：宿主 ④f 测试侧形态（活引用绑定真 Session；appendWithSurfaceOp
  // = 真 Session.append 直通带遮蔽——四执法点在 assembly 侧另有锁）；
  // currentSessionId 模拟宿主 ALS 路由（测试语境恒路由到本会话）
  ctx.provide('sessions', {
    appendEvent: (type: string, data: unknown): SessionEvent | undefined => session.append(type, data),
    eventsOfType: (type: string): SessionEvent[] => session.events.filter((e) => e.type === type),
    deriveMessages: (): ProjectedMessage[] => session.deriveMessages(),
    // 字符账直通真 Session 增量计数（O-6——判据腿与宿主装配同源）
    projectedJsonChars: (): number => session.projectedJsonChars(),
    currentSessionId: (): string | undefined => session.header.sessionId,
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
  });

  // llm stub：complete 可脚本化（模型层停靠站）+ 模型目录恒有窗口
  ctx.provide('llm', {
    complete: async (req: { messages: Array<{ content: string }> }) => {
      prompts.push(req.messages[0]!.content);
      return completeImpl();
    },
    getModel: (_id: string): { contextWindow: number } => ({ contextWindow: 200_000 }),
  });

  // 模型窗口判据源：request/header 末条 + getModel 元数据
  session.append('request/header', { model: 'test-model', mode: 'default' });

  const plugin: BuiltinAppModule = createCompactionApp();
  void plugin.apply(ctx as never, ctx.config);

  return {
    ctx,
    session,
    fire: () => {
      for (const cb of [...settledCbs]) cb({ sessionId: session.header.sessionId });
    },
    reseedCalls: () => reseedCalls.length,
    setReseed: (ok) => {
      reseedOk = ok;
    },
    prompts: () => prompts,
    setComplete: (impl) => {
      completeImpl = impl;
    },
    setUsage: (input) => {
      session.append('llm/usage', { callId: `turn:${session.length}`, usage: { input, output: 10 } });
    },
    addTurn: () => {
      session.append('turn/start', {});
      session.append('user/message', { content: '继续' });
      session.append('assistant/message', { content: [{ type: 'text', text: '好的' }], stopReason: 'end_turn' });
      session.append('turn/end', { reason: 'completed' });
    },
    overflow: () => ctx.tryGet('compaction'),
  };
}

/* ---------------- 触发链 ---------------- */

describe('compaction 官方件 apply', () => {
  it('无 ctx.agent 服务：阈值触发路停用但溢出压缩面照提供（配套②——语义收窄）', async () => {
    const h = setup({ agent: false });
    // 面恒在场：compactForOverflow 可调（agent 缺席同）；阈值路无订阅（fire 空转）
    expect(h.overflow()).toBeDefined();
    expect(typeof h.overflow()!.compactForOverflow).toBe('function');
    h.fire(); // settledCbs 空——无 agent 无订阅，不抛即过
  });

  it('过阈触发 durable 五步：start→complete→summary→载体遮蔽→end + 重播种', async () => {
    const h = setup();
    // 造 9 条消息（head 1 + 中段 2 + tail 6）+ 过阈 usage 笔（150_000 ≥ 100_000）
    for (let i = 0; i < 5; i++) h.addTurn(); // 5 轮 = 10 条消息（u/a ×5）
    h.setUsage(150_000);
    h.fire();

    await until(() => h.session.events.some((e) => e.type === 'compaction/end'));
    const types = h.session.events.map((e) => e.type);
    // 五步顺序：start 先于 summary 先于载体先于 end（indexOf 严格递增）
    const iStart = types.indexOf('compaction/start');
    const iSummary = types.indexOf('compaction/summary');
    const iEnd = types.indexOf('compaction/end');
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iSummary).toBeGreaterThan(iStart);
    expect(iEnd).toBeGreaterThan(iSummary);
    // start 归因（出生纪律：reason + willRetry）
    const start = h.session.events[iStart]!;
    expect(start.data).toMatchObject({ reason: 'threshold', willRetry: true });
    // summary 审计面：text/model/usage 可从日志重建
    expect(h.session.events[iSummary]!.data).toMatchObject({ text: '结构化摘要文本', model: 'test-model' });
    // 载体：user/message + surfaceOp + plugin: 归因 + 溯源含区间与依据外 seq
    const carrier = h.session.events.find((e) => e.type === 'user/message' && e.surfaceOp !== undefined)!;
    expect(carrier.data).toMatchObject({ source: 'app:compaction' });
    expect(String((carrier.data as { content: string }).content).startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(carrier.surfaceOp).toMatchObject({ op: 'replace' });
    expect(carrier.sourceEventSeqs).toContain(iSummary); // 摘要依据事件在列（区间外）
    // 投影：中段被遮 + 载体可见 + head 首条保留（任务锚）
    const msgs = h.session.deriveMessages();
    const carrierMsg = msgs.find((m) => m.type === 'user' && JSON.stringify(m.content).includes(SUMMARY_PREFIX));
    expect(carrierMsg).toBeDefined();
    expect(msgs[0]).toMatchObject({ type: 'user' }); // head 保留
    expect(msgs.length).toBeLessThan(10); // 中段确实被遮（10 → 更少）
    // 重播种被调（压缩完成即试播）
    expect(h.reseedCalls()).toBe(1);
  });

  it('未过阈不触发（usage 笔低于阈）', async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setUsage(50_000);
    h.fire();
    await until(() => h.reseedCalls() >= 0); // 结算链空转
    expect(h.session.events.some((e) => e.type === 'compaction/start')).toBe(false);
    expect(h.prompts()).toHaveLength(0);
  });

  it('complete 抛错：落 compaction/failed 孪生（冷却数据源）', async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setUsage(150_000);
    h.setComplete(() => Promise.reject(new Error('provider 599')));
    h.fire();
    await until(() => h.session.events.some((e) => e.type === 'compaction/failed'));
    const failed = h.session.events.find((e) => e.type === 'compaction/failed')!;
    expect(failed.data).toMatchObject({ reason: 'threshold' });
    expect(String((failed.data as { error: string }).error)).toContain('599');
    // 载体未落（失败在摘要步——无遮蔽半成品）
    expect(h.session.events.some((e) => e.type === 'user/message' && e.surfaceOp)).toBe(false);
  });

  it('冷却 derive：failed 事件在冷却窗内 → 过阈也不触发', async () => {
    const h = setup();
    h.session.append('compaction/failed', { reason: 'threshold', error: '上次失败' });
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setUsage(150_000);
    h.fire();
    await until(() => h.reseedCalls() >= 0);
    expect(h.session.events.filter((e) => e.type === 'compaction/start')).toHaveLength(0);
  });

  it('pendingReseed：播种被拒记账 → 下次结算先补播种再判新触', async () => {
    const h = setup();
    h.setReseed(false); // run 永远「进行中」——播种恒拒
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setUsage(150_000);
    h.fire();
    await until(() => h.session.events.some((e) => e.type === 'compaction/end'));
    expect(h.reseedCalls()).toBe(1); // 试了一次被拒
    // 载体已落（durable 五步不受播种推迟影响——先落账后生效）
    expect(h.session.events.some((e) => e.type === 'user/message' && e.surfaceOp)).toBe(true);

    // 补播种窗口开 + usage 降到阈下（播种生效后的真实笔）→ 下次结算：补播成功 + 不再新触
    h.setReseed(true);
    h.setUsage(30_000);
    h.fire();
    await until(() => h.reseedCalls() === 2);
    // 只此一轮压缩（第二轮未叠）
    expect(h.session.events.filter((e) => e.type === 'compaction/start')).toHaveLength(1);
  });

  it('防抖三轮链：两轮低节省 suppress → 判据量涨 ×1.5 恢复', async () => {
    const h = setup();
    // 轮1：150_000 过阈压缩（before 记 150_000）
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setUsage(150_000);
    h.fire();
    await until(() => h.session.events.some((e) => e.type === 'compaction/end'));

    // 轮2：播种后笔 146_000（省 2.7% <10% → count 1）→ 仍过阈 → 第二轮压缩
    h.addTurn();
    h.setUsage(146_000);
    h.fire();
    await until(() => h.session.events.filter((e) => e.type === 'compaction/end').length === 2);

    // 轮3：142_000（又省 2.7% → count 2 → suppress 置位）→ 过阈被拦，无第三轮
    h.addTurn();
    h.setUsage(142_000);
    h.fire();
    await until(() => h.reseedCalls() >= 2);
    expect(h.session.events.filter((e) => e.type === 'compaction/start')).toHaveLength(2);

    // 轮4：判据量 220_000 > 146_000×1.5（显著新增）→ suppress 解除 → 第三轮压缩
    h.setUsage(220_000);
    h.fire();
    await until(() => h.session.events.filter((e) => e.type === 'compaction/start').length === 3);
  });
});

/* ---------------- 溢出压缩面（第四十五批步 2） ---------------- */

describe('compaction 溢出面 compactForOverflow', () => {
  it('compacted：五步事件序 + start 归因 overflow 不落判据三件 + 不播种不占阈值路记账', async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.addTurn(); // 10 条消息（可规划区间）
    const verdict = await h.overflow()!.compactForOverflow();

    expect(verdict).toBe('compacted');
    const types = h.session.events.map((e) => e.type);
    const iStart = types.indexOf('compaction/start');
    const iSummary = types.indexOf('compaction/summary');
    const iEnd = types.indexOf('compaction/end');
    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iSummary).toBeGreaterThan(iStart);
    expect(iEnd).toBeGreaterThan(iSummary);
    // start 载荷：reason 穿透（配套①）+ 无判据三件（溢出判据是错误本身非估算）
    const start = h.session.events[iStart]!.data as Record<string, unknown>;
    expect(start.reason).toBe('overflow');
    expect(start.willRetry).toBe(true);
    expect(start.basis).toBeUndefined();
    expect(start.estTokens).toBeUndefined();
    expect(start.window).toBeUndefined();
    // 播种不被调（mid-run 播种必拒——归调用方私有重播种路径）+ 无阈值路结算
    expect(h.reseedCalls()).toBe(0);
    expect(h.fire).toBeDefined();
  });

  it('nothing：区间不足（tailKeep 保护）诚实无操作——无任何 compaction 事件', async () => {
    const h = setup();
    for (let i = 0; i < 2; i++) h.addTurn(); // 4 条消息 < tailKeep 6 → planSegment null
    const verdict = await h.overflow()!.compactForOverflow();

    expect(verdict).toBe('nothing');
    expect(h.session.events.some((e) => e.type.startsWith('compaction/'))).toBe(false);
    expect(h.prompts()).toHaveLength(0);
  });

  it('failed：摘要抛错落 compaction/failed reason=overflow（配套①穿透）', async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setComplete(() => Promise.reject(new Error('provider 599')));
    const verdict = await h.overflow()!.compactForOverflow();

    expect(verdict).toBe('failed');
    const failed = h.session.events.find((e) => e.type === 'compaction/failed')!;
    expect(failed.data).toMatchObject({ reason: 'overflow' });
    expect(String((failed.data as { error: string }).error)).toContain('599');
    // 载体未落（失败在摘要步——无遮蔽半成品）
    expect(h.session.events.some((e) => e.type === 'user/message' && e.surfaceOp)).toBe(false);
  });

  it('在飞互斥（配套⑤）：阈值路压缩在飞时等待 → 结算后见新压缩终点直返 compacted 不重复压', async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.addTurn();
    h.setUsage(150_000); // 过阈
    // 阈值路 complete 挂起（手动放行——制造在飞窗口）
    let releaseThreshold!: () => void;
    const gate = new Promise<void>((r) => {
      releaseThreshold = r;
    });
    h.setComplete(() =>
      gate.then(() => ({ message: { content: '阈值路摘要', model: 'test-model' }, usage: { input: 100, output: 50 } })),
    );

    h.fire(); // 阈值路起跑（五步在飞、互斥位持有）
    await until(() => h.session.events.some((e) => e.type === 'compaction/start'));
    // 溢出调用进门：等互斥（此刻快照 end 序 = -1 无终点）
    const overflowPromise = h.overflow()!.compactForOverflow();
    releaseThreshold(); // 阈值路五步放行落账（end 落）

    expect(await overflowPromise).toBe('compacted'); // 等待期间已有新压缩——不重复压
    // 只有一轮五步（溢出等待方未再起 start）
    expect(h.session.events.filter((e) => e.type === 'compaction/start')).toHaveLength(1);
    expect(h.session.events.filter((e) => e.type === 'compaction/end')).toHaveLength(1);
  });

  it('溢出压缩后阈值路判据不受污染：pendingReseed/防抖账面不动（溢出节省偶入判据属无害偏差）', async () => {
    const h = setup();
    for (let i = 0; i < 5; i++) h.addTurn();
    await h.overflow()!.compactForOverflow();

    // 溢出压缩后首个结算：无 lastBeforeTokens 记账（防抖判据从零起）+ 播种不被调
    h.setUsage(30_000); // 阈下
    h.fire();
    await until(() => h.reseedCalls() >= 0);
    expect(h.session.events.filter((e) => e.type === 'compaction/start')).toHaveLength(1); // 仅溢出那一轮
  });
});
