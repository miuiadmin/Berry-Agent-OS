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
 * ctx.agent——阈值触发路停用（warn；第四十五批配套②——「停用」语义收窄为
 * 「阈值触发停用」，溢出压缩面照提供：其消费面是 sessions+llm 硬注入与
 * agent face 无关）；'sessions'/'llm' 恒供（装配层无条件 provide）走硬
 * inject。溢出压缩面 = 恒 provide('compaction') 单方法 compactForOverflow
 * （第四十五批溢出兜底步 2——驱动 compact-and-retry-once 消费；与阈值路
 * 共享 per-session 在飞互斥，配套⑤——两路五步串行化，规划基于锁内新投影）。
 */

import { Type } from '../contracts/typebox.js';
import type { SessionEvent } from '../contracts/events.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
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
  type SegmentPlan,
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
  /**
   * 投影 JSON 字符总长（判据底账——遗漏大扫 20260901 O-6）：恒等于
   * JSON.stringify(deriveMessages()).length，但增量维护不随读频 stringify。
   */
  projectedJsonChars(): number;
  /** 当前调用链会话 id（ALS 路由——溢出压缩互斥键与语境断言用；脱链 undefined） */
  currentSessionId(): string | undefined;
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

/**
 * 分账 Map 空闲保留帽（遗漏大扫 20260902-b #8，第六十四批——会话与存储篇
 * M-3 条款勘正）：daemon 常驻下 webui 每新会话各建档永不回收 = 无界累积
 * （jobs 终态帽 L-4 同族）。超帽按**建档序**（Map 迭代序 = 插入序）逐出最旧
 * **空闲**条——两类结构性免逐：
 * - 在飞（inFlight 持键——互斥压缩进行中，条目正被本次 run 消费）；
 * - 持播种义务（pendingReseed 置位——压缩已落账播种未成，逐出 = 压缩对
 *   活时间线永不生效，这是唯一有正确性后果的状态位）。
 * 被逐条目的防抖/计数态重触时重置重来（启发式判据，丢了至多多压一轮）；
 * 冷却/迭代链是 durable 派生面，本就不在 Map 内。
 */
export const STATES_RETENTION_CAP = 256;

/**
 * 超帽逐出（纯函数——导出面供回归锁直测语义；states 迭代序即建档序）。
 * @param states per-session 分账 Map（就地删除）
 * @param inFlight 在飞互斥键集（持键条目免逐）
 * @param cap 保留帽（≤0 时清空全部空闲条——不用于产品配置，测试便利）
 */
export function evictIdleStates(
  states: Map<string, { pendingReseed: boolean }>,
  inFlight: { has(key: string): boolean },
  cap: number,
): void {
  for (const key of states.keys()) {
    if (states.size <= cap) break; // 已收帽——停（新建档在迭代序末位永不被自己触发）
    const entry = states.get(key);
    if (entry === undefined) continue; // 迭代中途已被删（并发安全形态，防御位）
    if (inFlight.has(key) || entry.pendingReseed) continue; // 两类免逐（见帽常量 JSDoc）
    states.delete(key);
  }
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
export function createCompactionApp(): BuiltinAppModule {
  const module: BuiltinAppModule = {
    name: 'compaction',
    inject: ['sessions', 'llm'] as const,
    optionalInject: ['agent'] as const,
    config: compactionConfig,

    apply: async (ctx: AppContext) => {
      // sessions/llm 恒供（装配层无条件 provide）走硬 inject——溢出压缩面
      // （compactForOverflow）的消费面同是这两键，与 agent face 无关（第四十五
      // 批配套②：agent 缺席只停阈值触发路，压缩面照提供）
      const sessions = ctx.get<SessionsCompactionFace>('sessions');
      const llm = ctx.get<LlmCompactionFace>('llm');
      const agent = ctx.tryGet<AgentCompactionFace>('agent');
      if (!agent) {
        // chat 件未装载（诊断装配 / persist:false）——阈值触发路停用（配套②
        // 「停用」语义收窄：溢出压缩面照提供——无 chat 件 = 无调用方，面闲置无害）
        ctx.logger.warn('无 ctx.agent 服务（chat 件未装载）——compaction 阈值触发路停用（溢出压缩面照提供）');
      }

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

      /** per-session 分账（冷读 M-3）——带空闲保留帽（见 STATES_RETENTION_CAP：新建档点即逐出执法点，不另设周期面） */
      const states = new Map<string, SessionCompactionState>();
      const stateOf = (sessionId: string): SessionCompactionState => {
        let s = states.get(sessionId);
        if (s === undefined) {
          s = newState();
          states.set(sessionId, s);
          // 建档是 Map 唯一增长点——就地执法（引用下方 inFlight 闭包变量，
          // 调用时机恒在 apply 体执行完毕之后，无 TDZ 风险）
          evictIdleStates(states, inFlight, STATES_RETENTION_CAP);
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

      /** 最近压缩终点 seq（配套⑤：判「互斥等待期间是否有新压缩落账」——无事件 = -1） */
      const lastEndSeq = (): number => {
        const ends = sessions.eventsOfType('compaction/end');
        const last = ends.at(-1);
        return last === undefined ? -1 : last.seq;
      };

      /**
       * per-session 在飞压缩互斥（第四十五批配套⑤）：阈值路 attempt 与溢出
       * compactForOverflow 全程共享——两路各基于当时投影快照规划可出重叠区间，
       * 交织落账 = 同区间双遮蔽 + 双摘要载体（投影不减反增）或溯源校验拒写，
       * 串行化后结构性不存在。前序成败不阻断后继（失败已各自落账）。
       */
      const inFlight = new Map<string, Promise<unknown>>();
      const runSerialized = <T>(sessionId: string, body: () => Promise<T>): Promise<T> => {
        const prev = inFlight.get(sessionId) ?? Promise.resolve();
        // 注册位在本调用链内（ALS 随 promise 延续穿透——body 仍见信封会话语境）
        const result = prev.then(body, body);
        // 尾链吞异常只作 Map 存值（真异常已由 result 路各自落账，不重复处理）
        const tail = result.catch(() => undefined);
        inFlight.set(sessionId, tail);
        void tail.then(() => {
          if (inFlight.get(sessionId) === tail) inFlight.delete(sessionId); // 结算清位防 Map 无界
        });
        return result;
      };

      /**
       * durable 五步核心（两触发路共享：start→complete 摘要→summary→载体遮蔽→end）。
       * 阈值路与溢出路的差异全在壳：start 载荷（判据三件落不落）与前后记账。
       * @param opts.reason 触发路归因（start 载荷穿透——配套①：日志读侧可辨路）
       * @param opts.plan 遮蔽区间规划（planSegment 产物——必须基于锁内新投影）
       * @param opts.projected 规划时的投影快照（区间过滤与提示词构建同一份账）
       * @param opts.basis 判据三件（阈值路落 start 载荷；溢出不落——判据是溢出错误本身非估算）
       */
      const fiveStep = async (opts: {
        reason: 'threshold' | 'overflow';
        plan: SegmentPlan;
        projected: readonly ProjectedMessage[];
        basis?: { basis: string; estTokens: number; window: number };
      }): Promise<void> => {
        sessions.appendEvent('compaction/start', {
          reason: opts.reason,
          willRetry: true,
          ...(opts.basis === undefined
            ? {}
            : { basis: opts.basis.basis, estTokens: opts.basis.estTokens, window: opts.basis.window }),
        });
        const occluded = opts.projected.filter((m) => m.seq >= opts.plan.start && m.seq <= opts.plan.end);
        const prompt = buildSummaryPrompt(
          occluded,
          previousSummary(),
          summaryBudgetFor(opts.plan.occludedChars, {
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
        for (let seq = opts.plan.start; seq <= opts.plan.end; seq++) seqs.push(seq);
        if (summaryEvent !== undefined) seqs.push(summaryEvent.seq);
        await sessions.appendWithSurfaceOp({
          type: 'user/message',
          data: { content: `${SUMMARY_PREFIX} ${summaryText}`, source: 'app:compaction' },
          surfaceOp: { op: 'replace', start: opts.plan.start, end: opts.plan.end },
          sourceEventSeqs: seqs,
        });
        sessions.appendEvent('compaction/end', {
          occludedMessages: opts.plan.occludedMessages,
          occludedChars: opts.plan.occludedChars,
        });
      };

      /**
       * mid-run 溢出压缩（第四十五批溢出兜底步 2——驱动 compact-and-retry-once
       * 消费的显式调用面）。与阈值触发路差异三件：去防抖/抑制/冷却（溢出是硬
       * 信号非启发式判阈——有界性由调用方 retry-once 旗标承担）、不播种（mid-run
       * 公共 reseedTimeline 必拒 running 守卫——播种归调用方私有重播种路径；防抖
       * 账面不动——溢出压缩的节省偶入阈值路防抖判据属无害偏差）、start 不落判据
       * 三件（判据是溢出错误本身非估算）。必须在信封会话调用链语境内调用
       * （配套③——sessions 面 ALS 路由；脱链 = 防御位 'failed' 响亮日志）。
       */
      const compactForOverflow = (): Promise<'compacted' | 'nothing' | 'failed'> => {
        const sessionId = sessions.currentSessionId();
        if (sessionId === undefined) {
          // 防御位：官方接线（驱动调用点）恒在信封会话链内——脱链只可能来自
          // 未来的第三方直取服务面调用，响亮失败不猜会话
          ctx.logger.error('compactForOverflow 脱链调用（无信封会话语境）——配套③ 禁做形态，防御位返回 failed');
          return Promise.resolve('failed');
        }
        // 等待前快照：判「互斥等待期间是否有新压缩终点落账」（配套⑤——已有
        // 缩量不重复压，缩量归因不问路：恢复目标是「缩了可续入」）
        const endSeqAtEntry = lastEndSeq();
        return runSerialized(sessionId, async () => {
          if (lastEndSeq() !== endSeqAtEntry) return 'compacted' as const;
          const projected = sessions.deriveMessages();
          const plan = planSegment(projected, cfg.tailKeep);
          if (plan === null) return 'nothing' as const; // 区间不足（tailKeep 保护）——诚实无操作
          try {
            await fiveStep({ reason: 'overflow', plan, projected });
          } catch (err) {
            // 摘要调用/载体写抛错：落 failed（reason 穿透——配套①）后转诚实失败面
            try {
              sessions.appendEvent('compaction/failed', { reason: 'overflow', error: String(err) });
            } catch (inner) {
              ctx.logger.error('compaction failed 事件落账失败', { error: String(inner) });
            }
            ctx.logger.error('溢出压缩失败（compactForOverflow）', { sessionId, error: String(err) });
            return 'failed' as const;
          }
          ctx.logger.info('溢出压缩完成', {
            sessionId,
            occludedMessages: plan.occludedMessages,
            occludedChars: plan.occludedChars,
          });
          return 'compacted' as const;
        });
      };

      /**
       * 在飞压缩汇流快照（遗漏大扫 20260902-c #5 规范先行——[会话与存储]篇
       * 溢出兜底条服务面扩面）：per-session 在飞互斥位（配套⑤ Map）values 的
       * Promise.all。唯一消费方 = tick 编排收口（submitOnce resolve 后 shutdown
       * 前 await——tick 会话按 job 定向跨跳累积，压缩链被进程收口掐死即上下文
       * 无界增长）。性质：快照语义（快照后新起压缩不担待——消费方收口序已保证
       * 结算波内注册）；tail 恒不拒（runSerialized 尾链吞异常只作 Map 存值），
       * all 直返无 rejection 面；无在飞 = 已结算 Promise 直返。
       */
      const drain = (): Promise<void> => Promise.all([...inFlight.values()]).then(() => undefined);

      // 溢出压缩面（第四十五批配套②）：恒提供——agent 缺席同；消费方（chat
      // 驱动）经根作用域调用点惰性 tryGet 解析（chat 首行先于本第九行装载，
      // 装配期求值恒空——时序由调用点解决）
      ctx.provide('compaction', { compactForOverflow, drain });

      // 阈值触发路：agent 缺席即无此路（面已照提供，下方只接 run 结算订阅）
      if (!agent) return;

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

        // ② 观测采集 + 判阈（字符账走 sessions 窄面增量计数——O-6，不再全量 stringify）
        const verdict = evaluateThreshold({
          lastLoopUsageInput: lastLoopUsageInput(),
          contextWindow: currentContextWindow(),
          projectedChars: sessions.projectedJsonChars(),
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

        // ④ 冷却检查（durable derive——只读不落账，锁外先行即可）
        if (inCooldown(lastFailedAt(), Date.now(), cfg.cooldownMs)) return;

        // ④'⑤ 区间规划 + durable 五步（per-session 互斥内——配套⑤：规划必须
        // 基于锁内新投影——锁外快照在等待期间可能已被他路压缩改写，规划-落账
        // 同账零迟滞窗；判据三件随阈值路落 start 载荷）
        await runSerialized(sessionId, async () => {
          const projected = sessions.deriveMessages();
          const plan = planSegment(projected, cfg.tailKeep);
          if (plan === null) return; // 最小条数保护（planSegment 内）
          await fiveStep({
            reason: 'threshold',
            plan,
            projected,
            basis: { basis: verdict.basis, estTokens: verdict.estTokens, window: verdict.effectiveWindow },
          });
          ctx.logger.info('compaction 完成', {
            sessionId,
            occludedMessages: plan.occludedMessages,
            occludedChars: plan.occludedChars,
          });
        });

        // ⑥ 闲时重播种（running 被拒 → pendingReseed，下次结算先补——一轮迟滞接受面）
        state.lastBeforeTokens = verdict.estTokens;
        if (!agent.reseedTimeline(sessionId)) {
          state.pendingReseed = true;
          ctx.logger.warn('compaction 播种推迟（run 进行中——下次结算补播）', { sessionId });
        }
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
