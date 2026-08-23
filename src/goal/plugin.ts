/**
 * L3 goal — 官方内置件（骨架篇 §6.8 `builtin:goal`，Ring 2 编排域官方件）。
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
 * needs-resume。session_start 在插件装载之前发出（boot 时序事实）——降级不订阅
 * 事件，走构造闭包 wasResumed 旗标；一次性旗标（bootDemotionArmed）保证
 * /reload 重激活不误降级（/reload 复用同一内置件实例，闭包旗标跨重载存活）。
 *
 * persist:false 降级：无连接即 warn 空转（同 memory 内置件——诊断面行可见、
 * 装载成功，语义诚实）。
 */

import { describeError } from '../contracts/errors.js';
import type { ToolDefinition } from '../contracts/tools.js';
import type { BuiltinPluginModule } from '../contracts/plugin.js';
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
/* ---------------------------------------------------------------------------------- */

/** 工具注册面（tools 服务最小面：插件贡献动词的唯一入口） */
interface ToolsRegisterFace {
  register(def: ToolDefinition): Disposer;
}

/** 命令注册面（channels 服务最小面——CommandDefinition 的结构子集） */
interface ChannelsCommandFace {
  registerCommand(cmd: {
    readonly name: string;
    readonly description: string;
    readonly source?: string;
    handler(args: string): void | Promise<void>;
  }): Disposer;
}

/** ctx.agent 服务最小面（agent-service.ts AgentServiceFace 的结构子集） */
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

/** 内置件构造依赖（装配期闭包注入——官方内置件 = 宿主装配特权） */
export interface GoalPluginDeps {
  /** SQLite 连接（goals 表物理载体）；缺省 = persist:false 降级 warn 空转 */
  readonly connection?: DatabaseConnection;
  /** 当前会话 id 活取值（/new 热切换后自动跟新会话走） */
  readonly getSessionId: () => string | undefined;
  /** boot 是否续接既有会话（session_start origin=resume 语义）——active 行降级触发器 */
  readonly wasResumed: boolean;
}

/**
 * 构造 goal 内置件（builtins 注册表 `builtin:goal` 行）。
 */
export function createGoalPlugin(deps: GoalPluginDeps): BuiltinPluginModule {
  // boot 降级一次性旗标：进程 boot 后首次 apply 执行降级即解除——/reload 复用
  // 同一模块实例重跑 apply，旗标已 false 不误降级（§6.7「/reload 不误降级」）
  let bootDemotionArmed = deps.wasResumed;
  return {
    name: 'goal',
    inject: ['tools', 'channels', 'agent', 'ui'],
    apply: (ctx: Context) =>
      applyGoalPlugin(ctx, deps, () => {
        const armed = bootDemotionArmed;
        bootDemotionArmed = false;
        return armed;
      }),
  };
}

/**
 * 内置件 apply 本体（接线序：boot 降级 → 工具三件 → /goal 命令 → 续跑触发 → 预算刹车）。
 * 异常上抛走加载器统一回卷（PLUGIN_APPLY_FAILED）。
 */
async function applyGoalPlugin(ctx: Context, deps: GoalPluginDeps, consumeBootDemotion: () => boolean): Promise<void> {
  // persist:false 降级：无物理层即无 goal（状态/记账/续跑全依赖 goals 表）——warn 空转
  if (!deps.connection) {
    ctx.logger.warn('无持久层（persist:false）——goal 内置件空转：工具/命令/续跑/预算刹车均不注册');
    return;
  }
  const store = new GoalStore(deps.connection);

  /* ---- ⓪ boot 降级（激活权不跨进程）：origin=resume 续接即 active ⇒ needs-resume ---- */
  if (consumeBootDemotion()) {
    const sessionId = deps.getSessionId();
    if (sessionId !== undefined) store.demoteToNeedsResume(sessionId, Date.now());
  }

  /* ---- ① 工具三件（目标内容在模型）---- */
  const tools = ctx.get<ToolsRegisterFace>('tools');
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

  /* ---- ③ 续跑触发：run 结算边界（completed 且 active 且预算未尽才续）---- */
  const agent = ctx.get<AgentServiceFace>('agent');
  ctx.effect(() =>
    agent.onRunSettled((settled) => {
      try {
        const sessionId = deps.getSessionId();
        if (sessionId === undefined) return;
        const goal = store.get(sessionId);
        if (goal === undefined || !shouldContinueGoal(goal, settled.status)) return;
        // backgroundWake：计入自激预算 maxConsecutiveWakes=3——连续自动续跑
        // 封顶 3 轮（用户手写消息恢复预算）；超帽 deliver 自动降级 inject 只留记录
        agent.sendUserMessage(renderContinuationPrompt(goal), { source: 'plugin:goal', backgroundWake: true });
      } catch (err) {
        // 续跑触发异常止步日志（结算通知链不受插件违约影响——服务层另有隔离壳）
        ctx.logger.error('goal 续跑触发失败', { error: describeError(err) });
      }
    }),
  );

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
        // 模型当轮收尾交代下一步；预算尽≠完成，提示词如实示态）
        store.stopByBudget(sessionId, goal.tokensUsed, Date.now());
        const stopped = store.get(sessionId);
        if (stopped !== undefined) {
          agent.sendUserMessage(renderBudgetExhaustedPrompt(stopped), { source: 'plugin:goal' });
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
