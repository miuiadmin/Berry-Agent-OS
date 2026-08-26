/**
 * L3 compaction — 官方压缩件（会话篇 §2 增补七条，2026-08-26 纵切落码；
 * 骨架篇 §3.2 挂点定稿 / 内核边界篇席 20 / 契约篇 §5.1 默认层第九行）。
 *
 * 长会话上下文治理，durable 五步路（surfaceOp 遮蔽——「模型可见即落日志」
 * 不变式裁决：LLM 摘要非纯函数必须落 durable；探针轮十一的 context_transform
 * 挂法只是机制沙盘，产品版不采）：
 *
 *   compaction/start（锁+归因）→ ctx.llm.complete 摘要（五段模板+迭代链）
 *   → compaction/summary（审计：model/usage/callId——可从日志重建）
 *   → user/message 载体携 surfaceOp 遮蔽中段（appendWithSurfaceOp 宿主代写）
 *   → compaction/end。
 *
 * 两段式触发（冷读 B-1/M-1 回写）：onRunSettled（run 结算边界——turn/end
 * 深度归零的现成驱动级对物，零自建计数）判阈启动五步；压缩完成后闲时
 * reseedTimeline 重播种（resetTimeline 原位原语——活数组时间线非投影自动
 * 同步）。running 时播种拒绝 → pendingReseed 记账，下次结算再试（一轮
 * 迟滞 = 接受面）。
 *
 * 零新表族：压缩状态全在会话事件日志（进行态=start/end 事件、冷却=failed
 * 事件、迭代链=summary 事件）——重启从日志重 derive，无迁移无件自有表。
 * 多会话分账（冷读 M-3）：观测/防抖/pendingReseed 按信封 sessionId 分账
 * （件内 Map）；压缩全程在信封会话调用链语境内跑（onRunSettled 派发点在
 * 驱动链内，ALS 随 async 延续穿透——complete await 后路由仍指本会话）。
 *
 * 'agent' 走 optionalInject（goal 件先例）：chat 件未装载 / 诊断装配时无
 * ctx.agent——无触发面无播种面，件降级停用（warn，行可见装载成功语义诚实）；
 * 'sessions'/'llm' 恒供（装配层无条件 provide）走硬 inject。
 */

import { Type } from '../contracts/typebox.js';
import type { SessionEvent } from '../contracts/events.js';
import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import type { ProjectedMessage } from '../session/derive.js';
// 词汇宿主面注册的模块副作用导入（官方件纪律，会话篇 §2.1：durable 词汇
// 走宿主面模块级注册而非 ctx.registerSessionEventType——旧日志可读性不随
// 组合树行装载漂移；件可禁用，曾压缩过的会话日志必须永远可读）
import './events.js';
import {
  SUMMARY_PREFIX,
  buildSummaryPrompt,
  evaluateDebounce,
  evaluateThreshold,
  inCooldown,
  planSegment,
  summaryBudgetFor,
} from './policy.js';

/* ---------------------------------------------------------------------------------- */
/* 服务最小面（结构类型窄化——compaction 模块不 import chat/app/llm 实现，拓扑边    */
/* 不越界；宿主 provide 的 'agent'/'sessions'/'llm' 服务结构性满足以下接口）。       */
/* ---------------------------------------------------------------------------------- */

/** run 结算载荷（chat 件 RunSettled 的窄化——归属 sessionId 是分账键） */
interface RunSettledLike {
  readonly sessionId: string;
}

/** ctx.agent 窄面（本件消费：run 结算订阅 + 闲时重播种） */
interface AgentCompactionFace {
  onRunSettled(cb: (settled: RunSettledLike) => void): () => void;
  /** 闲时重播种（run 进行中返回 false——pendingReseed 记账重试） */
  reseedTimeline(sessionId: string): boolean;
}

/** 遮蔽载体（appendWithSurfaceOp 的受理形状——仅 user/message 型+必带遮蔽） */
interface SurfaceCarrier {
  readonly type: 'user/message';
  readonly data: { readonly content: unknown; readonly source: string };
  readonly surfaceOp: { readonly op: 'replace'; readonly start: number; readonly end: number };
  readonly sourceEventSeqs: readonly number[];
}

/** ctx.sessions 窄面（本件消费：事件读写 + 投影读 + 遮蔽写） */
interface SessionsCompactionFace {
  appendEvent(type: string, data: unknown): SessionEvent | undefined;
  appendWithSurfaceOp(carrier: SurfaceCarrier): Promise<SessionEvent | undefined>;
  eventsOfType(type: string): SessionEvent[];
  deriveMessages(): ProjectedMessage[];
}

/** ctx.llm 窄面（本件消费：受托管单发摘要 + 窗口元数据） */
interface LlmCompactionFace {
  complete(req: {
    messages: Array<{ role: 'user'; content: string }>;
    systemPrompt?: string;
  }): Promise<{ message: { content: unknown; model?: string }; usage: { input: number; output: number } }>;
  getModel(id: string): { contextWindow: number } | undefined;
}

/** 件配置面（config schema——会话篇 §2 增补 4 缺省拍板值的用户可调面） */
export const compactionConfig = Type.Object({
  /** 触发阈值比例（末条主 loop usage.input ≥ 窗口 × 此值即触发） */
  thresholdRatio: Type.Optional(Type.Number({ default: 0.5, minimum: 0.1, maximum: 0.95 })),
  /** tail 保留条数（最近 N 条消息不遮） */
  tailKeep: Type.Optional(Type.Number({ default: 6, minimum: 1, maximum: 100 })),
  /** 摘要失败冷却（毫秒——冷却态从 compaction/failed 事件日志 derive） */
  cooldownMs: Type.Optional(Type.Number({ default: 600_000, minimum: 0 })),
  /** 摘要预算：被压缩内容 token 量 × 此值（钳制在 [summaryMin, summaryMax]） */
  summaryRatio: Type.Optional(Type.Number({ default: 0.2, minimum: 0.05, maximum: 0.5 })),
  /** 摘要预算下限（tokens） */
  summaryMin: Type.Optional(Type.Number({ default: 2000, minimum: 100 })),
  /** 摘要预算上限（tokens） */
  summaryMax: Type.Optional(Type.Number({ default: 12000, minimum: 1000 })),
  /** 窗口未知时的兜底假设窗口（tokens——粗估判据用） */
  fallbackWindowTokens: Type.Optional(Type.Number({ default: 200_000, minimum: 10_000 })),
});

/** 已解析配置（缺省值填充后的形状——件内统一经此读） */
interface ResolvedConfig {
  readonly thresholdRatio: number;
  readonly tailKeep: number;
  readonly cooldownMs: number;
  readonly summaryRatio: number;
  readonly summaryMin: number;
  readonly summaryMax: number;
  readonly fallbackWindowTokens: number;
}

/** per-session 运行态（冷读 M-3 分账——观测/防抖/播种记账各会话独立） */
interface SessionCompactionState {
  /** 上次压缩前的判据 token 量（播种生效后对照判「节省」——防抖判据） */
  lastBeforeTokens: number | null;
  /** 连续低节省计数（≥2 即 suppress——evaluateDebounce 纯函数计算） */
  lowSavingsCount: number;
  /** suppress 置位时的判据 token 量（新量 > ×1.5 显著新增内容时解除重试） */
  suppressAtTokens: number | null;
  /** 压缩已落账但播种未成（run 进行中推迟——下次结算先补播种再判新触） */
  pendingReseed: boolean;
}

function newState(): SessionCompactionState {
  return { lastBeforeTokens: null, lowSavingsCount: 0, suppressAtTokens: null, pendingReseed: false };
}

/** 从 AssistantMessage content 提取纯文本（摘要结果——text 块拼接） */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '',
      )
      .join('');
  }
  return '';
}

/** llm/usage 事件 data 形状（chat/durable.ts 落点——callId 区分主 loop 笔与 complete 笔） */
interface UsageData {
  readonly callId?: string;
  readonly usage?: { readonly input?: number };
}

/**
 * 构造 compaction 官方件（builtins 注册——deps 零依赖，服务全经 ctx 取）。
 */
export function createCompactionPlugin(): BuiltinPluginModule {
  const module: BuiltinPluginModule = {
    name: 'compaction',
    inject: ['sessions', 'llm'] as const,
    optionalInject: ['agent'] as const,
    config: compactionConfig,

    apply: async (ctx: PluginContext) => {
      const agent = ctx.tryGet<AgentCompactionFace>('agent');
      if (!agent) {
        // chat 件未装载（诊断装配 / persist:false）——无触发面无播种面，降级停用
        ctx.logger.warn('无 ctx.agent 服务（chat 件未装载）——compaction 官方件停用：无 run 结算触发面');
        return;
      }
      const sessions = ctx.get<SessionsCompactionFace>('sessions');
      const llm = ctx.get<LlmCompactionFace>('llm');

      // 四词（compaction/start|summary|end|failed）已经 events.ts 宿主面模块级
      // 注册（导入副作用）——此处不再走 ctx.registerSessionEventType（官方件
      // durable 词汇纪律：旧日志可读性不随件装载漂移，check-events 族 3 同闸）

      const cfgRaw = ctx.config;
      const cfg: ResolvedConfig = {
        thresholdRatio: (cfgRaw.thresholdRatio as number) ?? 0.5,
        tailKeep: (cfgRaw.tailKeep as number) ?? 6,
        cooldownMs: (cfgRaw.cooldownMs as number) ?? 600_000,
        summaryRatio: (cfgRaw.summaryRatio as number) ?? 0.2,
        summaryMin: (cfgRaw.summaryMin as number) ?? 2000,
        summaryMax: (cfgRaw.summaryMax as number) ?? 12000,
        fallbackWindowTokens: (cfgRaw.fallbackWindowTokens as number) ?? 200_000,
      };

      /** per-session 分账（冷读 M-3） */
      const states = new Map<string, SessionCompactionState>();
      const stateOf = (sessionId: string): SessionCompactionState => {
        let s = states.get(sessionId);
        if (s === undefined) {
          s = newState();
          states.set(sessionId, s);
        }
        return s;
      };

      /** 读末条主 loop 用量 input（callId `turn:` 前缀笔——complete 单发计量不入选，冷读 M-2） */
      const lastLoopUsageInput = (): number | null => {
        const usages = sessions.eventsOfType('llm/usage');
        for (let i = usages.length - 1; i >= 0; i--) {
          const data = usages[i]!.data as UsageData;
          if (typeof data.callId === 'string' && data.callId.startsWith('turn:')) {
            return data.usage?.input ?? null;
          }
        }
        return null;
      };

      /** 读当前模型窗口（末条 request/header 的 model → getModel 元数据；未知 undefined） */
      const currentContextWindow = (): number | undefined => {
        const headers = sessions.eventsOfType('request/header');
        const last = headers.at(-1);
        const model = last !== undefined ? (last.data as { model?: string }).model : undefined;
        return model !== undefined ? llm.getModel(model)?.contextWindow : undefined;
      };

      /** 读前次摘要文本（迭代链——durable 天然可查，不持内存态） */
      const previousSummary = (): string | null => {
        const summaries = sessions.eventsOfType('compaction/summary');
        const last = summaries.at(-1);
        return last !== undefined ? ((last.data as { text?: string }).text ?? null) : null;
      };

      /** 读末次失败时间（冷却 derive——冷读 M-4：失败事实在日志，重启不重试持续性故障） */
      const lastFailedAt = (): number | null => {
        const failures = sessions.eventsOfType('compaction/failed');
        return failures.length > 0 ? failures.at(-1)!.time : null;
      };

      /**
       * 一次压缩尝试（onRunSettled 触发——全程在信封会话调用链语境内）。
       * fire-and-forget：异常自catch 落 compaction/failed（失败降级面）。
       */
      const attempt = async (sessionId: string): Promise<void> => {
        const state = stateOf(sessionId);

        // ① 上次压缩收尾（冷读 M-1：防抖判据以播种生效后的 usage 笔为准——
        // 即时播种与推迟播种两路统一在此结账）：
        //   a. 补播种（压缩时 run 在跑被拒 → pendingReseed；仍被拒即整段推迟——
        //      节省判据同样依赖播种生效后的新 usage 笔，一并等）；
        //   b. 判「上次压缩的节省」：<10% 计数，连续两次 suppress（evaluateDebounce
        //      纯函数算）；判完即清 lastBeforeTokens（usage 笔未落时保留待下轮）。
        if (state.pendingReseed) {
          if (!agent.reseedTimeline(sessionId)) return;
          state.pendingReseed = false;
        }
        if (state.lastBeforeTokens !== null) {
          const after = lastLoopUsageInput();
          if (after !== null && after > 0) {
            const verdict = evaluateDebounce({
              beforeInput: state.lastBeforeTokens,
              afterInput: after,
              consecutiveLowSavings: state.lowSavingsCount,
            });
            state.lowSavingsCount = verdict.nextCount;
            if (verdict.suppress) {
              state.suppressAtTokens = state.lastBeforeTokens;
              ctx.logger.warn('compaction 防抖：连续两次节省 <10%，暂停触发（显著新增内容后自动恢复）', {
                sessionId,
              });
            }
            state.lastBeforeTokens = null;
          }
        }

        // ② 观测采集 + 判阈
        const projected = sessions.deriveMessages();
        const verdict = evaluateThreshold({
          lastLoopUsageInput: lastLoopUsageInput(),
          contextWindow: currentContextWindow(),
          projectedChars: JSON.stringify(projected).length,
          thresholdRatio: cfg.thresholdRatio,
          fallbackWindowTokens: cfg.fallbackWindowTokens,
        });
        if (!verdict.fire) return;

        // ③ suppress 检查：连续低节省置位后，判据量涨到置位时 ×1.5（显著新增）才恢复
        if (state.suppressAtTokens !== null) {
          if (verdict.estTokens < state.suppressAtTokens * 1.5) return;
          state.suppressAtTokens = null; // 恢复
          state.lowSavingsCount = 0;
        }

        // ④ 冷却检查（durable derive）+ 区间规划（最小条数保护在 planSegment 内）
        if (inCooldown(lastFailedAt(), Date.now(), cfg.cooldownMs)) return;
        const plan = planSegment(projected, cfg.tailKeep);
        if (plan === null) return;

        // ⑤ durable 五步
        sessions.appendEvent('compaction/start', {
          reason: 'threshold',
          willRetry: true,
          basis: verdict.basis,
          estTokens: verdict.estTokens,
          window: verdict.effectiveWindow,
        });
        const occluded = projected.filter((m) => m.seq >= plan.start && m.seq <= plan.end);
        const prompt = buildSummaryPrompt(
          occluded,
          previousSummary(),
          summaryBudgetFor(plan.occludedChars, {
            ratio: cfg.summaryRatio,
            min: cfg.summaryMin,
            max: cfg.summaryMax,
          }),
        );
        const result = await llm.complete({ messages: [{ role: 'user', content: prompt }] });
        const summaryText = extractText(result.message.content);
        const summaryEvent = sessions.appendEvent('compaction/summary', {
          text: summaryText,
          model: result.message.model,
          usage: { input: result.usage.input, output: result.usage.output },
        });
        // 溯源 = 被遮蔽区间全部 seq + 摘要依据事件 seq（宿主验「依据在列」：区间外至少一笔）
        const seqs: number[] = [];
        for (let seq = plan.start; seq <= plan.end; seq++) seqs.push(seq);
        if (summaryEvent !== undefined) seqs.push(summaryEvent.seq);
        await sessions.appendWithSurfaceOp({
          type: 'user/message',
          data: { content: `${SUMMARY_PREFIX} ${summaryText}`, source: 'plugin:compaction' },
          surfaceOp: { op: 'replace', start: plan.start, end: plan.end },
          sourceEventSeqs: seqs,
        });
        sessions.appendEvent('compaction/end', {
          occludedMessages: plan.occludedMessages,
          occludedChars: plan.occludedChars,
        });

        // ⑥ 闲时重播种（running 被拒 → pendingReseed，下次结算先补——一轮迟滞接受面）
        state.lastBeforeTokens = verdict.estTokens;
        if (!agent.reseedTimeline(sessionId)) {
          state.pendingReseed = true;
        }
        ctx.logger.info('compaction 完成', {
          sessionId,
          occludedMessages: plan.occludedMessages,
          occludedChars: plan.occludedChars,
          reseeded: !state.pendingReseed,
        });
      };

      // 触发接线：run 结算边界（每 run 终结派发一次，载荷带归属 sessionId——
      // 回调同步段在驱动调用链内，async 延续 ALS 穿透保持会话语境）
      ctx.effect(() =>
        agent.onRunSettled((settled) => {
          void attempt(settled.sessionId).catch((err) => {
            // 失败降级面：落 failed 孪生事件（冷却 derive 的数据源）——appendEvent
            // 自身失败（如词汇被回卷）只能 error 日志，不再递归
            try {
              sessions.appendEvent('compaction/failed', {
                reason: 'threshold',
                error: String(err),
              });
            } catch (inner) {
              ctx.logger.error('compaction failed 事件落账失败', { error: String(inner) });
            }
            ctx.logger.error('compaction 尝试失败（冷却后重试）', { sessionId: settled.sessionId, error: String(err) });
          });
        }),
      );
    },
  };

  return module;
}
