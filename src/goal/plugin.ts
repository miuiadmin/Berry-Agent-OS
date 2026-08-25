/**
 * L3 goal — 官方件（骨架篇 §6.8 `builtin:goal`，Ring 2 编排域官方件）。
 *
 * 长目标续跑：**没有新循环机器**——持久 goal 状态（goals 表）+ run 结算边界
 * 注入提示词（onRunSettled → ctx.agent.sendUserMessage 三通道路由）+ 预算刹车
 * （session/event 镜像过滤 assistant/message 累计）三个已有原语的组合。
 *
 * 装配接线（全部挂 ctx.effect，装载锚 dispose 即 LIFO 回卷）：
 * ① 工具三件（goal_get/goal_set/goal_update）进 ctx.tools；
 * ② 命令 /goal（查状态）/goal resume/goal stop 进 ctx.channels——激活权在人类；
 * ③ 续跑触发：onRunSettled(completed 且 active 且预算未尽) → 续跑提示注入
 *    （backgroundWake——计入自激预算 maxConsecutiveWakes=3，防失控续跑）；
 * ④ 预算刹车：assistant/message usage 累计 ≥ tokenBudget → 刹停（stopped/budget）
 *    + 同步注入收尾提示（忙时 steer——当轮收尾交代下一步，非硬断）。
 *
 * 激活态不持久化（§6.7 拍板）：boot 续接（origin=resume）即把 active 行降级
 * needs-resume。wasResumed 为惰性取值（应用面第一纵切）：chat 对话应用件（默认
 * 层首行）装载时绑定会话并回写旗标，goal 轮次激活必晚于它——apply 期首读必得
 * 居值；一次性旗标（bootDemotionArmed）保证 /reload 重激活不误降级（/reload
 * 复用同一官方件实例，闭包旗标跨重载存活）。
 *
 * 'agent' 走 optionalInject（应用面第一纵切）：chat 件未装载/诊断装配
 * （persist:false）时无 ctx.agent——③续跑触发降级停用（warn），④预算刹车保留
 * 记账与刹停、仅跳过收尾注入；①工具②/goal 命令不受影响（inject 硬依赖只剩
 * tools/channels/ui——内核恒供）。
 *
 * persist:false 降级：无连接即 warn 空转（同 memory 官方件——诊断面行可见、
 * 装载成功，语义诚实）。
 */

import { describeError } from '../contracts/errors.js';
import type { ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import type { Context, Disposer } from '../context/types.js';
import type { DatabaseConnection } from '../persist/index.js';
import { GoalStore } from './store.js';
import { canResumeGoal, canStopGoal, shouldContinueGoal } from './machine.js';
import type { GoalRecord } from './machine.js';
import { renderBudgetExhaustedPrompt, renderContinuationPrompt } from './prompts.js';
import { createGoalTools } from './tools.js';

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

/** ctx.agent 服务最小面（chat-plugin.ts AgentServiceFace 的结构子集） */
interface AgentServiceFace {
  sendUserMessage(content: string, opts?: { readonly source?: string; readonly backgroundWake?: boolean }): void;
  onRunSettled(cb: (settled: { readonly status: 'completed' | 'aborted' | 'failed' }) => void): Disposer;
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
export interface GoalPluginDeps {
  /** SQLite 连接（goals 表物理载体）；缺省 = persist:false 降级 warn 空转 */
  readonly connection?: DatabaseConnection;
  /** 当前会话 id 活取值（/new 热切换后自动跟新会话走） */
  readonly getSessionId: () => string | undefined;
  /**
   * boot 是否续接既有会话（session_start origin=resume 语义）——active 行降级
   * 触发器。惰性取值：chat 件（默认层首行）装载绑定会话后才回写真值，goal
   * 轮次激活必晚于绑定，apply 期首读必得居值
   */
  readonly wasResumed: () => boolean;
}

/**
 * 构造 goal 官方件（builtins 注册表 `builtin:goal` 行）。
 */
export function createGoalPlugin(deps: GoalPluginDeps): BuiltinPluginModule {
  // boot 降级一次性旗标：armed 恒 true 起步，首次 apply 读 wasResumed() 惰性值
  // 并解除——/reload 复用同一模块实例重跑 apply，旗标已 false 不误降级
  //（§6.7「/reload 不误降级」）
  let bootDemotionArmed = true;
  return {
    name: 'goal',
    // 'agent' 为 optionalInject：chat 件未装载/诊断装配时缺供不阻激活（降级见上）
    inject: ['tools', 'channels', 'ui'],
    optionalInject: ['agent'],
    apply: (ctx: PluginContext) =>
      applyGoalPlugin(ctx, deps, () => {
        const armed = bootDemotionArmed && deps.wasResumed();
        bootDemotionArmed = false;
        return armed;
      }),
  };
}

/**
 * 官方件 apply 本体（接线序：boot 降级 → 工具三件 → /goal 命令 → 续跑触发 → 预算刹车）。
 * 异常上抛走加载器统一回卷（PLUGIN_APPLY_FAILED）。
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

async function applyGoalPlugin(
  ctx: PluginContext,
  deps: GoalPluginDeps,
  consumeBootDemotion: () => boolean,
): Promise<void> {
  // persist:false 降级：无物理层即无 goal（状态/记账/续跑全依赖 goals 表）——warn 空转
  if (!deps.connection) {
    ctx.logger.warn('无持久层（persist:false）——goal 官方件空转：工具/命令/续跑/预算刹车均不注册');
    return;
  }
  const store = new GoalStore(deps.connection);

  /* ---- ⓪ boot 降级（激活权不跨进程）：origin=resume 续接即 active ⇒ needs-resume ---- */
  if (consumeBootDemotion()) {
    const sessionId = deps.getSessionId();
    if (sessionId !== undefined) store.demoteToNeedsResume(sessionId, Date.now());
  }

  /* ---- ① 工具三件（目标内容在模型）---- */
  const tools = ctx.get<ToolsService>('tools');
  for (const def of createGoalTools({ store, getSessionId: deps.getSessionId })) {
    ctx.effect(() => tools.register(def));
  }

  /* ---- ② /goal 命令族（激活权在人类：resume 重新授权 / stop 人工停）---- */
  const ui = ctx.get<UiNotifyFace>('ui');
  ctx.effect(() =>
    ctx.get<ChannelsCommandFace>('channels').registerCommand({
      name: 'goal',
      description:
        '长目标管理：/goal 查看状态；/goal resume 重新激活（重启后降级 needs-resume 时）；/goal stop 人工停止',
      source: 'plugin',
      handler: (args) => handleGoalCommand(args.trim(), { store, getSessionId: deps.getSessionId, ui }),
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
          const sessionId = deps.getSessionId();
          if (sessionId === undefined) return;
          const goal = store.get(sessionId);
          if (goal === undefined || !shouldContinueGoal(goal, settled.status)) return;
          // backgroundWake：计入自激预算 maxConsecutiveWakes=3——连续自动续跑
          // 封顶 3 轮（用户手写消息恢复预算）；超帽 deliver 自动降级 inject 只留记录。
          // 第二十四批题3a：无人值守续跑轮工具面收窄（needsWrite 未申报时）——
          // 机制级投影非提示词劝阻（letta token 扫描被绕过删除的反面教训）：
          // read 类工具 + goal_get/goal_update（结算件必须在场，否则续跑轮永远
          // 无法申报终态）；goal_set/goal_update 自身 effect 均为 write，靠名单
          // 显式保留而非 effect 过滤自然命中。开洞：goal_set 申报 needsWrite
          // 即不携带 toolFilter（续跑轮全量工具面）。
          const toolFilter = goal.needsWrite ? undefined : wakeToolFilter(tools.list());
          agent.sendUserMessage(renderContinuationPrompt(goal), {
            source: 'plugin:goal',
            backgroundWake: true,
            ...(toolFilter !== undefined ? { toolFilter } : {}),
          });
        } catch (err) {
          // 续跑触发异常止步日志（结算通知链不受插件违约影响——服务层另有隔离壳）
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
        const sessionId = deps.getSessionId();
        if (sessionId === undefined || envelope.sessionId !== sessionId) return;
        // 只对 active 行记账（needs-resume/stopped/终态不再累计——刹停后的收尾
        // 轮花销不属于本目标预算；先判状态再累加，读改写间无并发窗口）
        const current = store.get(sessionId);
        if (current === undefined || current.status !== 'active') return;
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
        const stopped = store.get(sessionId);
        if (stopped !== undefined) {
          agent?.sendUserMessage(renderBudgetExhaustedPrompt(stopped), { source: 'plugin:goal' });
        }
      } catch (err) {
        // fire-and-forget 纪律：刹车异常止步日志，绝不上抛进事件派发面
        ctx.logger.error('goal 预算刹车失败', { error: describeError(err) });
      }
    }),
  );
}

/** /goal 命令体（args 三形态：空 = 查状态 / resume / stop） */
function handleGoalCommand(
  args: string,
  opts: { store: GoalStore; getSessionId: () => string | undefined; ui: UiNotifyFace },
): void {
  const sessionId = opts.getSessionId();
  const goal = sessionId === undefined ? undefined : opts.store.get(sessionId);
  if (args === '') {
    opts.ui.notify(goal === undefined ? '当前会话没有设定目标（模型可 goal_set 设定）。' : renderGoalForUser(goal));
    return;
  }
  if (args === 'resume') {
    if (goal === undefined) {
      opts.ui.notify('当前会话没有目标可恢复（goal_set 先设定）。');
      return;
    }
    if (!canResumeGoal(goal)) {
      opts.ui.notify(`目标当前为 ${goal.status}——只有 needs-resume 态需要重新激活。`);
      return;
    }
    opts.store.reactivate(sessionId!, Date.now());
    opts.ui.notify('目标已重新激活（active）——下一轮结算起恢复续跑。');
    return;
  }
  if (args === 'stop') {
    if (goal === undefined) {
      opts.ui.notify('当前会话没有目标可停。');
      return;
    }
    if (!canStopGoal(goal)) {
      opts.ui.notify(`目标当前为 ${goal.status}——已是终态，无需停止。`);
      return;
    }
    opts.store.stopByUser(sessionId!, Date.now());
    opts.ui.notify('目标已人工停止（stopped/user）——不再续跑。');
    return;
  }
  opts.ui.notify('用法：/goal（查状态）| /goal resume | /goal stop');
}

/** goal 行 → 人读投影（命令面——与工具面 renderGoal 同口径，独立于人读排版） */
function renderGoalForUser(goal: GoalRecord): string {
  const lines = [
    `目标：${goal.objective}`,
    `状态：${goal.status}${goal.stopReason !== null ? `（原因：${goal.stopReason}）` : ''}`,
    `预算：已用 ${goal.tokensUsed} / ${goal.tokenBudget} tokens`,
  ];
  if (goal.evidence !== null) lines.push(`证据/原因：${goal.evidence}`);
  return lines.join('\n');
}
