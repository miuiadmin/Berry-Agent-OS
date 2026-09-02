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
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import type { Disposer } from '../context/types.js';
import type { DatabaseConnection } from '../persist/index.js';
import { discoveryGates, WAKE_CHAIN_CAP, type DiscoveryGateDecision } from './gates.js';
import { looksLikeSchedule, parseSchedule } from './schedule.js';
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

/**
 * OS 定时注册面最小面（结构类型窄化——实现在组合根 app/tick-register.ts，
 * 件不 import app〔L3→L5 逆向边在结构上消失，runJob 先例同构〕）。
 * 回执 {ok, message} 人读直用——件面不做二次措辞。
 */
export interface OsRegistrarFace {
  /** 注册/覆盖注册（读任务行的 schedule 翻译 launchd/crontab 语义） */
  register(job: JobRecord): Promise<{ readonly ok: boolean; readonly message: string }>;
  /** 注销（未注册 = 幂等回执非错误） */
  unregister(name: string): Promise<{ readonly ok: boolean; readonly message: string }>;
  /** 是否已注册（list 行探测） */
  isRegistered(name: string): Promise<boolean>;
}

/**
 * goal 挂钟任务面（刀四 T7-B CR-7：goal→scheduler 操作面——组合根闭包注入
 * 窄面，**不立 ctx.schedule 新服务词汇**）。四法 + OS 注册联动：
 * - register：schedule 词法当场执法（parseSchedule 在本件——词法管辖权随
 *   面）+ putOwned upsert（名约定 goal-<goalId> 确定性——重挂即同行覆盖）+
 *   OS 注册器联动（在场时；缺席 = 注册面降级但行照写——回执如实示态）；
 * - disable/enable：enabled 位置 0/1（行留史 + OS 注册保留——CR-6 生命周期
 *   位；廉价 no-op 非反复注销重注册）；
 * - remove：删行 + OS 注销联动（防幽灵行——行没了 OS 还在到点白触发）。
 *
 * 结构类型窄化：goal 件（GoalChannel 槽）持自己的结构同形接口，零 import
 * 接线点在组合根 builtins.ts（lsp mountDiagnostics 先例同构——迟到注入：
 * goal 行第四行先装载、scheduler 行第五行装载完成时回填）。
 */
export interface GoalJobsFace {
  /** 挂钟/重挂（schedule 坏串 → {ok:false, message} 响亮拒绝） */
  register(input: {
    readonly goalId: string;
    readonly sessionId: string;
    readonly schedule: string;
    readonly promptSnapshot: string;
  }): Promise<{ readonly ok: boolean; readonly message: string }>;
  /** 终态/降级同笔停摆（行留史 OS 保留；无行 = 静默 no-op） */
  disable(goalId: string): Promise<void>;
  /** resume/重挂复活（无行 = 静默 no-op） */
  enable(goalId: string): Promise<void>;
  /** 摘钟（删行 + OS 注销；无行 = 静默 no-op） */
  remove(goalId: string): Promise<void>;
}

/** goal 挂钟行的确定性名约定（goal-<goalId>——合 JOB_NAME_PATTERN；名即寻径） */
export function goalJobName(goalId: string): string {
  return `goal-${goalId}`;
}

/** goal 挂钟归属行 id（owner 列恒值——组合根行 id，非运行时字符串约定耦合） */
export const GOAL_JOB_OWNER = 'builtin:goal';

/** 官方件构造依赖（装配期闭包注入——官方件 = 宿主装配特权） */
export interface SchedulerAppDeps {
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
  /**
   * OS 定时注册面（K2-d——launchd/crontab 注册器在组合根 app/tick-register.ts，
   * 闭包注入；缺省（诊断装配）= /tick enable·disable 报不可用，其余子命令
   * 不受影响，runJob 先例同构）
   */
  readonly osRegistrar?: OsRegistrarFace;
  /**
   * goal 挂钟面回填（刀四迟到注入）：scheduler 行装载完成（store 就绪）时
   * 回调——组合根接线 `(face) => goalChannel.mountSchedulerFace(face)`，
   * 返回摘除器（行回卷摘面：通道槽 miss → goal 侧响亮拒绝，两向诚实降级；
   * lsp mountDiagnostics 同构）。缺省（诊断装配无 goal 通道）= 不挂面。
   */
  readonly mountGoalJobs?: (face: GoalJobsFace) => Disposer;
  /** 判定时钟（缺省 Date.now——测试注入冻结） */
  readonly now?: () => number;
}

/** 构造 scheduler 官方件（builtins 注册表 `builtin:scheduler` 行） */
export function createSchedulerApp(deps: SchedulerAppDeps): BuiltinAppModule {
  return {
    name: 'scheduler',
    inject: ['channels', 'ui'],
    apply: (ctx: AppContext) => applySchedulerApp(ctx, deps),
  };
}

/** 件 apply 本体（异常上抛走加载器统一回卷 APP_APPLY_FAILED） */
async function applySchedulerApp(ctx: AppContext, deps: SchedulerAppDeps): Promise<void> {
  // persist:false 降级：无物理层即无任务面——warn 空转（goal 件同款）
  if (!deps.connection) {
    ctx.logger.warn('无持久层（persist:false）——scheduler 官方件空转：/tick 命令不注册');
    return;
  }
  const store = new JobsStore(deps.connection);
  const ui = ctx.get<UiNotifyFace>('ui');

  /* ---- goal 挂钟面构造 + 迟到注入回填（刀四 CR-7：store 就绪即可挂面）----
   * 面本体闭包持有 store/deps.osRegistrar/now；行回卷摘面（通道槽 miss →
   * goal 侧响亮拒绝「scheduler 未装载」）。回填失败止步 debug——goal 侧
   * 槽 miss 的响亮拒绝是完整 UX，本侧无需再报 */
  const goalFace: GoalJobsFace = {
    register: async (input) => {
      // schedule 词法执法（三形状 parse——管辖权在 scheduler 件，goal 侧只传原样串）
      const parsed = parseSchedule(input.schedule, (deps.now ?? Date.now)());
      if (!parsed.ok) {
        return { ok: false, message: `schedule 不合法：${parsed.error}` };
      }
      const now = (deps.now ?? Date.now)();
      // upsert：名确定性 goal-<goalId>（重挂 = 同行覆盖，last_run_at 触发史保留）
      store.putOwned({
        name: goalJobName(input.goalId),
        prompt: input.promptSnapshot,
        schedule: input.schedule,
        sessionId: input.sessionId,
        owner: GOAL_JOB_OWNER,
        ownerKey: input.goalId,
        now,
      });
      // OS 注册联动（K2-d 注册器；缺席 = 行已写、OS 面降级——回执如实示态）
      if (deps.osRegistrar !== undefined) {
        const osResult = await deps.osRegistrar.register(store.get(goalJobName(input.goalId))!);
        if (!osResult.ok) {
          return { ok: true, message: `挂钟已登记（OS 定时注册失败：${osResult.message}——重挂时再试）` };
        }
        return { ok: true, message: `挂钟已登记：${input.schedule}（OS 定时：${osResult.message}）` };
      }
      return { ok: true, message: `挂钟已登记：${input.schedule}（OS 注册面未装配——到点需在场自激或手跑）` };
    },
    disable: async (goalId) => {
      store.setOwnedEnabled(GOAL_JOB_OWNER, goalId, false, (deps.now ?? Date.now)());
    },
    enable: async (goalId) => {
      store.setOwnedEnabled(GOAL_JOB_OWNER, goalId, true, (deps.now ?? Date.now)());
    },
    remove: async (goalId) => {
      // 删行 + OS 注销联动（防幽灵行）；未删到 = 无钟可摘静默 no-op
      const name = store.removeOwned(GOAL_JOB_OWNER, goalId);
      if (name !== null && deps.osRegistrar !== undefined) {
        await deps.osRegistrar.unregister(name);
      }
    },
  };
  if (deps.mountGoalJobs !== undefined) {
    try {
      const disposeFace = deps.mountGoalJobs(goalFace);
      ctx.effect(() => disposeFace); // 行回卷摘面——此后通道槽 miss，goal 侧响亮拒绝
    } catch (err) {
      ctx.logger.debug('goal 挂钟面回填失败（组合根未接线——goal 侧将响亮拒绝）', {
        error: describeError(err),
      });
    }
  }

  ctx.effect(() =>
    ctx.get<ChannelsCommandFace>('channels').registerCommand({
      name: 'tick',
      description:
        'tick 任务面：/tick add <name> [schedule] <prompt...> 新增（schedule = once@<ISO>/every@<n>[mhd]/daily@HH:MM，可省）| /tick list 清单 | /tick rm <name> 删除 | /tick run <name> 手动触发（只读子进程单发）| /tick enable|disable <name> OS 定时注册/注销（launchd/crontab）',
      source: 'app',
      handler: (args) => handleTickCommand(args.trim(), { store, deps, ui }),
    }),
  );
}

/** 命令面依赖束（handler 闭包持有） */
interface TickCommandOpts {
  readonly store: JobsStore;
  readonly deps: SchedulerAppDeps;
  readonly ui: UiNotifyFace;
}

/** 用法串（子命令空/未知共用——单一事实源） */
const TICK_USAGE =
  '用法：/tick add <name> [schedule] <prompt...> | /tick list | /tick rm <name> | /tick run <name> | /tick enable|disable <name>（OS 定时注册）';

/** /tick 命令体（args 子命令分派；async——enable/disable/list 含注册器往返） */
async function handleTickCommand(args: string, opts: TickCommandOpts): Promise<void> {
  const { ui } = opts;
  // 子命令分词：首词子命令，余量整体传子命令（add 的 prompt 取余量含空格）
  const spaceAt = args.indexOf(' ');
  const sub = spaceAt === -1 ? args : args.slice(0, spaceAt);
  const rest = spaceAt === -1 ? '' : args.slice(spaceAt + 1);

  switch (sub) {
    case 'add':
      handleAdd(rest, opts);
      return;
    case 'list':
      await handleList(opts);
      return;
    case 'rm':
      await handleRemove(rest, opts);
      return;
    case 'run':
      handleRun(rest, opts);
      return;
    case 'enable':
      await handleToggle(rest, opts, 'enable');
      return;
    case 'disable':
      await handleToggle(rest, opts, 'disable');
      return;
    case '':
      ui.notify(TICK_USAGE);
      return;
    default:
      ui.notify(`未知子命令：${sub}——${TICK_USAGE}`);
  }
}

/**
 * /tick add：首空白分界 name/prompt；第二词若形如 schedule 声明（once@/
 * every@/daily@ 前缀嗅探）则吃作可选触发参数——`/tick add <name> [schedule] <prompt...>`。
 * schedule 词法当场执法（坏串拒入库——存库的都是过闸好串）。
 */
function handleAdd(rest: string, opts: TickCommandOpts): void {
  const trimmed = rest.trim();
  const firstSpace = trimmed.indexOf(' ');
  const name = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  let remainder = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
  // 可选 schedule：第二词前缀嗅探（looksLikeSchedule 三前缀——不形如声明则整体是 prompt）
  let schedule: string | null = null;
  const secondSpace = remainder.indexOf(' ');
  const secondWord = secondSpace === -1 ? remainder : remainder.slice(0, secondSpace);
  if (looksLikeSchedule(secondWord)) {
    schedule = secondWord;
    remainder = secondSpace === -1 ? '' : remainder.slice(secondSpace + 1).trim();
  }
  const prompt = remainder;
  if (!JOB_NAME_PATTERN.test(name) || prompt === '') {
    opts.ui.notify(
      '用法：/tick add <name> [schedule] <prompt...>（name 限字母数字连字符下划线、不以连字符开头；prompt 非空）',
    );
    return;
  }
  // schedule 词法执法（null = 仅手动触发，跳过）
  if (schedule !== null) {
    const parsed = parseSchedule(schedule, Date.now());
    if (!parsed.ok) {
      opts.ui.notify(`schedule 不合法：${parsed.error}`);
      return;
    }
  }
  const outcome = opts.store.add(name, prompt, Date.now(), schedule);
  if (outcome === 'duplicate') {
    opts.ui.notify(`任务已存在：${name}（同名拒——改错先 /tick rm ${name} 再 add）`);
    return;
  }
  const scheduleLine =
    schedule === null ? '触发：仅手动' : `触发：${schedule}（到点执行：/tick enable ${name} 注册 OS 定时）`;
  opts.ui.notify(`任务已新增：${name}\n${scheduleLine}\nprompt：${prompt}`);
}

/** /tick list：任务清单人读投影（name + schedule + OS 注册态 + 最近触发与记因 + prompt 首行截断） */
async function handleList(opts: TickCommandOpts): Promise<void> {
  const jobs = opts.store.list();
  if (jobs.length === 0) {
    opts.ui.notify('（无 tick 任务——/tick add <name> [schedule] <prompt...> 新增）');
    return;
  }
  // OS 注册态逐行探测（注册器缺席 = 全部「－」——诊断面不炸）
  const registered = await Promise.all(
    jobs.map(async (job) => (opts.deps.osRegistrar ? opts.deps.osRegistrar.isRegistered(job.name) : false)),
  );
  const lines = jobs.map((job, index) => {
    const schedule = job.schedule ?? '（仅手动）';
    const osState = opts.deps.osRegistrar === undefined ? '－' : registered[index] ? 'OS 已注册' : '未注册';
    const lastRun = job.lastRunAt === null ? '未跑过' : new Date(job.lastRunAt).toISOString();
    // 记因注记（manual/scheduled/missed——v9 列；未跑过时缺省空）
    const reason = job.lastRunReason === null ? '' : `〔${job.lastRunReason}〕`;
    // prompt 首行截断（多行 prompt 只示首行 60 字——清单面紧凑，全文在 add 回执）
    const preview = job.prompt.split('\n')[0]!.slice(0, 60);
    return `  ${job.name}  ${schedule}  ${osState}  ${lastRun}${reason}  ${preview}`;
  });
  opts.ui.notify(`tick 任务（${jobs.length} 个——OS 定时注册 /tick enable <name>）：\n${lines.join('\n')}`);
}

/** /tick rm：删除回执（删到/不存在两态）；删到时联动注销 OS 注册（防幽灵行——行没了 OS 还在到点白触发） */
async function handleRemove(rest: string, opts: TickCommandOpts): Promise<void> {
  const name = rest.trim();
  if (name === '') {
    opts.ui.notify('用法：/tick rm <name>');
    return;
  }
  if (!opts.store.remove(name)) {
    opts.ui.notify(`任务不存在：${name}`);
    return;
  }
  // 联动注销（注册器缺席跳过——诊断面；未注册幂等回执非错误）
  if (opts.deps.osRegistrar !== undefined) {
    const result = await opts.deps.osRegistrar.unregister(name);
    opts.ui.notify(`任务已删除：${name}\nOS 定时：${result.message}`);
    return;
  }
  opts.ui.notify(`任务已删除：${name}`);
}

/**
 * /tick enable|disable：OS 定时注册/注销（K2-d——注册器在组合根，件经闭包
 * 收面；schedule 缺席与 once 生命周期的拒因在注册器内裁，回执人读直用）。
 */
async function handleToggle(rest: string, opts: TickCommandOpts, action: 'enable' | 'disable'): Promise<void> {
  const { store, deps, ui } = opts;
  const name = rest.trim();
  if (name === '') {
    ui.notify(`用法：/tick ${action} <name>`);
    return;
  }
  if (deps.osRegistrar === undefined) {
    ui.notify(`OS 注册面未装配（诊断形态无系统操作面）——/tick ${action} 不可用；其余子命令不受影响。`);
    return;
  }
  if (action === 'disable') {
    const result = await deps.osRegistrar.unregister(name);
    ui.notify(result.ok ? `已注销（${name}）：\n${result.message}` : `注销失败（${name}）：${result.message}`);
    return;
  }
  const job = store.get(name);
  if (job === undefined) {
    ui.notify(`任务不存在：${name}（/tick list 查看）`);
    return;
  }
  const result = await deps.osRegistrar.register(job);
  ui.notify(result.ok ? `已注册 OS 定时（${name}）：\n${result.message}` : `注册失败（${name}）：${result.message}`);
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
  // 抢占：changes=1 才花钱（token 不可逆——reserve-then-run）；手动路记因 manual
  const reserved = store.reserveRun(name, Date.now(), 'manual');
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
