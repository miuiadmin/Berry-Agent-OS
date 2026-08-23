/**
 * L3 memory 单元/集成测试（周期 review + consolidation——记忆篇 §4 周期路 / §5 后续整理）。
 *
 * mock 只停在模型层：llm 面注入脚本化 ReviewLlmFace（返回固定 JSON 文本），
 * 其余全真（真 ctx 事件总线 + 真 :memory: 记忆库 + 真合并管线）。不断言 AI 生成的
 * 具体文本——脚本模型的产物是测试自备数据。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../context/index.js';
import { createLogger } from '../context/logger.js';
import { openStore } from '../persist/index.js';
import { MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION } from './schema.js';
import { MemoryStore } from './store.js';
import type { ReviewLlmFace } from './review.js';
import { attachPeriodicReview, collectConsolidationCandidates, runConsolidationOnce, runReviewOnce } from './review.js';

/* ---------------- 测试基建 ---------------- */

/** 当前测试库（每用例新建 :memory:） */
let db: MemoryStore;

beforeEach(() => {
  db = new MemoryStore(
    openStore({ path: ':memory:', migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION] }).connection,
  );
});

/** 静默 logger 根作用域（fire-and-forget 通道收行断言） */
function captureRoot() {
  const lines: string[] = [];
  const ctx = createContext({
    logger: createLogger({ module: 'test', level: 'debug', sink: (line) => lines.push(line) }),
  });
  return { ctx, lines };
}

/** 脚本模型调用记录面 */
interface ScriptedCall {
  systemPrompt?: string;
  messages: unknown[];
  priority?: string;
}

/**
 * 脚本化 llm（mock 停在模型层的唯一面）：responses 按序出、耗尽后重复末项；
 * afford=false 模拟 canAfford 拒绝（周期路应跳过本轮不发起调用）。
 */
function scriptedLlm(responses: readonly string[], opts: { afford?: boolean } = {}) {
  const calls: ScriptedCall[] = [];
  let cursor = 0;
  const llm: ReviewLlmFace = {
    async complete(req) {
      calls.push({ systemPrompt: req.systemPrompt, messages: req.messages, priority: req.priority });
      const text = responses[Math.min(cursor, responses.length - 1)] ?? '[]';
      cursor += 1;
      return { message: { content: text } };
    },
    canAfford: (priority) => (priority === 'foreground' ? true : (opts.afford ?? true)),
  };
  return { llm, calls };
}

/** 一条合法候选 JSON（kind/summary/content 可覆写） */
function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'preference',
    summary: '用户偏好 pnpm',
    content: '会话中用户明确表示统一用 pnpm。',
    confidence: 0.8,
    ...over,
  };
}

describe('runReviewOnce（周期路单轮编排）', () => {
  it('合法候选入库 + 非法候选丢弃：kind 词汇外/confidence 越界不进库、不计候选数', async () => {
    const { llm, calls } = scriptedLlm([
      JSON.stringify([
        candidate(),
        candidate({ kind: 'fact', summary: '项目用 vitest', content: '本项目测试框架是 vitest。' }),
        candidate({ kind: 'hobby', summary: '非法 kind' }), // kind 词汇外——丢弃
        candidate({ confidence: 1.5, summary: '置信度越界' }), // 0..1 外——丢弃
      ]),
    ]);
    const report = await runReviewOnce({ store: db, llm, logger: createLogger({ module: 't' }) }, [
      { role: 'user', content: '统一用 pnpm 装依赖', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '好的' }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: 'stop',
        timestamp: 0,
      },
    ]);
    expect(report).toMatchObject({ candidates: 2, inserted: 2, merged: 0, superseded: 0, rejected: 0, blocked: 0 });
    expect(db.list(['global'])).toHaveLength(2);
    // 请求面：priority background + systemPrompt 注入 + 转录透传（user 直通、assistant 块数组原样）
    expect(calls[0]!.priority).toBe('background');
    expect(calls[0]!.systemPrompt).toContain('memory extraction');
    expect(calls[0]!.messages as Array<{ role: string }>).toHaveLength(2);
  });

  it('同候选重复出现走 exact 合并增强（evidence +1）——周期路与工具/即时路同管线', async () => {
    const { llm } = scriptedLlm([JSON.stringify([candidate(), candidate()])]);
    const report = await runReviewOnce({ store: db, llm, logger: createLogger({ module: 't' }) }, [
      { role: 'user', content: 'x', timestamp: 0 },
    ]);
    expect(report).toMatchObject({ candidates: 2, inserted: 1, merged: 1 });
    expect(db.list(['global'])[0]!.evidenceCount).toBe(2);
  });

  it('产物容错：代码围栏剥壳可解析；纯文本废话整轮丢弃不抛', async () => {
    const fenced = '```json\n' + JSON.stringify([candidate()]) + '\n```';
    const ok = await runReviewOnce(
      { store: db, llm: scriptedLlm([fenced]).llm, logger: createLogger({ module: 't' }) },
      [{ role: 'user', content: 'x', timestamp: 0 }],
    );
    expect(ok.inserted).toBe(1);

    const { lines } = captureRoot();
    const junk = await runReviewOnce(
      {
        store: db,
        llm: scriptedLlm(['我认为没什么值得记的']).llm,
        logger: createLogger({ module: 't', level: 'warn', sink: (l) => lines.push(l) }),
      },
      [{ role: 'user', content: 'y', timestamp: 0 }],
    );
    expect(junk).toMatchObject({ candidates: 0, inserted: 0 }); // 尽力而为：丢弃不重试不抛
    expect(lines.some((l) => l.includes('丢弃'))).toBe(true);
  });

  it('转录空 / 预算不足：跳过本轮且零模型调用', async () => {
    const empty = scriptedLlm(['[]']);
    const r1 = await runReviewOnce({ store: db, llm: empty.llm, logger: createLogger({ module: 't' }) }, []);
    expect(r1.skipped).toBe('empty');
    expect(empty.calls).toHaveLength(0);

    const broke = scriptedLlm(['[]'], { afford: false });
    const r2 = await runReviewOnce({ store: db, llm: broke.llm, logger: createLogger({ module: 't' }) }, [
      { role: 'user', content: 'x', timestamp: 0 },
    ]);
    expect(r2.skipped).toBe('budget');
    expect(broke.calls).toHaveLength(0);
  });

  it('候选含疑似密钥：写前扫描拦截不入库（reject 只记模式计数）', async () => {
    const poisoned = candidate({ kind: 'fact', summary: '部署 token', content: `token=${'w'.repeat(40)}` });
    const { llm } = scriptedLlm([JSON.stringify([candidate(), poisoned])]);
    const report = await runReviewOnce({ store: db, llm, logger: createLogger({ module: 't' }) }, [
      { role: 'user', content: 'x', timestamp: 0 },
    ]);
    expect(report).toMatchObject({ candidates: 2, inserted: 1, blocked: 1 });
    expect(db.list(['global'])).toHaveLength(1);
  });
});

describe('collectConsolidationCandidates（老化 ∪ 容量溢出——纯查询）', () => {
  /** 写一条可控时间戳的 active 条目 */
  function seed(summary: string, confidence: number, nowMs: number) {
    db.addMemory(
      {
        ownerKey: 'global',
        kind: 'fact',
        summary,
        content: `${summary}（正文）`,
        confidence,
        sourceRefs: [{ sessionId: 's', seq: 1 }],
      },
      nowMs,
    );
  }

  it('老化腿：updated_at 距今超 staleDays 的进候选', () => {
    const NOW = 180_000_000_000_000; // 固定「今天」
    seed('新条目', 0.5, NOW - 1000);
    seed('老条目', 0.5, NOW - 100 * 24 * 3600 * 1000); // 100 天前 > 90
    const { stale } = collectConsolidationCandidates(db, 'global', { now: () => NOW });
    expect(stale.map((r) => r.summary)).toEqual(['老条目']);
  });

  it('容量腿：超出上限取最低分盈余；未溢出为空', () => {
    const NOW = 180_000_000_000_000;
    seed('强证据条目', 0.9, NOW - 1000);
    seed('中证据条目', 0.5, NOW - 1000);
    seed('弱证据条目', 0.1, NOW - 1000);
    // 上限 2 → surplus 1 → 分最低（0.1）那条
    const hit = collectConsolidationCandidates(db, 'global', {
      now: () => NOW,
      staleDays: 36500,
      maxActivePerOwner: 2,
    });
    expect(hit.overflow.map((r) => r.summary)).toEqual(['弱证据条目']);
    // 上限 5 → 未溢出
    const miss = collectConsolidationCandidates(db, 'global', {
      now: () => NOW,
      staleDays: 36500,
      maxActivePerOwner: 5,
    });
    expect(miss.overflow).toHaveLength(0);
  });

  it('效用维度叠加（§5）：同置信同证据下，被引用条目优先保活、零用条目先进整理集', () => {
    const NOW = 180_000_000_000_000;
    seed('零用条目', 0.5, NOW - 1000);
    seed('常用条目', 0.5, NOW - 1000);
    // 常用条目被引用 5 次（utilityScore ×(1+ln6) ≈ ×2.79 抬分保活）
    const used = db.list(['global']).find((r) => r.summary === '常用条目')!;
    for (let i = 0; i < 5; i += 1) db.markUsed([used.id], NOW - i * 1000);
    const hit = collectConsolidationCandidates(db, 'global', {
      now: () => NOW,
      staleDays: 36500,
      maxActivePerOwner: 1, // 上限 1 → surplus 1 → 零用条目进整理集
    });
    expect(hit.overflow.map((r) => r.summary)).toEqual(['零用条目']);
    expect(hit.overflow[0]!.usageCount).toBe(0);
  });
});

describe('runConsolidationOnce（合并组 + 降权应用——走既有路径）', () => {
  const NOW = 180_000_000_000_000;

  beforeEach(() => {
    // 两条同义老条目 + 一条待降权老条目（均 >90 天 → 老化候选）
    db.addMemory(
      { ownerKey: 'global', kind: 'fact', summary: '用户偏好 pnpm', content: '统一用 pnpm。', confidence: 0.7 },
      NOW - 100 * 24 * 3600 * 1000,
    );
    db.addMemory(
      { ownerKey: 'global', kind: 'fact', summary: '包管理器用 pnpm', content: '包管理统一 pnpm。', confidence: 0.6 },
      NOW - 95 * 24 * 3600 * 1000,
    );
    db.addMemory(
      {
        ownerKey: 'global',
        kind: 'insight',
        summary: '旧框架遗留的教训',
        content: '旧架构的失败教训，已不再相关。',
        confidence: 0.8,
      },
      NOW - 120 * 24 * 3600 * 1000,
    );
  });

  it('合并组：keep 条 canonical 重走管线（证据 +1）+ drop 条软删 superseded_by 指向 llm:keepId；降权条 confidence 下调且 updated_at 不动', async () => {
    const keep = db.list(['global']).find((r) => r.summary === '用户偏好 pnpm')!;
    const drop = db.list(['global']).find((r) => r.summary === '包管理器用 pnpm')!;
    const decay = db.list(['global']).find((r) => r.kind === 'insight')!;
    const { llm, calls } = scriptedLlm([
      JSON.stringify({
        merges: [{ keepId: keep.id, dropIds: [drop.id] }],
        decays: [{ id: decay.id, factor: 0.5 }],
      }),
    ]);
    const report = await runConsolidationOnce(
      { store: db, llm, logger: createLogger({ module: 't' }) },
      { now: () => NOW },
    );
    expect(report).toMatchObject({ candidates: 3, mergedGroups: 1, decayed: 1 });
    expect(calls[0]!.priority).toBe('background');
    // 合并应用：keep 证据增强；drop dismissed 且 superseded_by 指向 keep（'llm:' 前缀族）
    const keepAfter = db.get(keep.id)!;
    expect(keepAfter.evidenceCount).toBe(2);
    const dropAfter = db.get(drop.id)!;
    expect(dropAfter.status).toBe('dismissed');
    expect(dropAfter.supersededBy).toBe(`llm:${keep.id}`);
    // 降权应用：confidence 减半；updated_at 保持老化基准（降权不是新证据——不洗新）
    const decayAfter = db.get(decay.id)!;
    expect(decayAfter.confidence).toBeCloseTo(0.4);
    expect(decayAfter.updatedAt).toBe(decay.updatedAt);
  });

  it('幻觉护栏：建议引用候选集外的 id 全忽略；产物非法整轮丢弃', async () => {
    const before = db
      .list(['global'])
      .map((r) => `${r.id}:${r.status}`)
      .sort();
    const ghost = scriptedLlm([
      JSON.stringify({
        merges: [{ keepId: 'ghost-id', dropIds: ['also-ghost'] }],
        decays: [{ id: 'ghost-id', factor: 0.1 }],
      }),
    ]);
    const r1 = await runConsolidationOnce(
      { store: db, llm: ghost.llm, logger: createLogger({ module: 't' }) },
      { now: () => NOW },
    );
    expect(r1).toMatchObject({ candidates: 3, mergedGroups: 0, decayed: 0 });
    expect(
      db
        .list(['global'])
        .map((r) => `${r.id}:${r.status}`)
        .sort(),
    ).toEqual(before); // 零副作用

    const junk = scriptedLlm(['不是 JSON']);
    const r2 = await runConsolidationOnce(
      { store: db, llm: junk.llm, logger: createLogger({ module: 't' }) },
      { now: () => NOW },
    );
    expect(r2.mergedGroups).toBe(0);
  });

  it('候选空 / 预算不足：跳过且零模型调用', async () => {
    // 时钟拨到 entries 写入后 1 天 → 无老化候选、无溢出
    const none = scriptedLlm(['{}']);
    const r1 = await runConsolidationOnce(
      { store: db, llm: none.llm, logger: createLogger({ module: 't' }) },
      { now: () => NOW - 99 * 24 * 3600 * 1000 },
    );
    expect(r1.skipped).toBe('empty');
    expect(none.calls).toHaveLength(0);

    const broke = scriptedLlm(['{}'], { afford: false });
    const r2 = await runConsolidationOnce(
      { store: db, llm: broke.llm, logger: createLogger({ module: 't' }) },
      { now: () => NOW },
    );
    expect(r2.skipped).toBe('budget');
    expect(broke.calls).toHaveLength(0);
  });
});

describe('attachPeriodicReview（session/event 计数触发全栈）', () => {
  /** 构造 session/event 信封载荷 */
  function envelope(type: string, data: unknown = {}) {
    return { sessionId: 's1', event: { type, seq: 1, time: 1, data } };
  }

  it('turn 阈值触发：消息进转录缓冲、候选经模型提取入库、consolidation 顺跑', async () => {
    const { ctx } = captureRoot();
    const { llm, calls } = scriptedLlm([JSON.stringify([candidate()])]);
    const handle = attachPeriodicReview(ctx, { store: db, llm, turnThreshold: 2, toolCallThreshold: 999 });

    ctx.emit('session/event', envelope('user/message', { content: '以后统一用 pnpm' }));
    ctx.emit('session/event', envelope('assistant/message', { content: [{ type: 'text', text: '好的' }] }));
    ctx.emit('session/event', envelope('turn/end'));
    ctx.emit('session/event', envelope('turn/end')); // 达阈值 2 → fire

    await handle.idle();
    expect(db.list(['global'])).toHaveLength(1); // 候选真实入库
    // 转录透传给模型：user 直通 + assistant 块数组（两轮消息原样可见）
    const messages = calls[0]!.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: '以后统一用 pnpm' });
    expect(messages[1]!.role).toBe('assistant');
    handle.dispose();
  });

  it('tool/call 腿先到先触发；dispose 后不再触发', async () => {
    const { ctx } = captureRoot();
    const { llm, calls } = scriptedLlm(['[]']);
    const handle = attachPeriodicReview(ctx, { store: db, llm, turnThreshold: 999, toolCallThreshold: 3 });

    ctx.emit('session/event', envelope('user/message', { content: '查一下依赖' }));
    for (let i = 0; i < 3; i += 1) ctx.emit('session/event', envelope('tool/call', { name: 'fs_read' }));
    await handle.idle();
    expect(calls).toHaveLength(1); // review 一发（产物 []）+ consolidation 候选空不发
    expect(db.list(['global'])).toHaveLength(0);

    handle.dispose();
    for (let i = 0; i < 6; i += 1) ctx.emit('session/event', envelope('tool/call'));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1); // dispose 后零新调用
  });

  it('在飞防抖：一轮未收尾时阈值再达不叠发（收尾后下个周期再试）', async () => {
    const { ctx } = captureRoot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const llm: ReviewLlmFace = {
      async complete() {
        started += 1;
        await gate; // 手动闸：第一轮挂起直至放行
        return { message: { content: '[]' } };
      },
      canAfford: () => true,
    };
    const handle = attachPeriodicReview(ctx, { store: db, llm, turnThreshold: 1 });

    ctx.emit('session/event', envelope('user/message', { content: '有内容的转录才会调模型' }));
    ctx.emit('session/event', envelope('turn/end')); // 第一轮起飞（挂起）
    ctx.emit('session/event', envelope('turn/end')); // 在飞 → 防抖吞掉
    ctx.emit('session/event', envelope('turn/end')); // 同上
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(1);

    release(); // 放行第一轮收尾
    await handle.idle();
    expect(started).toBe(1); // 防抖期间阈值达被吞——不补发

    ctx.emit('session/event', envelope('turn/end')); // 下一周期正常触发
    await handle.idle();
    expect(started).toBe(2);
    handle.dispose();
  });
});
