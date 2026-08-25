/**
 * L5 app — 组合根本体（骨架篇 §9：一切装配发生在这里，模块间零横向 import）。
 *
 * createBerryRuntime 把 M1 已落模块接线成真实可跑：
 * context 根作用域 → channels/ui → persist（session）→ llm（凭证适配注入）→
 * tools（fs 族 + 三段管道 + gate/decision durable）→ safety（审批 + 守门行 +
 * 可写根）→ skills（本地 provider + refresh）→ 插件装载 → 内置命令。
 *
 * 2026-08-24 应用面第一纵切（契约篇 §5.4 规范先行）：**对话应用装配本体迁
 * `builtin:chat` 官方件**（默认层首行）——会话选择/续接、durable 绑定、
 * request/header 差分化、ConversationDriver 构造、ctx.agent provide 全在件内；
 * 组合根不再直装对话，只持活引用槽（session/durable/driver/chat 控制面）与
 * 装配层接线（tools_change/prompts_change 刷新、/new 编排、/reload、信号与
 * 关停）。对话是应用不是内核（命题 §3.5）——overlay 禁用 chat 件即首启无对话
 * 循环、宿主照启（装/守/存职能与命令面完好）。
 */

import type { AgentMessage } from '../contracts/messages.js';
import type { StreamFn } from '../contracts/llm.js';
import { AppError, PLUGIN_LOAD_FAILED, describeError } from '../contracts/errors.js';
import { TOOLS_CHANGE_EVENT } from '../contracts/tools.js';
import { PROMPTS_CHANGE_EVENT, registerPromptsService } from './prompts.js';
import type { AgentTool } from '../contracts/tools.js';
import type { ContextScope } from '../context/types.js';
import { createContext } from '../context/context.js';
import { loadPlugins, type PluginSkillsInfo } from '../context/loader.js';
import { Persistence, localDayStartMs, spentBackgroundTokensSince } from '../persist/index.js';
import type { LlmRuntime, Provider } from '../llm/index.js';
import { createLlmRuntime, createLlmService, createStreamFn } from '../llm/index.js';
import { createToolPipeline } from '../tools/index.js';
import { registerToolsService } from '../tools/registry.js';
import type { ToolsService } from '../tools/registry.js';
import type { ToolPipelineExecutor } from '../tools/index.js';
import { createFsTools } from '../tools/fs.js';
import { createSearchTools } from '../tools/search.js';
import {
  APPROVAL_ANSWER_EVENT,
  createApprovalService,
  createRootsProvider,
  createSandboxService,
  installSafetyGate,
} from '../safety/index.js';
import type { ApprovalPolicyMode, ApprovalService, ApprovalRequest, SandboxMode } from '../safety/index.js';
// exec 件聚落（第 18 模块，2026-08-25 exec 纵切）：bash 工具件 + ctx.exec 服务 +
// environment 披露段——组合根双装配点注册（检索族先例）
import { createBashTool, registerExecService, renderEnvironmentSection } from '../exec/index.js';
import {
  createLocalSkillsProvider,
  createPackageSkillsProvider,
  createSkillsService,
  defaultSkillLocations,
  registerSkillsService,
} from '../skills/index.js';
import type { SkillLocation, SkillsService } from '../skills/index.js';
import { SKILLS_CHANGE_EVENT } from '../skills/index.js';
import { registerChannelServices } from '../channels/service.js';
import type { ChannelsServiceEntity } from '../channels/service.js';
import type { UiService } from '../channels/types.js';
import type { Session } from '../session/session.js';
import { isCoreSessionEventType } from '../contracts/session-events.js';
import { SESSION_CORE_TYPE_FORBIDDEN } from '../contracts/errors.js';
import type { SessionEvent } from '../contracts/events.js';
import { createDurableSinks, CHAT_APP_ID } from '../chat/index.js';
import type { DurableSinks, ConversationDriver, ChatControls } from '../chat/index.js';
import { createChatPlugin } from '../chat/index.js';
import { createPathsService, loadComposition, type CompositionReport } from './composition.js';
import { loadOfficialApps, assertAppComponents } from './app-registry.js';
import type { AppManifest } from '../contracts/app.js';
import { createBuiltinRegistry, collectBuiltinMigrations } from './builtins.js';
import { createMcpSpawner } from './mcp-spawn.js';
import { killTree } from '../exec/index.js';
import { createSubagentChildFactory } from './subagent-factory.js';
import { createTickRunner } from './scheduler-runner.js';
import { createJobsService, createSubagentsService } from '../subagent/index.js';
import type { SubagentSettlement } from '../contracts/subagent.js';
import { createSubagentNotifier } from './notify.js';
import { createPluginsService } from './plugins.js';
import type { PluginsService } from './plugins.js';
import { createCredentialStore } from './persist-bridge.js';
import { defaultConvertToLlm } from './convert.js';
import { registerBuiltinCommands } from './commands.js';
import { formatUsagePanel } from './usage.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, dbPath, ensureDbDir } from './paths.js';
import { setProjectAliases } from '../context/workspace.js';
import type { CompositionReloadedPayload } from '../contracts/events.js';

/**
 * 装载 project-aliases 表（记忆篇 §3 挂账——canonical 根重定向的物理面，
 * 2026-08-25 检索族纵切批兑现）。文件形如 { "<现根绝对路径>": "<记账根绝对路径>" }，
 * 键值均字符串；进程级一次设置（组合根 ①b），表换即清探测缓存。
 *
 * 容错口径：文件缺失或不可读 = 常态，零日志返回空表（别名表是可选逃生
 * 通道，缺它一切照旧）；读到内容但解析失败/形状不对 = warn 一次后整表
 * 丢弃——半张表比没表更难排查，不拒启只留痕。
 */
function loadProjectAliases(dir: string, warn: (message: string) => void): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(dir, 'project-aliases.json'), 'utf8');
  } catch {
    return {}; // 缺失/不可读：零日志空表
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warn('project-aliases.json 形状不对（须为 { 绝对路径: 绝对路径 } 对象），整表忽略');
      return {};
    }
    for (const value of Object.values(parsed)) {
      if (typeof value !== 'string') {
        warn('project-aliases.json 存在非字符串值（须为绝对路径），整表忽略');
        return {};
      }
    }
    return Object.fromEntries(Object.entries(parsed));
  } catch (err) {
    warn(`project-aliases.json 解析失败，整表忽略：${describeError(err)}`);
    return {};
  }
}

/** 缺省模型（Anthropic-first 拍板；APP_MODEL env 或 RuntimeOptions.model 覆盖） */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

/** M1 系统提示词基座（技能渐进披露清单在装配期拼接其后） */
const SYSTEM_PROMPT_BASE =
  'You are a terminal-based coding assistant. ' +
  'Use the available tools to read, write, and edit files in the workspace instead of guessing. ' +
  'Keep answers concise unless asked to elaborate.';

/** 组合根装配选项（全部可注入——测试用 :memory: 库 + scripted streamFn + faux provider） */
export interface RuntimeOptions {
  /** 会话库路径（缺省 dbPath()；测试传 ':memory:' 或临时文件） */
  readonly dbPath?: string;
  /** 是否持久化（false = 不开库——dump-config 诊断面用；缺省 true） */
  readonly persist?: boolean;
  /** 工作区根（缺省 process.cwd()） */
  readonly workspace?: string;
  /** 模型标识（缺省 APP_MODEL env → DEFAULT_MODEL） */
  readonly model?: string;
  /** 审批策略档（缺省 'ask'） */
  readonly approvalPolicy?: ApprovalPolicyMode;
  /** 沙箱档（缺省 'workspace-write'） */
  readonly sandboxMode?: SandboxMode;
  /** provider 集合（缺省 pi-ai 内置全家桶；测试传 faux provider） */
  readonly providers?: readonly Provider[];
  /** StreamFn 覆盖（测试注入 scripted 流；缺省由 llm 运行时组装） */
  readonly streamFn?: StreamFn;
  /** 技能发现位置（缺省 defaultSkillLocations；测试注入临时目录） */
  readonly skillLocations?: readonly SkillLocation[];
  /** 主目录（技能缺省位置推导用；缺省 os.homedir()——测试注入） */
  readonly homeDir?: string;
  /** 交互模式（true = 注册审批 answerer 接 ctx.ui；headless run 传 false） */
  readonly interactive?: boolean;
  /**
   * 启动会话策略（技术栈篇 §5 拍板，经 chat 件执行）：true = 按 cwd 续接最新
   * 会话（TUI 缺省）；string = 显式续接指定 id；缺省 = 新建（run 一次性语义）。
   * 目标不存在回落新建
   */
  readonly resumeSession?: boolean | string;
  /**
   * 组合树目录（overlay.yaml 与插件装机子树的根；缺省 dataDir()——
   * 测试注入临时目录，与生产路径完全同构）
   */
  readonly compositionDir?: string;
  /**
   * tick 单发 runner 覆盖（scheduler 件闭包注入——缺省 createTickRunner 真
   * spawn；测试注入假 runner 记 prompt 断言触发链，不真起子进程）
   */
  readonly tickRunner?: (prompt: string) => Promise<import('../scheduler/index.js').TickRunResult>;
}

/** 组合根产物（三个命令入口持有的运行时面） */
export interface BerryRuntime {
  /** 根作用域（插件 fork 的锚） */
  readonly ctx: ContextScope;
  /** 持久层（persist:false 时为 undefined） */
  readonly persistence: Persistence | undefined;
  /** 会话（persist:false 或 chat 件未装载时为 undefined；/new 热切换后指向新会话——活取值） */
  readonly session: Session | undefined;
  /** llm 运行时（streamFn 注入测试时仍存在——目录解析面可用） */
  readonly llm: LlmRuntime;
  /** 工具注册表（fs 四件已注册，管道已接） */
  readonly tools: ToolsService;
  readonly channels: ChannelsServiceEntity;
  readonly ui: UiService;
  readonly skills: SkillsService;
  readonly approval: ApprovalService;
  /** 组合树装载产物（合成行集 + 装载计划——dump-config / 诊断面；/reload 后活取值） */
  readonly composition: CompositionReport;
  /** 插件管理服务（ctx.plugins 同一实例——list/install/toggle/update 有状态面） */
  readonly plugins: PluginsService;
  /**
   * 官方应用清单（装载期解析——id → 清单；契约篇 §5.4 第二纵切。第三方面随
   * ctx.plugins install 装机期发现面挂账，出现即并入此表口径）
   */
  readonly apps: ReadonlyMap<string, AppManifest>;
  /**
   * 应用组件缺场表（id → 缺失装载身份串清单——在场断言产物；空表 = 全完整）。
   * 诊断出口（dump-config + debug 日志）；/reload 后活取值（组合树换装缺场可变）
   */
  readonly appGaps: ReadonlyMap<string, readonly string[]>;
  /** 生效组合（诊断输出用） */
  readonly model: string;
  readonly workspace: string;
  readonly sandboxMode: SandboxMode;
  readonly systemPrompt: string;
  /** 技能发现位置（dump-config 诊断输出用） */
  readonly skillLocations: readonly SkillLocation[];
  /**
   * 会话驱动（通道宿主面：submit / requestQuit）——chat 对话应用件的活句柄：
   * 件装载即就绪；persist:false 诊断装配或 overlay 禁用 chat 件时为 undefined
   * （宿主照启——命令面/插件管理完好，无对话循环）
   */
  readonly conversation: ConversationDriver | undefined;
  /** 开新会话（/new）：新 Session + durable 换指 + 时间线重置；无持久层、无驱动或 run 进行中返回 undefined */
  newSession(): Session | undefined;
  /**
   * 组合树全量重载（/reload，契约篇 §1.3 落码形态）：run 进行中被拒（busy）；
   * overlay 校验失败不动旧装配（error）；成功 = 锚 dispose → 重装 → 系统提示词
   * 重建 → composition/reloaded 派发（payload 三份行 id 清单）。失败行逐行报告
   * 不杀进程（boot 与 /reload 两面失败语义之 /reload 半边）。
   */
  reload(): Promise<ReloadResult>;
  /** 优雅关停（run 结算 → flush 屏障 → 关库 → ctx 回卷——骨架篇 §1.3 的进程内编排） */
  shutdown(): Promise<void>;
}

/** /reload 结果（成功载荷 + 两类拒绝/失败回执——TUI 薄壳直显，不二次判型） */
export interface ReloadResult {
  /** run 进行中被拒（与 /new 同准入判据——旧装配与进程原样保留） */
  readonly busy?: boolean;
  /** overlay/装载期异常（进程存活；message 走 describeError 统一口径） */
  readonly error?: string;
  /** 成功载荷（composition/reloaded 事件同款三份行 id 清单） */
  readonly payload?: CompositionReloadedPayload;
}

/**
 * 组装 Berry 运行时（组合根唯一入口；三个命令入口共用）。
 * 装配顺序即依赖序：ctx → channels → persist → llm → tools → safety → skills
 * → 插件装载（⑨，组合树 Ring 2/3 行；**首行 chat 件装载即会话选择/驱动构造/
 * ctx.agent provide 全就绪**）→ 命令（⑨b，闭包引用 plugins/reload——须后于装载
 * 声明）。全部注册走 ctx.provide/on/effect——作用域 dispose 即整体回卷。
 * async：插件装载（jiti import + apply）是异步序列（契约篇 §1）。
 */
export async function createBerryRuntime(opts: RuntimeOptions = {}): Promise<BerryRuntime> {
  const workspace = opts.workspace ?? process.cwd();
  const model = opts.model ?? process.env['APP_MODEL'] ?? DEFAULT_MODEL;
  const sandboxMode = opts.sandboxMode ?? 'workspace-write';
  const persistEnabled = opts.persist !== false;

  /* ---- ① 根作用域（模块加载器/插件 fork 的锚） ---- */
  const ctx = createContext({ name: 'app' });

  /* ---- ①b project-aliases 表装载（canonical 根重定向——context 宿主原语，
   * 记忆篇 §3 挂账随检索族纵切批兑现）：须早于任何 ownerKey/信任判定求值。
   * 文件缺失 = 常态零日志；存在但坏 JSON/形状不对 = warn 一次 + 空表（别名表
   * 是用户逃生通道，坏配置不拒启） ---- */
  setProjectAliases(loadProjectAliases(dataDir(), ctx.logger.warn.bind(ctx.logger)));

  /* ---- ② 通道与 UI 服务 ---- */
  const { channels, ui } = registerChannelServices(ctx);

  /* ---- ③ 持久层（persist:false 跳过——诊断面不落库） ---- */
  // 首启建档（paths.ts ensureDbDir）：库文件父目录须先在——三入口共用的唯一
  // 建档点（幂等 mkdir recursive；TUI 入口原早调已收编至此单点。建档对象是
  // 实际库路径的父目录：缺省 = 数据目录，显式注入/APP_DB_PATH 同样覆盖。
  // 2026-08-25 修：原先仅 TUI 入口建档，全新机器 berry run 在 Persistence.open
  // 即 ENOENT——深读 workflow 实证缺口）。persist:false 诊断面保持零副作用不建。
  const resolvedDbPath = opts.dbPath ?? dbPath();
  if (persistEnabled && resolvedDbPath !== ':memory:') ensureDbDir(resolvedDbPath);
  const persistence = persistEnabled
    ? Persistence.open({
        path: resolvedDbPath,
        // 业务表迁移链聚合（会话篇 §6 统一迁移框架——persist 提供框架不认识业务表）：
        // 静态声明面机械聚合（tick 第一刀兑现第十六批题十五目标态）——memory v2-v4
        // + goals v5 + jobs v7 全出自官方件注册表文件的 collectBuiltinMigrations，
        // 此后每加带表件本调用零改动。sessions.app 列 v6 由 persist 自注入（内核
        // 表迁移——openStore 内部并入链，业务调用方不感知）
        migrations: collectBuiltinMigrations(),
        // session/event 活体镜像（契约篇 §2.2 emit 模式行）：SessionEvent 入
        // write-behind 队列后同步上总线，载荷 { sessionId, event } 信封（dsh-11
        // 规则——多会话并存时订阅方必须能从载荷分辨归属）。createSession /
        // loadSession / forkSession 三路接线统一经此镜像，/new 新会话自动同接线
        onLiveEvent: (sessionId, event) => ctx.emit('session/event', { sessionId, event }),
      })
    : undefined;

  /* ---- ③b 会话/durable/驱动/件控制面 四活引用槽（应用面第一纵切） ----
   * 会话选择与驱动构造在 `builtin:chat` 件 apply（默认层首行装载即就绪）；
   * 组合根持槽 + durable 转发壳：已建服务（llm onUsage / ctx.sessions / 管道
   * 守门 sink / 审批 sink）构造期绑壳或闭包读槽，件绑定后即刻生效；/new 换指
   * 写同一活引用槽，不动已建服务的绑定（late-binding 既有先例的延伸）。 */
  let session: Session | undefined;
  /** boot 是否续接（goal 降级触发器读它——chat 件（首行）先装载，goal 轮次激活必晚于回写） */
  let resumedFlag = false;
  /** durable 活引用槽（boot 绑定与 /new 换指都写这里） */
  const durableRef: { current: DurableSinks | undefined } = { current: undefined };
  // durable 转发壳（无条件存在——件未装载/无持久层时三路皆 no-op，与今日
  // persist:false 同款降级）：管道守门与审批对构造期绑壳，落账永远到当前会话
  const durableForward: DurableSinks = {
    handle: (event) => durableRef.current?.handle(event),
    gate: (payload) => durableRef.current?.gate(payload),
    approval: {
      asked: (payload) => durableRef.current?.approval.asked(payload),
      decided: (payload) => durableRef.current?.approval.decided(payload),
    },
  };
  /** 会话驱动活句柄槽（chat 件构造后写入；runtime 面 / reload busy 判据 / 双入口读它） */
  const driverRef: { current: ConversationDriver | undefined } = { current: undefined };
  /** chat 件控制面槽（writeHeader/resetHeaderState/resetTimeline——件 apply 末写入） */
  const chatRef: { current: ChatControls | undefined } = { current: undefined };
  /** sandbox 档事实盖章（内核守门面数据 + dedup 内建；件在会话边界调时点——内核有数据，应用有时点） */
  const stampSandboxFacts = (target: Session): void => {
    const last = [...target.events].reverse().find((e) => e.type === 'sandbox/mode');
    if ((last?.data as { mode?: string } | undefined)?.mode !== sandboxMode) {
      target.append('sandbox/mode', { mode: sandboxMode });
    }
  };

  /* ---- ③c 官方应用清单装载（契约篇 §5.4 应用面第二纵切）----
   * 官方清单 = 宿主包内静态已知（仓库根 apps/*.app.yaml），装载期直接解析——
   * 解析/校验失败 = 启动断言拒启（官方件随包，坏 = 发版事故，宁拒绝不误读）；
   * 第三方清单 glob 发现面挂账随 ctx.plugins install。预算表随清单构建
   * （canAfford app 维数据源——④b llm 服务闭包读它，装载序上先行）。 */
  const officialApps = loadOfficialApps();
  /** 应用预算表（id → budget.dailyTokens；未入表 = 未声明 = 恒 true 不闸） */
  const appBudgets = new Map<string, number>();
  for (const [id, manifest] of officialApps) {
    if (manifest.budget?.dailyTokens !== undefined) {
      appBudgets.set(id, manifest.budget.dailyTokens);
    }
  }
  /** context_transform 桥（契约篇 §2.2 增补 5②）：loop 私有回调桥为根总线瀑布——根 ctx 恒存活（插件监听集随 /reload 更替），驱动绑此桥跨重装载稳定 */
  const transformContext = (messages: AgentMessage[]): Promise<AgentMessage[]> =>
    ctx.waterfall('context_transform', messages, (final: AgentMessage[]) => final);

  /* ---- ④ llm 运行时（凭证经 persist 适配注入；测试可整体换 streamFn） ---- */
  const llm = createLlmRuntime({
    ...(persistence ? { credentials: createCredentialStore(persistence.store) } : {}),
    ...(opts.providers ? { providers: opts.providers } : {}),
  });
  const streamFn: StreamFn = opts.streamFn ?? createStreamFn(llm);

  /* ---- ④b llm 具名服务（ctx.llm：插件单发补全唯一合法路径 + canAfford 预算闸门，骨架篇 §9.3） ---- */
  ctx.provide(
    'llm',
    createLlmService({
      runtime: llm,
      defaultModel: () => model,
      // 底账写侧（2026-08-24 第十一批拍板 #1，会话篇 §1.1）：complete 成功即落
      // llm/usage durable 事件（log-only 计量事实；callId = settlement 幂等身份，
      // write-behind 重试去重锚点）。session 为活引用闭包（chat 件绑定后生效——
      // /new 热切换后记到新会话）；无会话（诊断装配/件未装载）只 debug 不落账
      onUsage: (result, modelSpec) => {
        session?.append('llm/usage', {
          callId: result.callId,
          model: modelSpec,
          priority: result.priority,
          usage: { input: result.usage.input, output: result.usage.output },
        });
        ctx.logger.debug('llm.complete 用量入账', { model: modelSpec, totalTokens: result.usage.totalTokens });
      },
      // 底账读侧：当日后台累计 = llm/usage 事件当日时间窗聚合投影（persist 实现，
      // 余额不存储——重启不清零、双开经 WAL 各记可见、当日谁花了多少可审计）
      ...(persistence
        ? { backgroundSpentToday: () => spentBackgroundTokensSince(persistence.store, localDayStartMs()) }
        : {}),
      // canAfford 第三维 app 数据源（契约篇 §5.4 第二纵切）：预算表 = ③c 官方清单
      // budget.dailyTokens（未声明恒 true）；应用域已耗 = llm/usage 事件按
      // sessions.app 会话域投影的当日聚合（底账同源不同切面，persist 实现）
      appBudget: (app: string) => appBudgets.get(app),
      ...(persistence
        ? {
            appSpentToday: (app: string) => spentBackgroundTokensSince(persistence.store, localDayStartMs(), app),
          }
        : {}),
    }),
  );

  /* ---- ④c Job 注册表（ctx.jobs，骨架篇 §6.2 落码注记）----
   * 后台任务/一次性后台委派的进程内登记项（subagent 模块提供实现）：状态机
   * running→stopping→唯一终态，first-wins 结算，done 永不 reject。生命周期挂根
   * 作用域 effect（dispose 兜底 fire-and-forget 排空）；关停主路径在 shutdown 里
   * persistence.close 前显式 await drain()——executor 结算路可能仍写子会话事件。
   * 提供时点在插件装载 ⑨ 前：插件（subagent/process 委派件）inject 即得。 */
  const jobs = createJobsService(ctx);
  ctx.provide('jobs', jobs);

  /* ---- ④d 子代理服务（ctx.subagents，骨架篇 §6.1 落码注记）----
   * provider 注册表 + 能力协商布尔检查 + background Job 接线（stopReason→终态
   * 映射唯一持有处）+ onSettle 结算回调（§6.4：结算折叠 + 三通道通知）。
   * in-process provider 的每子装配工厂在纵切四随默认插件行落地（工厂闭包持
   * streamFn/父会话/persistence——组合根侧零件，此处不装配）。
   * 提供时点与 jobs 同理：插件装载 ⑨ 前，委派件 inject 即得。onSettle 经晚绑定
   * 挂点接线——通知器需要驱动与活会话引用（应用面第一纵切起两者皆活句柄，
   * ⑨ 装载后收口，见下）。 */
  let onSubagentSettle: ((settlement: SubagentSettlement) => void) | undefined;
  const subagents = createSubagentsService(ctx, {
    jobs,
    onSettle: (settlement) => onSubagentSettle?.(settlement),
  });
  ctx.provide('subagents', subagents);

  /* ---- ④e ctx.agent 具名服务（骨架篇 §9.3）——已随驱动迁 `builtin:chat` 件 ----
   * 服务与驱动同件同生命周期（件 apply 即 provide；/reload 销锚随件回卷、重装
   * 重建）。chat 行居默认层首行 → 轮次激活先于一切消费方（goal 等 inject
   * 'agent' 结构性取得，晚绑定 attach 挂点退役——件聚落 src/chat/plugin.ts）。 */

  /* ---- ④f 会话事件服务（ctx.sessions，骨架篇 §9.2 落码——最小面 v1）----
   * 插件落 durable 事件的唯一正门（会话篇 §8 拍板落点）：appendEvent 走活引用
   * 闭包读当前会话（chat 件绑定后生效——/new 热切换自动跟随，与 onUsage 同款
   * late-binding）；无会话（诊断装配或 chat 件未装载）返回 undefined，调用方各自降级。
   * 核心词汇伪造防护：内核词（user/message 等核心 14 类）的写入权属宿主——归因
   *（sendUserMessage source）/审批/结算语义全绑在宿主写点，插件经服务面伪造即
   * SESSION_CORE_TYPE_FORBIDDEN 响亮拒绝（内核边界，契约篇）；插件只许写自注册
   * 词汇（session.append 侧对未注册类型还有 SESSION_FORMAT_UNSUPPORTED 二道闸）。
   * 服务必须无条件 provide（即便 persist:false）——inject 是 Kahn 硬依赖，缺供
   * 即启动断言拒启。 */
  ctx.provide('sessions', {
    appendEvent: (type: string, data: unknown): SessionEvent | undefined => {
      // 核心词判据单一来源（contracts——注册侧同尺，两道闸一道判据）
      if (isCoreSessionEventType(type)) {
        throw new AppError(
          SESSION_CORE_TYPE_FORBIDDEN,
          `核心事件词汇不允许插件经 ctx.sessions.appendEvent 写入：${type}（内核词写入权属宿主，插件请注册自有词汇）`,
        );
      }
      return session?.append(type, data);
    },
  });

  /* ---- ⑤ 工具注册表 + 三段管道（gate/decision 落 durable——绑转发壳，件绑定后生效） ---- */
  const pipeline: ToolPipelineExecutor = createToolPipeline(ctx, {
    onGateDecision: durableForward.gate,
  });
  const tools = registerToolsService(ctx, { pipeline });
  // fs 工具族 + 检索族（可写根走 safety 档位推导——mode getter 形态与守门行
  // 同源：read-only 空根拒全量写、danger 全盘根、workspace-write 三根；原
  // entries 死参已删——carve-out 属守门行审批面。find/grep 只读族无 fence
  // 需求——读任意位置允许，与 read 工具同口径）
  const writableRoots = createRootsProvider({ workspace, mode: () => sandboxMode });
  const fsTools = createFsTools({ writableRoots, workspace: () => workspace });
  const searchTools = createSearchTools({ workspace: () => workspace });
  for (const def of [...fsTools.tools, ...searchTools.tools]) tools.register(def);

  /* ---- ⑥ 审批 + 守门行（审批对绑转发壳，件绑定后落 durable） ---- */
  const approval = createApprovalService(ctx, {
    policy: opts.approvalPolicy ?? 'ask',
    sink: durableForward.approval,
  });
  ctx.effect(() => installSafetyGate(ctx, { approval, workspace, mode: () => sandboxMode }));
  // sandbox 档首落随会话边界进 chat 件（③b stampSandboxFacts——内核有数据，
  // 应用有时点；续接同档不重复落的 diff 语义内建于盖章函数）

  /* ---- ⑥b exec 件聚落（第 18 模块，2026-08-25 exec 纵切）----
   * 沙箱 confine 服务此前零组合根装配（safety 落码时无消费方——exec 双面即
   * 首批消费方，接线债本批收口）。bash 工具件在审批服务之后注册：升权两参数
   * 是 requestEscalation 的首个消费者（依赖 approval 实例）；ctx.exec 服务同
   * 管道同沙箱——服务调用不旁路守门与落账（内部名 exec 不进模型词汇表）。 */
  const sandbox = createSandboxService();
  ctx.provide('sandbox', sandbox);
  tools.register(createBashTool({ sandbox, approval, mode: () => sandboxMode, workspaceRoot: workspace }));
  registerExecService(ctx, { pipeline, sandbox, mode: () => sandboxMode, workspaceRoot: workspace });

  /* ---- ⑦ 技能（本地 provider 发现 + 渐进披露清单进系统提示词）----
   * 具名提示词段服务（ctx.prompts，pi-4(a) 拍板）：段注册表宿主拥有，分节序固定 =
   * 基座 → 技能渐进披露 → 具名段（id 字典序）；render() 仅在重建时点求值物化，
   * 段内容随快照冻结（禁整串替换与 per-run 重写两毒品形态——契约篇 §1.3 五件） */
  const { service: prompts, host: promptsHost } = registerPromptsService(ctx);
  // environment 披露段（骨架篇 §7.3——exec 刀配套披露）：宿主自留地首例，
  // 走宿主半边通道（无 `/` 单段 id；插件面注册此类 id 即拒）。快照语义：
  // render 时现取档位/工作区——boot / /reload / /new 重建时点物化新值
  promptsHost.registerHostSection({
    id: 'environment',
    render: () => renderEnvironmentSection({ mode: () => sandboxMode, workspaceRoot: () => workspace }),
  });
  // 提供方链变更广播桥（契约篇 §2.2 增补 6，#17 收口）：服务保持纯（不持 ctx），
  // 组合根经 onProvidersChange 桥接总线——广播与 provide 收在同一时点，无窗口期
  const skills = createSkillsService({
    onProvidersChange: (providerIds) => ctx.emit(SKILLS_CHANGE_EVENT, { providers: providerIds }),
  });
  registerSkillsService(ctx, skills);
  const locations = opts.skillLocations ?? defaultSkillLocations(workspace, { homeDir: opts.homeDir, trusted: true });
  skills.registerProvider(createLocalSkillsProvider({ locations }));
  skills.refresh();
  // 系统提示词活视图（/reload 重建）：let 绑定 + rebuild 闭包改写——chat 件的
  // header 落账与 loop 上下文经 getter 读当前值（loop 每次模型请求重读
  // context.systemPrompt，/reload 后新提示词下次请求即见）
  let systemPrompt = [SYSTEM_PROMPT_BASE, skills.renderAvailableSkills(), prompts.materialize()]
    .filter((part) => part !== '')
    .join('\n');
  /** 重建系统提示词（/reload、/new、段集变更后调）：技能重扫 + 具名段重物化 + 重拼 */
  const rebuildSystemPrompt = (): void => {
    skills.refresh();
    systemPrompt = [SYSTEM_PROMPT_BASE, skills.renderAvailableSkills(), prompts.materialize()]
      .filter((part) => part !== '')
      .join('\n');
  };

  /* ---- ⑧ 装载层接线（骨架篇 §9.2 装配层接线义务——刷新 loop 活视图；驱动本体随 chat 件走） ---- */
  // loop 工具快照的活数组（组合根分配、chat 件填首帧）：loop 每次模型请求与
  // 每次 tool call 查找都读 context.tools——原位替换（length=0 + push）即达
  // loop，含 run 中途；tools_change 时在下方接线处刷新
  const toolView: AgentTool[] = [];
  // 装载窗口（骨架篇 §9.2 注记）：boot ⑨ 与 /reload 的批量装载期间，工具/段注册
  // 只刷活视图不逐条落 header——装载期中间态非模型可见时点，逐条快照只产噪声且
  // 窃走首请求的 initial 名分（会话篇 §1.3 腿 2）；窗口收口统一落账（boot 首请求
  // initial/resume，/reload 收口单张 change）。窗口外的运行时注册仍即时落 change
  //（「模型可见即落日志」不变）
  let loadWindow = true;
  // tools_change → 刷新 loop 工具快照 + 即时落 request/header 快照（骨架篇 §9.2
  // 接线义务；会话篇 §1.3 腿 2「仅变化才快照」——writeHeader 内建 diff，toolSchemas
  // 变了才落 reason=change，run 中途换工具也当场留痕）。注册在装配期 fs 工具族
  // 之后：装配期注册不触发（首张 header 仍由首 run 落）；chat 件未装载时 chatRef
  // 空——数组照刷（无 run 即无模型可见性），header 落账自然跳过
  const unwatchToolsChange = ctx.on(TOOLS_CHANGE_EVENT, () => {
    const fresh = tools.list().map((def) => tools.toAgentTool(def));
    toolView.length = 0;
    toolView.push(...fresh);
    if (loadWindow) return; // 装载窗口内不逐条落账——窗口收口统一落
    chatRef.current?.writeHeader();
  });
  // prompts_change → 重建系统提示词 + 即时落 header 快照（pi-4(a) 落码形态④，与
  // tools_change 同族）：段集只在装载//reload 两时点变（注册/注销即广播）；装配层
  // 同点完成重建——订阅者是观测刷新，不承担重建。writeHeader 内建 diff：段内容
  // 变了才落 reason=change，没变不污染日志
  const unwatchPromptsChange = ctx.on(PROMPTS_CHANGE_EVENT, () => {
    rebuildSystemPrompt();
    if (loadWindow) return; // 装载窗口内不逐条落账——窗口收口统一落
    chatRef.current?.writeHeader();
  });
  // skills_change → 重建系统提示词 + 即时落 header 快照（契约篇 §2.2 增补 6，
  // 变更事件族第 3 件，与 prompts_change 同构）：provider 链变更（插件热注册/
  // 卸载技能来源）即时重建——渐进披露随 rebuildSystemPrompt 内的 skills.refresh()
  // 重扫。单一机制收口（树干原则）：boot ⑨ 装载窗口内事件照发、重建即时幂等
  // （窗口收口由 header 落账闸统一），不加收口补丁——此前插件技能提供方
  // 装机即隐身，可见性靠 /reload //new 或无关插件注册段捎带 rebuild 的偶然耦合
  const unwatchSkillsChange = ctx.on(SKILLS_CHANGE_EVENT, () => {
    rebuildSystemPrompt();
    if (loadWindow) return; // 装载窗口内不逐条落账——窗口收口统一落
    chatRef.current?.writeHeader();
  });
  /** 退订三个变更监听（关停序在 flush/close 前调用）：ctx 回卷会逐件注销插件工具/ 段/技能提供方（tools_change/prompts_change/skills_change 随之广播），若库已关监听仍在，会向死连接 append header、重物化简报段——关停期变更非模型可见时点且永不落盘，纯噪声 */
  const unwatchChangeEvents = (): void => {
    unwatchToolsChange();
    unwatchPromptsChange();
    unwatchSkillsChange();
  };

  /* ---- ⑧b 开新会话（/new 热切换）：新 Session + durable 换指 + 时间线重置 ----
   * 编排留组合根（与 /reload 同族——全为宿主资源调度），件内状态（header 差分
   * 基线/时间线）经 chatRef 控制面复位。 */
  const startNewSession = (): Session | undefined => {
    // run 进行中拒绝热切换（时间线正被 loop 引用）；无持久层/无驱动（件未装载）无事可做
    const driver = driverRef.current;
    if (!persistence || driver === undefined || driver.isRunning) return undefined;
    // /new 新会话仍落 chat 域（默认入口期——/app 前台进入是第三纵切，届时按显式域打标）
    const fresh = persistence.createSession({ cwd: workspace, profile: 'default', app: CHAT_APP_ID });
    session = fresh;
    resumedFlag = false;
    durableRef.current = createDurableSinks(fresh, { model });
    // 新会话首事件：sandbox 档（新会话 fold 从零起步，必落——dedup 内建等价无条件落）
    stampSandboxFacts(fresh);
    // header 落账状态复位：新会话首快照 reason=initial、diff 基线清零
    chatRef.current?.resetHeaderState();
    // /new 重建时点（pi-4(a) 落码形态③）：具名段重物化——简报等段内容随新会话
    // 快照冻结（旧会话会话内不漂移的对称面：跨会话时点刷新）
    rebuildSystemPrompt();
    driver.resetTimeline();
    // /new 新会话落定同发 session_start（§6.4 落码注记——触发点之一；origin=initial）
    ctx.emit('session_start', { sessionId: fresh.header.sessionId, origin: 'initial' });
    return fresh;
  };

  /* ---- ⑨ 组合树 + 插件装载（契约篇 §5.1/§1：Ring 2/3 行走树；Ring 0/1 仍硬装配，树化 seam） ----
   * 服务全部就位后再装插件（inject 依赖驱动轮次激活——宿主服务首轮即全就绪）；
   * **首行 chat 件装载即会话选择/驱动构造/ctx.agent provide 全就绪**（其后行的
   * 工具注册经 ⑧ 已接线的 tools_change 原位刷新 loop 工具快照，含 run 中途）。
   *
   * 卸载基底 = 插件锚作用域（§1.3 落码形态①）：全体插件 scope 自锚 fork、自定义
   * 事件词汇挂锚 effect——锚 dispose 即 LIFO 级联回卷一切插件注册（工具/监听/服务/
   * 词汇），/reload 的卸载半边由此成立；重锚 = ctx.fork 再派生（注册表同根共享）。
   * chat 件的驱动为件内单例——重装载 apply 复用驱动（时间线存续），只重接
   * provide 与结算接线。jiti moduleCache:false 是两条缓存纪律的 v1 基底（重装即
   * 全依赖图重求值）。plugins 服务 provide 一次（§1.3 服务集恒定）：boot 与
   * /reload 经 applyLoad 就地更新状态，热应用期间服务引用永不断链。
   * 失败行两面语义（§1.6）：boot = 启动断言拒绝启动（先收尾持久层再回卷 ctx，抛全量
   * 清单）；/reload = 逐行响亮报告、进程存活（local 源「改动 + /reload 即见」环）。 */
  const compositionDir = opts.compositionDir ?? dataDir();
  ctx.provide('paths', createPathsService(compositionDir));
  const plugins = createPluginsService({ dataDir: compositionDir });
  ctx.provide('plugins', plugins);
  /**
   * convertToLm 未注册角色丢弃的 debug 上报（#16 拍板 (c)——蒸发陷阱留痕）：
   * 第三方注入自造角色名曾是全静默过滤（无错无日志），此处接根 logger 让丢弃
   * 一目了然。注册角色的 toLlm:null 是设计内过滤，不走上报（免刷日志）。
   */
  const reportDroppedRole = (role: string): void => {
    ctx.logger.debug(
      `convertToLm 丢弃未注册角色消息：${role}（自定义角色须先注册——插件面 ctx.registerMessageRole，角色名必含 / 域前缀）`,
    );
  };
  // 官方件注册表（契约篇 §6.1 `builtin:` 前缀唯一解析面）：官方随包件闭包注入
  // 宿主活资源（官方件 = 宿主装配特权——不新开 ctx 服务名）。persist:false 时
  // 无 store，memory 官方件降级空转（warn 进日志）；subagent 真工厂闭包 streamFn/
  // model/活会话引用/父沙箱档/根总线（app/subagent-factory.ts——每子独立装配序）；
  // chat 件收会话选择/驱动/ctx.agent 四件（件聚落 src/chat/plugin.ts）——无条件注入，
  // 无持久层时件自降级空转（装载面完好——dump-config 诊断树不断链）；
  // scheduler 件收 gate 判据两闭包 + runner（spawn 组装在 app/scheduler-runner.ts
  // ——argv 公式 + env set 注入 + 10 分钟超时，席 13 第一刀）
  const tickRunner =
    opts.tickRunner ??
    createTickRunner({
      dataDir: dataDir(),
      dbPath: resolvedDbPath,
    });
  /** gate 判据②：当前会话最近 user/message 时刻（会话活对象内存直读——
   * append 即在，write-behind 零滞后；跨进程的「别打架」不归 gate 管，那是
   * reserve 抢占的职责，两护栏分工） */
  const lastUserMessageAt = (): number | null => {
    const events = session?.events;
    if (events === undefined) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type === 'user/message') return event.time;
    }
    return null;
  };
  const builtins = createBuiltinRegistry({
    ...(persistence ? { store: persistence.store } : {}),
    ...(persistence ? { goalConnection: persistence.store.connection } : {}),
    schedulerDeps: {
      runJob: tickRunner,
      isAgentBusy: () => driverRef.current?.isRunning ?? false,
      lastUserMessageAt,
    },
    // mcp 件闭包（契约篇 §6.6 冷读 #1：spawn/kill 组装上提组合根——
    // spawnServer 在 app/mcp-spawn.ts，killTree 自 exec 公开面；登记簿根
    // 钉数据目录，与 overlay 同根不随会话漂移）
    mcpDeps: {
      spawnServer: createMcpSpawner(dataDir()),
      killTree,
      dataDir: dataDir(),
    },
    workspace: () => workspace,
    subagentFactory: createSubagentChildFactory({
      ...(persistence ? { persistence } : {}),
      getSession: () => session,
      streamFn,
      model,
      convertToLlm: (messages) => defaultConvertToLlm(messages, reportDroppedRole),
      workspace,
      sandboxMode,
      rootCtx: ctx,
    }),
    getSession: () => session,
    // boot 降级触发器活取值（goal apply 期读——chat 件（首行）先装载，读必居值）
    wasResumed: () => resumedFlag,
    chat: createChatPlugin({
      ...(persistence ? { persistence } : {}),
      resumeSession: opts.resumeSession,
      workspace,
      model,
      sandboxMode,
      streamFn,
      convertToLlm: (messages) => defaultConvertToLlm(messages, reportDroppedRole),
      transformContext,
      getSystemPrompt: () => systemPrompt,
      tools,
      toolView,
      // 会话槽回写（let session / resumed 旗标——llm onUsage、ctx.sessions、
      // goal wasResumed 等组合根闭包经此读当前值）
      bindSession: (next, resumed) => {
        session = next;
        resumedFlag = resumed;
      },
      getSession: () => session,
      durableRef,
      durableForward,
      driverRef,
      chatRef,
      stampSandboxFacts,
    }),
  });
  // 锚是活绑定（/reload dispose 后重 fork）；composition 同为活绑定（/reload 重装载）
  let pluginAnchor: ContextScope = ctx.fork({ name: 'plugins' });
  let composition: CompositionReport = loadComposition(compositionDir, builtins);
  // 插件技能注册回调（契约篇 §1.2 第六件；拓扑 seam 落码形态——context 不引
  // skills，组合根在此桥接）：loadPlugins 在行作用域 fork 后、apply 之前逐声明行
  // 回调。桥接三件：包层 provider 工厂（skills 模块产）+ registerProvider（追加序
  // 即优先序——local-fs 装配序 ⑦ 已先注册，包内技能恒居最低层，用户本地永远压过
  // 包内）+ 挂行作用域 effect（行失败 / /reload 锚回卷即注销——技能是行资产）。
  // registerProvider → skills_change → 重建管线自然刷新，此处不另发 refresh
  //（双发 = 每插件双份全量重扫）。回调契约不抛错：factory/registerProvider 均纯装配
  const registerPluginSkills = (info: PluginSkillsInfo): void => {
    if (info.packageRoot === undefined) {
      // builtin 行（宿主函数件）无磁盘锚点——官方纯技能包件真出现时随其纵切开
      ctx.logger.warn('builtin 件声明 skills 暂不支持注册（无包根锚点）', { plugin: info.name, row: info.id });
      return;
    }
    const provider = createPackageSkillsProvider({
      pluginName: info.name,
      packageRoot: info.packageRoot,
      dirs: info.dirs,
    });
    info.scope.effect(() => skills.registerProvider(provider));
  };
  plugins.applyLoad(
    composition,
    await loadPlugins(pluginAnchor, composition.plan, { registerSkills: registerPluginSkills }),
  );
  if (plugins.list().some((row) => row.status === 'failed')) {
    const lines = plugins
      .list()
      .filter((row) => row.status === 'failed')
      .map((row) => `  - [${row.code}] ${row.id}：${row.message}`);
    try {
      await persistence?.flush();
      await persistence?.close();
    } finally {
      await ctx.dispose();
    }
    throw new AppError(
      PLUGIN_LOAD_FAILED,
      `插件启动断言失败（${lines.length} 行，plugin/failed 事件已逐行广播）：\n${lines.join('\n')}`,
    );
  }
  // ④d onSettle 晚绑定收口（§6.4）：通知器需要驱动 + 活会话引用——chat 件
  //（默认层首行）装载即驱动就绪，此处挂上此后子代理结算即走结算折叠 + 三通道
  // 通知（装载窗口内无委派件可用，此前窗口结算结构上不可达）
  onSubagentSettle = createSubagentNotifier({
    getDriver: () => driverRef.current,
    getSession: () => session,
    model,
  });
  // 应用组件在场断言（契约篇 §5.4——装载期 post-apply 时点，组合树已合成）：
  // 缺场 = 应用级隔离不拒启（清单是声明面，声明了没装 = 用户裁量非发行事故），
  // 诊断出口 = debug 日志 + runtime.appGaps（dump-config 打印）；/reload 后重算
  let appGaps = assertAppComponents(officialApps, composition);
  for (const [id, missing] of appGaps) {
    ctx.logger.debug('应用组件缺场（应用级隔离）', { app: id, missing });
  }
  // boot 装载窗口收口：此后运行时注册（tools_change/prompts_change）即时落
  // header change 快照——装载期中间态已被首请求的 initial 快照整体收编
  loadWindow = false;

  /** 组合树全量重载（/reload 主体；TUI 薄壳直调——对账逻辑不进壳面） */
  const reload = async (): Promise<ReloadResult> => {
    // run 进行中拒绝（与 /new 同准入判据——loop 正引用工具快照与提示词，不换装配）
    if (driverRef.current?.isRunning) return { busy: true };
    // overlay 校验先行：树坏不动旧装配（旧锚回卷是不可逆动作——先验后拆）
    let fresh: CompositionReport;
    try {
      fresh = loadComposition(compositionDir, builtins);
    } catch (err) {
      return { error: describeError(err) };
    }
    try {
      // 装载窗口开启：dispose+装载只刷活视图，收口由下方单张 change 统一落账
      loadWindow = true;
      await pluginAnchor.dispose(); // LIFO 级联回卷：工具卸载（tools_change 即时刷新）+ 监听/服务/词汇注销
      pluginAnchor = ctx.fork({ name: 'plugins' });
      const load = await loadPlugins(pluginAnchor, fresh.plan, { registerSkills: registerPluginSkills });
      composition = fresh;
      plugins.applyLoad(fresh, load); // 同实例就地更新（失败行进 list 状态面——进程存活）
      rebuildSystemPrompt();
      // 应用组件在场断言随重装载重算（组合树换装后缺场集可变——活取值面）
      appGaps = assertAppComponents(officialApps, fresh);
      // 组装参数变化经 writeHeader 内建 diff 落 reason=change 快照（仅变化才落——
      // 提示词/工具面变了才写，没变不污染日志；件未装载或无持久层为 no-op）
      chatRef.current?.writeHeader();
      const payload: CompositionReloadedPayload = {
        activated: load.activated.map((item) => item.id),
        failed: load.failed.map((item) => item.id),
        skipped: load.skipped.map((item) => item.id),
      };
      ctx.emit('composition/reloaded', payload);
      return { payload };
    } catch (err) {
      // 兜底：loadPlugins 逐行收集不抛，此处只剩 dispose/emit 级异常——进程存活报告
      return { error: describeError(err) };
    } finally {
      // 窗口必然收口（成败两路）：此后运行时注册恢复即时落账
      loadWindow = false;
    }
  };

  /* ---- ⑨b 内置命令（help/quit/new/skills/skill:<名> + 插件管理五件/reload） ----
   * 依赖 ⑨ 的 plugins 服务与 reload 闭包——必须在其后注册（引用先声明）。
   * quit/submit 经驱动活句柄（chat 件未装载时 no-op——命令面仍在，对话循环不在）。 */
  ctx.effect(() =>
    registerBuiltinCommands({
      commands: channels.commands,
      ui,
      skills,
      quit: () => driverRef.current?.requestQuit(),
      submit: (text) => driverRef.current?.submit(text),
      newSession: startNewSession,
      plugins, // ctx.plugins 服务（⑨ provide——命令壳与宿主同源）
      reload, // 组合根 reload 闭包（⑨ 定义——busy/error/payload 三面）
      // /usage 取数闭包：绑持久层活连接（诊断面无库时给说明行——面板零写入，
      // 库连接在关停序列中先于命令面注销而 close，通道壳兜底为通知）
      usage: persistence
        ? () => formatUsagePanel(persistence.store.connection)
        : () => '用量面板不可用（诊断面无持久层——persist:false）',
    }),
  );

  /* ---- ⑩ 交互模式：审批 answerer 接 ctx.ui（headless 无应答者 = fail-closed） ---- */
  if (opts.interactive) {
    ctx.on(APPROVAL_ANSWER_EVENT, async (req: ApprovalRequest, _next: () => unknown) => {
      const answer = await ui.confirm(`${req.summary}\n${req.reason ?? ''}\n批准？`);
      // 应答即短路（waterfall 语义：返回值即最终值，不调 next）
      return answer ? 'approve' : 'reject';
    });
  }

  return {
    ctx,
    persistence,
    // 活取值（/new 热切换后指向新会话；chat 件未装载时恒 undefined）——接口上
    // 仍是 readonly，实现为 getter
    get session(): Session | undefined {
      return session;
    },
    llm,
    tools,
    channels,
    ui,
    skills,
    approval,
    // 活取值（/reload 重装载后指向新树）——接口上仍是 readonly，实现为 getter
    get composition(): CompositionReport {
      return composition;
    },
    plugins,
    /** 官方应用清单（③c 装载期解析——静态数据，不随 /reload 变） */
    apps: officialApps,
    // 活取值（/reload 重装载后按新组合树重算）——接口上仍是 readonly，实现为 getter
    get appGaps(): ReadonlyMap<string, readonly string[]> {
      return appGaps;
    },
    model,
    workspace,
    sandboxMode,
    // 活取值（/reload 重建系统提示词后取新值）
    get systemPrompt(): string {
      return systemPrompt;
    },
    skillLocations: locations,
    // 活取值（chat 件装载后即驱动单例——诊断装配/overlay 禁用两形为 undefined）
    get conversation(): ConversationDriver | undefined {
      return driverRef.current;
    },
    newSession: startNewSession,
    reload,
    /** 优雅关停：等 run 结算 → flush 屏障 → 关库 → ctx 回卷（§1.3 编排） */
    async shutdown() {
      await driverRef.current?.settle();
      // try/finally：flush/close 任一失败也要 ctx.dispose 回卷（独立重读轮 #16
      // 复核——dispose 是资源必达件，不因持久层收尾异常被跳过；dispose 自身
      // 异常已被 context 回卷隔离逐条吞噬，不会反向炸关停序列）
      try {
        // 变更监听先退订：后续 ctx 回卷逐件注销插件工具/段时的广播不再触发
        // writeHeader/提示词重建（库未关也不落关停期快照——非模型可见时点）
        unwatchChangeEvents();
        // Job 排空主路径（骨架篇 §6.2）：全量 cancel + await 全部结算——子代理等
        // 后台任务的 executor 在结算路里可能还要写子会话事件，必须在 flush 屏障
        // 前收口（作用域回卷的 fire-and-forget 兜底只管异常路径，见 jobs.ts）
        await jobs.drain();
        await persistence?.flush();
        // session_shutdown 钩子（骨架篇 §1.3 序④ / 契约篇钩子表）：插件最终
        // 清理挂点——emit 异常隔离，单个清理器失败不拖垮关停
        if (session) ctx.emit('session_shutdown', { sessionId: session.header.sessionId });
        await persistence?.close();
      } finally {
        await ctx.dispose();
      }
    },
  };
}
