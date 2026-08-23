/**
 * L3 memory — 提取管线周期路 + consolidation（记忆篇 §4 周期路 / §5 后续整理）。
 *
 * 周期路：turn/end 计数（或 tool/call 计数）达阈值 → 后台低优先级把新近 surface
 * 转录交 ctx.llm.complete（priority:'background'——骨架篇 §9.2 受托管补全唯一
 * 合法路径）提取候选 → 逐条过 guardedAddMemory（§8 写前扫描 + §5 合并管线）。
 * 预算不足（canAfford false / LLM_BUDGET_EXCEEDED）→ 跳过本轮下个周期再试（铁律 4）。
 *
 * consolidation（低频 LLM，互补不替代确定性合并）：老化（>90 天）与容量溢出
 * （>500/owner）候选交模型建议合并对/降权表 → 应用走既有路径（合并 = addMemory
 * 规则 + forget 'llm:<id>'；降权 = decayConfidence）——不静默删除（删除只有用户
 * explicit forget）。
 *
 * 尽力而为纪律：提取产物 TypeBox 校验、失败条目丢弃不重试；一切异常止步于日志
 * （周期路是后台整理，炸 run = 设计错误）。schema 面用宿主 typebox 再导出（防双实例）。
 */

import { Type, Value } from '../contracts/typebox.js';
import type { AssistantMessage, Message, UserMessage } from '../contracts/llm.js';
import type { Context } from '../context/types.js';
import { utilityScore } from './store.js';
import type { MemoryStore } from './store.js';
import { guardedAddMemory } from './scan.js';

/** 周期路依赖的 llm 服务最小面（ctx.get('llm') 即满足——结构类型窄化便于测试注入脚本模型） */
export interface ReviewLlmFace {
  complete(req: {
    systemPrompt?: string;
    messages: Message[];
    priority?: 'background' | 'foreground';
    timeoutMs?: number;
  }): Promise<{ message: { content: unknown } }>;
  canAfford(priority: 'background' | 'foreground'): boolean;
}

/** 周期路阈值与窗口（全部插件配置项起草值——不进内核配置面，记忆篇 §4） */
export interface PeriodicReviewOptions {
  /** 记忆库 DAO */
  readonly store: MemoryStore;
  /** llm 服务面（一般传 ctx.get('llm')） */
  readonly llm: ReviewLlmFace;
  /** 提取条目归属（缺省 'global'；装配层按场景注入） */
  readonly ownerKey?: string;
  /** turn/end 计数阈值（缺省 10，Hermes 实证档） */
  readonly turnThreshold?: number;
  /** tool/call 计数阈值（缺省 15——两腿先到先触发） */
  readonly toolCallThreshold?: number;
  /** 转录窗口：最近 N 条消息（缺省 40 ≈ 20 turn） */
  readonly windowMessages?: number;
  /** 老化阈值天（缺省 90；consolidation 候选之一） */
  readonly staleDays?: number;
  /** 容量上限条/owner（缺省 500；溢出低分条目进 consolidation 候选） */
  readonly maxActivePerOwner?: number;
  /** 时钟注入（缺省 Date.now——老化判定与测试用） */
  readonly now?: () => number;
}

/** 单轮 review 报告（尽力而为的观测面——日志/diagnostics 用） */
export interface ReviewReport {
  /** 触发与否（预算不足/空转录 = 不触发） */
  readonly skipped?: 'budget' | 'empty';
  /** 模型产出且通过校验的候选数 */
  readonly candidates: number;
  /** 各候选入合并管线的四态计数 */
  readonly inserted: number;
  readonly merged: number;
  readonly superseded: number;
  readonly rejected: number;
  /** 写前扫描拦截数 */
  readonly blocked: number;
}

/** 单轮 consolidation 报告 */
export interface ConsolidationReport {
  /** 候选数（老化 ∪ 容量溢出） */
  readonly candidates: number;
  readonly skipped?: 'budget' | 'empty';
  /** 应用的合并组数（每组 = canonical addMemory + drop 条 forget 'llm:'） */
  readonly mergedGroups: number;
  /** 应用的降权条数 */
  readonly decayed: number;
}

/* ---------------- 提取 prompt 与产物 schema ---------------- */

/** 周期路提取 prompt（产出 = 纯 JSON 数组；五类候选——correction 归即时路） */
const REVIEW_SYSTEM_PROMPT = `You are a memory extraction engine. Review the conversation transcript and extract durable memories about the user and the work: stable preferences, facts, conventions, failure lessons, cross-event insights.
Rules:
- Only extract things worth remembering across sessions; skip one-off details.
- Output a pure JSON array (no prose, no code fence). Each element:
  {"kind":"preference|fact|convention|failure|insight","summary":"one-line summary (<=200 chars)","content":"full sentence(s)","confidence":0..1}
- If nothing is worth extracting, output [] .
- Never include secrets, API keys, tokens or credentials in any field.`;

/** 候选条目 schema（TypeBox——失败条目丢弃不重试，提取尽力而为） */
const CandidateSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('preference'),
    Type.Literal('fact'),
    Type.Literal('convention'),
    Type.Literal('failure'),
    Type.Literal('insight'),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 200 }),
  content: Type.String({ minLength: 1, maxLength: 4000 }),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

/** consolidation 建议 schema（merges 组 + decays 表；模型尽力而为的判据面） */
const ConsolidationSchema = Type.Object({
  merges: Type.Array(
    Type.Object({
      keepId: Type.String({ minLength: 1 }),
      dropIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
    }),
    { maxItems: 50 },
  ),
  decays: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      factor: Type.Number({ minimum: 0.1, maximum: 1 }),
    }),
    { maxItems: 100 },
  ),
});

/** consolidation prompt（候选清单交模型判同义/降权） */
const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidation engine. Given candidate memory entries (aged or overflow), propose:
1. merges: groups of entries saying the same thing — pick the best one as keepId, list redundant ones as dropIds;
2. decays: entries that look stale/no longer relevant (but not mergeable) — suggest a confidence factor 0.1..1 to multiply.
Rules: never propose deleting entries (soft state only via merges); output pure JSON (no prose): {"merges":[{"keepId":"...","dropIds":["..."]}],"decays":[{"id":"...","factor":0.6}]}; use [] / omit groups you are not confident about.`;

/* ---------------- 模型文本 → JSON 尽力而为解析 ---------------- */

/**
 * 从模型输出文本提取 JSON（尽力而为）：直取 JSON → 剥代码围栏 → 抓首个平衡的
 * 数组/对象段。提取是尽力而为——任何失败返回 undefined 由调用方丢弃本轮。
 */
function extractJson(text: string): unknown {
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  // 剥 ```json ... ``` 围栏（模型常见包装）
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }
  // 抓首个平衡的 [..] 或 {..} 段（容错模型前后缀废话）
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === open) depth += 1;
      else if (text[i] === close) {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParse(text.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return undefined;
}

/** JSON.parse 包装（undefined 语义 = 解析失败） */
function tryParse(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/* ---------------- 周期路单轮（可独立调用的编排件） ---------------- */

/**
 * 跑一轮 review：转录交模型 → 候选逐条过写前扫描 + 合并管线。
 * 不订阅不计数——计数/触发归 attachPeriodicReview（本函数纯编排，测试面友好）。
 */
export async function runReviewOnce(
  deps: { store: MemoryStore; llm: ReviewLlmFace; ownerKey?: string; logger: Context['logger'] },
  transcript: readonly Message[],
): Promise<ReviewReport> {
  // 计数器内部可变、出口一次性冻结成报告（readonly 报告面不允许逐字段 +=）
  const counts = { candidates: 0, inserted: 0, merged: 0, superseded: 0, rejected: 0, blocked: 0 };
  const visible = transcript.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (visible.length === 0) return { ...counts, skipped: 'empty' };
  if (!deps.llm.canAfford('background')) return { ...counts, skipped: 'budget' };

  const { message } = await deps.llm.complete({
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    messages: visible,
    priority: 'background',
    timeoutMs: 60_000,
  });
  const text = textOfContent(message.content);
  const parsed = extractJson(text);
  const raw = Array.isArray(parsed) ? parsed : undefined;
  if (!raw) {
    deps.logger.warn('周期 review 产物不是 JSON 数组——本轮丢弃（尽力而为，不重试）');
    return { ...counts };
  }

  for (const item of raw) {
    // 逐条校验（TypeBox）：失败条目丢弃不重试（§4 纪律）
    if (!Value.Check(CandidateSchema, item)) continue;
    counts.candidates += 1;
    const result = guardedAddMemory(deps.store, {
      ownerKey: deps.ownerKey ?? 'global',
      kind: item.kind,
      summary: item.summary,
      content: item.content,
      confidence: item.confidence,
    });
    if (result.status === 'blocked') counts.blocked += 1;
    else if (result.outcome.outcome === 'inserted') counts.inserted += 1;
    else if (result.outcome.outcome === 'merged') counts.merged += 1;
    else if (result.outcome.outcome === 'superseded') counts.superseded += 1;
    else counts.rejected += 1;
  }
  return { ...counts };
}

/* ---------------- consolidation 单轮 ---------------- */

/**
 * 收集 consolidation 候选（纯查询）：老化（updated_at 距今 > staleDays）∪
 * 容量溢出（active > maxPerOwner 的低分盈余，分数 = utilityScore——§5 效用
 * 维度叠加 usage：高用条目优先保活、零用条目优先整理；与简报排序同一把尺）。
 */
export function collectConsolidationCandidates(
  store: MemoryStore,
  ownerKey: string,
  opts: { staleDays?: number; maxActivePerOwner?: number; now?: () => number } = {},
): { stale: ReturnType<MemoryStore['list']>; overflow: ReturnType<MemoryStore['list']> } {
  const staleDays = opts.staleDays ?? 90;
  const maxActive = opts.maxActivePerOwner ?? 500;
  const now = opts.now?.() ?? Date.now();
  const cutoff = now - staleDays * 24 * 60 * 60 * 1000;
  const active = store.list([ownerKey]);
  const stale = active.filter((r) => r.updatedAt < cutoff);
  // 容量溢出：超出上限的低分盈余（升序 = 最弱先整理；utilityScore 含引用因子
  // ——被反复引用的条目即便低置信也靠 usage 抬分保活）；未溢出为空
  const surplus = Math.max(0, active.length - maxActive);
  const overflow = surplus > 0 ? [...active].sort((a, b) => utilityScore(a) - utilityScore(b)).slice(0, surplus) : [];
  return { stale, overflow };
}

/**
 * 跑一轮 consolidation：候选交模型建议合并/降权 → 应用走既有路径。
 * 应用语义：合并组 = 以 keep 条原文为 canonical 经 addMemory（exact 合并自增证据）
 * + drop 条 forget('llm:<keepId>')；降权 = decayConfidence（不动 updated_at）。
 * 只处理模型返回且 schema 通过的建议；建议里不存在的 id 忽略（尽力而为）。
 */
export async function runConsolidationOnce(
  deps: { store: MemoryStore; llm: ReviewLlmFace; ownerKey?: string; logger: Context['logger'] },
  opts: { staleDays?: number; maxActivePerOwner?: number; now?: () => number } = {},
): Promise<ConsolidationReport> {
  const ownerKey = deps.ownerKey ?? 'global';
  const counts = { mergedGroups: 0, decayed: 0 };
  const { stale, overflow } = collectConsolidationCandidates(deps.store, ownerKey, opts);
  // 候选去重合并（同 id 可能既老化又溢出）
  const seen = new Set<string>();
  const candidates = [...stale, ...overflow].filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  if (candidates.length === 0) return { candidates: 0, ...counts, skipped: 'empty' };
  if (!deps.llm.canAfford('background')) return { candidates: candidates.length, ...counts, skipped: 'budget' };

  // 候选清单进 prompt（id/kind/summary/分数——不进全文，控 token；引用计数
  // 一并披露——模型判断「该不该整理」时被反复引用的条目应倾向保活）
  const listing = candidates
    .map(
      (r) =>
        `- id=${r.id} [${r.kind}] ${r.summary}（置信 ${r.confidence.toFixed(2)}，证据 ${r.evidenceCount}，引用 ${r.usageCount}，更新于 ${new Date(r.updatedAt).toISOString().slice(0, 10)}）`,
    )
    .join('\n');
  const { message } = await deps.llm.complete({
    systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Candidate memory entries:\n${listing}\n\nPropose merges/decays as JSON.`,
        timestamp: 0,
      },
    ],
    priority: 'background',
    timeoutMs: 60_000,
  });
  const parsed = extractJson(textOfContent(message.content));
  if (parsed === undefined || typeof parsed !== 'object' || !Value.Check(ConsolidationSchema, parsed)) {
    deps.logger.warn('consolidation 产物不合法——本轮丢弃（尽力而为，不重试）');
    return { candidates: candidates.length, ...counts };
  }
  const byId = new Map(candidates.map((r) => [r.id, r]));

  for (const group of parsed.merges) {
    const keep = byId.get(group.keepId);
    if (!keep) continue; // 建议 id 不在候选集——忽略（模型幻觉护栏）
    const drops = group.dropIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined && r.id !== keep.id);
    if (drops.length === 0) continue;
    // canonical = keep 条原文重走合并管线（exact 自合并：证据 +1、refs 保序），
    // 随后 drop 条按 'llm:<keepId>' 软删——schema 的 superseded_by='llm:<id>' 值即此来源
    const result = guardedAddMemory(deps.store, {
      ownerKey,
      kind: keep.kind,
      summary: keep.summary,
      content: keep.content,
      confidence: keep.confidence,
      sourceRefs: keep.sourceRefs,
    });
    if (result.status === 'ok') {
      for (const drop of drops) deps.store.forget(drop.id, `llm:${keep.id}`);
      counts.mergedGroups += 1;
    }
  }
  for (const decay of parsed.decays) {
    if (!byId.has(decay.id)) continue;
    if (deps.store.decayConfidence(decay.id, decay.factor)) counts.decayed += 1;
  }
  return { candidates: candidates.length, ...counts };
}

/* ---------------- 事件订阅接线（计数触发） ---------------- */

/** surface 文本提取（user/message 与 assistant/message 共用：块数组取 text 拼接） */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as { type?: unknown; text?: unknown };
        return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
      })
      .filter((t) => t !== '')
      .join('\n');
  }
  return '';
}

/** 事件 content → 纯文本（与 extract 路同语义：string 或 text 块数组拼接） */
function textOfData(data: unknown): string {
  return textOfContent((data as { content?: unknown } | undefined)?.content);
}

/** surface 事件 → 标准消息（类型诚实构造，无 as 逃逸——补全面直通 pi-ai） */
function eventToMessage(type: 'user/message' | 'assistant/message', text: string): Message {
  if (type === 'user/message') {
    const user: UserMessage = { role: 'user', content: text, timestamp: 0 };
    return user;
  }
  const assistant: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, // 合成占位（转录重放非计费面）
    stopReason: 'stop',
    timestamp: 0,
  };
  return assistant;
}

/** attachPeriodicReview 返回句柄：dispose 退订 + idle 等待在飞轮结束（测试/关停面） */
export interface ReviewHandle {
  /** 退订 session/event 并停触发（在飞轮不中断——尽力而为自然收尾） */
  dispose(): void;
  /** 在飞的 review/consolidation 全部收尾（无在飞立即返回——测试与优雅关停用） */
  idle(): Promise<void>;
}

/**
 * 接线周期路：订阅 session/event——user/assistant 消息进滚动转录缓冲，
 * turn/end 与 tool/call 计数达阈值（先到先触发）发起一轮
 * 「review → consolidation 检查」后台任务。fire-and-forget：异常止步日志。
 * 同时至多一轮在飞（inFlight 防抖——高频会话不堆后台任务）。
 */
export function attachPeriodicReview(ctx: Context, opts: PeriodicReviewOptions): ReviewHandle {
  const turnThreshold = opts.turnThreshold ?? 10;
  const toolCallThreshold = opts.toolCallThreshold ?? 15;
  const windowMessages = opts.windowMessages ?? 40;
  const ownerKey = opts.ownerKey ?? 'global';

  /** 滚动转录缓冲（最近 windowMessages 条 surface 消息——per-process 插件态） */
  const buffer: Message[] = [];
  let turns = 0;
  let toolCalls = 0;
  let inFlight: Promise<void> | undefined;
  let disposed = false;

  const deps = { store: opts.store, llm: opts.llm, ownerKey, logger: ctx.logger };
  const consolidationOpts = {
    ...(opts.staleDays !== undefined ? { staleDays: opts.staleDays } : {}),
    ...(opts.maxActivePerOwner !== undefined ? { maxActivePerOwner: opts.maxActivePerOwner } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };

  /** 触发一轮（防抖 + 尽力而为收尾；预算不足在内部跳过） */
  const fire = (): void => {
    if (disposed || inFlight) return; // 阈值达而本轮不清零——下个事件再触发
    turns = 0;
    toolCalls = 0;
    inFlight = (async () => {
      try {
        const transcript = buffer.slice(-windowMessages);
        const review = await runReviewOnce(deps, transcript);
        ctx.logger.debug('周期 review 收尾', { ...review });
        const consolidation = await runConsolidationOnce(deps, consolidationOpts);
        if (consolidation.candidates > 0 || consolidation.skipped) {
          ctx.logger.debug('consolidation 收尾', { ...consolidation });
        }
      } catch (err) {
        // 尽力而为：LLM_BUDGET_EXCEEDED（检查与调用间竞态）与其他失败一并跳过本轮
        ctx.logger.debug('周期路本轮跳过', { error: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight = undefined;
      }
    })();
  };

  const off = ctx.on('session/event', (payload: unknown) => {
    try {
      const event = (payload as { event?: { type?: unknown; data?: unknown } })?.event;
      if (!event || typeof event.type !== 'string') return;
      switch (event.type) {
        case 'user/message':
        case 'assistant/message': {
          const text = textOfData(event.data);
          if (text !== '') buffer.push(eventToMessage(event.type, text));
          if (buffer.length > windowMessages * 2) buffer.splice(0, buffer.length - windowMessages * 2);
          break;
        }
        case 'turn/end':
          turns += 1;
          if (turns >= turnThreshold) fire();
          break;
        case 'tool/call':
          toolCalls += 1;
          if (toolCalls >= toolCallThreshold) fire();
          break;
        default:
          break;
      }
    } catch (err) {
      ctx.logger.error('周期路事件处理失败（fire-and-forget）', {
        error: err instanceof Error ? err.stack : String(err),
      });
    }
  });

  return {
    dispose() {
      disposed = true;
      off();
    },
    idle() {
      return inFlight ?? Promise.resolve();
    },
  };
}
