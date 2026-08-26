/**
 * L3 scheduler — 官方件 `builtin:scheduler`（内核边界篇 §4.1 席 13 第一刀，
 * 默认层第五行，Ring 2 真·可卸）。
 *
 * tick 任务面：jobs 表（v7）+ `/tick add|list|rm|run` 命令 + runner 子进程
 * 单发。**无新循环机器、无新 ctx 面**——三件事全是已有原语的组合：
 * - 表经统一迁移框架（件静态声明 migrations）；
 * - 命令走 channels registerCommand（goal 件先例同构）；
 * - spawn 组装在组合根（app/scheduler-runner.ts——exec「tools 不 import
 *   exec」先例同构），件经闭包收 `runJob(prompt)`，结构上不见 exec。
 *
 * 触发序（冷读 #1/#2 裁决）：gate（discoveryGates 纯函数——两判据组合根
 * 闭包注入）→ 抢占（reserveRun 条件更新，changes=1 才花钱）→ runJob
 * （fire-and-forget 异步，完成回执 ui.notify）。
 *
 * persist:false 降级：无连接 warn 空转（goal 件同款——诊断面行可见、
 * 装载成功，语义诚实）。runner 缺省（诊断装配）：/tick run 报不可用，
 * add/list/rm 照常（表操作与 spawn 无关）。
 */

import { describeError } from '../contracts/errors.js';
import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import type { Disposer } from '../context/types.js';
import type { DatabaseConnection } from '../persist/index.js';
import { discoveryGates, WAKE_CHAIN_CAP, type DiscoveryGateDecision } from './gates.js';
import { JobsStore, JOB_NAME_PATTERN } from './store.js';
import type { JobRecord, TickRunResult } from './types.js';

/* ---------------------------------------------------------------------------------- */
/* 服务最小面（结构类型窄化——goal 件同款，模块不 import channels 实现）。                */
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

/** ui 通知面（命令回执出口——/tick 系列人读结果） */
interface UiNotifyFace {
  notify(message: string): void;
}

/** 官方件构造依赖（装配期闭包注入——官方件 = 宿主装配特权） */
export interface SchedulerPluginDeps {
  /** SQLite 连接（jobs 表物理载体）；缺省 = persist:false 降级 warn 空转 */
  readonly connection?: DatabaseConnection;
  /**
   * runner 单发（组合根闭包——spawn 组装在 app/scheduler-runner.ts：
   * argv 公式 + env set 注入 + 超时）。缺省（诊断装配无 spawn 面）=
   * /tick run 报不可用，表操作不受影响
   */
  readonly runJob?: (prompt: string) => Promise<TickRunResult>;
  /**
   * 敞开 turn 深度（gate 判据①——第二刀④：driverRef 进程内布尔退役，数据面
   * = events 表 turn/start·turn/end 配对投影，跨进程有效；组合根闭包注入）
   */
  readonly turnDepth: () => number;
  /** 当前会话最近 user/message 时刻（gate 判据②——定时子进程路恒 null 退化） */
  readonly lastUserMessageAt: () => number | null;
  /**
   * 当日后台道预算是否可负担（gate 判据③——= ctx.llm.canAfford('background')
   * 同一闭包，同一底账不建第二套账；never-unbounded 律 tick 入口执法）
   */
  readonly backgroundAffordable: () => boolean;
  /**
   * 同链自激唤醒连击数（gate 判据④——手动路不适用传 null；会话投递路注入
   * 驱动闭包计数，v1 数据面进程内内存态）
   */
  readonly wakeCount?: () => number | null;
  /** 判定时钟（缺省 Date.now——测试注入冻结） */
  readonly now?: () => number;
}

/** 构造 scheduler 官方件（builtins 注册表 `builtin:scheduler` 行） */
export function createSchedulerPlugin(deps: SchedulerPluginDeps): BuiltinPluginModule {
  return {
    name: 'scheduler',
    inject: ['channels', 'ui'],
    apply: (ctx: PluginContext) => applySchedulerPlugin(ctx, deps),
  };
}

/** 件 apply 本体（异常上抛走加载器统一回卷 PLUGIN_APPLY_FAILED） */
async function applySchedulerPlugin(ctx: PluginContext, deps: SchedulerPluginDeps): Promise<void> {
  // persist:false 降级：无物理层即无任务面——warn 空转（goal 件同款）
  if (!deps.connection) {
    ctx.logger.warn('无持久层（persist:false）——scheduler 官方件空转：/tick 命令不注册');
    return;
  }
  const store = new JobsStore(deps.connection);
  const ui = ctx.get<UiNotifyFace>('ui');
  ctx.effect(() =>
    ctx.get<ChannelsCommandFace>('channels').registerCommand({
      name: 'tick',
      description:
        'tick 任务面：/tick add <name> <prompt...> 新增（同名拒）| /tick list 清单 | /tick rm <name> 删除 | /tick run <name> 手动触发（只读子进程单发）',
      source: 'plugin',
      handler: (args) => handleTickCommand(args.trim(), { store, deps, ui }),
    }),
  );
}

/** 命令面依赖束（handler 闭包持有） */
interface TickCommandOpts {
  readonly store: JobsStore;
  readonly deps: SchedulerPluginDeps;
  readonly ui: UiNotifyFace;
}

/** /tick 命令体（args 四子命令分派） */
function handleTickCommand(args: string, opts: TickCommandOpts): void {
  const { store, deps, ui } = opts;
  // 子命令分词：首词子命令，余量整体传子命令（add 的 prompt 取余量含空格）
  const spaceAt = args.indexOf(' ');
  const sub = spaceAt === -1 ? args : args.slice(0, spaceAt);
  const rest = spaceAt === -1 ? '' : args.slice(spaceAt + 1);

  switch (sub) {
    case 'add':
      handleAdd(rest, opts);
      return;
    case 'list':
      handleList(opts);
      return;
    case 'rm':
      handleRemove(rest, opts);
      return;
    case 'run':
      handleRun(rest, opts);
      return;
    case '':
      ui.notify('用法：/tick add <name> <prompt...> | /tick list | /tick rm <name> | /tick run <name>');
      return;
    default:
      ui.notify(
        `未知子命令：${sub}——用法：/tick add <name> <prompt...> | /tick list | /tick rm <name> | /tick run <name>`,
      );
  }
}

/** /tick add：首空白分界 name/prompt；词法执法 + 同名拒回执 */
function handleAdd(rest: string, opts: TickCommandOpts): void {
  const trimmed = rest.trim();
  const spaceAt = trimmed.indexOf(' ');
  const name = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  const prompt = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1).trim();
  if (!JOB_NAME_PATTERN.test(name) || prompt === '') {
    opts.ui.notify('用法：/tick add <name> <prompt...>（name 限字母数字连字符下划线、不以连字符开头；prompt 非空）');
    return;
  }
  const outcome = opts.store.add(name, prompt, Date.now());
  if (outcome === 'duplicate') {
    opts.ui.notify(`任务已存在：${name}（同名拒——改错先 /tick rm ${name} 再 add）`);
    return;
  }
  opts.ui.notify(`任务已新增：${name}\nprompt：${prompt}`);
}

/** /tick list：任务清单人读投影（name + 最近触发 + prompt 首行截断） */
function handleList(opts: TickCommandOpts): void {
  const jobs = opts.store.list();
  if (jobs.length === 0) {
    opts.ui.notify('（无 tick 任务——/tick add <name> <prompt...> 新增）');
    return;
  }
  const lines = jobs.map((job) => {
    const lastRun = job.lastRunAt === null ? '未跑过' : new Date(job.lastRunAt).toISOString();
    // prompt 首行截断（多行 prompt 只示首行 60 字——清单面紧凑，全文在 add 回执）
    const preview = job.prompt.split('\n')[0]!.slice(0, 60);
    return `  ${job.name}  ${lastRun}  ${preview}`;
  });
  opts.ui.notify(`tick 任务（${jobs.length} 个，schedule 待第二刀执法——当前全手动触发）：\n${lines.join('\n')}`);
}

/** /tick rm：删除回执（删到/不存在两态） */
function handleRemove(rest: string, opts: TickCommandOpts): void {
  const name = rest.trim();
  if (name === '') {
    opts.ui.notify('用法：/tick rm <name>');
    return;
  }
  opts.ui.notify(opts.store.remove(name) ? `任务已删除：${name}` : `任务不存在：${name}`);
}

/**
 * /tick run：gate → 抢占 → 异步单发。
 * spawn 长跑（缺省 10 分钟预算）不冻结命令面——回执走完成时 ui.notify。
 */
function handleRun(rest: string, opts: TickCommandOpts): void {
  const { store, deps, ui } = opts;
  const name = rest.trim();
  if (name === '') {
    ui.notify('用法：/tick run <name>');
    return;
  }
  const job = store.get(name);
  if (job === undefined) {
    ui.notify(`任务不存在：${name}（/tick list 查看）`);
    return;
  }
  // gate：统一闸门四判据（busy 配对投影 / recent_user_msg / canAfford / 自激预算）
  // ——定时/事件/手动三触发同一纯函数（席 13④）；手动路 wakeCount 不适用传 null
  const decision = discoveryGates({
    turnDepth: deps.turnDepth(),
    lastUserMessageAt: deps.lastUserMessageAt(),
    backgroundAffordable: deps.backgroundAffordable(),
    wakeCount: deps.wakeCount?.() ?? null,
    now: (deps.now ?? Date.now)(),
  });
  if (!decision.ok) {
    ui.notify(renderGateRefusal(decision, name));
    return;
  }
  // 抢占：changes=1 才花钱（token 不可逆——reserve-then-run）
  const reserved = store.reserveRun(name, Date.now());
  if (reserved === 'lost-race') {
    ui.notify(`任务 ${name} 刚被并发触发（另一 berry 进程已抢占）——本侧让路不重跑。`);
    return;
  }
  if (deps.runJob === undefined) {
    ui.notify(`任务 ${name} 已抢占但 runner 未装配（诊断面无 spawn 面）——本次不跑。`);
    return;
  }
  ui.notify(`任务 ${name} 触发（只读子进程单发）——跑完回执，期间对话照常。`);
  // fire-and-forget：完成回执走 notify；异常止步通知（命令面不崩）
  deps
    .runJob(job.prompt)
    .then((result) => ui.notify(renderRunReceipt(name, result)))
    .catch((err: unknown) => ui.notify(`任务 ${name} 运行失败：${describeError(err)}`));
}

/** gate 拒绝回执（人读——四判据各自说明） */
function renderGateRefusal(decision: DiscoveryGateDecision, name: string): string {
  if (decision.reason === 'agent_busy') {
    return `任务 ${name} 未触发：agent 正在跑（等本轮结算后再 /tick run——防抢上下文）。`;
  }
  if (decision.reason === 'over_budget') {
    return `任务 ${name} 未触发：当日后台道预算已尽（canAfford 拒——无人值守烧钱顶，见 /usage）。`;
  }
  if (decision.reason === 'wake_cap') {
    return `任务 ${name} 未触发：自激唤醒连击已达上限（连续 ${WAKE_CHAIN_CAP} 次后台唤醒——防自旋，用户说句话即复位）。`;
  }
  return `任务 ${name} 未触发：你刚发过消息（30 秒内对话可能即将开跑——稍后再 /tick run）。`;
}

/** 运行回执：exit code + 时长 + stdout 尾部行（stdout 已过 60KiB 保尾预算） */
function renderRunReceipt(name: string, result: TickRunResult): string {
  const lines = [
    `tick ${name} 完成：exit ${result.exitCode ?? '（被信号杀）'}，用时 ${(result.durationMs / 1000).toFixed(1)}s`,
  ];
  const tail = result.stdout.trimEnd().split('\n').slice(-5).join('\n');
  if (tail !== '') lines.push(`---- stdout 尾部 ----\n${tail}`);
  if (result.stderr.trim() !== '') lines.push(`---- stderr ----\n${result.stderr.trimEnd()}`);
  return lines.join('\n');
}
