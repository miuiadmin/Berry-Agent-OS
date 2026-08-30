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
 * ② 命令 /goal（查状态）/goal resume/goal stop 进 ctx.channels——激活权在人类；
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
 *    前查归因行活状态（预算尽/已停/已重绑 → stop:true 就地收场）。
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
 * tools/channels/ui——内核恒供）。
 *
 * persist:false 降级：无连接即 warn 空转（同 memory 官方件——诊断面行可见、
 * 装载成功，语义诚实）。
 */

import { AppError, AGENT_SESSION_INACTIVE, describeError } from '../contracts/errors.js';
import type { ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import type { Context, Disposer } from '../context/types.js';
import type { DatabaseConnection } from '../persist/index.js';
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
import type { GoalChannel } from './channel.js';
import { renderBudgetExhaustedPrompt, renderContinuationPrompt } from './prompts.js';
import { createGoalTools, snapshotOfItems } from './tools.js';
import type { GoalSessionsFace } from './tools.js';

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
    // 'sessions' 恒供（装配层无条件 provide——账本事件读写面，第三十九批 T4-A）
    inject: ['tools', 'channels', 'ui', 'sessions'],
    optionalInject: ['agent'],
    apply: (ctx: AppContext) => applyGoalApp(ctx, deps, consumeReplayUnseen),
  };
}

/**
 * 官方件 apply 本体（接线序：续接降级事件面 → 工具三件 → /goal 命令 → 续跑触发 → 预算刹车）。
 * 异常上抛走加载器统一回卷（APP_APPLY_FAILED）。
 */

/**
 * 续跑轮工具面投影（第二十四批题3a，骨架篇 §6.8 拍板落码）：
 * read 类工具全保（检索/阅读照常）+ goal_get/goal_update 显式保留（结算件——
 * 续跑轮必须能查态与申报终态，否则 goal 永远无法自然收束；两件自身 effect
 * 均为 write，靠名单显式保留而非 effect 过滤自然命中）；write/exec 类与
 * goal_set（轮中重设无意义）全部收走。模型感知面 = 白名单（不可见即不可调）。
 */
function wakeToolFilter(defs: readonly ToolDefinition[]): string[] {
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
          }
          return;
        }
        // 活体路径：进程内运行期再开续接会话——origin=resume 照常降级
        if (envelope.origin === 'resume') {
          store.demoteToNeedsResume(envelope.sessionId, Date.now());
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
  const sessions = ctx.get<GoalSessionsFace>('sessions');
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
  })) {
    ctx.effect(() => tools.register(def));
  }

  /* ---- ② /goal 命令族（激活权在人类：resume 重新授权〔可带 goalId 跨会话领养〕
   * / stop 人工停）---- */
  const ui = ctx.get<UiNotifyFace>('ui');
  ctx.effect(() =>
    ctx.get<ChannelsCommandFace>('channels').registerCommand({
      name: 'goal',
      description:
        '长目标管理：/goal 查看状态；/goal resume [goalId] 重新激活（重启降级 needs-resume 时；带 goalId 跨会话领养）；/goal stop 人工停止',
      source: 'app',
      handler: (args) =>
        handleGoalCommand(args.trim(), {
          store,
          getSessionId: deps.getSessionId,
          ui,
          logLength: () => sessions.logLength(),
        }),
    }),
  );

  /* ---- ③ 续跑触发：run 结算边界（completed 且 active 且预算未尽才续）----
   * ctx.agent 走 optionalInject：chat 件未装载/诊断装配时缺供——续跑触发降级
   * 停用（warn），预算刹车 ④ 独立保留 */
  const agent = ctx.tryGet<AgentServiceFace>('agent');
  if (agent === undefined) {
    ctx.logger.warn('ctx.agent 未提供（chat 件未装载或诊断装配）——goal 续跑触发降级停用（工具/命令/预算刹车不受影响）');
  } else {
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
            return;
          }
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

  /* ---- ④ 预算刹车：assistant/message usage 累计，≥ 帽即刹停 + 收尾注入 ---- */
  ctx.effect(() =>
    ctx.on('session/event', (payload: unknown) => {
      try {
        const envelope = payload as SessionEventEnvelope;
        if (typeof envelope?.sessionId !== 'string' || envelope.event?.type !== 'assistant/message') return;
        // S1 键控：信封会话直查（不再比对前台聚焦单值）——多会话并存时各会话
        // 目标各自记账，互不串账互不漏账
        const sessionId = envelope.sessionId;
        // 只对 active 行记账（needs-resume/stopped/终态不再累计——刹停后的收尾
        // 轮花销不属于本目标预算；先判状态再累加，读改写间无并发窗口）
        // v13 后 getActiveBySession 直取（历史终态行不再命中）
        const current = store.getActiveBySession(sessionId);
        if (current === undefined) return;
        // usage 为 turn 汇总额（durable 载荷）；totalTokens 缺失时回退 input+output
        const usage = envelope.event.data as
          { usage?: { totalTokens?: number; input?: number; output?: number } } | undefined;
        const delta = usage?.usage?.totalTokens ?? (usage?.usage?.input ?? 0) + (usage?.usage?.output ?? 0);
        if (delta <= 0) return;
        const goal = store.addUsage(sessionId, delta, Date.now());
        if (goal === undefined || goal.tokensUsed < goal.tokenBudget) return;
        // 刹停（幂等护栏：WHERE status='active'）+ 同步收尾注入（忙时 steer——
        // 模型当轮收尾交代下一步；预算尽≠完成，提示词如实示态）。agent 缺供
        //（chat 件未装载）只跳过注入——记账与刹停是数据面，不依赖对话循环
        store.stopByBudget(sessionId, goal.tokensUsed, Date.now());
        // 停因事件（刀三）：预算尽落 durable 证据——停滞判定断 streak（预算帽拒发
        // 轮不折算成模型停滞）+ 审计面回读；willRetry=false（预算尽不自动重试）
        sessions.appendEvent('goal/evidence', { goalId: goal.goalId, reason: 'budget', willRetry: false });
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

/** /goal 命令体（args 形态：空 = 查状态 / resume [goalId] / stop） */
function handleGoalCommand(
  args: string,
  opts: {
    store: GoalStore;
    getSessionId: () => string | undefined;
    ui: UiNotifyFace;
    /** 宿主日志长度面（resume 重绑的激活锚取值——sessions.logLength 单源） */
    logLength: () => number | undefined;
  },
): void {
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
    opts.ui.notify(`目标已重新激活（active，goalId ${target.goalId}）——下一轮结算起恢复续跑。`);
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
    opts.ui.notify('目标已人工停止（stopped/user）——不再续跑。');
    return;
  }
  opts.ui.notify('用法：/goal（查状态）| /goal resume [goalId] | /goal stop');
}

/** goal 行 → 人读投影（命令面——与工具面 renderGoal 同口径，独立于人读排版） */
function renderGoalForUser(goal: GoalRecord): string {
  const lines = [
    `目标：${goal.objective}`,
    `身份：${goal.goalId}`,
    `状态：${goal.status}${goal.stopReason !== null ? `（原因：${goal.stopReason}）` : ''}`,
    `预算：已用 ${goal.tokensUsed} / ${goal.tokenBudget} tokens`,
  ];
  if (goal.evidence !== null) lines.push(`证据/原因：${goal.evidence}`);
  return lines.join('\n');
}
