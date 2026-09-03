/**
 * L3 goal — 官方件（骨架篇 §6.8 `builtin:goal`，Ring 2 编排域官方件）。
 *
 * 长目标续跑：**没有新循环机器**——持久 goal 状态（goals 表）+ run 结算边界
 * 注入提示词（onRunSettled → ctx.agent.sendUserMessage 三通道路由）+ 预算刹车
 * （session/event 镜像过滤 assistant/message 累计）三个已有原语的组合。
 *
 * S1 键控改造：结算/记账/注入全部按**归属会话**路由（settled.sessionId 直查
 * goals 表、信封 sessionId 直查、sendUserMessage 显式键）——多驱动并存各归各；
 * 退役会话容错 = AGENT_SESSION_INACTIVE 仅此码降 debug（③ 续跑 / ④ 收尾注入
 * 两处同口径——旧会话停摆是 /new 的语义结果非故障）。
 *
 * 装配接线（全部挂 ctx.effect，装载锚 dispose 即 LIFO 回卷）：
 * ① 工具三件（goal_get/goal_set/goal_update）进 ctx.tools；
 * ② 命令 /goal（查状态 / resume / stop / wake 挂钟——刀四）进 ctx.channels
 *    ——激活权与挂钟授权都在人类；
 * ③ 续跑触发（刀三轮身份扩形）：onRunSettled 归因定行（goal 归因直查
 *    goalId、缺席兜底归属会话）→ 停滞判定（stallsDecision——硬停 stopped/
 *    stalls 或停滞指令段）→ 唤醒帽执法（wakeGate 双帽——超帽暂停投递非终态
 *    停）→ 续跑提示注入（attribution {goalId, wakeId, wakePath:'self'} 随
 *    user/message 落 durable——帽投影扫的就是这面归因；backgroundWake 计入
 *    驱动帽 maxConsecutiveWakes=3）；
 * ④ 预算刹车：assistant/message usage 累计 ≥ tokenBudget → 刹停（stopped/budget
 *    + 停因事件 reason='budget'）+ 同步注入收尾提示（忙时 steer——当轮收尾
 *    交代下一步，非硬断）；
 * ⑤ 复验面（刀三 T7-A）：agent_pre_step 瀑布监听——goal 唤醒轮每次进模型步
 *    前查归因行活状态（预算尽/已停/已重绑 → stop:true 就地收场）；
 * ⑥ 轮间沉淀（刀四 T6-A）：onRunSettled 同点触发（goal active 且投影过阈且
 *    水位有新增）→ ctx.llm.complete 单发摘要（objective 锚定）→ goal/summary
 *    durable 事件（事实源）→ surfaceOp 遮蔽已沉淀段 → goals 表缓存列回写 +
 *    usage delta 自报入预算——与 ③ 续跑判定独立（capped 拒发不影响沉淀）。
 *
 * 挂钟（刀四 T7-B）：goals.wake_schedule 列存声明原样串；jobs 表承载（owner
 * = builtin:goal / owner_key = goalId / enabled 生命周期位）；操作面经组合根
 * 通道迟到注入的 scheduler 窄面（register/disable/enable/remove——CR-7 不立
 * ctx.schedule 新服务词汇）；终态三处 + 降级 + resume 的同笔翻转见 suspendWake
 * /resumeWake 两闭包（面缺席静默跳过——投递前查行兜底让路）。
 *
 * 激活态不持久化（§6.7 拍板）：boot 续接（origin=resume）即把 active 行降级
 * needs-resume。触发面 = 装载收口 session_start 补播（二十九批 P1-6，契约篇
 * §2.2 增补 8①——chat 件 ring2 首行 apply 即发射、晚装载的 goal 监听器结构性
 * 收不到，宿主在装载收口对非退役条目补发 `{origin, replay:true}`）：降级条件
 * 三合一 replay===true && armed && origin==='resume'；armed = 模块实例闭包
 * 旗标「本件尚未见过补播」，首见任何 replay:true 即解除（无论 origin、不以
 * 降级为前提——防「boot 新会话 → 运行期续接旧会话 → 人工 /goal resume →
 * /reload」误降级人工授权序列）；/reload 复用同一官方件实例，闭包旗标跨重载
 * 存活、补播照发但不误降级。进程内运行期再开续接会话（活体 origin='resume'、
 * 无 replay 标记）照常降级。
 *
 * 'agent' 走 optionalInject（应用面第一纵切）：chat 件未装载/诊断装配
 * （persist:false）时无 ctx.agent——③续跑触发降级停用（warn），④预算刹车保留
 * 记账与刹停、仅跳过收尾注入；①工具②/goal 命令不受影响（inject 硬依赖只剩
 * tools/channels/ui/sessions/llm——内核恒供）。
 *
 * persist:false 降级：无连接即 warn 空转（同 memory 官方件——诊断面行可见、
 * 装载成功，语义诚实）。
 */

import { AppError, AGENT_SESSION_INACTIVE, describeError } from '../contracts/errors.js';
import type { ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import type { Disposer } from '../context/types.js';
import type { DatabaseConnection } from '../persist/index.js';
// session 边（2026-09-01 复盘 R-1「先看见的边」纪律）：llm/usage callId 判别式
// 同源收口——与 durable.ts 前台腿 / notify.ts 折叠腿两写点共用 event-types 三函数
import { isDelegationUsageCallId } from '../session/event-types.js';
// 预算刀自 session 共享件导入（第九轮 #7②/#20 修死）：摘要三面（事件 text/
// 载体 content/缓存列）同刀同文本 + 沉淀失败 error 腿 2KiB 小帽——走公开面
// '../session/index.js'，禁深挖 budget.ts（契约篇 §6.3#2）
import { budgetString, DURABLE_ERROR_MESSAGE_BUDGET_BYTES } from '../session/index.js';
import type { SessionEvent } from '../contracts/events.js';
import { GoalStore, newWakeId } from './store.js';
import {
  canResumeGoal,
  canStopGoal,
  shouldContinueGoal,
  wakeGate,
  stallsDecision,
  dueDeferredItems,
} from './machine.js';
import type { GoalRecord } from './machine.js';
import type { GoalChannel, GoalSchedulerFace } from './channel.js';
import { renderBudgetExhaustedPrompt, renderContinuationPrompt, escapeXml } from './prompts.js';
import { createGoalTools, snapshotOfItems } from './tools.js';
import type { GoalSessionsFace } from './tools.js';
import {
  shouldSummarize,
  planSummarySegment,
  summaryBudgetFor,
  buildGoalSummaryPrompt,
  GOAL_SUMMARY_PREFIX,
  type GoalSummaryEventPayload,
  type GoalSummaryFailedEventPayload,
  type SummaryMessageView,
} from './summary.js';

/* ---------------------------------------------------------------------------------- */
/* 服务最小面（结构类型窄化——goal 模块不 import app/channels 实现，拓扑边不越界）。       */
/* 宿主 provide 的 'tools'/'channels'/'agent'/'ui' 服务结构性满足以下接口。              */
/* tools 面类型单一来源在 contracts（§1.2 注记④）——channels/agent/ui 窄面保留局部。     */
/* ---------------------------------------------------------------------------------- */

/** 命令注册面（channels 服务最小面——CommandDefinition 的结构子集） */
interface ChannelsCommandFace {
  registerCommand(cmd: {
    readonly name: string;
    readonly description: string;
    readonly source?: string;
    handler(args: string): void | Promise<void>;
  }): Disposer;
}

/** ctx.agent 服务最小面（chat/app.ts AgentServiceFace 的结构子集） */
interface AgentServiceFace {
  sendUserMessage(
    content: string,
    opts?: {
      readonly source?: string;
      readonly backgroundWake?: boolean;
      /** 显式会话键（S1 三级解析序之首——多驱动路由的目标会话 id） */
      readonly session?: string;
      readonly toolFilter?: readonly string[];
      /** 归因键值对（刀三轮身份——goalId/wakeId/wakePath；durable 原样落账） */
      readonly attribution?: Readonly<Record<string, string>>;
    },
  ): void;
  /** 结算载荷含归属 sessionId（S1 增维——订阅全局单份、run 多驱动各自） */
  onRunSettled(
    cb: (settled: { readonly status: 'completed' | 'aborted' | 'failed'; readonly sessionId: string }) => void,
  ): Disposer;
}

/** ui 通知面（命令回执的唯一出口——/goal 系列人读结果） */
interface UiNotifyFace {
  notify(message: string): void;
}

/**
 * ctx.sessions 沉淀宽面（⑥ 轮间沉淀消费：GoalSessionsFace 之上加投影读 +
 * 遮蔽写——结构子集，宿主 sessions 服务天然满足；compaction 同构）。
 */
interface SummarySessionsFace extends GoalSessionsFace {
  // appendEvent 收窄回传（compaction 同款）：宿主面真身 SessionEvent | undefined
  appendEvent(type: string, data: unknown): SessionEvent | undefined;
  /** 会话投影读（判阈/区间规划的数据源——遮蔽段天然排除，投影自描述；窄视 SummaryMessageView——宿主投影天然满足） */
  deriveMessages(): readonly SummaryMessageView[];
  /** 宿主代写遮蔽载体（四执法点在宿主——件只组装 carrier） */
  appendWithSurfaceOp(carrier: {
    readonly type: 'user/message';
    readonly data: { readonly content: unknown; readonly source: string };
    readonly surfaceOp: { readonly op: 'replace'; readonly start: number; readonly end: number };
    readonly sourceEventSeqs: readonly number[];
  }): Promise<SessionEvent | undefined>;
}

/** ctx.llm 窄面（⑥ 沉淀消费：受托管单发摘要 + 窗口元数据——compaction 同构） */
interface GoalLlmFace {
  complete(req: {
    messages: Array<{ role: 'user'; content: string }>;
    readonly priority?: 'foreground' | 'background';
  }): Promise<{ message: { content: unknown }; usage: { input: number; output: number; totalTokens?: number } }>;
  getModel(id: string): { contextWindow: number } | undefined;
}

/** session/event 镜像信封（契约篇 §2.2——载荷 { sessionId, event } 结构子集） */
interface SessionEventEnvelope {
  readonly sessionId?: unknown;
  readonly event?: { readonly type?: unknown; readonly data?: unknown };
}

/** 官方件构造依赖（装配期闭包注入——官方件 = 宿主装配特权） */
export interface GoalAppDeps {
  /** SQLite 连接（goals 表物理载体）；缺省 = persist:false 降级 warn 空转 */
  readonly connection?: DatabaseConnection;
  /** 当前会话 id 活取值（/new 热切换后自动跟新会话走） */
  readonly getSessionId: () => string | undefined;
  /**
   * goal↔chat↔lsp 组合根通道（刀二计划态跨轮条）：goal 段查询注册侧 +
   * todo fold 查询消费侧。缺省不传（诊断装配）= 通道面缺席——chat fold
   * 退化 run-scoped、goal 计划态投影/open 项否决降级跳过（各消费方诚实降级）
   */
  readonly channel?: GoalChannel;
  /**
   * 进程形态（刀三 boot 降级四合一的第四条件，骨架篇 §6.8）：tick 子进程为
   * 挂钟轮到点而 resume 会话——不是「人类重启后的续接」，不降级 active 行
   * （挂钟语义跨 tick 存活）。缺省 undefined ≠ 'tick'（保守降级维持现行为）。
   */
  readonly processKind?: 'tui' | 'run' | 'tick' | 'daemon';
}

/**
 * 构造 goal 官方件（builtins 注册表 `builtin:goal` 行）。
 */
export function createGoalApp(deps: GoalAppDeps): BuiltinAppModule {
  // 「本件尚未见过补播」一次性旗标（二十九批增补 8①）：模块实例级闭包，/reload
  // 复用本实例重跑 apply 不重置——首见任何 replay:true 补播即解除，此后 /reload
  // 补播照发但不参与降级（§6.7「/reload 不误降级」）
  let replayUnseen = true;
  // 首见即解除：返回「本件此前是否未见过补播」并原子标记已见（true 只在第一枚
  // replay:true 补播到达时出现——此后 /reload 补播照发但不参与降级）
  const consumeReplayUnseen = (): boolean => {
    const wasUnseen = replayUnseen;
    replayUnseen = false;
    return wasUnseen;
  };
  return {
    name: 'goal',
    // 'agent' 为 optionalInject：chat 件未装载/诊断装配时缺供不阻激活（降级见上）；
    // 'sessions'/'llm' 恒供（装配层无条件 provide——账本事件读写面 + ⑥ 沉淀单发面）
    inject: ['tools', 'channels', 'ui', 'sessions', 'llm'],
    optionalInject: ['agent'],
    apply: (ctx: AppContext) => applyGoalApp(ctx, deps, consumeReplayUnseen),
  };
}

/**
 * 官方件 apply 本体（接线序：续接降级事件面 → 工具三件 → /goal 命令 → 续跑触发 → 预算刹车）。
 * 异常上抛走加载器统一回卷（APP_APPLY_FAILED）。
 */

/**
 * 续跑轮工具面投影（第二十四批题3a，骨架篇 §6.8 拍板落码；刀四导出——
 * tick 挂钟投递路同一函数单源消费）：
 * read 类工具全保（检索/阅读照常）+ goal_get/goal_update 显式保留（结算件——
 * 续跑轮必须能查态与申报终态，否则 goal 永远无法自然收束；两件自身 effect
 * 均为 write，靠名单显式保留而非 effect 过滤自然命中）；write/exec 类与
 * goal_set（轮中重设无意义）全部收走。模型感知面 = 白名单（不可见即不可调）。
 */
export function wakeToolFilter(defs: readonly ToolDefinition[]): string[] {
  const names = new Set<string>(['goal_get', 'goal_update']);
  for (const def of defs) {
    if (def.effect === 'read') names.add(def.name);
  }
  return [...names];
}

async function applyGoalApp(
  ctx: AppContext,
  deps: GoalAppDeps,
  /** 补播首见消费器（模块实例级闭包旗标——见 createGoalApp 注记） */
  consumeReplayUnseen: () => boolean,
): Promise<void> {
  // persist:false 降级：无物理层即无 goal（状态/记账/续跑全依赖 goals 表）——warn 空转
  if (!deps.connection) {
    ctx.logger.warn('无持久层（persist:false）——goal 官方件空转：工具/命令/续跑/预算刹车均不注册');
    return;
  }
  const store = new GoalStore(deps.connection);

  /* ---- 挂钟生命周期闭包（刀四 CR-6：终态/降级同笔翻转 enabled 位）----
   * 迟到面惰性取（scheduler 行第五行晚于本行装载——命令时点/事件时点取都
   * 已就绪；/reload 重装载 re-apply 重挂）。面缺席（scheduler 未装载）=
   * 静默跳过：行状态已是终态/降级，钟行不翻转不构成正确性缺口——至多 OS
   * 空跳一拍，tick 投递前查行兜底让路。fire-and-forget：翻转失败止步 debug */
  const suspendWake = (goalId: string): void => {
    const face = deps.channel?.schedulerFaceFor();
    if (face === undefined) return;
    void face.disable(goalId).catch((err: unknown) => {
      ctx.logger.debug('goal 挂钟停摆失败（非致命——投递前查行兜底）', { error: describeError(err) });
    });
  };
  const resumeWake = (goalId: string): void => {
    const face = deps.channel?.schedulerFaceFor();
    if (face === undefined) return;
    void face.enable(goalId).catch((err: unknown) => {
      ctx.logger.debug('goal 挂钟复活失败（非致命）', { error: describeError(err) });
    });
  };

  /* ---- ⓪ 续接降级事件面（S1 结构化 + 二十九批增补 8① 补播收敛为唯一路径）----
   * 两路载荷同面：活体（chat 件 open() 恒发 origin——进程内运行期续接/再开）与
   * 补播（宿主装载收口对非退役条目重发 {origin, replay:true}——boot 时 goal
   * 装载晚于 chat 首行 open、活体事件结构性错过，补播兜住；/reload 支线同型）。
   * 降级条件：活体 = origin==='resume' 照常；补播 = 三合一
   * replay===true && armed && origin==='resume'——armed =「本件尚未见过补播」
   * 首见任何 replay:true 即解除（无论 origin、不以降级为前提——防「boot 新会话
   * → 运行期续接旧会话 → 人工 /goal resume → /reload」误降级人工授权序列）。
   * demoteToNeedsResume 自身幂等（仅 active 行生效），双路同发不重复降级 */
  ctx.effect(() =>
    ctx.on('session_start', (payload: unknown) => {
      try {
        const envelope = payload as { sessionId?: unknown; origin?: unknown; replay?: unknown };
        if (typeof envelope?.sessionId !== 'string') return;
        if (envelope.replay === true) {
          // 补播路径：先消费旗标（首见解除不以降级为前提），armed 且 resume 且
          // 非 tick 形态才降级（刀三四合一第四条件——tick 子进程 resume 会话是
          // 挂钟轮到点，不是「人类重启后的续接」，active 行不降级）
          const armed = consumeReplayUnseen();
          if (armed && envelope.origin === 'resume' && deps.processKind !== 'tick') {
            store.demoteToNeedsResume(envelope.sessionId, Date.now());
            // 降级同笔停摆挂钟（CR-6「降级时 disable、resume 恢复」——行留史
            // OS 保留，resume 恢复）
            const demoted = store.getBySession(envelope.sessionId);
            if (demoted !== undefined) suspendWake(demoted.goalId);
          }
          return;
        }
        // 活体路径：进程内运行期再开续接会话——origin=resume 照常降级
        if (envelope.origin === 'resume') {
          store.demoteToNeedsResume(envelope.sessionId, Date.now());
          const demoted = store.getBySession(envelope.sessionId);
          if (demoted !== undefined) suspendWake(demoted.goalId);
        }
      } catch (err) {
        // fire-and-forget 纪律：降级异常止步日志，不上抛进事件派发面
        ctx.logger.error('goal 续接降级失败', { error: describeError(err) });
      }
    }),
  );

  /* ---- ⓪½ 组合根通道注册（刀二计划态跨轮：goal 段查询——chat fold 边界与
   * gates 判段的数据面）：仅 active 行在场时返回（needs-resume/终态行 =
   * 非 goal 段——fold 回落 run-scoped）；随 ctx.effect 锚回卷摘除，/reload
   * 重装载 re-apply 重注册。缺 channel（诊断装配）= 不注册，消费方 miss 即降级 */
  if (deps.channel !== undefined) {
    const channel = deps.channel;
    ctx.effect(() =>
      channel.registerGoalScope((sessionId) => {
        const row = store.getActiveBySession(sessionId);
        return row === undefined
          ? undefined
          : { active: true, activatedSeq: row.activatedSeq, needsWrite: row.needsWrite };
      }),
    );
  }

  /* ---- ① 工具三件（目标内容在模型；sessions 窄面 = 账本事件读写 + 激活锚长度）----
   * todoSnapshot（计划态投影 + open 项否决）经组合根通道从 chat 件 fold 回流；
   * currentWakeId（轮身份归因）刀三接线——本刀 undefined = 面缺席诚实降级 */
  const tools = ctx.get<ToolsService>('tools');
  // 沉淀宽面单取（GoalSessionsFace 的超集——工具面/账本面/沉淀面同一宿主服务）
  const sessions = ctx.get<SummarySessionsFace>('sessions');
  for (const def of createGoalTools({
    store,
    getSessionId: deps.getSessionId,
    sessions,
    // 计划态快照 hook：goalId → 行 → 归属会话 → chat fold 查询 → 计数。
    // undefined（面缺席/无驱动条目）原样透传——工具侧判缺降级
    ...(deps.channel !== undefined
      ? {
          todoSnapshot: (goalId: string) => {
            const row = store.getByGoalId(goalId);
            if (row === undefined || row.sessionId === null) return undefined;
            const items = deps.channel!.todoFoldFor(row.sessionId);
            return items === undefined || items === null ? undefined : snapshotOfItems(items);
          },
        }
      : {}),
    // 当前轮身份（刀三接线）：工具执行段经 runInSessionChain 路由到 run 会话
    //——wake 归因查询取该会话刚结算/在跑 run 的 wakeId（goal 唤醒轮在场，
    // 其余轮/通道缺席 = undefined，账本如实缺席不编造）
    currentWakeId: () => {
      const sessionId = deps.getSessionId();
      if (sessionId === undefined) return undefined;
      return deps.channel?.wakeAttributionFor(sessionId)?.wakeId;
    },
    // 终态同笔停摆挂钟（刀四 CR-6：goal_update 终态形执行段——settleDeclared
    // 后翻转钟行 enabled 位；面缺席/无钟 = 静默 no-op）
    onTerminal: (goalId) => suspendWake(goalId),
  })) {
    ctx.effect(() => tools.register(def));
  }

  /* ---- ② /goal 命令族（激活权在人类：resume 重新授权〔可带 goalId 跨会话领养〕
   * / stop 人工停 / wake 挂钟授权——刀四 T7-B：挂 ↔ off 摘）---- */
  const ui = ctx.get<UiNotifyFace>('ui');
  ctx.effect(() =>
    ctx.get<ChannelsCommandFace>('channels').registerCommand({
      name: 'goal',
      description:
        '长目标管理：/goal 查看状态；/goal resume [goalId] 重新激活（重启降级 needs-resume 时；带 goalId 跨会话领养）；/goal stop 人工停止；/goal wake <schedule>|off 挂钟（once@<ISO>/every@<n>[mhd]/daily@HH:MM——到点后台续跑）',
      source: 'app',
      handler: (args) =>
        handleGoalCommand(args.trim(), {
          store,
          getSessionId: deps.getSessionId,
          ui,
          logLength: () => sessions.logLength(),
          // 挂钟面惰性取（刀四迟到注入）：命令时点 scheduler 行已装载；缺席 =
          // wake 子命令响亮拒绝（schedulerFaceFor miss 判在命令体内）
          schedulerFace: () => deps.channel?.schedulerFaceFor(),
          // 终态/复活同笔翻转闭包（stop/resume 子命令接线）
          suspendWake,
          resumeWake,
        }),
    }),
  );

  /* ---- ③ 续跑触发：run 结算边界（completed 且 active 且预算未尽才续）----
   * ctx.agent 走 optionalInject：chat 件未装载/诊断装配时缺供——续跑触发降级
   * 停用（warn），预算刹车 ④ 独立保留。⑥ 沉淀与 ③ 同点同权——都挂在
   * onRunSettled 订阅内（agent 缺供 = 无 run 结算 = 两触发面同停，语义自洽） */
  const agent = ctx.tryGet<AgentServiceFace>('agent');
  if (agent === undefined) {
    // agent 缺供 = 无对话循环 = 无 run 结算——③ 续跑与 ⑥ 沉淀两触发面同停
    ctx.logger.warn(
      'ctx.agent 未提供（chat 件未装载或诊断装配）——goal 续跑触发/轮间沉淀降级停用（工具/命令/预算刹车不受影响）',
    );
  } else {
    /** ⑥ 沉淀机器（刀四 T6-A）——fire-and-forget，异常落 goal/summary-failed
     * durable 事件（第九轮 #20 修死：catch 只 debug 落日志 = 「只在 debug 出现
     * 的分支其行为不是 durable 事件」红线违例——沉淀失败无账面、重试无界），
     * 水位不进 = 下次结算自然重试（llm 预算拒发 LLM_BUDGET_EXCEEDED 同路让位） */
    const llm = ctx.get<GoalLlmFace>('llm');
    const attemptSummary = (goal: GoalRecord): void => {
      void runGoalSummary(goal, {
        store,
        sessions,
        llm,
        logger: ctx.logger,
        // 自报越限的挂钟腿（stopByBudget/evidence 在机器内——闭包在此接线）
        onBudgetStop: (goalId) => suspendWake(goalId),
      }).catch((err: unknown) => {
        // 沉淀失败落账（compaction/failed 先例——log-only 事实源事件）：error =
        // describeError 摘要过 2KiB 错误腿小帽（错误说明是归因线索非全文）。
        // 内层 try/catch 防失败落账自身再炸（如 append 抛错）反噬宿主结算链
        try {
          sessions.appendEvent('goal/summary-failed', {
            goalId: goal.goalId,
            error: budgetString(describeError(err), DURABLE_ERROR_MESSAGE_BUDGET_BYTES),
          } satisfies GoalSummaryFailedEventPayload);
        } catch (appendErr) {
          ctx.logger.warn('goal 轮间沉淀失败且失败事件落账失败', {
            goalId: goal.goalId,
            error: describeError(appendErr),
          });
        }
        ctx.logger.debug('goal 轮间沉淀失败（下次结算重试）', { goalId: goal.goalId, error: describeError(err) });
      });
    };
    ctx.effect(() =>
      agent.onRunSettled((settled) => {
        try {
          // S1 键控 + 刀三轮身份两路定行：刚结算 run 有 goal 归因（chat 通道
          // wake 查询——sendUserMessage attribution 经驱动 launch 定型回读）→
          // goalId 直查（跨会话行也命中）；无归因（用户手写首跑/非 goal 轮）→
          // 归属会话激活行兜底。归因行已重绑他乡（sessionId ≠ 结算会话）= 该
          // 链路已换主——旧会话迟到结算不再续跑，诚实让位
          const attribution = deps.channel?.wakeAttributionFor(settled.sessionId);
          const goal =
            attribution?.goalId !== undefined
              ? store.getByGoalId(attribution.goalId)
              : store.getActiveBySession(settled.sessionId);
          if (goal === undefined) return;
          // 重绑护栏（归因路专属）：归因命中但行已换绑他乡（或脱钩 NULL）= 该链路
          // 已换主——旧会话迟到结算不再续跑，诚实让位（兜底路无此判——按会话
          // 查出的行天然绑在本会话）
          if (attribution !== undefined && goal.sessionId !== settled.sessionId) return;
          if (!shouldContinueGoal(goal, settled.status)) return;
          // 投递目标：行绑定会话优先（重绑后 goal 归新会话——续跑跟行走）
          const targetSession = goal.sessionId ?? settled.sessionId;
          // 停滞硬停（刀三 T5-A 反空转燃尽）：goal/evidence 事件流按 goalId 投影
          //——连续 3 轮 surface_only 或 gap 幕 ≥ 2 → stopped(stalls) 不再续跑。
          // 扫描读路由会话（结算派发经 runInSessionChain 包裹 = 结算会话日志；
          // 重绑边缘诚实注记：重绑前历史在旧会话——投影按「链路实际跑过的账」）
          const stalls = stallsDecision(goal.goalId, sessions.eventsOfType('goal/evidence'));
          if (stalls.hardStop) {
            store.stopByStalls(goal.goalId, Date.now());
            sessions.appendEvent('goal/evidence', { goalId: goal.goalId, reason: 'stalls', willRetry: false });
            // 终态同笔停摆挂钟（刀四 CR-6 三处之一）
            suspendWake(goal.goalId);
            return;
          }
          // ⑥ 沉淀触发（刀四 T6-A）：与续跑判定独立——capped 拒发不影响沉淀
          //（上下文管理不随唤醒拒发而停）。fire-and-forget：与下方投递并发，
          // 渲染面读行时点的缓存列——竞窗只影响「本轮续跑提示是否携带新摘要」
          //（下轮起必携带），正确性无涉。ALS 路由：结算回调链内 sessions 面
          // 天然路由到结算会话 = goal 绑定会话（重绑护栏已让位）。
          //
          // 【守卫甲】tick 形态豁免——沉淀腿（遗漏大扫 20260902-c #5 规范先行，
          // 骨架篇 §6.8「后台唤醒」条裁决①；冷读复审 D-1 定型双守卫落点）：tick
          // 子进程是单发执行体——submitOnce resolve 后 finally 即收口，attemptSummary
          // 的 LLM 单发链会被 retire/进程退出掐死在出生点（provider 侧计费、结果
          // 丢弃）。滞后面 = 水位不进即重试语义天然兜底（长命进程触及该 goal 结算
          // 时补账）；纯挂钟 goal 无新摘要为**已披露降级面**——摘要的活消费者两处：
          // 结算边界续跑注入（tick 路已跳过）与挂钟 ⑤b 动态渲染（**在场**——每跳
          // 提示恒携带最近一次沉淀的陈旧/缺席摘要；只影响提示质量，非状态机正确性）。
          if (deps.processKind !== 'tick') attemptSummary(goal);
          // 唤醒帽执法（刀三 T5-A「执法点 = wakeGate 单源」）：超帽动作 = 暂停
          // 投递非终态停——goal 仍 active，自激路拒发本轮唤醒，停因事件落 durable
          //（willRetry=true——下一 run 结算或到窗后再试）
          const gate = wakeGate({
            goalId: goal.goalId,
            now: Date.now(),
            events: sessions.eventsOfType('user/message'),
          });
          if (!gate.allow) {
            sessions.appendEvent('goal/evidence', { goalId: goal.goalId, reason: 'capped', willRetry: true });
            return;
          }
          // 【守卫乙】tick 形态豁免——续跑投递腿（裁决①；冷读复审 D-1 定型双守卫
          // 落点）：落点在 wakeGate capped 帽块**之后**——执法点单源：上方 stalls
          // 硬停与 capped 帽落账走真码路径对 tick 照落（纯挂钟喂养的停滞 goal 仍
          // 硬停、超帽史仍可判读——不为豁免复刻判据）。tick 单发收口：此处往下的
          // 投递腿（duties/到窗复评/wakeId/sendUserMessage）开的 run 会被 shutdown
          // retire 掐死在出生点即纯浪费；挂钟语义本就是每跳一轮——接力交给下一跳
          // OS 钟。
          if (deps.processKind === 'tick') return;
          // 停滞指令段（needsReplan / needsFloorRecovery——机器判据点名的行为义务）
          const duties: string[] = [];
          if (stalls.needsReplan) {
            duties.push(
              '连续两轮「改了没生效」（outcome_gap）——先 replan：重读目标与现状、换一条打法再动手，不许原路再试。',
            );
          }
          if (stalls.needsFloorRecovery) {
            duties.push(
              '连续两轮只完成表面动作（surface_only）——重估写面需求：实际需要写/执行就调 goal_set 申报 needsWrite 开洞，否则下一轮必须产出对结果可见的推进。',
            );
          }
          // 到窗复评段（刀三）：deferred 项的复活条件到窗——prompt 点名复评
          const fold = deps.channel?.todoFoldFor(targetSession);
          const deferredDue = fold === undefined || fold === null ? undefined : dueDeferredItems(fold, Date.now());
          // backgroundWake：计入自激预算 maxConsecutiveWakes=3——连续自动续跑
          // 封顶 3 轮（用户手写消息恢复预算）；超帽 deliver 自动降级 inject 只留记录。
          // 刀三轮身份：每次唤醒新 wakeId + wakePath 标路（self = 自激续跑路）——
          // wakeGate 帽投影扫的就是这面归因
          const wakeId = newWakeId();
          // 第二十四批题3a：无人值守续跑轮工具面收窄（needsWrite 未申报时）——
          // 机制级投影非提示词劝阻（letta token 扫描被绕过删除的反面教训）：
          // read 类工具 + goal_get/goal_update（结算件必须在场，否则续跑轮永远
          // 无法申报终态）；goal_set/goal_update 自身 effect 均为 write，靠名单
          // 显式保留而非 effect 过滤自然命中。开洞：goal_set 申报 needsWrite
          // 即不携带 toolFilter（续跑轮全量工具面）。
          // S2 域视角（域键升级批升 compositionFor）：wake 名单从「该会话组成面」
          // 投影（全局层 ∪ 本驱动应用域层 ∪ 本驱动层——fs 四名等 per-driver 工具
          // 照常进白名单筛选，别家驱动层不掺入；退役/未知 sessionId = 全局层同口径
          // 回落，与 chat 件 open 同一投影）
          const toolFilter = goal.needsWrite ? undefined : wakeToolFilter(tools.compositionFor(targetSession));
          try {
            agent.sendUserMessage(
              renderContinuationPrompt(goal, {
                duties: duties.length > 0 ? duties : undefined,
                deferredDue: deferredDue !== undefined && deferredDue.length > 0 ? deferredDue : undefined,
              }),
              {
                source: 'app:goal',
                backgroundWake: true,
                session: targetSession,
                attribution: { goalId: goal.goalId, wakeId, wakePath: 'self' },
                ...(toolFilter !== undefined ? { toolFilter } : {}),
              },
            );
          } catch (err) {
            // S1 退役容错：目标会话已退役（/new 换新后旧会话结算迟到）→
            // AGENT_SESSION_INACTIVE 仅此码降 debug——旧会话停摆是 /new 的
            // 语义结果非故障；其余异常照外层 error 口径
            if (err instanceof AppError && err.code === AGENT_SESSION_INACTIVE) {
              ctx.logger.debug('goal 续跑跳过：归属会话已退役', { sessionId: settled.sessionId });
            } else {
              throw err;
            }
          }
        } catch (err) {
          // 续跑触发异常止步日志（结算通知链不受应用违约影响——服务层另有隔离壳）
          ctx.logger.error('goal 续跑触发失败', { error: describeError(err) });
        }
      }),
    );
  }

  /* ---- ④ 预算刹车：两腿累计，≥ 帽即刹停 + 收尾注入 ----
   * 腿一（原腿）：前台 assistant/message usage（turn 汇总额——主 loop 流式调用
   * 的计量事实）。
   * 腿二（2026-09-01 复盘 R-1）：委派结算折叠笔——callId 带 'delegation:' 前缀的
   * llm/usage 镜像（app/notify.ts 折进父会话 background 道）。修复前子代理花销
   * 对 ④ 记账/⑤ 复验/沉淀自报三面全盲：委派工具归 'read' 不受 backgroundWake
   * 工具面收窄，read-only 续跑轮可经委派烧钱绕 tokenBudget 帽。只认前缀不认
   * priority——complete 单发腿 randomUUID 裸形不命中（不与轮间沉淀调用点自报
   * 双计）、前台 'turn:' 笔不命中（已随腿一计过，再计即双计）；判别式与两写点
   * 同源收口于 session/event-types 三函数。delta 口径 = 底账四桶和（llm/usage
   * 无 totalTokens 派生值——派生归投影律）。 */

  /**
   * ④ 预算记账 + 刹停收尾（两腿共尾——腿二并入后提取，防双份漂移）：
   * 记账后判帽，超帽即停（幂等 WHERE status='active'）+ 落 budget 证据 +
   * 停摆挂钟 + 收尾注入（agent 缺供只跳过注入——记账与刹停是数据面）。
   * @param sessionId 归属会话
   * @param delta 本笔增量（腿一 totalTokens 口径 / 腿二四桶和口径——各自算好传入）
   */
  const chargeAndBrake = (sessionId: string, delta: number): void => {
    const goal = store.addUsage(sessionId, delta, Date.now());
    if (goal === undefined || goal.tokensUsed < goal.tokenBudget) return;
    // 刹停（幂等护栏：WHERE status='active'）+ 同步收尾注入（忙时 steer——
    // 模型当轮收尾交代下一步；预算尽≠完成，提示词如实示态）
    store.stopByBudget(sessionId, goal.tokensUsed, Date.now());
    // 停因事件（刀三）：预算尽落 durable 证据——停滞判定断 streak（预算帽拒发
    // 轮不折算成模型停滞）+ 审计面回读；willRetry=false（预算尽不自动重试）
    sessions.appendEvent('goal/evidence', { goalId: goal.goalId, reason: 'budget', willRetry: false });
    // 终态同笔停摆挂钟（刀四 CR-6 三处之二）
    suspendWake(goal.goalId);
    // 刹停后行已非 active——getBySession 取当前行（updated_at 最新 = 刚停行）
    const stopped = store.getBySession(sessionId);
    if (stopped !== undefined) {
      try {
        agent?.sendUserMessage(renderBudgetExhaustedPrompt(stopped), { source: 'app:goal', session: sessionId });
      } catch (err) {
        // S1 退役容错：目标会话已退役——收尾注入无处可投仅记 debug（与 ③ 同口径）
        if (err instanceof AppError && err.code === AGENT_SESSION_INACTIVE) {
          ctx.logger.debug('goal 收尾注入跳过：归属会话已退役', { sessionId });
        } else {
          throw err;
        }
      }
    }
  };

  ctx.effect(() =>
    ctx.on('session/event', (payload: unknown) => {
      try {
        const envelope = payload as SessionEventEnvelope;
        if (typeof envelope?.sessionId !== 'string') return;
        // S1 键控：信封会话直查（不再比对前台聚焦单值）——多会话并存时各会话
        // 目标各自记账，互不串账互不漏账
        const sessionId = envelope.sessionId;
        // 只对 active 行记账（needs-resume/stopped/终态不再累计——刹停后的收尾
        // 轮花销不属于本目标预算；先判状态再累加，读改写间无并发窗口）
        // v13 后 getActiveBySession 直取（历史终态行不再命中）
        // 腿二（复盘 R-1）：委派结算折叠笔——'delegation:' 前缀判别
        if (envelope.event?.type === 'llm/usage') {
          const data = envelope.event.data as
            | {
                callId?: unknown;
                usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
              }
            | undefined;
          if (typeof data?.callId !== 'string' || !isDelegationUsageCallId(data.callId)) return;
          if (store.getActiveBySession(sessionId) === undefined) return;
          // 四桶和口径：llm/usage 底账无 totalTokens（派生归投影律）；cacheWrite1h
          // ⊂ cacheWrite、reasoning ⊂ output 不重复计
          const buckets = data.usage;
          const delta =
            (buckets?.input ?? 0) + (buckets?.output ?? 0) + (buckets?.cacheRead ?? 0) + (buckets?.cacheWrite ?? 0);
          if (delta <= 0) return;
          chargeAndBrake(sessionId, delta);
          return;
        }
        // 腿一（原腿）：前台 assistant/message
        if (envelope.event?.type !== 'assistant/message') return;
        const current = store.getActiveBySession(sessionId);
        if (current === undefined) return;
        // usage 为 turn 汇总额（durable 载荷）；totalTokens 缺失时回退 input+output
        const usage = envelope.event.data as
          { usage?: { totalTokens?: number; input?: number; output?: number } } | undefined;
        const delta = usage?.usage?.totalTokens ?? (usage?.usage?.input ?? 0) + (usage?.usage?.output ?? 0);
        if (delta <= 0) return;
        chargeAndBrake(sessionId, delta);
      } catch (err) {
        // fire-and-forget 纪律：刹车异常止步日志，绝不上抛进事件派发面
        ctx.logger.error('goal 预算刹车失败', { error: describeError(err) });
      }
    }),
  );

  /* ---- ⑤ 复验面（刀三 T7-A：agent_pre_step 瀑布监听——进模型步前再执法）----
   * 与 ④ 预算刹车的分工：④ 是事后记账（assistant/message 累计，漏检窗口 =
   * 记账事件迟到）；⑤ 是事前拦（每次进模型步查归因行的活状态，durability
   * 屏障已在此回调前成立——驱动 beforeModelStep 包装对后台轮先 flush 会话，
   * 已投递消息 durable 先于其后模型花销）。三停因：预算尽（主动刹停+落账）/
   * 行非 active（他路先停——用户 stop、停滞硬停：幂等让位不覆写状态面）/
   * 行已重绑他乡（同 ③ 重绑护栏——旧链路让位）。
   * 关键闸门：无 goal 归因的 run 一律 next() 放行——普通对话/工具轮与本件
   * 无关（缺此闸门 = 每个会话每次 run 都被停）。异常 fail-open（复验面故障
   * 不杀 run——next() 放行 + error 日志，下次结算照常补执法） */
  ctx.effect(() =>
    ctx.on('agent_pre_step', (payload: unknown, next: () => unknown) => {
      try {
        const envelope = payload as { sessionId?: unknown };
        if (typeof envelope?.sessionId !== 'string') return next();
        // 归因闸门：chat 通道 wake 查询取「该会话在跑 run」的归因——非 goal
        // 唤醒轮（用户手写/其他件注入）归因缺席 = 不归本件管，直接放行
        const attribution = deps.channel?.wakeAttributionFor(envelope.sessionId);
        if (attribution?.goalId === undefined) return next();
        const row = store.getByGoalId(attribution.goalId);
        // 行缺席/非 active/已重绑他乡：停发但不写状态面（幂等让位——状态面
        // 归属先到者；重绑后旧链路的在飞轮就地收场，新会话链路由新投递驱动）
        if (row === undefined || row.status !== 'active' || row.sessionId !== envelope.sessionId) {
          return { stop: true };
        }
        // 预算尽：主动刹停 + 停因落账（与 ④ 同一 stopByBudget——幂等护栏
        // WHERE status='active' 两路不冲突，先到者赢）
        if (row.tokensUsed >= row.tokenBudget) {
          store.stopByBudget(envelope.sessionId, row.tokensUsed, Date.now());
          sessions.appendEvent('goal/evidence', { goalId: row.goalId, reason: 'budget', willRetry: false });
          // 终态同笔停摆挂钟（刀四 CR-6 与 ④/stalls/tools 终态路同一单源纪律——
          // 复盘 #52：此路漏翻则 OS 钟照跳，每跳 tick 整机装配后让路空转）
          suspendWake(row.goalId);
          return { stop: true };
        }
        return next();
      } catch (err) {
        // fail-open：复验面自身故障不杀 run（错误止步日志，模型步照常走）
        ctx.logger.error('goal 复验面失败（fail-open 放行）', { error: describeError(err) });
        return next();
      }
    }),
  );
}

/* ---------------------------------------------------------------------------------- */
/* ⑥ 轮间沉淀机器（刀四 T6-A——模块级机器函数，attemptSummary fire-and-forget 调用）       */
/* ---------------------------------------------------------------------------------- */

/**
 * 摘要预算三参（compaction config summaryRatio/Min/Max 缺省同值——同源复刻
 * 对齐注记，goal→compaction 无拓扑边各自本地）。
 */
const GOAL_SUMMARY_BUDGET = { ratio: 0.2, min: 2000, max: 12_000 } as const;

/** 沉淀机器依赖束（attemptSummary 闭包组包——全部结构面，宿主服务天然满足） */
interface SummaryMachineOpts {
  readonly store: GoalStore;
  readonly sessions: SummarySessionsFace;
  readonly llm: GoalLlmFace;
  /** 日志面（debug/info 两级——ctx.logger 结构子集） */
  readonly logger: { debug(message: string, meta?: unknown): void; info(message: string, meta?: unknown): void };
  /**
   * 预算越限同笔停摆挂钟（④ 同款编排的挂钟腿——stopByBudget/evidence 在机器
   * 内，suspendWake 闭包在 apply 侧，经此回调接线）
   */
  readonly onBudgetStop: (goalId: string) => void;
}

/** 从模型响应 content 提取纯文本（compaction extractText 同构——text 块拼接） */
function extractSummaryText(content: unknown): string {
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

/**
 * 一次沉淀尝试（⑥ 机器本体——全程在结算会话调用链语境内，ALS 随 async
 * 续体存活，appendEvent/appendWithSurfaceOp 天然路由到 goal 绑定会话）。
 * 落账序：① goal/summary durable 事件（事实源）→ ② surfaceOp 载体遮蔽
 * （宿主四执法点）→ ③ goals 表缓存列回写。crash 窗口皆良性：① 后 crash =
 * 载体未遮但事实源在（下轮回填后判水位 no-op）；② 后 crash = 遮蔽已生效、
 * 缓存列 stale（渲染面读列得旧摘要——正确性无涉，下次沉淀覆盖）。
 * 逐条 no-op 判据见各 return 注记。
 */
async function runGoalSummary(goal: GoalRecord, opts: SummaryMachineOpts): Promise<void> {
  const { store, sessions, llm } = opts;
  // 预算尽不沉淀（spec：花销侧不追——预算帽拒的是继续烧钱，沉淀白嫖模型同理）
  if (goal.tokensUsed >= goal.tokenBudget) return;
  // 投影 + 判阈（字符粗估源——goal 路无 compaction 的主 loop usage 笔可消费）
  const projected = sessions.deriveMessages();
  const headers = sessions.eventsOfType('request/header');
  const lastHeader = headers.at(-1);
  const model = lastHeader !== undefined ? (lastHeader.data as { model?: string }).model : undefined;
  const contextWindow = model !== undefined ? llm.getModel(model)?.contextWindow : undefined;
  if (!shouldSummarize({ contextWindow, projectedChars: JSON.stringify(projected).length })) return;
  // 区间规划（激活锚 floor——锚前旧会话史归 compaction 管辖不越界遮蔽）
  const plan = planSummarySegment(projected, goal.activatedSeq);
  if (plan === null) return;
  // 水位 no-op：上次沉淀已覆盖到本区间末端（重复结算/无新增推进）——不重跑 LLM
  if (goal.summarySeq !== null && plan.end <= goal.summarySeq) return;
  // 摘要单发（background 道——canAfford 内闸；LLM_BUDGET_EXCEEDED 抛出走
  // attemptSummary 的 catch 让位，下次结算自然重试）
  const occluded = projected.filter((m) => m.seq >= plan.start && m.seq <= plan.end);
  const prompt = buildGoalSummaryPrompt({
    objective: goal.objective,
    previousSummary: goal.summary,
    occludedMessages: occluded,
    budgetTokens: summaryBudgetFor(plan.occludedChars, GOAL_SUMMARY_BUDGET),
    escape: escapeXml,
  });
  const result = await llm.complete({ messages: [{ role: 'user', content: prompt }], priority: 'background' });
  // 预算刀（第九轮 #7②）：LLM 单发摘要无体积硬约束——模型超产原样落 append 必
  // 抛 SESSION_EVENT_TOO_LARGE → attemptSummary catch（debug-only）→ 每次结算
  // 后台重烧一次 LLM 单发再失败，零账面。过刀后事件 text / 载体 content /
  // 缓存列三面共用同一截断文本（预算一次）
  const text = budgetString(extractSummaryText(result.message.content));
  if (text === '') return; // 模型未产出文本——诚实缺席不落空摘要
  // ① 事实源事件（goal/summary：载荷 goalId/text/summarySeq——缓存列可回填面）
  const summaryEvent = sessions.appendEvent('goal/summary', {
    goalId: goal.goalId,
    text,
    summarySeq: plan.end,
  } satisfies GoalSummaryEventPayload);
  // ② 遮蔽载体（user/message 单边 + replace + app: 归因 + 溯源区间全 seq 外加
  // 摘要依据事件——宿主四执法点统一验）
  const seqs: number[] = [];
  for (let seq = plan.start; seq <= plan.end; seq++) seqs.push(seq);
  if (summaryEvent !== undefined) seqs.push(summaryEvent.seq);
  await sessions.appendWithSurfaceOp({
    type: 'user/message',
    data: { content: `${GOAL_SUMMARY_PREFIX} ${text}`, source: 'app:goal' },
    surfaceOp: { op: 'replace', start: plan.start, end: plan.end },
    sourceEventSeqs: seqs,
  });
  // ③ 缓存列回填（列只是缓存——事实源在 ①；渲染面 renderContinuationPrompt 读列）
  store.recordSummary(goal.goalId, text, plan.end, Date.now());
  // usage 自报（CR-3：旁路 LLM 计量调用点不进 ④ 的事件镜像路——complete 的
  // llm/usage 底账由装配层自动落，此处补 goal 侧账本 delta；行非 active =
  // 中途被停，让位不记账返回 undefined）
  if (goal.sessionId !== null) {
    const delta = result.usage.totalTokens ?? result.usage.input + result.usage.output;
    const updated = store.addUsage(goal.sessionId, delta, Date.now());
    if (updated !== undefined && updated.tokensUsed >= updated.tokenBudget) {
      // 自报越限：同笔刹停 + 停因落账 + 摘钟（与 ④ 同一 stopByBudget 幂等护栏，
      // 先到者赢）；**不注入收尾提示**——沉淀点无 run 在飞，注入即烧新轮
      store.stopByBudget(goal.sessionId, updated.tokensUsed, Date.now());
      sessions.appendEvent('goal/evidence', { goalId: goal.goalId, reason: 'budget', willRetry: false });
      opts.onBudgetStop(goal.goalId);
    }
  }
  opts.logger.info('goal 轮间沉淀完成', {
    goalId: goal.goalId,
    occludedMessages: plan.occludedMessages,
    summarySeq: plan.end,
  });
}

/** /goal 命令体（args 形态：空 = 查状态 / resume [goalId] / stop / wake <schedule>|off） */
async function handleGoalCommand(
  args: string,
  opts: {
    store: GoalStore;
    getSessionId: () => string | undefined;
    ui: UiNotifyFace;
    /** 宿主日志长度面（resume 重绑的激活锚取值——sessions.logLength 单源） */
    logLength: () => number | undefined;
    /** 挂钟面惰性取（刀四迟到注入——命令时点 scheduler 行已装载；miss = wake 响亮拒绝） */
    schedulerFace: () => GoalSchedulerFace | undefined;
    /** 终态/复活同笔翻转闭包（stop/resume 子命令接线——面缺席静默跳过） */
    suspendWake: (goalId: string) => void;
    resumeWake: (goalId: string) => void;
  },
): Promise<void> {
  const sessionId = opts.getSessionId();
  const goal = sessionId === undefined ? undefined : opts.store.getBySession(sessionId);
  if (args === '') {
    opts.ui.notify(goal === undefined ? '当前会话没有设定目标（模型可 goal_set 设定）。' : renderGoalForUser(goal));
    return;
  }
  // 子命令与余参拆分（resume 可带 goalId——跨会话领养形）
  const spaceAt = args.indexOf(' ');
  const sub = spaceAt === -1 ? args : args.slice(0, spaceAt);
  const rest = spaceAt === -1 ? '' : args.slice(spaceAt + 1).trim();

  if (sub === 'resume') {
    if (sessionId === undefined) {
      opts.ui.notify('无会话上下文——/goal resume 不可用。');
      return;
    }
    // 目标行解析：带 goalId = 跨会话领养形（getByGoalId 直取）；缺省 = 当前行
    const target = rest !== '' ? opts.store.getByGoalId(rest) : goal;
    if (target === undefined) {
      opts.ui.notify(rest !== '' ? `没有 goalId 为 ${rest} 的目标行。` : '当前会话没有目标可恢复（goal_set 先设定）。');
      return;
    }
    if (!canResumeGoal(target)) {
      opts.ui.notify(`目标 ${target.goalId} 当前为 ${target.status}——只有 needs-resume 态需要重新激活。`);
      return;
    }
    // 撞 active 行复用工具码同款回执（冷读复审 minor②——两执法位一词汇）：
    // 领养进已有 active 行的会话 = 占位冲突，响亮拒绝不静默换行
    const activeHere = opts.store.getActiveBySession(sessionId);
    if (activeHere !== undefined && activeHere.goalId !== target.goalId) {
      opts.ui.notify(
        `当前会话已有进行中的目标（active，goalId ${activeHere.goalId}）——先停止或完成再领养 ${target.goalId}`,
      );
      return;
    }
    // 领养重绑：行 sessionId 换当前会话（原会话不再持有），状态回 active；
    // 激活锚同步刷新（拍板形态：重绑到新会话即新锚——重新授权点重新折叠）
    opts.store.reactivate(target.goalId, sessionId, Date.now(), opts.logLength() ?? null);
    // 挂钟复活（CR-6 resume 路）：有声明即重挂而非裸 enable——putOwned upsert
    // 顺带把钟行 session_id 治愈到新会话（领养重绑后钟跟行走，tick 投递
    // 目标不陈旧）；无声明 = 无钟可活，enable 空转走对称闭包
    if (target.wakeSchedule !== null) {
      const face = opts.schedulerFace();
      if (face !== undefined) {
        const reregistered = await face.register({
          goalId: target.goalId,
          sessionId,
          schedule: target.wakeSchedule,
          promptSnapshot: target.objective,
        });
        if (!reregistered.ok) {
          opts.ui.notify(`挂钟重挂失败：${reregistered.message}（目标本身已重新激活——/goal wake 重试挂钟）`);
          return;
        }
      }
    } else {
      opts.resumeWake(target.goalId);
    }
    opts.ui.notify(
      `目标已重新激活（active，goalId ${target.goalId}）——下一轮结算起恢复续跑${target.wakeSchedule !== null ? '（挂钟随之恢复并跟到本会话）' : ''}。`,
    );
    return;
  }
  if (sub === 'stop') {
    if (goal === undefined) {
      opts.ui.notify('当前会话没有目标可停。');
      return;
    }
    if (!canStopGoal(goal)) {
      opts.ui.notify(`目标当前为 ${goal.status}——已是终态，无需停止。`);
      return;
    }
    opts.store.stopByUser(goal.goalId, Date.now());
    // 人工停同笔停摆挂钟（CR-6：stopped 即不再被唤醒——行留史可查，摘钟另走 off）
    opts.suspendWake(goal.goalId);
    opts.ui.notify('目标已人工停止（stopped/user）——不再续跑。');
    return;
  }
  if (sub === 'wake') {
    // 挂钟授权在人类（T7-B）：/goal wake <schedule> 挂 ↔ /goal wake off 摘。
    // 允许任意在场行挂钟（needs-resume/终态行也可——到点投递前查行让路，
    // resume 后生效；这比「只许 active」少一道状态耦合，语义自说明）
    if (goal === undefined) {
      opts.ui.notify('当前会话没有目标——挂钟挂在目标行上（模型 goal_set 先设定）。');
      return;
    }
    const face = opts.schedulerFace();
    if (face === undefined) {
      opts.ui.notify('scheduler 官方件未装载——/goal wake 不可用（挂钟任务面缺席）。');
      return;
    }
    if (rest === 'off') {
      await face.remove(goal.goalId);
      opts.store.updateWakeSchedule(goal.goalId, null, Date.now());
      opts.ui.notify(`已摘除目标 ${goal.goalId} 的挂钟（OS 定时注销 + 行删除）。`);
      return;
    }
    if (rest === '') {
      opts.ui.notify('用法：/goal wake <schedule>|off（schedule = once@<ISO>/every@<n>[mhd]/daily@HH:MM）');
      return;
    }
    // schedule 词法执法在 scheduler 侧（parseSchedule 管辖权随面）；prompt 快照
    // = objective 静态兜底（到点投递首选动态渲染 renderContinuationPrompt——
    // 行缺席/渲染失败才落到此串）
    const registered = await face.register({
      goalId: goal.goalId,
      sessionId: sessionId ?? '',
      schedule: rest,
      promptSnapshot: goal.objective,
    });
    if (!registered.ok) {
      opts.ui.notify(registered.message);
      return;
    }
    opts.store.updateWakeSchedule(goal.goalId, rest, Date.now());
    // 注记两行：非 active 行到点让路（resume 恢复）；needsWrite 未申报 =
    // 挂钟轮工具面只读（与自激续跑轮同一收窄单源 wakeToolFilter）
    const lines = [registered.message];
    if (goal.status !== 'active') {
      lines.push(`注记：目标当前为 ${goal.status}——到点投递前查行让路，/goal resume 后挂钟生效。`);
    }
    if (!goal.needsWrite) {
      lines.push('注记：目标未申报 needsWrite——挂钟轮工具面只读（模型 goal_set 申报 needsWrite 开洞）。');
    }
    opts.ui.notify(lines.join('\n'));
    return;
  }
  opts.ui.notify('用法：/goal（查状态）| /goal resume [goalId] | /goal stop | /goal wake <schedule>|off');
}

/** goal 行 → 人读投影（命令面——与工具面 renderGoal 同口径，独立于人读排版） */
function renderGoalForUser(goal: GoalRecord): string {
  const lines = [
    `目标：${goal.objective}`,
    `身份：${goal.goalId}`,
    `状态：${goal.status}${goal.stopReason !== null ? `（原因：${goal.stopReason}）` : ''}`,
    `预算：已用 ${goal.tokensUsed} / ${goal.tokenBudget} tokens`,
  ];
  // 挂钟披露（刀四 v1 只读面）：声明原样串 + needsWrite 工具面档位——挂/摘走 /goal wake
  if (goal.wakeSchedule !== null) lines.push(`挂钟：${goal.wakeSchedule}`);
  lines.push(goal.needsWrite ? '写面：已申报 needsWrite（续跑/挂钟轮全量工具面）' : '写面：未申报（续跑/挂钟轮只读）');
  if (goal.summary !== null) lines.push(`沉淀：已摘要至 seq ${goal.summarySeq ?? '？'}`);
  if (goal.evidence !== null) lines.push(`证据/原因：${goal.evidence}`);
  return lines.join('\n');
}
