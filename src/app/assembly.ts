/**
 * L5 app — 组合根本体（骨架篇 §9：一切装配发生在这里，模块间零横向 import）。
 *
 * createBerryRuntime 把 M1 已落模块接线成真实可跑：
 * context 根作用域 → channels/ui → persist（session）→ llm（凭证适配注入）→
 * tools（fs 族 + 三段管道 + gate/decision durable）→ safety（审批 + 守门行 +
 * 可写根）→ skills（本地 provider + refresh）→ 应用装载 → 内置命令。
 *
 * 2026-08-24 应用面第一纵切（契约篇 §5.4 规范先行）：**对话应用装配本体迁
 * `builtin:chat` 官方件**（默认层首行）——会话选择/续接、durable 绑定、
 * request/header 差分化、ConversationDriver 构造、ctx.agent provide 全在件内；
 * 对话是应用不是内核（命题 §3.5）——overlay 禁用 chat 件即首启无对话
 * 循环、宿主照启（装/守/存职能与命令面完好）。
 *
 * 2026-08-26 S1 durable 键控总根因刀（多应用并行第一纵切，骨架篇 §9.3）：
 * 组合根四单槽（session/resumedFlag/durableRef + driverRef/chatRef）整体退役
 * 为 **DriverRegistry**（Map<sessionId, DriverEntry> + 前台聚焦指针——chat 件
 * 工厂 createChatApp 产物，组合根分配、件填充与消费）；全局绑定面（onUsage
 * 计量/ctx.sessions 缺省路由/管道守门与审批落账/子代理 fork 源/goal 工具命令面）
 * 全部改键控路由（调用链 → 注册表 → 前台聚焦）；/new = open 新条目 + 退役旧
 * 条目；TUI 持 FrontHost façade 跨 /new 稳定。
 */

import type { AgentMessage } from '../contracts/messages.js';
import type { StreamFn } from '../contracts/llm.js';
import {
  APP_SHUTDOWN_QUIESCE_VIOLATED,
  AppError,
  COMPOSITION_ROW_INVALID,
  APP_LOAD_FAILED,
  describeError,
} from '../contracts/errors.js';
import { TOOLS_CHANGE_EVENT } from '../contracts/tools.js';
import { PROMPTS_CHANGE_EVENT, registerPromptsService } from './prompts.js';
import type { ToolsService } from '../tools/registry.js';
import type { ContextScope } from '../context/types.js';
import { createContext, SYSTEM_ZONE, appZoneId } from '../context/context.js';
import { createAppJiti, importAppEntry, loadApps, type AppSkillsInfo } from '../context/loader.js';
import { RateLimiter } from '../context/rate-limit.js';
import { resolveLocalCodepageLabels } from '../context/index.js';
import {
  Persistence,
  createAppSqliteFace,
  localDayStartMs,
  openTurnDepth,
  spentBackgroundTokensSince,
} from '../persist/index.js';
import type { LlmRuntime, Provider, StreamFnDefaults } from '../llm/index.js';
import { createLlmRuntime, createLlmService, createStreamFn, InFlightTracker, providerApiFace } from '../llm/index.js';
import {
  APPROVAL_ANSWER_EVENT,
  createApprovalService,
  createRootsProvider,
  createSandboxService,
  externalEffectiveRoots,
  installSafetyGate,
} from '../safety/index.js';
import type { ApprovalPolicyMode, ApprovalService, ApprovalRequest, SandboxMode } from '../safety/index.js';
// exec 件聚落（第 18 模块，2026-08-25 exec 纵切）：bash 工具件 + ctx.exec 服务 +
// environment 披露段——组合根双装配点注册（检索族先例）
import { registerExecService, renderEnvironmentSection } from '../exec/index.js';
import { createBridgeFleet, type BridgeFleet } from './bridge-fleet.js';
import {
  createLocalSkillsProvider,
  createPackageSkillsProvider,
  createSkillsService,
  defaultSkillLocations,
  registerSkillsService,
} from '../skills/index.js';
import type { SkillLocation, SkillsService } from '../skills/index.js';
import { SKILLS_CHANGE_EVENT } from '../skills/index.js';
// 声明式子代理发现位置（agents/*.md——尾刀落码，subagent 官方件消费）
import { defaultAgentLocations } from './agents-md.js';
import type { AgentLocation } from './agents-md.js';
// 项目指令文件四层发现（骨架篇 §7.3 instructions 段——尾刀落码）
import { defaultInstructionLocations, discoverInstructions, renderInstructions } from './instructions.js';
import type { InstructionLocation } from './instructions.js';
import { registerChannelServices } from '../channels/service.js';
import type { ChannelsServiceEntity } from '../channels/service.js';
import type { UiService } from '../channels/types.js';
import type { Session } from '../session/session.js';
import {
  getSessionEventType,
  snapshotJsonValue,
  jsonBytes,
  usageLedgerBuckets,
  ledgerModel,
} from '../session/index.js';
import type { ProjectedMessage } from '../session/derive.js';
import { isCoreSessionEventType } from '../contracts/session-events.js';
import { chainCaller, chainSessionId, runInCallerChain } from '../context/chain.js';
import type { RowAppProbe } from '../contracts/app.js';
import { resolveRowCarrier } from '../contracts/app.js';
import type { AppLoadResult } from '../contracts/app.js';
import {
  EVENT_HANDLER_TIMEOUT,
  PERSIST_BATCH_WRITE_FAILED,
  APP_EVENT_RATE,
  SESSION_CORE_TYPE_FORBIDDEN,
  SESSION_EVENT_DATA_INVALID,
  SESSION_EVENT_TOO_LARGE,
  SESSION_FORMAT_UNSUPPORTED,
  SESSION_SURFACE_OP_INVALID,
} from '../contracts/errors.js';
import type { EventQueryOptions, EventQueryResult, SessionEvent } from '../contracts/events.js';
import type { AgentServiceFace, DurableSinks, ConversationDriver, DriverRegistry, FrontHost } from '../chat/index.js';
import { createChatApp } from '../chat/index.js';
import {
  createPathsService,
  loadComposition,
  assertRing1Required,
  diffRing1Rows,
  safeModeComposition,
  partitionPlan,
  RING1_REQUIRED_ROW_IDS,
  appDataDirOf,
  type CompositionReport,
  type PlanPartition,
} from './composition.js';
import { loadOfficialApps, assertAppComponents, resolveApp, mergeRequestForApp } from './app-registry.js';
import type { AppManifest } from '../contracts/app.js';
import { createBuiltinRegistry, collectBuiltinMigrations } from './builtins.js';
import { createMcpSpawner } from './mcp-spawn.js';
import { killTree } from '../exec/index.js';
import { createSubagentChildFactory } from './subagent-factory.js';
import { emitSessionShutdownBounded } from './subagent-child.js';
import { createTickRunner } from './scheduler-runner.js';
import { createTickOsRegistrar } from './tick-register.js';
import { createJobsService, createSubagentsService, createInProcessProvider } from '../subagent/index.js';
import { createAgentTool } from './subagent-app.js';
import type { SubagentSettlement } from '../contracts/subagent.js';
import { createSubagentNotifier } from './notify.js';
import { createAppsService, sweepAppTmpDirs } from './apps.js';
import type { AppsService } from './apps.js';
import { createCredentialStore } from './persist-bridge.js';
import { defaultConvertToLlm } from './convert.js';
import { registerBuiltinCommands } from './commands.js';
import { AllowlistStore } from './allowlist-store.js';
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
  /**
   * StreamFn 请求参数默认值（S4 前置债批——重试/采样档位 + per-provider 在飞帽
   * 上限 maxInFlightPerProvider：0 = 不限，缺省 4；完整键面见 llm 模块定义）
   */
  readonly defaults?: StreamFnDefaults;
  /** 技能发现位置（缺省 defaultSkillLocations；测试注入临时目录） */
  readonly skillLocations?: readonly SkillLocation[];
  /** 声明式子代理发现位置（缺省 defaultAgentLocations；测试注入 fixture 目录） */
  readonly agentLocations?: readonly AgentLocation[];
  /** 指令文件发现位置（缺省 defaultInstructionLocations 四层；测试注入 fixture 目录） */
  readonly instructionLocations?: readonly InstructionLocation[];
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
   * CLI --app 应用 id（第三纵切进入面，契约篇 §5.4 第 2 条 / 技术栈篇 §5）：
   * boot 即进入该应用域（会话打标/严格域续接/agent 装配默认位/审批预设）。
   * 查无 = APP_NOT_FOUND（在册清单在 message 披露）；缺省不传 = 默认应用（chat 域）
   */
  readonly app?: string;
  /**
   * 组合树目录（overlay.yaml 与应用装机子树的根；缺省 dataDir()——
   * 测试注入临时目录，与生产路径完全同构）
   */
  readonly compositionDir?: string;
  /**
   * 安全模式（技术栈篇 §5 `--no-apps`，2026-08-27 落码）：boot 组合树空装
   * ——默认层与 overlay 全跳过，只保 Ring 1 硬装配行（RING1_REQUIRED_ROW_IDS，
   * 否则 assertRing1Required 拒启）。boot 拒启自救位：坏应用锁死启动时经此旗标
   * 起最小内核（无驱动一等态：TUI 壳照启可退 / run 语义性失败）→ 修 overlay →
   * /reload 不受本旗标影响（fresh 读盘不过滤——救援环一进程内闭环）
   */
  readonly noApps?: boolean;
  /**
   * external 域 OS 沙箱层开关（external carrier 落码批，契约篇 §1.7 第三十七
   * 批增补 2a）：缺省 true——装载期 probe 醒 fail-closed（SANDBOX_UNAVAILABLE
   * 拒装）+ spawn 经 sandbox.confine 包裹（seatbelt/bwrap 尽力层）。显式
   * false = **PM-only 逃生门**：operator 显式降格档（跳过 OS 层与 probe；
   * 进程墙 + PM 中层两层执法仍全）——安全降格必须显式传参，不设环境变量
   * 静默通道（宪章九「安全可控」）。CLI 旗标面随真实运营需求另接。
   */
  readonly externalOsLayer?: boolean;
  /**
   * 本进程主 loop 花销记账道（缺省 'foreground'）。tick 唤起入口声明
   * 'background'（CLI `run --background` → 此处 → chat 件 durable 落账——
   * 席 13 第二刀：tick 烧的钱进 background 道，canAfford 才读得到）
   */
  readonly usagePriority?: 'background' | 'foreground';
  /**
   * tick 单发 runner 覆盖（scheduler 件闭包注入——缺省 createTickRunner 真
   * spawn；测试注入假 runner 记 prompt 断言触发链，不真起子进程）
   */
  readonly tickRunner?: (prompt: string) => Promise<import('../scheduler/index.js').TickRunResult>;
  /**
   * OS 定时注册器覆盖（scheduler 件闭包注入——缺省 createTickOsRegistrar
   * 真系统操作〔darwin launchd / Linux crontab〕；测试注入假注册器断言
   * enable/disable 命令链，不动真系统注册面）
   */
  readonly osTickRegistrar?: import('./tick-register.js').TickOsRegistrar;
  /**
   * web 件依赖覆盖（生产零参——真 fetch/真 DNS/件级限流单例；组合根全栈
   * 测试注入 fetchImpl/lookup——服务与工具同一卫生件的回归锁在此层验）
   */
  readonly webOverrides?: import('../web/index.js').WebAppOverrides;
  /**
   * context_transform 消费点挂起时钟（毫秒，缺省 5000——契约篇 §1.6 时钟族，
   * 2026-08-27 刀〇a）：桥上钩子挂起视为故障，超时抛 EVENT_HANDLER_TIMEOUT
   * 上抛走 run failed 现径（loop 零 try/catch 纪律）。测试面注小值验证超时路径；
   * 生产面用缺省。
   */
  readonly transformTimeoutMs?: number;
  /**
   * user_input 消费点挂起时钟（毫秒，缺省 5000——契约篇 §1.6 时钟族 + §2.2
   * 增补 7②，2026-08-27 P1-2）：批消费位逐条竞速，超时抛 EVENT_HANDLER_TIMEOUT
   * 上抛走 run failed 现径。测试面注小值验证超时路径。
   */
  readonly inputTimeoutMs?: number;
  /**
   * turn_stopping 消费点挂起时钟（毫秒，缺省 5000——同上，增补 7①）：超时抛
   * EVENT_HANDLER_TIMEOUT——驱动侧经 onCallbackError 吞并上报（run 已结算，
   * 征询器故障不改写历史结果、不拖死停机路径）。
   */
  readonly stoppingTimeoutMs?: number;
  /**
   * ctx.sessions 写面频率护栏（缺省容量 2000 / 1000 每分钟——契约篇 §1.6
   * 资源护栏族 #14，2026-08-27 刀〇b）：按**目标会话**令牌桶（归因 = 应用写
   * 落在归属会话），appendEvent / appendWithSurfaceOp 两口统一计费；计费在
   * session.append 成功之后（只对成功写扣费）。测试面注小桶验证执法路径。
   */
  readonly sessionRateLimit?: { capacity: number; perMinute: number };
  /**
   * 会话增生令牌桶（缺省容量 10 / 5 每分钟——会话篇 §5.1 洪水上界，2026-08-27
   * P1-1）：**进程级全局桶**，createSession 与 fork 同桶计费——每会话帽（100k 事件
   * × 64KiB）不约束会话数，失控应用无界开新会话即无界写盘，上界必须进程级。
   * APP_EVENT_RATE 一码三面之三（emit scope 键 / sessions 会话键 / 增生进程键，
   * message 带面名可分辨）。正常迁移/回退一次一调用，10/min 缺省帽碰不到。
   */
  readonly sessionSpawnRateLimit?: { capacity: number; perMinute: number };
}

/** 组合根产物（三个命令入口持有的运行时面） */
export interface BerryRuntime {
  /** 根作用域（应用 fork 的锚） */
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
  /** 应用管理服务（ctx.apps 同一实例——list/install/toggle/update 有状态面） */
  readonly appsService: AppsService;
  /**
   * 官方应用清单（装载期解析——id → 清单；契约篇 §5.4 第二纵切。第三方面随
   * ctx.apps install 装机期发现面挂账，出现即并入此表口径）
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
   * 会话驱动（通道宿主面：submit / requestQuit）——**前台聚焦条目投影**（活取值）：
   * 件装载即就绪；persist:false 诊断装配或 overlay 禁用 chat 件时为 undefined
   * （宿主照启——命令面/应用管理完好，无对话循环）。跨 /new 稳定的完整面见
   * drivers / front 两字段
   */
  readonly conversation: ConversationDriver | undefined;
  /**
   * 会话驱动注册表（S1 单真相——Map<sessionId, DriverEntry> + 前台聚焦指针 +
   * open/retire/focused/chained/routed）。恒在：persist:false 或 chat 件未装载时
   * 恒空表；S3 /app 前台切换消费 open 面
   */
  readonly drivers: DriverRegistry;
  /**
   * 前台宿主 façade（S1）：submit/requestQuit/settle 随前台聚焦路由 + 退出聚合
   * promise + 展示转接——TUI 起屏持它一次即跨 /new 稳定。恒在：无驱动形态
   * submit 静默、requestQuit 直接聚合退（壳照启可退）
   */
  readonly front: FrontHost;
  /** 开新会话（/new）：registry.open 一条龙 + 旧聚焦条目退役；无持久层或聚焦驱动 run 进行中返回 undefined */
  newSession(): Session | undefined;
  /**
   * 组合树重载（/reload，契约篇 §1.3 落码形态）：run 进行中**排队不拒绝**
   *（2026-08-27 刀 2 改排队——分槽 coalesce：置 pending 返 {queued:true}，
   * run 结算回调见各自域排水条件即自动排水执行；排队的 reload 失败不重排，
   * 错误经 ui.notify 报请求方）；overlay 校验失败不动旧装配（error）；成功 =
   * 锚 dispose → 重装 → 系统提示词重建 → composition/reloaded 派发（payload
   * 三份行 id 清单）。失败行逐行报告不杀进程（boot 与 /reload 两面失败语义
   * 之 /reload 半边）。app 参数 = 单区重载（D3 per-app reload）：只动该应用
   * 第三方挂载行（该区 worker 行 terminate → 该区锚 dispose → 重锚 → 该区行
   * 重装载），他区与根/系统运行时不动；未知/不在册 id = error 面；载荷带
   * app 腿（缺席 = 全量）与卸词集警示 droppedEvents。
   */
  reload(app?: string): Promise<ReloadResult>;
  /** 优雅关停（run 结算 → flush 屏障 → 关库 → ctx 回卷——骨架篇 §1.3 的进程内编排） */
  shutdown(): Promise<void>;
}

/** /reload 结果（成功载荷 + 排队/失败回执——TUI 薄壳直显，不二次判型） */
export interface ReloadResult {
  /**
   * run 进行中已排队（2026-08-27 刀 2：busy 拒绝改排队——单槽 coalesce，已排队
   * 再排 no-op；run 结算回调见全闲自动排水执行，结果经 ui.notify 报请求方）
   */
  readonly queued?: true;
  /** overlay/装载期异常（进程存活；message 走 describeError 统一口径） */
  readonly error?: string;
  /** 成功载荷（composition/reloaded 事件同款三份行 id 清单） */
  readonly payload?: CompositionReloadedPayload;
}

/**
 * 组装 Berry 运行时（组合根唯一入口；三个命令入口共用）。
 * 装配顺序即依赖序：ctx → channels → persist → llm → tools → safety → skills
 * → 应用装载（⑨，组合树 Ring 2/3 行；**首行 chat 件装载即会话选择/驱动构造/
 * ctx.agent provide 全就绪**）→ 命令（⑨b，闭包引用 appsService/reload——须后于装载
 * 声明）。全部注册走 ctx.provide/on/effect——作用域 dispose 即整体回卷。
 * async：应用装载（jiti import + apply）是异步序列（契约篇 §1）。
 */
export async function createBerryRuntime(opts: RuntimeOptions = {}): Promise<BerryRuntime> {
  const workspace = opts.workspace ?? process.cwd();
  const model = opts.model ?? process.env['APP_MODEL'] ?? DEFAULT_MODEL;
  const sandboxMode = opts.sandboxMode ?? 'workspace-write';
  const persistEnabled = opts.persist !== false;

  /* ---- ① 根作用域（模块加载器/应用 fork 的锚） ---- */
  const ctx = createContext({ name: 'app' });

  /* ---- ①b project-aliases 表装载（canonical 根重定向——context 宿主原语，
   * 记忆篇 §3 挂账随检索族纵切批兑现）：须早于任何 ownerKey/信任判定求值。
   * 文件缺失 = 常态零日志；存在但坏 JSON/形状不对 = warn 一次 + 空表（别名表
   * 是用户逃生通道，坏配置不拒启） ---- */
  setProjectAliases(loadProjectAliases(dataDir(), ctx.logger.warn.bind(ctx.logger)));

  /* ---- ①c 码页标签预热（骨架篇 §7.5 射面总账，P1-3 挖矿 B11 缺口④）：
   * prompt 面三读者（instructions/agents-md/SKILL.md 发现）是同步链，标签
   * 只能同步 peek——win32 上先在此探一次注册表（两发 reg query，几十毫秒，
   * 进程内缓存此后永免），三读者与 spawn/read 两半边共享同一缓存；非 win32
   * 即时返回空对零开销 ---- */
  await resolveLocalCodepageLabels();

  /* ---- ①d 行挂载目标投影（D1 清单投影批，契约篇 §5.1 注册面路由；第三十六批
   * 数组化改形）----
   * rowId → appId 数组的活视图：boot 合成后与 /reload 重合成后各重建一次
   * （syncRowAppMap），闭包读活 Map——三个注册面消费方（tools 隐式路由〔多应用
   * 行按数组投多域〕/ skills·channels 拒载）构造时点与组合树合成先后无关。探
   * 针注入经构造参数透传（registerChannelServices / createSkillsService /
   * toolsDeps），全部指回同一闭包实例。 */
  let rowAppMap = new Map<string, readonly string[]>();
  const rowApp: RowAppProbe = {
    get: (rowId) => rowAppMap.get(rowId),
    size: () => rowAppMap.size,
  };
  /** 组合树换装时重建投影：带 apps 键的行进投影（含禁用行——树形事实非装载事实） */
  const syncRowAppMap = (report: CompositionReport): void => {
    rowAppMap = new Map(report.rows.filter((row) => row.apps !== undefined).map((row) => [row.id, row.apps!] as const));
  };

  /* ---- ② 通道与 UI 服务 ---- */
  const { channels, ui } = registerChannelServices(ctx, {
    // UI 广播异常诊断（隔离案一第一刀 #3）：坏后端异常经根 logger 留痕——
    // 广播循环逐后端隔离，单后端抛错不毒调用方、不截断后续通道
    onUiError: (err, op) =>
      ctx.logger.error(`UI 广播异常已隔离（${op}）`, { error: err instanceof Error ? err.stack : String(err) }),
    // D1 app 行命令拒载探针（TUI 命令单表无域层——app 行注册即跨应用漏命令）
    rowApp,
  });

  /* ---- ③ 持久层（persist:false 跳过——诊断面不落库） ---- */
  // 首启建档（paths.ts ensureDbDir）：库文件父目录须先在——三入口共用的唯一
  // 建档点（幂等 mkdir recursive；TUI 入口原早调已收编至此单点。建档对象是
  // 实际库路径的父目录：缺省 = 数据目录，显式注入/APP_DB_PATH 同样覆盖。
  // 2026-08-25 修：原先仅 TUI 入口建档，全新机器 berry run 在 Persistence.open
  // 即 ENOENT——深读 workflow 实证缺口）。persist:false 诊断面保持零副作用不建。
  const resolvedDbPath = opts.dbPath ?? dbPath();
  if (persistEnabled && resolvedDbPath !== ':memory:') {
    ensureDbDir(resolvedDbPath);
    // 件临时空间扫龄（契约篇 §1.5 tmp 钉位细则④）：boot 装载前同步一次、
    // 与 ensureDbDir 同一零副作用闸（:memory: 诊断路不扫——删也是落盘）；
    // best-effort（函数内单件失败 warn 不抛），不阻装配。
    sweepAppTmpDirs(dataDir(), ctx.logger);
  }
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

  /* ---- ③b 会话路由基建（S1 durable 键控总根因刀，骨架篇 §9.3）----
   * 四单槽（session/resumedFlag/durableRef + driverRef/chatRef）整体退役为
   * chat 件 DriverRegistry（⑨ 装配点创建——Map<sessionId, DriverEntry> + 前台
   * 聚焦指针；本段早期闭包对 registry 的引用全为运行期调用，TDZ 安全）。本段
   * 只留两件：sandbox 盖章、durable 转发壳——壳已收窄为 gate/approval 两路
   * （handle 半边随驱动直绑退役：管道守门/审批对的落账路由 = 调用链 → 注册表
   * → 前台聚焦，registry.routed()）。loop 工具快照与系统提示词均 per-entry
   * （S2：chat 件 open 各自构造活数组与物化串——不再有组合根级共享单份）。 */
  /** sandbox 档事实盖章（内核守门面数据 + dedup 内建；件在会话边界调时点——内核有数据，应用有时点。
   * mode = 本驱动效值（第三纵切：应用审批预设生效时按预设落事实），缺省全局档） */
  const stampSandboxFacts = (target: Session, mode: SandboxMode = sandboxMode): void => {
    const last = [...target.events].reverse().find((e) => e.type === 'sandbox/mode');
    if ((last?.data as { mode?: string } | undefined)?.mode !== mode) {
      target.append('sandbox/mode', { mode });
    }
  };
  // durable 转发壳（S1 收窄）：管道守门与审批对构造期绑壳，落账路由走 registry
  //（惰性引用——⑨ 创建；gate/approval 只在 run 运行期触发，届时 registry 必已就位）。
  // 件未装载/无持久层时 routed() 恒 undefined——三路皆 no-op，与 persist:false 同款降级。
  // 桥帧守卫（R1 复盘批二 11d——契约篇 §1.7）：session 链无帧 + caller 链有帧 =
  // 分域行经桥的宿主内代执行（svc-invoke/tool-run 还帧的行 id），本无宿主会话
  // 语境——routed() 回退前台聚焦会把归因落进不相干前台会话账本（比零落账更糟：
  // 污染他人清算面，宪章八）。此形态不落账（no-op 宁缺勿错位）；宿主级 durable
  // 落点（桥调用独立审计账——不挂任何会话）挂账，判据 = 首个需要桥调用审计
  // 回放的真实场景
  const routedForDurable = () =>
    chainSessionId() === undefined && chainCaller() !== undefined ? undefined : registry.routed();
  const durableForward: Omit<DurableSinks, 'handle'> = {
    gate: (payload) => routedForDurable()?.durable.gate(payload),
    approval: {
      asked: (payload) => routedForDurable()?.durable.approval.asked(payload),
      decided: (payload) => routedForDurable()?.durable.approval.decided(payload),
    },
  };

  /* ---- ③c 官方应用清单装载（契约篇 §5.4 应用面第二纵切）----
   * 官方清单 = 宿主包内静态已知（仓库根 apps/*.app.yaml），装载期直接解析——
   * 解析/校验失败 = 启动断言拒启（官方件随包，坏 = 发版事故，宁拒绝不误读）；
   * 第三方清单 glob 发现面挂账随 ctx.apps install。预算表随清单构建
   * （canAfford app 维数据源——④b llm 服务闭包读它，装载序上先行）。 */
  const officialApps = loadOfficialApps();
  /** 在册应用 id 集（D1 清单投影批）：组合树行 app 键取值域——loadComposition
   * 触发①执法面（boot :1213 与 /reload fresh :1688 两消费点共用；装载序上官方
   * 清单先行于组合树合成，键集就绪时点成立） */
  const knownAppIds = new Set(officialApps.keys());
  /* -- CLI --app 进入面解析（第三纵切）：boot 即进入的非缺省应用。查无 =
   * APP_NOT_FOUND（在册清单在 message 披露）——官方清单装载后、一切装配前
   * 先解析（进入错 id 不该走到起驱动那步才失败）。 */
  const bootApp = opts.app === undefined ? undefined : resolveApp(officialApps, opts.app);
  /** 应用预算表（id → budget.dailyTokens；未入表 = 未声明 = 恒 true 不闸） */
  const appBudgets = new Map<string, number>();
  /** 应用内存预算表（装载身份串 → 最严 memoryMb；第三纵切补第二纵切欠账——worker 行 resourceLimits 映射数据源） */
  const appMemoryMb = new Map<string, number>();
  for (const [id, manifest] of officialApps) {
    if (manifest.budget?.dailyTokens !== undefined) {
      appBudgets.set(id, manifest.budget.dailyTokens);
    }
    // 内存预算按组件收键：多应用共享组件取最严（min——预算是申请面，从严不从宽）。
    // main 域组件命中此表无消费面（resourceLimits 是 worker 专属——惰性声明，诚实边界）
    const mb = manifest.budget?.memoryMb;
    if (mb !== undefined) {
      for (const ref of manifest.components) {
        const prev = appMemoryMb.get(ref);
        if (prev === undefined || mb < prev) appMemoryMb.set(ref, mb);
      }
    }
  }
  /** context_transform 桥（契约篇 §2.2 增补 5② + S1 双参）：loop 私有回调桥为根
   * 总线瀑布——根 ctx 恒存活（应用监听集随 /reload 更替），驱动绑此桥跨重装载
   * 稳定；sessionId 作第二种子穿透给 handler（差分/检索按归属会话路由）。
   * 挂起时钟（§1.6 时钟族，2026-08-27 刀〇a）：钩子永不 resolve 且已返还控制 =
   * 故障语义，整链竞速 transformTimeoutMs（缺省 5s）——超时抛
   * EVENT_HANDLER_TIMEOUT 上抛（loop 零 try/catch 纪律 → run failed 现径）；
   * 迟到结算挂 catch 兜底不进 unhandledRejection。 */
  const transformTimeoutMs = opts.transformTimeoutMs ?? 5_000;
  const transformContext = (messages: AgentMessage[], sessionId: string): Promise<AgentMessage[]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AppError(
              EVENT_HANDLER_TIMEOUT,
              `context_transform 钩子挂起超 ${transformTimeoutMs}ms（挂起与抛错同族，run 按失败收尾）`,
            ),
          ),
        transformTimeoutMs,
      );
    });
    const waterfallPromise = ctx.waterfall<AgentMessage[]>(
      'context_transform',
      messages,
      sessionId,
      (final: AgentMessage[]) => final,
    );
    waterfallPromise.catch(() => {}); // 竞速败方迟到 reject 兜底
    return Promise.race([waterfallPromise, clock]).finally(() => clearTimeout(timer));
  };

  /* ---- user_input / turn_stopping 两桥（契约篇 §2.2 增补 7①②，2026-08-27 P1-2
   * 兑现——与 transformContext 桥同形态：根总线 + 挂起钟 + sessionId 参数化） ---- */
  const inputTimeoutMs = opts.inputTimeoutMs ?? 5_000;
  /** user_input：单条消息变换瀑布（驱动批消费位逐条调用；失败/超时上抛 → run failed） */
  const transformInput = (message: AgentMessage, sessionId: string): Promise<AgentMessage> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AppError(
              EVENT_HANDLER_TIMEOUT,
              `user_input 钩子挂起超 ${inputTimeoutMs}ms（挂起与抛错同族，run 按失败收尾）`,
            ),
          ),
        inputTimeoutMs,
      );
    });
    const waterfallPromise = ctx.waterfall<AgentMessage>(
      'user_input',
      message,
      sessionId,
      (final: AgentMessage) => final,
    );
    waterfallPromise.catch(() => {}); // 竞速败方迟到 reject 兜底
    return Promise.race([waterfallPromise, clock]).finally(() => clearTimeout(timer));
  };
  const stoppingTimeoutMs = opts.stoppingTimeoutMs ?? 5_000;
  /** turn_stopping：run 结算征询 serial（超时 reject——驱动侧吞并经 onCallbackError 上报） */
  const onTurnStopping = (payload: { sessionId: string; stopReason: string }): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new AppError(
              EVENT_HANDLER_TIMEOUT,
              `turn_stopping 钩子挂起超 ${stoppingTimeoutMs}ms（run 已结算，放弃等待不拖死停机）`,
            ),
          ),
        stoppingTimeoutMs,
      );
    });
    const serialPromise = ctx.serial('turn_stopping', payload);
    serialPromise.catch(() => {}); // 竞速败方迟到 reject 兜底
    return Promise.race([serialPromise, clock]).finally(() => clearTimeout(timer));
  };

  /* ---- ④ llm 运行时（凭证经 persist 适配注入；测试可整体换 streamFn） ---- */
  const llm = createLlmRuntime({
    ...(persistence ? { credentials: createCredentialStore(persistence.store) } : {}),
    ...(opts.providers ? { providers: opts.providers } : {}),
  });
  // S4 前置债③：per-provider 在飞计数器——装配处构造一份，streamFn（主循环路）
  // 与 ctx.llm.complete（单发路）共享同一份，「per-provider」名实相符。上限来自
  // opts（缺省 4，0 = 不限）——StreamFnDefaults.maxInFlightPerProvider 同名键语义。
  const maxInFlight = opts.defaults?.maxInFlightPerProvider ?? 4;
  const inflight = maxInFlight > 0 ? new InFlightTracker(maxInFlight) : undefined;
  const streamFn: StreamFn = opts.streamFn ?? createStreamFn(llm, opts.defaults, inflight);

  /* ---- ④b llm 具名服务（ctx.llm：应用单发补全唯一合法路径 + canAfford 预算闸门，骨架篇 §9.3） ---- */
  const llmService = createLlmService({
    runtime: llm,
    // S4 前置债③：与 streamFn 同一份计数器（两出口同源——达帽 complete 路同拒）
    ...(inflight !== undefined ? { tracker: inflight } : {}),
    ...(opts.defaults !== undefined ? { defaults: opts.defaults } : {}),
    defaultModel: () => model,
    // 底账写侧（2026-08-24 第十一批拍板 #1，会话篇 §1.1）：complete 成功即落
    // llm/usage durable 事件（log-only 计量事实；callId = settlement 幂等身份，
    // write-behind 重试去重锚点）。S1 键控（骨架篇 §9.3「读点=ctx.llm onUsage」
    // 语义定案）：调用链命中条目才落账——无链无键**不落 focus**只 debug（timer
    // 面/诊断面去向显式化；此前「落到恰好活着的会话」错账归零）
    onUsage: (result, modelSpec) => {
      const entry = registry.chained();
      if (entry !== undefined) {
        entry.session.append('llm/usage', {
          callId: result.callId,
          // model 口径统一（2026-08-27 P1-5 收编观察项）：实录优先——响应消息
          // provider+model 拼全形，请求标识兜底（与 chat durable 前台写点同律）
          model: ledgerModel(result.message, modelSpec),
          priority: result.priority,
          // 全桶入账（会话篇 §1.1 P1-5 修偏）：usageLedgerBuckets 归一——cacheRead/
          // cacheWrite 必落，cacheWrite1h/reasoning 上报才落，totalTokens/cost 滤除
          usage: usageLedgerBuckets(result.usage),
        });
      }
      ctx.logger.debug('llm.complete 用量入账', {
        model: modelSpec,
        totalTokens: result.usage.totalTokens,
        ...(entry !== undefined ? { session: entry.session.header.sessionId } : { session: '(无链不落账)' }),
      });
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
  });
  ctx.provide('llm', llmService);

  /* ---- ④c Job 注册表（ctx.jobs，骨架篇 §6.2 落码注记）----
   * 后台任务/一次性后台委派的进程内登记项（subagent 模块提供实现）：状态机
   * running→stopping→唯一终态，first-wins 结算，done 永不 reject。生命周期挂根
   * 作用域 effect（dispose 兜底 fire-and-forget 排空）；关停主路径在 shutdown 里
   * persistence.close 前显式 await drain()——executor 结算路可能仍写子会话事件。
   * 提供时点在应用装载 ⑨ 前：应用（subagent/process 委派件）inject 即得。 */
  const jobs = createJobsService(ctx);
  ctx.provide('jobs', jobs);

  /* ---- ④d 子代理服务（ctx.subagents，骨架篇 §6.1 落码注记）----
   * provider 注册表 + 能力协商布尔检查 + background Job 接线（stopReason→终态
   * 映射唯一持有处）+ onSettle 结算回调（§6.4：结算折叠 + 三通道通知）。
   * in-process provider 的每子装配工厂在纵切四随默认应用行落地（工厂闭包持
   * streamFn/父会话/persistence——组合根侧零件，此处不装配）。
   * 提供时点与 jobs 同理：应用装载 ⑨ 前，委派件 inject 即得。onSettle 经晚绑定
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
   * 'agent' 结构性取得，晚绑定 attach 挂点退役——件聚落 src/chat/app.ts）。 */

  /* ---- ④f 会话事件服务（ctx.sessions，骨架篇 §9.2 落码）----
   * 写面：应用落 durable 事件的唯一正门（会话篇 §8 拍板落点）：appendEvent 走
   * 缺省路由闭包（S1：调用链 → 注册表 → 前台聚焦——registry.routed()；run 期
   * 应用工具落在归属会话，命令面落在聚焦会话）；无路由落点（诊断装配或 chat
   * 件未装载）返回 undefined，调用方各自降级。
   * 读面（2026-08-26 挖矿批 P0-1，会话篇 §3.2「当前会话只读投影」定形）：两读法
   * 锚定**当前会话**（与 sessionId 信封同源）——currentSessionId() 无落点返回
   * undefined；eventsOfType(type) 读**内存活日志**过滤枚举（与 appendEvent 同账
   * 零迟滞，write-behind 迟滞不影响读；返回过滤副本——append-only 不失效）。
   * 写读同规（B1 收口）：撞未注册词与写侧**同抛 SESSION_FORMAT_UNSUPPORTED**——
   * 读侧静默空数组 = 拼错事件名的无声死，禁止。
   * 核心词汇伪造防护：内核词（user/message 等核心 14 类）的写入权属宿主——归因
   *（sendUserMessage source）/审批/结算语义全绑在宿主写点，应用经服务面伪造即
   * SESSION_CORE_TYPE_FORBIDDEN 响亮拒绝（内核边界，契约篇）；读面核心词不禁
   *（已注册即返回——读不伪造任何宿主语义）。服务必须无条件 provide（即便
   * persist:false）——inject 是 Kahn 硬依赖，缺供即启动断言拒启。
   * 写面频率护栏（#14，2026-08-27 刀〇b）：按目标会话令牌桶（容量 2000 /
   * 1000 每分钟，RuntimeOptions.sessionRateLimit 可调）——归因裁决：服务面无
   * scope 键，目标会话（registry.routed）即天然键（应用写落在归属会话，失控
   * 洪水淹没的就是该会话）。计费在 session.append 成功之后（只对成功写扣费
   * ——未注册词/核心词执法先抛，不扣令牌）；宿主自身 durable 写点不经此面。 */
  const sessionRate = new RateLimiter(opts.sessionRateLimit ?? { capacity: 2000, perMinute: 1000 });
  /** 写面计费（两口共用）：session.append 成功返回后扣令牌，桶空 fail-loud */
  const chargeSessionWrite = (sessionId: string, face: string): void => {
    if (!sessionRate.tryCharge(sessionId)) {
      throw new AppError(
        APP_EVENT_RATE,
        `ctx.sessions.${face} 写入超频（会话 ${sessionId}——按目标会话计费）` +
          `：护栏 ${sessionRate.params.perMinute} 次/分钟（令牌桶：突发上限 ${sessionRate.params.capacity}、` +
          `回填 ${sessionRate.params.perMinute}/min；fail-loud 非静默丢弃，契约篇 §1.6 #14）`,
      );
    }
  };
  /* ---- 会话增生桶（会话篇 §5.1 洪水上界，2026-08-27 P1-1）----
   * 进程级全局令牌桶：createSession 与 fork 同桶——每会话帽（100k × 64KiB）不
   * 约束会话数，失控应用无界开新会话即无界写盘，上界必须进程级。APP_EVENT_RATE
   * 一码三面之三（emit scope 键 / sessions 会话键 / 增生进程键），message 带面名。 */
  const sessionSpawnRate = new RateLimiter(opts.sessionSpawnRateLimit ?? { capacity: 10, perMinute: 5 });
  /** 增生桶键：进程单桶常量键（区别于 emit 的 scope 键与写面的会话键） */
  const SPAWN_BUCKET_KEY = 'session-spawn';
  /** 导入种子总量帽（卫生闸第三道——单会话事件数上界，与活体会话同尺 10 万） */
  const IMPORT_SEED_TOTAL_LIMIT = 100_000;
  /** 导入种子单事件体积帽（卫生闸第二道——与活体 append 的 64KiB 同尺；种子不走
   * append（构造器直接入账），体积闸必须在服务面前置） */
  const IMPORT_EVENT_BYTES_LIMIT = 64 * 1024;
  /** 增生计费（两面共用）：物理写盘动作之前扣令牌（拒绝时不产生半套状态），桶空 fail-loud */
  const chargeSpawn = (face: string): void => {
    if (!sessionSpawnRate.tryCharge(SPAWN_BUCKET_KEY)) {
      throw new AppError(
        APP_EVENT_RATE,
        `ctx.sessions.${face} 会话增生超频（进程级——createSession 与 fork 同桶计费）` +
          `：护栏 ${sessionSpawnRate.params.perMinute} 次/分钟（令牌桶：突发上限 ${sessionSpawnRate.params.capacity}、` +
          `回填 ${sessionSpawnRate.params.perMinute}/min；fail-loud 非静默丢弃，会话篇 §5.1 洪水上界）`,
      );
    }
  };
  ctx.provide('sessions', {
    /**
     * 导入会话（会话篇 §5.1，2026-08-27 P1-1）：origin='import' 钉死无参数
     * （闭集归因——导入语义不开放给调用方）；四道卫生闸洗外部种子 → durable
     * 承诺（ensureSeeded + flush 屏障）→ 返回 sessionId 不返回活引用。
     * 顺序纪律：卫生闸（纯校验零副作用）→ 增生计费 → 构造落库——非法数据
     * 不耗配额（与 register 查重先过同理），拒绝时不产生半套状态。
     */
    createSession: async (opts: { seed: readonly SessionEvent[] }): Promise<string> => {
      // persist:false 诊断装配 = durable 承诺物理不可履行（码族随语义族走——与
      // 批落失败同族；不返回空转 sessionId：导入面返回的 id 指向空壳 = 承诺谎报）
      if (persistence === undefined) {
        throw new AppError(
          PERSIST_BATCH_WRITE_FAILED,
          'createSession 在 persist:false 诊断装配下不可用（导入 = durable 承诺——物理不可履行即响亮拒绝，不返回空转 sessionId）',
        );
      }
      // 闸三（总量帽，会话级）：零遍历成本先拒——100k × 64KiB 是单会话洪水上界
      if (opts.seed.length > IMPORT_SEED_TOTAL_LIMIT) {
        throw new AppError(
          SESSION_EVENT_TOO_LARGE,
          `导入种子 ${opts.seed.length} 条超会话总量帽 ${IMPORT_SEED_TOTAL_LIMIT}（会话篇 §5.1 卫生闸第三道）`,
        );
      }
      // 闸一+二+四（逐事件）：data JSON 性快照 / time 有限数值 / 64KiB 体积 /
      // 信封剥除 + ignorable 按注册表重盖章——外部数据是平展事实流，宿主侧
      // 信封字段（surfaceOp/sourceEventSeqs/ignorable）一律不信不透传。核心词
      // 放行（导入的历史天然含 user/message——红线例外即 importer 归因的理由）；
      // seq 连续性归构造时 validateSeed 既有闸（此处不重复执法）
      const cleaned: SessionEvent[] = [];
      for (let i = 0; i < opts.seed.length; i++) {
        const event = opts.seed[i]!;
        const snapshot = snapshotJsonValue(event.data, `seed[${i}].data`); // JSON 性（非 JSON 值抛 DATA_INVALID）
        if (typeof event.time !== 'number' || !Number.isFinite(event.time)) {
          throw new AppError(
            SESSION_EVENT_DATA_INVALID,
            `导入种子 seed[${i}].time 非有限数值（收到 ${String(event.time)}——时间戳必须是有限毫秒数）`,
          );
        }
        const size = jsonBytes(snapshot);
        if (size > IMPORT_EVENT_BYTES_LIMIT) {
          throw new AppError(
            SESSION_EVENT_TOO_LARGE,
            `导入种子 seed[${i}]（type=${event.type}）data 体积 ${size}B 超护栏 ${IMPORT_EVENT_BYTES_LIMIT}B（与活体事件同尺）`,
          );
        }
        const def = getSessionEventType(event.type);
        // 闸四重盖章素材 + 未知词在此响亮（validateSeed 兜底执法，此处消息带位置）
        if (def === undefined) {
          throw new AppError(
            SESSION_FORMAT_UNSUPPORTED,
            `导入种子含未注册事件类型：${event.type}（seed[${i}]——注册即写入许可，请先经 ctx.registerSessionEventType 注册词汇）`,
          );
        }
        cleaned.push({
          type: event.type,
          seq: event.seq,
          time: event.time,
          data: snapshot,
          ...(def.ignorable ? { ignorable: true } : {}), // 重盖章：向前兼容位唯一生产者 = 注册表
        });
      }
      chargeSpawn('createSession'); // 增生计费：先于物理动作（洪水面 = 写盘）
      // cwd/app 继承调用链会话（无路由落点回落 workspace——导入件在工具/apply 段
      // 调用时天然锚定归属会话）；importer 归因 = 调用链 caller 推导（宿主推导非
      // 应用自报——装载器/工具管道两边界已归一，无链 = 宿主自身 'host'）
      const anchor = registry.routed();
      const inherited = anchor !== undefined ? persistence.metaOf(anchor.session.header.sessionId) : undefined;
      const session = persistence.createSession({
        seed: cleaned,
        origin: 'import',
        cwd: inherited?.cwd ?? workspace,
        profile: 'default',
        app: inherited?.app,
        importer: chainCaller() ?? 'host',
      });
      // 敞开 turn 恢复协议兜底（与 loadSession 恢复同款）：导入流尾可能停在 turn
      // 中间——closers 经 append 进 write-behind 队列，随下方屏障一并落盘
      session.recoverFromInterruption();
      // durable 承诺双保险：显式种子落库（幻影 id 防线）+ flush 屏障（崩溃窗内
      // 「导入成功返回但数据未入库」不可接受）
      await persistence.ensureSeeded(session);
      await persistence.flush(session.header.sessionId);
      return session.header.sessionId;
    },
    /**
     * fork 露头（会话篇 §5.2，2026-08-27 P1-1）：以调用链当前会话的前缀为种子
     * 分叉——回退正路（checkpoint-rewind 实证）= fork + openSession 切换后写。
     * 锚 = registry.routed()（无路由落点返回 undefined 降级，与 appendEvent 同款）；
     * 服务口 ensureSeeded + flush 同 durable 承诺（不返回幻影 id——惰性复制仅
     * 宿主内部 forkSession 维持）；与 createSession 同一进程级增生桶计费。
     */
    fork: async (boundary?: number): Promise<string | undefined> => {
      if (persistence === undefined) {
        throw new AppError(
          PERSIST_BATCH_WRITE_FAILED,
          'fork 在 persist:false 诊断装配下不可用（前缀定格 = durable 承诺——物理不可履行即响亮拒绝）',
        );
      }
      const entry = registry.routed();
      if (entry === undefined) return undefined; // 无路由落点降级（不耗配额）
      chargeSpawn('fork'); // 同桶：fork 每次物理复制父前缀，洪水面与导入同源
      // cwd/profile/app 继承父会话由 forkSession 内部处理；boundary 落在敞开
      // turn 内由 Session.fork 抛 SESSION_FORK_BOUNDARY_INVALID
      const child = persistence.forkSession(entry.session, boundary !== undefined ? { boundary } : {});
      await persistence.ensureSeeded(child);
      await persistence.flush(child.header.sessionId);
      return child.header.sessionId;
    },
    appendEvent: (type: string, data: unknown): SessionEvent | undefined => {
      // 核心词判据单一来源（contracts——注册侧同尺，两道闸一道判据）
      if (isCoreSessionEventType(type)) {
        throw new AppError(
          SESSION_CORE_TYPE_FORBIDDEN,
          `核心事件词汇不允许应用经 ctx.sessions.appendEvent 写入：${type}（内核词写入权属宿主，应用请注册自有词汇）`,
        );
      }
      const entry = registry.routed();
      if (entry === undefined) return undefined;
      const event = entry.session.append(type, data); // 成功写先落账（执法先于计费：未注册词在 append 内先抛）
      chargeSessionWrite(entry.session.header.sessionId, 'appendEvent');
      return event;
    },
    currentSessionId: (): string | undefined => registry.routed()?.session.header.sessionId,
    eventsOfType: (type: string): SessionEvent[] => {
      // 写读同规：未注册词读侧同抛（读侧静默空数组 = 拼错事件名的无声死）
      if (getSessionEventType(type) === undefined) {
        throw new AppError(
          SESSION_FORMAT_UNSUPPORTED,
          `未知事件类型：${type}（eventsOfType 读侧同抛——请先经 ctx.registerSessionEventType 注册词汇）`,
        );
      }
      // 读源钉死 = 内存活日志（与 appendEvent 同账零迟滞）；无落点 = 空枚举
      const current = registry.routed();
      return current === undefined ? [] : current.session.events.filter((e) => e.type === type);
    },
    /**
     * 遮蔽载体宿主代写（会话篇 §2 增补 6，compaction 纵切装配缺口第 1 件）：
     * 应用携 surfaceOp 的 user/message 载体经宿主写权落账——核心词 user/message
     * 应用不可伪造（appendEvent 拒），遮蔽注入是唯一例外通道且四执法点在此收口：
     * ①载体型单边（仅 user/message——assistant/tool 词写权属 loop，非载体）；
     * ②必带遮蔽（无 surfaceOp 的注入一律走 sendUserMessage 归因正门）；
     * ③归因强制 app: 前缀（宿主代写 = 应用行为，归因必须落在应用名上）；
     * ④依据在列补验（冷读 M-5：sourceEventSeqs 须含区间外至少一笔——遮蔽依据
     *   本身被遮 = 遮后不可考；区间覆盖半边由 Session.validateSurfaceOp 执法）。
     * 写入即 flush（边缘纪律 3 宿主级落法）：遮蔽载体是模型可见性变更，flush
     * 屏障先于返回——崩溃窗内「载体丢而重播种已做」的内存/日志分叉收窄到屏障内。
     */
    appendWithSurfaceOp: async (carrier: {
      readonly type: string;
      readonly data: { readonly content: unknown; readonly source: string };
      readonly surfaceOp: { readonly op: 'replace'; readonly start: number; readonly end: number };
      readonly sourceEventSeqs: readonly number[];
    }): Promise<SessionEvent | undefined> => {
      if (carrier.type !== 'user/message') {
        throw new AppError(
          SESSION_CORE_TYPE_FORBIDDEN,
          `appendWithSurfaceOp 载体型单边：仅受理 user/message（收到 ${carrier.type}——assistant/tool 词写权属 loop，应用遮蔽载体只有 user/message 一型）`,
        );
      }
      const { surfaceOp } = carrier;
      if (!surfaceOp || surfaceOp.op !== 'replace') {
        throw new AppError(
          SESSION_SURFACE_OP_INVALID,
          'appendWithSurfaceOp 必带 replace 型 surfaceOp（无遮蔽的注入请走 sendUserMessage 归因正门）',
        );
      }
      if (typeof carrier.data.source !== 'string' || !carrier.data.source.startsWith('app:')) {
        throw new AppError(
          SESSION_SURFACE_OP_INVALID,
          `appendWithSurfaceOp 归因强制 app: 前缀（收到 ${String(carrier.data.source)}——宿主代写是应用行为，归因必须落在应用名上）`,
        );
      }
      const hasOutsideBasis = carrier.sourceEventSeqs.some((seq) => seq < surfaceOp.start || seq > surfaceOp.end);
      if (!hasOutsideBasis) {
        throw new AppError(
          SESSION_SURFACE_OP_INVALID,
          `溯源依据在列：sourceEventSeqs 须含区间 [${surfaceOp.start},${surfaceOp.end}] 外至少一笔（遮蔽依据本身被遮 = 遮后不可考）`,
        );
      }
      const current = registry.routed();
      if (current === undefined) return undefined;
      const event = current.session.append('user/message', carrier.data, {
        surfaceOp: { op: 'replace', start: surfaceOp.start, end: surfaceOp.end },
        sourceEventSeqs: [...carrier.sourceEventSeqs],
      });
      chargeSessionWrite(current.session.header.sessionId, 'appendWithSurfaceOp'); // #14：成功写计费（flush 屏障在其后）
      await persistence?.flush();
      return event;
    },
    /** 模型历史投影只读（增补 7 装配缺口第 2 件——应用读当前会话投影走此面，禁自扫原始流绕投影） */
    deriveMessages: (): ProjectedMessage[] => registry.routed()?.session.deriveMessages() ?? [],
    /**
     * 跨会话有界时间窗查询（会话篇 §3.4 单原语，2026-08-27 刀 1）——sanctioned
     * 直读事实表（不派生状态不攒第二份账）：管理面 events_query 工具与 uninstall
     * 受影响会话数反查的公共取数面。读物理库（write-behind 未 flush 尾部不可见
     * ——迟滞披露条），需精确可传 flushFirst: true（屏障内嵌参数不新开装载面
     * flush API）。persist:false 诊断装配 = 返空降级（deriveMessages 空数组同款）。
     */
    queryEvents: async (query: EventQueryOptions): Promise<EventQueryResult> => {
      if (persistence === undefined) return { rows: [], truncated: false };
      if (query.flushFirst === true) await persistence.flush(); // 屏障先于查询（全量 flush——查询本身跨会话）
      return persistence.queryEvents(query);
    },
  });

  /* ---- ④e 组合树装载前置 + Ring 1 行树化（契约篇 §5.1 节奏表第一刀：tools 行起算） ----
   * Ring 1 必备行挂**独立装载锚**（ring1Anchor——宿主装配期专用锚，与应用锚
   * 分离：/reload 只 dispose 应用锚，Ring 1 行不被动不回卷，仅 boot 生效）。
   * tools 行产物（ctx.tools 服务 + 三段管道 + 检索族；fs 族 S2 已迁 chat 件域
   * 注册）是 ⑥b exec、⑧ 工具快照接线、⑨ chat 件的先行依赖——组合树装载与
   * 官方件注册表因之整体前置到宿主装配期；chat 件对 tools 的依赖改经 ctx.get
   * （件 inject 声明驱动 Kahn 轮次，apply 期取必居值）。 */
  const compositionDir = opts.compositionDir ?? dataDir();
  ctx.provide('paths', createPathsService(compositionDir, workspace));
  /* 应用管理服务注入边（契约篇 §3.4 第二刀，2026-08-27 刀 2）：三个闭包引用的
   * persistence/virtualFaces/registry 均在本行之后才声明——TDZ 安全（闭包只在
   * install/update/uninstall 运行期被调，彼时装配已完成全部初始化）。
   * - loadEntry：词表账本收割面——与装载管线同一 jiti 工厂同一 import 门禁
   *   （virtualFaces + guardTransform），一次性装载读 name/events 词名；
   * - affectedSessionCounts：受影响会话计数取数面——flush 屏障内嵌（write-behind
   *   尾部对查询不可见）+ Store 全库精确聚合（latestSessionId 同族宿主侧直查）；
   * - emitUninstalled：卸载成功尾双落地——总线广播 + 当前会话流落账
   *   （app/uninstalled 核心词，无路由会话时总线面单落地）；
   * - requestReload：重载请求投递面（刀 3 导线——契约篇 §3.4 刀 2 工具族条：
   *   reload 真身住组合根，服务面只投递）。reload 闭包在本行之后声明——箭头
   *   懒求值 TDZ 安全（与上方三闭包同律：只在运行期被调，彼时装配已收口）；
   *   ReloadResult → ReloadOutcome 映射在此（三态投影：queued/done/error）。 */
  const appsService = createAppsService({
    dataDir: compositionDir,
    loadEntry: (entry) => importAppEntry(createAppJiti(virtualFaces), entry),
    // persist:false 诊断装配不注入——服务面按缺省省略受影响会话计数（queryEvents 空降级同款）
    ...(persistEnabled
      ? {
          affectedSessionCounts: async (types: readonly string[]) => {
            const p = persistence; // const 拷贝收窄（闭包内 TS 不追外层条件式）
            if (p === undefined) return {};
            await p.flush();
            return p.store.affectedSessionCounts(types);
          },
        }
      : {}),
    emitUninstalled: (data) => {
      ctx.emit('app/uninstalled', data);
      registry.routed()?.session.append('app/uninstalled', data);
    },
    // 在册应用清单 id 集活取面（R4 行为小刀）：mount 写行前 apps 值域预校验——
    // 与 loadComposition 触发①同源（officialApps 键集，装载序上先行于组合树）
    knownAppIds: () => knownAppIds,
    requestReload: async (requestOpts) => {
      const result = await reload(requestOpts?.app);
      if (result.queued === true) return { status: 'queued' as const };
      if (result.error !== undefined) return { status: 'error' as const, message: result.error };
      return {
        status: 'done' as const,
        failed: result.payload?.failed ?? [],
        // 单区两腿透传（D3 per-app reload）：目标应用 + 卸词集警示
        ...(result.payload?.app !== undefined ? { app: result.payload.app } : {}),
        ...(result.payload?.droppedEvents !== undefined && result.payload.droppedEvents.length > 0
          ? { droppedEvents: result.payload.droppedEvents }
          : {}),
      };
    },
  });
  ctx.provide('apps', appsService);
  /* worker 域舰队登记簿（契约篇 §1.7 K3-c）：各锚舰队建好后登记，拒启/关停
   * 收编遍历此簿——refuseBoot 定义先于舰队建立（装载期拒启路径），登记簿
   * 声明提前、引用延后，TDZ 安全（早期拒启时点簿为空 = 无域可收） */
  const fleets: BridgeFleet[] = [];
  /**
   * convertToLm 丢弃诊断上报（#16 拍板 (c) + 隔离案一第一刀 #2）：
   * ①未注册角色（无 reason）——蒸发陷阱留痕（可能是应用未装，debug 级）；
   * ②toLlm 抛错（带 reason）——应用 bug 已发生，按丢弃收尾不穿透杀 run。
   * 注册角色的 toLlm:null 是设计内过滤，不上报（免刷日志）。
   */
  const reportDroppedRole = (role: string, reason?: string): void => {
    ctx.logger.debug(
      reason !== undefined
        ? `convertToLm 丢弃消息：${role}（${reason}）`
        : `convertToLm 丢弃未注册角色消息：${role}（自定义角色须先注册——装载面 ctx.registerMessageRole，角色名必含 / 域前缀）`,
    );
  };
  /** 拒启收尾（Ring 1 与 Ring 2 启动断言同形）：先收 worker 域舰队再收尾持久层再回卷 ctx，抛聚合清单 */
  const refuseBoot = async (code: string, message: string): Promise<never> => {
    try {
      // worker 域先收（登记簿遍历——早期拒启时点簿空即无域可收；拒启不留孤儿进程）
      for (const f of fleets) f.terminateAll(`boot 拒启收尾（${code}）`);
      await persistence?.flush();
      await persistence?.close();
    } finally {
      await ctx.dispose();
    }
    throw new AppError(code, message);
  };
  // 官方件注册表（契约篇 §6.1 `builtin:` 前缀唯一解析面）：官方随包件闭包注入
  // 宿主活资源（官方件 = 宿主装配特权——不新开 ctx 服务名）。persist:false 时
  // 无 store，memory 官方件降级空转（warn 进日志）；subagent 真工厂闭包 streamFn/
  // model/活会话引用/父沙箱档/根总线（app/subagent-factory.ts——每子独立装配序）；
  // chat 件收会话选择/驱动/ctx.agent 四件（件聚落 src/chat/app.ts）——无条件注入，
  // 无持久层时件自降级空转（装载面完好——dump-config 诊断树不断链）；
  // scheduler 件收 gate 判据两闭包 + runner（spawn 组装在 app/scheduler-runner.ts
  // ——argv 公式 + env set 注入 + 10 分钟超时，席 13 第一刀）+ OS 定时注册器
  //（app/tick-register.ts——launchd/crontab 注册，K2-d；件经闭包收面不见 exec）
  const tickRunner =
    opts.tickRunner ??
    createTickRunner({
      dataDir: dataDir(),
      dbPath: resolvedDbPath,
    });
  const osTickRegistrar =
    opts.osTickRegistrar ??
    createTickOsRegistrar({
      dataDir: dataDir(),
      dbPath: resolvedDbPath,
    });
  /** gate 判据②：全注册表最近 user/message 时刻（S1 升格——多驱动并存时取全部
   * 会话最大值，含退役保留者〔其活日志仍在内存〕；会话活对象内存直读——append
   * 即在，write-behind 零滞后；跨进程的「别打架」不归 gate 管，那是 reserve
   * 抢占的职责，两护栏分工） */
  const lastUserMessageAt = (): number | null => {
    let latest: number | null = null;
    for (const entry of registry.entries.values()) {
      const events = entry.session.events;
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!;
        if (event.type === 'user/message') {
          if (latest === null || event.time > latest) latest = event.time;
          break;
        }
      }
    }
    return latest;
  };
  /* ---- chat 件 bundle（S1 工厂化，契约篇 §5.4 第 6 条 S1 射面）----
   * createChatApp 产物 = {module, registry, front}：注册表由组合根此处分配、
   * chat 件负责填充与消费（单真相）。早期闭包（③b 转发壳 / ④b onUsage /
   * ④f sessions / 调度判据）对 registry 的引用全部运行期才调用——TDZ 安全。 */
  /**
   * 系统提示词物化器（S2 per-entry，契约篇 §1.3 落码形态①）：`[基座, 技能渐进
   * 披露, 具名段]` 在调用时点求值拼接。全局 let + rebuild 退役——每条目 open
   * 各自物化（串与记忆基线**同时点同面**冻结，多会话纪元互不串档）；skills/
   * prompts 两 const 在 ④g/⑦ 构造、晚于本箭头——闭包内引用，调用必在装载期
   * 后（chat 件 ring2 apply 的 open 最早），无 TDZ。sessionId 透传具名段
   * materialize（会话键控段冻结该会话基线）；缺省 = 诊断物化（dump-config）。
   */
  const materializeSystemPrompt = (sessionId?: string): string =>
    [SYSTEM_PROMPT_BASE, skills.renderAvailableSkills(), prompts.materialize(sessionId)]
      .filter((part) => part !== '')
      .join('\n');
  /** 可写根推导器（safety/roots 同源产物——S2 fs 迁域随 chat 件走：主驱动 fs
   * 族的 fence 数据源；与守门行同源单点接线，chat/subagent 两消费面同款构造） */
  const rootsProvider = createRootsProvider({ workspace, mode: () => sandboxMode });
  /**
   * in-process 子装配工厂（subagent 件与 delegable 应用注册共用同一实例——
   * 每子独立装配 dsh-10，委派目标形态差异只在 mergeRequest 静态半边）。
   * fork 源读点④（骨架篇 §9.3）：链 → 注册表 → 前台聚焦——子工厂在父 tool
   * call 链内调 getSession（链在场=父会话），命令面/程序面调用落聚焦。
   */
  // 行收窄查询单点闭包（R1 P0-4 → R1 复盘批二双消费面，契约篇 §1.7 增补
  // 2c + 第 11b 条）：定义前置（下方子代理工厂与 ⑦ 区 exec 服务两处消费——
  // 本处先于两者）。按 caller 链帧读出的行 id 查该 external 行有效白名单
  // （基线 ∩ 行声明——单源 externalEffectiveRoots；composition 是 let，闭包
  // 活取——/reload 重赋后自动见新树，调用时恒已初始化）。「OS 沙箱罩后代」
  // 与「委派借道不拿会话档宽面」两执法通道同源：分域行经 svc-invoke 调宿主
  // exec 的间接子进程按 confine writableRoots 显式覆盖收窄；external 行经
  // tool-run 调全局层委派工具 → 子代理 fs 写面按栈交集收窄。非行帧 / 行不
  // 在表 / 非 external 载体 = undefined = 会话档现行为。组合根注入闭包
  // （exec 与 factory 拓扑上不能 import app 的 composition 现实）。
  const rowConfinementLookup = (caller: string | undefined): readonly string[] | undefined => {
    if (caller === undefined) return undefined;
    const row = composition.rows.find((r) => r.id === caller);
    if (row === undefined || resolveRowCarrier(row) !== 'external') return undefined;
    return externalEffectiveRoots(workspace, appDataDirOf(dataDir(), row.id), row.sandbox?.fs?.writableRoots);
  };
  const subagentChildFactory = createSubagentChildFactory({
    ...(persistence ? { persistence } : {}),
    // 父驱动活取值（域键升级批：session 与 appId 单次 routed() 原子取——派生腿
    // 读 listFor(父 app) 需要应用域键，fork 源需要会话；getParent 缺席 = persist:false
    // 诊断形态，派生腿回落 list() 全局层）
    getParent: () => {
      const entry = registry.routed();
      return entry === undefined ? undefined : { session: entry.session, appId: entry.appId };
    },
    streamFn,
    model,
    convertToLlm: (messages) => defaultConvertToLlm(messages, reportDroppedRole),
    workspace,
    sandboxMode,
    rootCtx: ctx,
    // 行收窄注入（R1 复盘批二）：子代理自建 fs 写面 = 会话档 ∩ caller 链栈行
    // 声明交集——external 行委派借道不再拿会话档宽面（契约篇 §1.7 第 11b 条）
    confinementFor: rowConfinementLookup,
    // 守门行传导判据（第三十一批 P1-4）：anchors = 根名 + 锚 fork 名拼成的 owner
    // 完整前缀（根名 'app' = :398、锚 fork 'ring1'/'apps' = :1219/:1491 三处
    // 字面量的镜像——/reload 重建锚同名，前缀恒定）；mainRows 活取组合树 main
    // 载体行 id（resolveRowCarrier 闩一分派——worker 行走分域装载不进 main 快照；
    // external 行 fail-closed 拒载不进装载序，快照天然不含；disabled 行不在装
    // 载序、快照天然不含，无需再滤；let composition 捕获——/reload 重赋后活取
    // 自动见新树）
    gateRowFilter: {
      anchors: ['app:apps:', 'app:ring1:'],
      mainRows: () => new Set(composition.rows.filter((row) => resolveRowCarrier(row) === 'main').map((row) => row.id)),
    },
  });
  /** 沙箱 confine 服务（S5 bash 迁域上提至此：chat deps 需要 sandbox 实例作
   * bash def 构造原料，而 chatBundle 构造点在本行——实例无依赖可先行；provide
   * 挂 ⑥b 原位不动） */
  const sandbox = createSandboxService();
  const chatBundle = createChatApp({
    ...(persistence ? { persistence } : {}),
    resumeSession: opts.resumeSession,
    // CLI --app 进入面（第三纵切）：boot 首驱动即该应用域；显式档标记供审批
    // 预设优先序（显式旗标 > 应用预设 > 全局缺省——opts.sandboxMode 在场性即显式性）
    ...(bootApp !== undefined ? { app: bootApp } : {}),
    ...(opts.sandboxMode !== undefined ? { sandboxModeExplicit: true } : {}),
    rootCtx: ctx,
    workspace,
    model,
    sandboxMode,
    streamFn,
    // S4 会话层 turn 级 auto-retry 的 transient 判定器：llm 服务桶表直通
    // （classifyError === 'transient'——chat 拓扑边不含 llm，判定器经服务面注入）
    isTransientError: (message) => llmService.classifyError(message) === 'transient',
    convertToLlm: (messages) => defaultConvertToLlm(messages, reportDroppedRole),
    transformContext,
    // user_input / turn_stopping 两桥（契约篇 §2.2 增补 7①②，2026-08-27 P1-2
    // 兑现）：同 transformContext 形态——根总线 + 挂起钟，sessionId 参数化
    // 由 chat 件闭包绑定到各驱动
    transformInput,
    onTurnStopping,
    materializeSystemPrompt,
    writableRoots: rootsProvider,
    stampSandboxFacts,
    // tick 入口记账道声明（--background argv → run 入口 → 此处；缺省前台道）
    ...(opts.usagePriority !== undefined ? { usagePriority: opts.usagePriority } : {}),
    // S5 审批守门归属批：驱动 fresh 作用域三件的原料随 deps 注入——
    // approvalPolicy（CLI 旗标唯一来源，v1 全驱动同档）/ confirm（interactive
    // 时 ui.confirm——fresh 作用域 answerer 绑它；headless 不传 = fail-closed）/
    // sandbox + allowlist（bash def 构造原料 + 守门行同源活数组）
    ...(opts.approvalPolicy !== undefined ? { approvalPolicy: opts.approvalPolicy } : {}),
    ...(opts.interactive ? { confirm: (text: string) => ui.confirm(text) } : {}),
    // 「始终允许」三态化两件（§8.4 增补 2 落码形态③⑥）：select = ui.select
    // 三选原语（interactive 时注入；缺省降级 confirm 两态不呈现 always）；
    // persistAllowlist = AllowlistStore.add 面（幂等去重）
    ...(opts.interactive
      ? { select: (m: string, c: readonly { value: string; label: string }[]) => ui.select(m, c) }
      : {}),
    persistAllowlist: (draft) => allowlist.add(draft),
    sandbox,
    allowlist: () => allowlist.entries,
  });
  /** 会话驱动注册表（S1 单真相——Map<sessionId, DriverEntry> + 前台聚焦指针） */
  const registry = chatBundle.registry;
  const builtins = createBuiltinRegistry({
    ...(persistence ? { store: persistence.store } : {}),
    ...(persistence ? { goalConnection: persistence.store.connection } : {}),
    schedulerDeps: {
      runJob: tickRunner,
      osRegistrar: osTickRegistrar,
      // busy 判据（第二刀④）：turn/start·turn/end 配对深度投影——跨进程有效
      //（driverRef 进程内布尔退役）；persist:false 无账可读 = 0（诊断面不拦）
      turnDepth: persistence ? () => openTurnDepth(persistence.store) : () => 0,
      lastUserMessageAt,
      // canAfford 判据（第二刀④ never-unbounded 执法）：同一底账同一闸——
      // 复用 ④b 服务闭包（spend ledger = 日志投影，不建第二套账）
      backgroundAffordable: persistence ? () => llmService.canAfford('background') : () => true,
    },
    // mcp 件闭包（契约篇 §6.6 冷读 #1：spawn/kill 组装上提组合根——
    // spawnServer 在 app/mcp-spawn.ts，killTree 自 exec 公开面；登记簿根
    // 钉数据目录，与 overlay 同根不随会话漂移）
    mcpDeps: {
      spawnServer: createMcpSpawner(dataDir()),
      killTree,
      dataDir: dataDir(),
    },
    // tools 件闭包（S2 fs 迁域后收窄）：gate/decision durable 落点绑转发壳
    //（件绑定后落账生效）+ 检索族路径锚。可写根推导器已随 fs 族迁 chat 件
    // deps（rootsProvider——见 chatBundle 接线处）。rowApp 探针 = D1 注册面
    // 隐式路由（挂应用的行注册落应用域层——探针活闭包，装载期恒现行树）
    toolsDeps: {
      gateSink: durableForward.gate,
      workspace: () => workspace,
      rowApp,
    },
    // web 件测试注入缝（生产零参——真 fetch/真 DNS；组合根全栈测试注入
    // fetchImpl/lookup 假实现，mock 停在外部边界非中间层）
    webOverrides: opts.webOverrides,
    // 可写根活取值（memory 件文件命令面落盘判定——第三十二批；chatBundle 的
    // fs 可写根同源：同一 rootsProvider，文件命令与 fs 工具族同一物理边界）
    writableRoots: rootsProvider,
    workspace: () => workspace,
    // 声明式子代理发现位置（镜像 skills ⑥⑦ 形态：workspace 同源 + homeDir 测试缝）
    agentLocations: opts.agentLocations ?? defaultAgentLocations(workspace, { homeDir: opts.homeDir, trusted: true }),
    // in-process 子装配工厂（subagent 件与 delegable 应用注册共用同一实例——
    // 每子独立装配 dsh-10，委派目标形态差异只在 mergeRequest 静态半边）
    subagentFactory: subagentChildFactory,
    // goal 工具三件//goal 命令的会话归属（同 routed 路由：run 期链内=归属会话，
    // TUI 命令面=聚焦会话）。boot 续接降级已改走装载收口 session_start 补播
    // 事件面（二十九批增补 8①）——wasResumed 装配旁路退役
    getSession: () => registry.routed()?.session,
    // chat 件 bundle（S1 工厂化）：注册表/前台宿主由件构造、组合根在此分配持有
    //（早期闭包 ③b/④b/④f 惰性引用 registry——TDZ 安全：全部运行期才调用）
    chat: chatBundle.module,
  });
  // 虚拟面第五/六键注入物（P0-2，契约篇 §1.2 注记①）：参数注入加载器——
  // context 不 import llm/persist（拓扑护栏）。第六键拒开基准 = resolvedDbPath
  //（APP_DB_PATH 覆盖已计入，与 Persistence 开库同源）；persist:false 形态下路径
  // 仍可算、比对语义照常成立（真开库时才比对）。boot 与 /reload 共用同一份
  //（两工厂产物均无状态——llm 面是纯 re-export，sqlite 面只闭包主库路径）
  const virtualFaces = {
    llm: providerApiFace,
    sqlite: createAppSqliteFace(resolvedDbPath),
  };
  // 组合树合成（overlay 后写胜出）。composition 是活绑定（/reload 重装载换树）
  let composition: CompositionReport = loadComposition(compositionDir, builtins, knownAppIds);
  // 安全模式（--no-apps，技术栈篇 §5）：boot 合成期过滤到 Ring 1 硬装配行
  // ——Ring 2/3 全跳过（官方默认层与 overlay 一视同仁）。只作用 boot：/reload
  // 的 fresh 读盘不过滤（救援环——boot 安全模式 → 修 overlay → /reload 恢复
  // 全树，进程内闭环，见 reload 内注记）
  if (opts.noApps) composition = safeModeComposition(composition);
  // 行挂载目标投影重建（D1）：boot 合成产物（安全模式过滤后）即投影源——
  // 早于一切装载（Ring 1 ③/应用 ⑨ 的注册面路由与拒载执法即刻生效）
  syncRowAppMap(composition);
  // Ring 1 必备行断言·第一面（契约篇 §5.1 行树化批「第二断言类」）：合成产物
  // 里的 Ring 1 行被 overlay 禁用/平台门控/解析失败即拒启（列举全部缺失行）
  const ring1Violations = assertRing1Required(composition);
  if (ring1Violations.length > 0) {
    const lines = ring1Violations.map((v) => `  - ${v.id}〔${v.kind}〕：${v.detail}`);
    await refuseBoot(
      COMPOSITION_ROW_INVALID,
      `Ring 1 必备行断言失败（${lines.length} 行——卸掉任一行首启核心循环必破）：\n${lines.join('\n')}`,
    );
  }
  // Ring 1 行装载（独立锚：fork 自根 ctx、注册表同根共享——ring1 provide 对
  // ⑥b/⑧/⑨ 与后续装载行全局可见；锚永不重 fork，/reload 不动它）。区身份 =
  // 系统区（D3 装载分面分区，契约篇 §5.1「Ring 1 行 provide 归系统区表」）：
  // 与系统区行同生命周期（boot + 全量 /reload），宿主面读链（根表→系统区表）
  // 照见——对 ⑥b/⑧ 消费面零迁移
  const ring1Anchor = ctx.fork({ name: 'ring1', zone: SYSTEM_ZONE });
  // worker 域监督编舞值（契约篇 §1.7 K3-c 宿主全局缺省，两舰队共用）：
  // 心跳 15s 节律 × 3 拍缺省 ≈ 45s 冻结判定（同步死循环/事件循环冻结可判可杀；
  // CPU 燃烧如实收窄不可判——打点照登）；JS 堆 512MB = 预算内存维度宿主缺省
  //（只限引擎堆非安全墙；分应用细配 = rowResourceLimits——应用清单 budget.memoryMb
  // 已于第三纵切收键消费〔2026-08-27〕，见下方钩子注记）
  // worker 监督编舞 + 死亡结算状态回写（markFailed——域死行在 ctx.apps.list
  // 状态源同步转 failed，与 app/failed 事件广播同一时点）
  const workerChoreography = {
    heartbeatMs: 15_000,
    resourceLimits: { maxOldGenerationSizeMb: 512 },
    // 按行覆盖（第三纵切 budget.memoryMb 落码形态）：应用组件命中的 worker 行
    // 按清单限值执行（键 = 行 pkg 装载身份串，与组件在场断言同键）；未命中
    // 回落全局 512MB。多应用共享组件已在 appMemoryMb 构建时取严（min）
    rowResourceLimits: (row: { readonly pkg?: string }): { maxOldGenerationSizeMb: number } | undefined => {
      const mb = row.pkg !== undefined ? appMemoryMb.get(row.pkg) : undefined;
      return mb !== undefined ? { maxOldGenerationSizeMb: mb } : undefined;
    },
    markFailed: appsService.markFailed,
    // external 腿装配（external carrier 落码批——契约篇 §1.7 第三十七批）：
    // 三层执法参数面（闩二校验 + PM 旗 + OS confine + probe 醒 + 白名单 env
    // + per-域 TMPDIR 在舰队内单点组装）。sandbox 实例复用 ⑥b 前上提的同源
    // 服务（后端链/probe 同一探索面）；Ring 1 舰队同携带——替换行两腿同管线
    // 资格（官方行恒 main，参数闲置无副作用）
    external: {
      workspace,
      dataDir: dataDir(),
      sandbox,
      // OS 层开关（RuntimeOptions.externalOsLayer——显式装配参数，缺省开：
      // probe 醒 fail-closed + confine 包裹；false = PM-only 逃生门）
      ...(opts.externalOsLayer === false ? { osLayer: false } : {}),
    },
  };
  // worker 域舰队·Ring 1 面（每 worker 行一域）：Ring 1 缺省全 builtin 行（恒
  // main 域），workerLoader 在此只为替换行保留同管线资格；锚永不重 fork——
  // 本舰队只在进程关停收编（/reload 不动 Ring 1）
  const ring1Fleet = createBridgeFleet({ root: ctx, anchor: () => ring1Anchor, ...workerChoreography });
  fleets.push(ring1Fleet); // 登记簿收录（refuseBoot/关停收编遍历面）
  const ring1Plan = composition.plan.filter((row) => RING1_REQUIRED_ROW_IDS.includes(row.id));
  const ring1Load = await loadApps(ring1Anchor, ring1Plan, { virtualFaces, workerLoader: ring1Fleet.loader });
  // Kahn 零进展残留行的孤儿域清割（行已进失败清单——防漏是舰队的存在理由）
  ring1Fleet.reapUnapplied('Ring 1 装载收口（Kahn 残留行清割）');
  if (ring1Load.failed.length > 0) {
    const lines = ring1Load.failed.map((row) => `  - [${row.code}] ${row.id}：${row.message}`);
    await refuseBoot(
      APP_LOAD_FAILED,
      `Ring 1 行装载失败（${lines.length} 行，app/failed 事件已逐行广播）：\n${lines.join('\n')}`,
    );
  }
  // Ring 1 产物就位断言·第二面：tools 服务在场且带管道（替换件若未提供带管道
  // 服务面，下游 exec/loop 全部失能——boot 期响亮拒绝，不留运行期暗坑）
  const tools = ctx.get<ToolsService>('tools');
  const pipeline = tools.executor;
  if (pipeline === undefined) {
    await refuseBoot(
      COMPOSITION_ROW_INVALID,
      'Ring 1 必备行 tools 未提供带管道的工具服务（替换件实现须 provide ctx.tools 且携带 executor——契约篇 §5.1 行树化批）',
    );
    // refuseBoot 是 async-never（Promise<never>）——TS 流分析不把 await 异步
    // never 识别为终态，显式 throw 收束控制流（运行期不可达）
    throw new AppError(COMPOSITION_ROW_INVALID, 'Ring 1 拒启（不可达兜底）');
  }

  /* ---- ⑤ 工具面（Ring 1 行树化批起 = builtin:tools 件在 ④e 装载，本段仅存指针） ----
   * 三段管道 + ctx.tools 服务 + 检索族的原硬装配已整体入列组合树第七行
   * （src/tools/app.ts——apply 于 ring1Anchor；fs 族 S2 迁 chat 件域注册）；
   * 守门行仍在 ⑥ 经 tools_pre_execute 事件 prepend 占首位（管道无关接线，见 gate.ts）。 */

  /* ---- ⑥ 审批 + 守门行（审批对绑转发壳，件绑定后落 durable） ---- */
  const approval = createApprovalService(ctx, {
    policy: opts.approvalPolicy ?? 'ask',
    sink: durableForward.approval,
  });
  // 跨会话 allowlist 用户配置层（第二十四批题1a 接线批 Commit B）：<数据目录>/
  // allowlist.json 原子写；活数组交给守门行同一引用，/allowlist 命令的 add/remove
  // 原地改零重装。损坏/缺省 = 空表起步（warn——隔离 ≠ 静默；allowlist 是增益面
  // 非事实源，不炸启动）。诊断面（dump-config :memory:）容忍此读侧副作用。
  const allowlist = new AllowlistStore(join(dataDir(), 'allowlist.json'), {
    warn: (message) => ctx.logger.warn(message),
  });
  ctx.effect(() =>
    installSafetyGate(ctx, { approval, workspace, mode: () => sandboxMode, allowlist: allowlist.entries }),
  );
  // sandbox 档首落随会话边界进 chat 件（③b stampSandboxFacts——内核有数据，
  // 应用有时点；续接同档不重复落的 diff 语义内建于盖章函数）

  /* ---- ⑥b exec 件聚落（第 18 模块，2026-08-25 exec 纵切；S5 bash 迁域 2026-08-26）----
   * 沙箱 confine 服务实例已在 chatBundle 前上提构造（S5 bash 迁域——chat 件
   * open() 构造 bash def 需要 sandbox 原料，构造点先于本段；provide 挂本段
   * 原位）。bash 工具件全局层注册**退役**：随 chat 件 open() 会话域注册（升权
   * 闭包绑本驱动 approval——骨架篇 exec 节「bash 注册面迁域」）；全局层退役后
   * 诊断面（dump-config 无驱动语境）无 bash 属正确投影。ctx.exec 服务保留：
   * 走全局管道（无驱动语境面——与 ctx.fetch 同形，服务调用不旁路守门与落账，
   * 内部名 exec 不进模型词汇表）。 */
  ctx.provide('sandbox', sandbox);
  // 行收窄注入面（R1 P0-4 → R1 复盘批二双消费面）：exec 服务与子代理工厂
  // 共用前置定义的 rowConfinementLookup（见上方子代理工厂装配处注释——
  // 契约篇 §1.7 增补 2c + 第 11b 条）
  registerExecService(ctx, {
    pipeline,
    sandbox,
    mode: () => sandboxMode,
    workspaceRoot: workspace,
    confinementFor: rowConfinementLookup,
  });

  /* ---- ⑦ 技能（本地 provider 发现 + 渐进披露清单进系统提示词）----
   * 具名提示词段服务（ctx.prompts，pi-4(a) 拍板）：段注册表宿主拥有，分节序固定 =
   * 基座 → 技能渐进披露 → 具名段（id 字典序）；render() 仅在重建时点求值物化，
   * 段内容随快照冻结（禁整串替换与 per-run 重写两毒品形态——契约篇 §1.3 五件） */
  const { service: prompts, host: promptsHost } = registerPromptsService(ctx, {
    // D3 注册面同族收口（契约篇 §5.1）：app 行装载期调 registerSection 拒载
    //（prompt 段全局物化无域层——与 D1 skills/命令拒载同律，caller 链行籍帧判行）
    rowApp,
  });
  // environment 披露段（骨架篇 §7.3——exec 刀配套披露）：宿主自留地首例，
  // 走宿主半边通道（无 `/` 单段 id；装载面注册此类 id 即拒）。快照语义：
  // render 时现取档位/工作区——boot / /reload / /new 重建时点物化新值
  promptsHost.registerHostSection({
    id: 'environment',
    render: () => {
      // 应用装载计数（environment 第五件，契约篇 §3.4）：缺省不注入即无此行——
      // environment 段先于装载物化，boot ⑨ 收口的重物化才让计数非零（B-1 落码
      // 义务）。render 时现取 = 快照语义（重建时点冻结）
      const appCounts = () => {
        const rows = appsService.list();
        return {
          total: rows.length,
          activated: rows.filter((r) => r.status === 'activated').length,
          failed: rows.filter((r) => r.status === 'failed').length,
          skipped: rows.filter((r) => r.status === 'skipped').length,
        };
      };
      return renderEnvironmentSection({
        mode: () => sandboxMode,
        workspaceRoot: () => workspace,
        appCounts,
      });
    },
  });
  // 项目指令文件段（骨架篇 §7.3 四层发现——宿主自留地第二段）：render 仅重建
  // 时点求值 = 每次重建重读文件（改 AGENTS.md 后 /reload 生效——快照语义）；
  // 发现位置装配期定死（workspace + homeDir 测试缝，skills/agents 同款形态）
  const instructionLocations =
    opts.instructionLocations ?? defaultInstructionLocations(workspace, { homeDir: opts.homeDir });
  promptsHost.registerHostSection({
    id: 'instructions',
    render: () => {
      // 截断等诊断转发宿主 logger（warn 面可见——不静默吞护栏触发）
      const found = discoverInstructions(instructionLocations);
      for (const diagnostic of found.diagnostics) ctx.logger.warn(`[instructions] ${diagnostic.message}`);
      return renderInstructions(found.sections);
    },
  });
  // 提供方链变更广播桥（契约篇 §2.2 增补 6，#17 收口）：服务保持纯（不持 ctx），
  // 组合根经 onProvidersChange 桥接总线——广播与 provide 收在同一时点，无窗口期
  const skills = createSkillsService({
    onProvidersChange: (providerIds) => ctx.emit(SKILLS_CHANGE_EVENT, { providers: providerIds }),
    // D1 app 行技能拒载探针（provider 全局注入 systemPrompt 无域层——app 行
    // 注册即跨应用漏注入；探针活闭包见 ①d 段注记）
    rowApp,
  });
  registerSkillsService(ctx, skills);
  const locations = opts.skillLocations ?? defaultSkillLocations(workspace, { homeDir: opts.homeDir, trusted: true });
  skills.registerProvider(createLocalSkillsProvider({ locations }));
  skills.refresh();
  // 系统提示词全局 let + rebuild 已退役（S2 契约篇 §1.3 落码形态①）：物化器
  // materializeSystemPrompt 在 chatBundle 接线处定义（每条目 open 各自物化/
  // 变更时点全部非退役条目重物化），本段不再持有进程级单份串

  /* ---- ⑧ 装载层接线（骨架篇 §9.2 装配层接线义务——刷新 loop 活视图；驱动本体随 chat 件走） ---- */
  // loop 工具快照与系统提示词均 per-entry（S2）：本段不再持有组合根级共享快照，
  // 只做变更监听接线——事件载荷路由到条目控制面（refreshTools/rematerialize）
  // 装载窗口（骨架篇 §9.2 注记）：boot ⑨ 与 /reload 的批量装载期间，工具/段注册
  // 只刷活视图不逐条落 header——装载期中间态非模型可见时点，逐条快照只产噪声且
  // 窃走首请求的 initial 名分（会话篇 §1.3 腿 2）；窗口收口统一落账（boot 首请求
  // initial/resume，/reload 收口单张 change）。窗口外的运行时注册仍即时落 change
  //（「模型可见即落日志」不变）
  let loadWindow = true;
  /** 非退役条目统一落 header 快照（S1：tools/prompts/skills 变更与 /reload 收口
   * 共用——遍历注册表；退役会话不再 run，change 快照是纯噪声故跳过。writeHeader
   * 内建 diff，组装参数未变不落；注册表空〔件未装载/persist:false〕自然 no-op） */
  const writeHeadersAll = (): void => {
    for (const entry of registry.entries.values()) {
      if (!entry.retired) entry.controls.writeHeader();
    }
  };
  /** 全条目重物化系统提示词（S2：技能重扫一次 + 全部非退役条目各自重物化——
   * prompts/skills 变更与 /reload 收口共用；/new 不走此路〔open 即新纪元〕） */
  const rematerializeAll = (): void => {
    skills.refresh();
    for (const entry of registry.entries.values()) {
      if (!entry.retired) entry.controls.rematerialize();
    }
  };
  // tools_change → 刷新 loop 工具快照 + 即时落 request/header 快照（骨架篇 §9.2
  // 接线义务；会话篇 §1.3 腿 2「仅变化才快照」——writeHeader 内建 diff，toolSchemas
  // 变了才落 reason=change，run 中途换工具也当场留痕）。**两键路由（域键升级批）**：
  // 载荷带 `driver`（sessionId）= 驱动层变更只刷该驱动条目（chat 件 open 注册 fs+bash
  // 时即此形）；带 `domain`（appId）= 应用域层变更刷该应用全部条目（v1 空层无住客，
  // 清单投影批起有流量）；缺省 = 全局层变更刷全部条目（memory/exec/web/mcp 等行
  // 注册）。chat 件未装载时注册表空——自然 no-op（无条目即无快照面）
  const unwatchToolsChange = ctx.on(TOOLS_CHANGE_EVENT, (payload: unknown) => {
    const change = payload as { domain?: unknown; driver?: unknown } | undefined;
    const domainKey = typeof change?.domain === 'string' ? change.domain : undefined;
    const driverKey = typeof change?.driver === 'string' ? change.driver : undefined;
    for (const entry of registry.entries.values()) {
      if (entry.retired) continue;
      // 窄键优先：driver 单条目 > domain 该应用全部条目 > 全部（驱动层注册只发
      // driver 键、应用域层只发 domain 键——emit 面保证两键不同带，此处防御序仍定）
      if (driverKey !== undefined) {
        if (entry.session.header.sessionId !== driverKey) continue;
      } else if (domainKey !== undefined && entry.appId !== domainKey) continue;
      entry.controls.refreshTools();
      if (!loadWindow) entry.controls.writeHeader();
    }
  });
  // prompts_change → 全条目重物化 + 即时落 header 快照（pi-4(a) 落码形态④，与
  // tools_change 同族）：段集只在装载//reload 两时点变（注册/注销即广播）；装配层
  // 同点完成重物化——订阅者是观测刷新，不承担重建。writeHeader 内建 diff：段内容
  // 变了才落 reason=change，没变不污染日志
  const unwatchPromptsChange = ctx.on(PROMPTS_CHANGE_EVENT, () => {
    rematerializeAll();
    if (loadWindow) return; // 装载窗口内不逐条落账——窗口收口统一落
    writeHeadersAll();
  });
  // skills_change → 全条目重物化 + 即时落 header 快照（契约篇 §2.2 增补 6，
  // 变更事件族第 3 件，与 prompts_change 同构）：provider 链变更（应用热注册/
  // 卸载技能来源）即时重物化——渐进披露随 rematerializeAll 内的 skills.refresh()
  // 重扫。单一机制收口（树干原则）：boot ⑨ 装载窗口内事件照发、重物化即时幂等
  // （窗口收口由 header 落账闸统一），不加收口补丁——此前应用技能提供方
  // 装机即隐身，可见性靠 /reload //new 或无关应用注册段捎带 rebuild 的偶然耦合
  const unwatchSkillsChange = ctx.on(SKILLS_CHANGE_EVENT, () => {
    rematerializeAll();
    if (loadWindow) return; // 装载窗口内不逐条落账——窗口收口统一落
    writeHeadersAll();
  });
  /** 退订三个变更监听（关停序在 flush/close 前调用）：ctx 回卷会逐件注销应用工具/ 段/技能提供方（tools_change/prompts_change/skills_change 随之广播），若库已关监听仍在，会向死连接 append header、重物化简报段——关停期变更非模型可见时点且永不落盘，纯噪声 */
  const unwatchChangeEvents = (): void => {
    unwatchToolsChange();
    unwatchPromptsChange();
    unwatchSkillsChange();
  };

  /* ---- ⑧b 开新会话（/new，S1）：registry.open 一条龙 + 旧聚焦条目退役 ----
   * 编排留组合根（与 /reload 同族——全为宿主资源调度）：会话创建/durable 直连/
   * session_start/盖章/header 名分/驱动构造全在 chat 件工厂 open() 内化；旧
   * 条目退役但 session/durable 保留（迟到结算继续落原会话账——防 seq 撞号），
   * 驱动停摆（投递降 inject、续跑 INACTIVE——「退役即停摆」）。 */
  const startNewSession = (): Session | undefined => {
    // 无持久层（诊断面）无事可做；聚焦驱动 run 进行中拒绝（时间线正被 loop 引用）
    if (!persistence || registry.focused()?.driver.isRunning) return undefined;
    const previous = registry.focused();
    // 技能重扫先行（/new 重建时点的技能面半边——原 rebuildSystemPrompt 内含的
    // refresh 保留；提示词半边随 open 即新纪元物化，不再全局 rebuild）
    skills.refresh();
    /* 聚焦条目 app 透传（D1-d，契约篇 §5.4 B 案——「同应用新开」收口）：/new
     * 前聚焦在哪个应用域，新会话即开在该域（恒 chat 域过渡态退役）。查表而非
     * 透传 id：open({app}) 吃清单（装配默认位/审批预设/预算打标全在清单上）；
     * appId 值域 = 在册 ∪ chat（enter/boot 两入口均经 officialApps 解析），查无
     * 仅剩 apps 目录缺失的退化形态——回落裸 open（chat 缺省域与 CHAT_APP_ID
     * 同值，行为不变不炸命令面）。/app new 是另一动词（开新+驻留），恒 chat 域
     * 不在此径（两动词 app 归属不同是字面事实非矛盾）。 */
    const app = previous === undefined ? undefined : officialApps.get(previous.appId);
    const opened = registry.open(app === undefined ? {} : { app });
    if (opened === undefined) return undefined;
    if (previous !== undefined && previous !== opened) registry.retire(previous.session.header.sessionId);
    return opened.session;
  };

  /* ---- ⑨ 组合树装载（Ring 2/3 行走树；Ring 1 行已在 ④e 独立锚装载——树化批） ----
   * 服务全部就位后再装应用（inject 依赖驱动轮次激活——宿主服务首轮即全就绪）；
   * **首行 chat 件装载即会话选择/驱动构造/ctx.agent provide 全就绪**（其后行的
   * 工具注册经 ⑧ 已接线的 tools_change 原位刷新 loop 工具快照，含 run 中途）。
   *
   * 卸载基底 = 应用锚作用域（§1.3 落码形态①）：全体应用 scope 自锚 fork、自定义
   * 事件词汇挂锚 effect——锚 dispose 即 LIFO 级联回卷一切应用注册（工具/监听/服务/
   * 词汇），/reload 的卸载半边由此成立；重锚 = ctx.fork 再派生（注册表同根共享）。
   * ring1Anchor 不在回卷面（Ring 1 行不回卷，契约篇 §5.1 /reload 语义）。chat 件
   * 的驱动注册表为工厂级（S1）——重装载 apply 复用全部条目（时间线存续），只
   * 重接 provide 服务面。jiti moduleCache:false 是两条缓存纪律的 v1 基底（重装即全依赖图
   * 重求值）。appsService 服务 provide 在 ④e 一次（§1.3 服务集恒定）：boot 与
   * /reload 经 applyLoad 就地更新状态，热应用期间服务引用永不断链。
   * 失败行两面语义（§1.6）：boot = 启动断言拒绝启动（先收尾持久层再回卷 ctx，抛全量
   * 清单）；/reload = 逐行响亮报告、进程存活（local 源「改动 + /reload 即见」环）。 */
  // 应用技能注册回调（契约篇 §1.2 第六件；拓扑 seam 落码形态——context 不引
  // skills，组合根在此桥接）：loadApps 在行作用域 fork 后、apply 之前逐声明行
  // 回调。桥接三件：包层 provider 工厂（skills 模块产）+ registerProvider（追加序
  // 即优先序——local-fs 装配序 ⑦ 已先注册，包内技能恒居最低层，用户本地永远压过
  // 包内）+ 挂行作用域 effect（行失败 / /reload 锚回卷即注销——技能是行资产）。
  // registerProvider → skills_change → 重建管线自然刷新，此处不另发 refresh
  //（双发 = 每应用双份全量重扫）。回调契约不抛错已退役（D1 注册面路由，
  // 2026-08-27）：app 行的技能注册会被服务面拒（COMPOSITION_ROW_INVALID）→
  // 加载器收为行失败——故意执法非契约违背。装载器回调刻意不置 caller 链
  //（桥接是宿主行为），故此处 runInCallerChain 显式还帧：服务面单一执法点
  // 同时覆盖两路径（apply 内 ctx 注册走装载器帧；包声明技能走本 seam 帧）
  const registerAppSkills = (info: AppSkillsInfo): void => {
    if (info.packageRoot === undefined) {
      // builtin 行（宿主函数件）默认无磁盘锚点——未自述 packageRoot 的 builtin
      // 件仍不可注册技能（契约篇 §3.4 两来源：builtin 自述〔admin 件先例〕/
      // 文件应用 entry 推导；两来源皆无才落此分支）
      ctx.logger.warn('builtin 件声明 skills 但未自述 packageRoot，暂不支持注册', { plugin: info.name, row: info.id });
      return;
    }
    const provider = createPackageSkillsProvider({
      appName: info.name,
      packageRoot: info.packageRoot,
      dirs: info.dirs,
    });
    // runInCallerChain 还帧（见上注）：行 id 进 caller 链——服务面拒载执法
    // 按行挂载目标判；effect 返回的注销器随行作用域回卷（技能是行资产）
    info.scope.effect(() => runInCallerChain(info.id, () => skills.registerProvider(provider)));
  };
  /* ---- D3 装载分面分区（契约篇 §5.1，2026-08-29）----
     Ring 2/3 计划（Ring 1 必备行剔除——④e 已装载，双装载即 TOOL_DUPLICATE
     事态，结构上排除）分区为系统区 + 各应用区。锚结构 = apps:system 锚 + 每
     app 一锚（apps:app:<id>），皆自根 fork——兄弟非父子：fork 共享整树服务表，
     层级化不构成可见性边界（分表是回卷单元与撞名域，可见性由读链承载）。 */
  const partition = partitionPlan(composition.plan);
  // 锚袋 = 区 id → 锚（活绑定——/reload dispose 整袋后按新分区重建）。fleet
  // 锚 getter 取系统锚：舰队只把锚作事件发射面（行作用域由 loadApps fork 承载
  // ——zone 随锚级联自动落表，bridge 零感知）
  const buildZoneAnchors = (part: PlanPartition): Map<string, ContextScope> => {
    const anchors = new Map<string, ContextScope>();
    anchors.set(SYSTEM_ZONE, ctx.fork({ name: 'apps:system', zone: SYSTEM_ZONE }));
    for (const appId of part.appIds) {
      const zone = appZoneId(appId);
      anchors.set(zone, ctx.fork({ name: `apps:app:${appId}`, zone }));
    }
    return anchors;
  };
  let zoneAnchors: Map<string, ContextScope> = buildZoneAnchors(partition);
  // worker 域舰队·Ring 2/3 面（与锚袋同寿命）：/reload 先 terminateAll 再随新
  // 锚袋重装载（舰队对象复用——登记簿已空、计数器累积 = 装机计数观测锚⑩）
  const appFleet = createBridgeFleet({
    root: ctx,
    anchor: () => zoneAnchors.get(SYSTEM_ZONE)!,
    ...workerChoreography,
  });
  fleets.push(appFleet); // 登记簿收录（refuseBoot/关停收编遍历面——/reload 单收本舰队不动 Ring 1）
  // 分区装载单源（boot 与全量 /reload 同构）：系统相位先行收口（区内 Kahn 轮次
  // + 失败行结算完毕——跨区行同挂此相位装载恰一次，装载律①）→ 各应用区依在册
  // 清单 id 字典序串行（序仅定日志序——跨区 inject 同拒故区际零依赖）。
  // byZone = 区 id → 该区装载结果（D3 单区 reload 收口面③的数据基座：他区行
  // 沿用旧装载结果 = 运行时真值，全量路整替、单区路只换该区槽）。zoneLoadOpts
  // 与单区路共用（三个注入物都是装配期稳定引用）
  const zoneLoadOpts = { registerSkills: registerAppSkills, virtualFaces, workerLoader: appFleet.loader };
  const loadPartitioned = async (
    part: PlanPartition,
  ): Promise<{ merged: AppLoadResult; byZone: ReadonlyMap<string, AppLoadResult> }> => {
    const byZone = new Map<string, AppLoadResult>();
    const loads: AppLoadResult[] = [];
    const sysLoad = await loadApps(zoneAnchors.get(SYSTEM_ZONE)!, part.system, zoneLoadOpts);
    byZone.set(SYSTEM_ZONE, sysLoad);
    loads.push(sysLoad);
    for (const appId of part.appIds) {
      const zoneLoad = await loadApps(zoneAnchors.get(appZoneId(appId))!, part.zoneRows.get(appId)!, zoneLoadOpts);
      byZone.set(appZoneId(appId), zoneLoad);
      loads.push(zoneLoad);
    }
    return {
      merged: {
        activated: loads.flatMap((load) => load.activated),
        failed: loads.flatMap((load) => load.failed),
        skipped: loads.flatMap((load) => load.skipped),
      },
      byZone,
    };
  };
  const bootPartitioned = await loadPartitioned(partition);
  const ring2Load = bootPartitioned.merged;
  // 各区装载结果活账（单区 reload 的他区真值源 + 卸词集旧词基准）：全量路整替
  let zoneLoads: ReadonlyMap<string, AppLoadResult> = bootPartitioned.byZone;
  // Kahn 残留行孤儿域清割（同 Ring 1 面防漏语义——全区分区装载完毕后统一收口）
  appFleet.reapUnapplied('Ring 2/3 装载收口（Kahn 残留行清割）');
  // 装载结果合并回灌（ctx.apps.list 唯一事实源 = 组合树全行——Ring 1 行状态
  // 同面可见；/reload 后 Ring 1 行沿用 boot 装载结果 = 运行时真值：行仍激活中）
  appsService.applyLoad(composition, {
    activated: [...ring1Load.activated, ...ring2Load.activated],
    failed: [...ring1Load.failed, ...ring2Load.failed],
    skipped: [...ring1Load.skipped, ...ring2Load.skipped],
  });
  if (appsService.list().some((row) => row.status === 'failed')) {
    const lines = appsService
      .list()
      .filter((row) => row.status === 'failed')
      .map((row) => `  - [${row.code}] ${row.id}：${row.message}`);
    await refuseBoot(
      APP_LOAD_FAILED,
      `应用启动断言失败（${lines.length} 行，app/failed 事件已逐行广播）：\n${lines.join('\n')}`,
    );
  }
  // ④d onSettle 晚绑定收口（§6.4）：通知器按注册表解析归属条目——S1 键控
  //（ownerSessionId 显式键 ?? 调用链——迟到结算折进原会话账，不随前台聚焦错投）
  onSubagentSettle = createSubagentNotifier({
    resolveEntry: (sessionId) => registry.entries.get(sessionId),
    model,
  });
  // 应用组件在场断言（契约篇 §5.4——装载期 post-apply 时点，组合树已合成）：
  // 缺场 = 应用级隔离不拒启（清单是声明面，声明了没装 = 用户裁量非发行事故），
  // 诊断出口 = debug 日志 + runtime.appGaps（dump-config 打印）；/reload 后重算
  let appGaps = assertAppComponents(officialApps, composition);
  for (const [id, missing] of appGaps) {
    ctx.logger.debug('应用组件缺场（应用级隔离）', { app: id, missing });
  }
  /* -- delegable 应用自动注册（第三纵切，契约篇 §5.4 第 2 条委派形态）--
     镜像声明式子代理桥：in-process 机器 + mergeRequest 清单填充 + agent_<id>
     静态工具。缺场应用不注册（应用级隔离一致性——前台不可进入的应用同样不可
     委派）；与声明式 agent 文件撞名 = warn 跳过不炸装配（用户文件取到官方
     应用 id 是可预见的用户行为，同 subagent 件 reservedNames 纪律）。注册锚 =
     boot 组合根：清单静态已知不随 /reload 重算，provider 表工厂级跨 /reload
     存续（④d 服务面同款）——/reload 只换装载面，应用注册表不动。 */
  for (const [id, manifest] of officialApps) {
    if (manifest.entry?.delegable !== true || appGaps.has(id)) continue;
    if (subagents.list().some((info) => info.name === id)) {
      ctx.logger.warn(`应用 ${id}：与既有子代理 provider 撞名（声明式 agent 文件同名？）——跳过 delegable 注册`);
      continue;
    }
    subagents.register(
      createInProcessProvider({
        factory: subagentChildFactory,
        name: id,
        description: manifest.label,
        mergeRequest: mergeRequestForApp(manifest),
      }),
    );
    // 静态工具 agent_<id>（id 不合工具名字符集 = 只注册 provider 不注册工具）
    if (/^[A-Za-z0-9_-]+$/.test(id)) {
      if (tools.get(`agent_${id}`) === undefined) {
        tools.register(
          createAgentTool({
            subagents,
            getSession: () => registry.routed()?.session,
            agentName: id,
            providerName: id,
            staticDescription: manifest.label,
          }),
        );
      }
    } else {
      ctx.logger.warn(
        `应用 ${id}：id 不合工具名字符集（字母/数字/_/-）——delegable provider 已注册但无 agent_${id} 工具`,
      );
    }
  }
  // boot 装载收口重物化（B-1，与 /reload 收口对称——契约篇 §3.4 落码义务）：
  // chat 件首会话 open() 早于装载收口，其 systemPrompt 首物化时点 appsService.list()
  // 尚空（applyLoad 合并回灌在后）——environment 应用计数行恒缺席。收口处补
  // 一次全段重物化，装载结果（含 environment 第五件计数）即时入首请求快照
  rematerializeAll();
  // boot 装载窗口收口：此后运行时注册（tools_change/prompts_change）即时落
  // header change 快照——装载期中间态已被首请求的 initial 快照整体收编
  loadWindow = false;

  // session_start 装载收口补播（二十九批 P1-6 案 A，契约篇 §2.2 增补 8①）：
  // chat 件是默认层首行（inject:['tools']），apply 即 registry.open()——open() 内
  // 发射 session_start（活体），后续行应用（goal 等）on() attach 迟到结构性
  // 收不到。宿主在装载收口对**非退役**条目按建会事实（resumed ? 'resume' :
  // 'initial'）补发带 replay:true 标记的同型载荷——origin 建会维度不变、replay
  // 是投递维度标记，既有按 origin 过滤的监听器零迁移。boot 与 /reload 两路
  // 各自收口处同型补播（设计指令）。root 发射零频率护栏约束（免计费）。
  // appId 参数（D3 单区 reload 收口面⑤）：在场 = 只 replay 该应用域在册会话
  //（事件总线无域层、监听全局——新装载实例对一切会话皆白纸，v1 取保守面：
  // 该区行按挂载语义服务于该应用，他应用会话不补播）；缺席 = 全体非退役条目。
  const replaySessionStarts = (appId?: string): void => {
    for (const entry of registry.entries.values()) {
      if (entry.retired) continue; // 退役条目不补——会话停摆，初始化面向在场者
      if (appId !== undefined && entry.appId !== appId) continue; // 单区：他应用域会话不补播
      ctx.emit('session_start', {
        sessionId: entry.session.header.sessionId,
        origin: entry.resumed ? 'resume' : 'initial',
        replay: true,
      });
    }
  };

  // composition/reloaded boot 路（契约篇 §2.2 增补 1/7④，2026-08-27 P1-2 补齐）：
  // 词汇注释「boot 与 /reload 两时点」自始为承诺面——boot 装载收口后同款载荷
  // 派发。时点依据：装载器激活序 = apply 先于 loadApps 返回，应用 apply 期
  // 已订阅故能听到本事件（无「订阅晚于事件」空窗）。payload = Ring 1 + Ring 2/3
  // 两批装载结果合并三清单（id 面）；boot 即 Ring 1 生效时点，无
  // ring1RestartRequired 键（与 /reload 路的差异仅此一项）。git-worktree 应用
  // 墙 #3 可以此作「组合树就绪」信号（ready 级）。
  const bootPayload: CompositionReloadedPayload = {
    activated: [...ring1Load.activated, ...ring2Load.activated].map((item) => item.id),
    failed: [...ring1Load.failed, ...ring2Load.failed].map((item) => item.id),
    skipped: [...ring1Load.skipped, ...ring2Load.skipped].map((item) => item.id),
  };
  // 补播先于 composition/reloaded：晚装载应用先补齐会话级初始化态、再收
  // 「组合树就绪」信号（次序 = 生命周期序，replay 是 start 的重放非新词）
  replaySessionStarts();
  ctx.emit('composition/reloaded', bootPayload);

  /* ---- /reload 排队机制（契约篇 §3.4 第二刀，2026-08-27 刀 2；D3 per-app 分槽——第三十五批拍板项③）----
   * run 进行中的 reload 不再拒绝：置 pending 返 {queued:true}，run 结算回调见
   * 排水条件自动执行。D3 分槽化：全量槽（'*'）+ 每应用一槽——每槽独立 pending
   * 旗 + 各自域的排水条件（全量槽 = 全闲；应用槽 = 该 app 域闲），他应用在跑
   * 不阻断本应用换件排队；同槽再排 = no-op（Set 天然 coalesce）。排水内竞速新
   * run（reload 又返 queued）= 静默重新置槽；排水失败不重排（错误经 ui.notify
   * 报请求方——通知文案与 commands.ts notifyReloadResult 同口径，此处内联：
   * commands 已 import 本模块 ReloadResult 类型，反向 import 成环）。
   * 订阅面 = chat 件 ctx.agent.onRunSettled（工厂级订阅表跨 /reload 存续——订阅
   * 一次恒活）；chat 件可能 boot 装载失败/经 /reload 才上线：惰性武装
   *（once-guard，boot ⑨ 后与 busy 分支两处尝试；chat 未装载 = 无驱动 = 永不
   * busy = 排队面天然不需要，武装不成功静默无害）。 */
  /** busy 判定（D3 收窄）：app 在场 = 只看该 app 域非退役驱动（判据键 = 条目 appId） */
  const anyRunActive = (appId?: string): boolean =>
    [...registry.entries.values()].some(
      (entry) => !entry.retired && entry.driver.isRunning && (appId === undefined || entry.appId === appId),
    );
  /** 全量排水槽哨兵（与应用 id 分子集——app id 形 `[a-z][a-z0-9-]*` 恒不撞 '*'） */
  const FULL_RELOAD_SLOT = '*';
  /** 排水槽集（D3 分槽）：槽 = '*' 全量 | app id 单区；成员在集 = pending 中 */
  const reloadPendingSlots = new Set<string>();
  let reloadHookArmed = false;
  const armRunSettledHook = (): void => {
    if (reloadHookArmed) return;
    const agent = ctx.tryGet<AgentServiceFace>('agent');
    if (agent === undefined) return; // chat 件未上线——boot 收口与 busy 分支两处再试
    reloadHookArmed = true;
    agent.onRunSettled(() => {
      if (reloadPendingSlots.size === 0) return;
      // 逐槽判排水条件（每次结算全槽重评——幂等；槽间互不阻断）
      for (const slot of [...reloadPendingSlots]) {
        const slotApp = slot === FULL_RELOAD_SLOT ? undefined : slot;
        if (anyRunActive(slotApp)) continue; // 本槽域仍有 run 在跑——留待下次结算
        reloadPendingSlots.delete(slot); // 先清再执行：失败不重排，竞速 queued 在结果面重置
        void reload(slotApp).then((result) => {
          if (result.queued === true) {
            reloadPendingSlots.add(slot); // 排水瞬间又有 run 起跑——留待该 run 结算再排（静默）
            return;
          }
          if (result.error !== undefined) {
            ui.notify(`排队的重载失败：${result.error}\n（原组合仍在运行——修正 overlay 后再试）`);
            return;
          }
          const payload = result.payload;
          if (payload !== undefined) {
            // 与 notifyReloadResult 同口径（内联因反向 import 成环）+ 卸词集警示
            const scope = payload.app !== undefined ? `应用 ${payload.app} 单区` : '组合';
            const parts = [`${scope}激活 ${payload.activated.length}`];
            if (payload.failed.length > 0) parts.push(`失败 ${payload.failed.length}（${payload.failed.join('、')}）`);
            parts.push(`跳过 ${payload.skipped.length}`);
            if (payload.droppedEvents !== undefined && payload.droppedEvents.length > 0) {
              parts.push(`警示：事件词消失 ${payload.droppedEvents.join('、')}（重装即回；改名即旧词永失）`);
            }
            ui.notify(`排队的重载已执行：${parts.join('，')}`);
          }
        });
      }
    });
  };

  /** 单区重载执行体（D3 per-app reload 拆装五步对偶全量——契约篇 §1.3；入参 app
   * 必在册、Ring 1 已验无变化、fresh 树已过全局先验。五步 = 该区 worker 行
   * terminate → 该区锚 dispose → 分区随新树走 → 该区行重装载 → 收口面六项） */
  const reloadAppZone = async (app: string, fresh: CompositionReport): Promise<ReloadResult> => {
    const zone = appZoneId(app);
    const freshPartition = partitionPlan(fresh.plan);
    const zoneRows = freshPartition.zoneRows.get(app) ?? [];
    // 卸词集基准先取（收口面⑥）：该区旧词 = 旧装载结果真值（activated 载荷
    // events 收割面），不取树投影——树可能含他区变更，与本区无关
    const oldWords = new Set((zoneLoads.get(zone)?.activated ?? []).flatMap((item) => item.events ?? []));
    try {
      // 装载窗口开启：dispose+装载只刷活视图，收口单张 change 统一落账（同全量路）
      loadWindow = true;
      // ② 该区 worker 行选择性终止（fleet 行→区过滤——「该区行」谓词 = 独占该区，
      // 跨区行与系统相位行 zone 列不等不动；worker/external 两腿同舰队同谓词）
      appFleet.terminateZone(zone, `单区 reload 域收编（${zone}）`);
      // ③ 该区锚 dispose（LIFO——仅回卷该区注册：工具/监听/服务/词汇；跨区行
      // effect 链挂 apps:system 锚、他区锚均不动。?. 兜「旧树该区本无锚」态）
      await zoneAnchors.get(zone)?.dispose();
      // ④ 分区随新树走：行全删 = 空区卸载正路（锚出袋）；有行 = 重锚（自根
      // fork 同形——兄弟非父子，zone 随锚级联落表）
      if (zoneRows.length === 0) zoneAnchors.delete(zone);
      else zoneAnchors.set(zone, ctx.fork({ name: `apps:app:${app}`, zone }));
      // ⑤ 该区行重装载（空集 = 纯回卷即卸载；jiti 缓存纪律同全量——每次装载
      // 新建 jiti 实例即全图重求值，毒化缓存不跨装载存活）
      const load: AppLoadResult =
        zoneRows.length > 0
          ? await loadApps(zoneAnchors.get(zone)!, zoneRows, zoneLoadOpts)
          : { activated: [], failed: [], skipped: [] };
      appFleet.reapUnapplied(`单区 reload 装载收口（${zone} Kahn 残留行清割）`);
      // 收口面③：applyLoad 合并回灌——他区行沿用旧装载结果（运行时真值）、该区
      // 行新结果；Ring 1 恒 boot 真值（行仍激活中不回卷）。空区路径清槽
      const nextZoneLoads = new Map(zoneLoads);
      if (zoneRows.length > 0) nextZoneLoads.set(zone, load);
      else nextZoneLoads.delete(zone);
      zoneLoads = nextZoneLoads;
      const others = [...nextZoneLoads.entries()].filter(([z]) => z !== zone);
      composition = fresh;
      appsService.applyLoad(fresh, {
        activated: [...ring1Load.activated, ...others.flatMap(([, other]) => other.activated), ...load.activated],
        failed: [...ring1Load.failed, ...others.flatMap(([, other]) => other.failed), ...load.failed],
        skipped: [...ring1Load.skipped, ...others.flatMap(([, other]) => other.skipped), ...load.skipped],
      }); // 同实例就地更新（失败行进 list 状态面——进程存活）
      // 收口面④：appGaps 只重跑该应用（换件后 components 在场重验——他应用槽
      // 不动；单区路径的变更域承诺 = 该区）
      const freshGaps = assertAppComponents(officialApps, fresh);
      if (appGaps.has(app) || freshGaps.has(app)) {
        const nextGaps = new Map(appGaps);
        nextGaps.delete(app);
        const missing = freshGaps.get(app);
        if (missing !== undefined) nextGaps.set(app, missing);
        appGaps = nextGaps;
      }
      // systemPrompt 重建 v1 恒无（app 区零技能〔D1 拒载〕零 prompt 段〔本批
      // 拒载〕——区装内容不进 systemPrompt）：不调 rematerializeAll；toolView
      // 走 tools_change 域腿即时刷新；writeHeader 全体调靠既有差分化自然收窄
      writeHeadersAll();
      // 卸词集 = 该区旧词 ∖ 新词（警示面：reload 是换版本非删除、词随重装
      // 回来；改名即旧词永失——差集如实点名，消费方按词表三档 unknown 档处理）
      const newWords = new Set(load.activated.flatMap((item) => item.events ?? []));
      const droppedEvents = [...oldWords].filter((word) => !newWords.has(word));
      // 收口面⑤：只 replay 该应用域在册会话（事件总线无域层、监听全局——v1
      // 取保守面：该区行按挂载语义服务于该应用，他应用会话不补播）
      replaySessionStarts(app);
      const payload: CompositionReloadedPayload = {
        activated: load.activated.map((item) => item.id),
        failed: load.failed.map((item) => item.id),
        skipped: load.skipped.map((item) => item.id),
        app,
        ...(droppedEvents.length > 0 ? { droppedEvents } : {}),
      };
      ctx.emit('composition/reloaded', payload);
      return { payload };
    } catch (err) {
      // 兜底：loadApps 逐行收集不抛，此处只剩 dispose/emit 级异常——进程存活报告
      return { error: describeError(err) };
    } finally {
      loadWindow = false;
    }
  };

  /** 组合树重载单次执行体（/reload 主体；TUI 薄壳直调——对账逻辑不进壳面。
   * app 在场 = 单区路〔D3 per-app reload〕：换该应用第三方挂载行不动他区运行时） */
  const reloadOnce = async (app?: string): Promise<ReloadResult> => {
    // run 进行中排队（刀 2 改排队不拒绝；loop 正引用工具快照与提示词，装配不换；
    // D3 收窄：单区只看该 app 域——他应用在跑不阻断本应用换件；全量看全闲。
    // 同槽已排队再排 no-op；chat 件若此刻才上线顺手武装结算钩子）
    if (anyRunActive(app)) {
      reloadPendingSlots.add(app ?? FULL_RELOAD_SLOT);
      armRunSettledHook();
      return { queued: true };
    }
    // overlay 校验先行（全局——坏树全局拒载不分区放行，分区不改「不带病运行」：
    // 树校验失败即拒，无「绕过坏区只重好区」路径；旧锚回卷不可逆——先验后拆）。
    // 安全模式旗标刻意不进本路径（技术栈篇 §5 救援环）：boot --no-apps 起的
    // 最小内核在此读回全量树——修好 overlay 后 /reload 即恢复，无需重启进程
    let fresh: CompositionReport;
    try {
      fresh = loadComposition(compositionDir, builtins, knownAppIds);
    } catch (err) {
      return { error: describeError(err) };
    }
    // 单区校验（契约篇 §1.3 动词面）：未知/不在册 appId = 报错退出
    //（COMPOSITION_ROW_INVALID 同族拒绝式——与 overlay 行 apps 键校验同律）
    if (app !== undefined && !knownAppIds.has(app)) {
      return {
        error: `应用 ${app} 不在册（在册清单：${[...knownAppIds].sort().join('、')}）——/reload --app 须用在册应用 id`,
      };
    }
    // Ring 1 行变更检测（契约篇 §5.1 /reload 语义）：Ring 1 行不回卷不重装载
    //（仅 boot 生效）。全量路 = 报告需重启；单区路 = 收口面②拒绝前置（单区
    // 目标恒应用区行，Ring 1 变化不吞不静默——报错指路全量）
    const ring1RestartRequired = diffRing1Rows(composition, fresh);
    if (app !== undefined && ring1RestartRequired.length > 0) {
      return {
        error: `Ring 1 行合成结果变化（${ring1RestartRequired.join('、')}）——单区 reload 不动 Ring 1，请走全量 /reload`,
      };
    }
    // 行挂载目标投影重建（收口面①——全量重建）：fresh 即目标树——早于旧锚回卷
    // 与新装载，整个换窗（dispose + load）内注册面读到的恒为「正过渡到」的树投影
    syncRowAppMap(fresh);
    // 单区路分流（五步对偶 + 收口面六项都在 reloadAppZone 单体）
    if (app !== undefined) return reloadAppZone(app, fresh);
    try {
      // 装载窗口开启：dispose+装载只刷活视图，收口由下方单张 change 统一落账
      loadWindow = true;
      // worker 域先于锚收编（契约篇 §1.7 /reload 编舞：terminate → 锚回卷 →
      // 重装载——行作用域随锚 LIFO 回卷，unload 联动因端点已 dispose 静默吸收
      // 是预期态；Ring 1 面不动——/reload 只换 Ring 2/3）
      appFleet.terminateAll('/reload 域收编');
      // 整袋回卷（D3）：系统锚 + 各应用锚逐个 LIFO 级联回卷（工具卸载
      // tools_change 即时刷新 + 监听/服务/词汇注销）；兄弟锚独立 effect 栈，
      // dispose 序无语义差——按袋内序（系统先行、应用字典序）收口即可
      for (const anchor of zoneAnchors.values()) {
        await anchor.dispose();
      }
      // 新分区整袋重建（分区随新树走——应用区增删即锚增删）+ 分区装载与 boot
      // 同单源（loadPartitioned；worker 行重装载同缝：舰队对象复用 terminateAll
      // 已清登记，漏传此缝 = worker 行在 /reload 静默落 failed「装载器未注入」）
      const freshPartition = partitionPlan(fresh.plan);
      zoneAnchors = buildZoneAnchors(freshPartition);
      const { merged: load, byZone } = await loadPartitioned(freshPartition);
      zoneLoads = byZone; // 各区活账整替（单区 reload 的他区真值源）
      composition = fresh;
      // 合并回灌（Ring 1 行沿用 boot 装载结果 = 运行时真值：行仍激活中）
      appsService.applyLoad(fresh, {
        activated: [...ring1Load.activated, ...load.activated],
        failed: [...ring1Load.failed, ...load.failed],
        skipped: [...ring1Load.skipped, ...load.skipped],
      }); // 同实例就地更新（失败行进 list 状态面——进程存活）
      rematerializeAll();
      // 应用组件在场断言随重装载重算（组合树换装后缺场集可变——活取值面）
      appGaps = assertAppComponents(officialApps, fresh);
      // 组装参数变化经 writeHeader 内建 diff 落 reason=change 快照（仅变化才落——
      // 提示词/工具面变了才写，没变不污染日志；件未装载或无持久层为 no-op）
      writeHeadersAll();
      const payload: CompositionReloadedPayload = {
        activated: load.activated.map((item) => item.id),
        failed: load.failed.map((item) => item.id),
        skipped: load.skipped.map((item) => item.id),
        ...(ring1RestartRequired.length > 0 ? { ring1RestartRequired } : {}),
      };
      // 补播先于 composition/reloaded（与 boot 收口同型同序，增补 8①）：锚回卷
      // 把晚装载应用的监听面拆了重挂——补播让重挂的监听器重建会话级初始化态
      replaySessionStarts();
      ctx.emit('composition/reloaded', payload);
      return { payload };
    } catch (err) {
      // 兜底：loadApps 逐行收集不抛，此处只剩 dispose/emit 级异常——进程存活报告
      return { error: describeError(err) };
    } finally {
      // 窗口必然收口（成败两路）：此后运行时注册恢复即时落账
      loadWindow = false;
    }
  };
  /* /reload 串行链（刀 2）：并发调用（TUI 手动 + 排队排水自动）按序执行、各拿
   * 各的结果——排水竞速手动 reload 不再产生双 dispose/双装载竞态；排队在链上的
   * 调用真正轮到时才做 busy 判定（run 仍在跑则照常置槽返 queued）。全量与单区
   * 共链（换装窗互斥——单区 dispose 期间全量整袋回卷会撕裂活账）。 */
  let reloadChain: Promise<unknown> = Promise.resolve();
  const reload = (app?: string): Promise<ReloadResult> => {
    const run = reloadChain.then(() => reloadOnce(app));
    reloadChain = run.then(
      () => undefined,
      () => undefined, // 失败吸收进链（错误已由各调用方的结果面承载——链永不断流）
    );
    return run;
  };
  // boot ⑨ 收口武装结算钩子（chat 件已装载则一次成功；装载失败留待 busy 分支再试）
  armRunSettledHook();

  /* ---- ⑨b 内置命令（help/quit/new/skills/skill:<名> + 应用管理五件/reload） ----
   * 依赖 ⑨ 的 appsService 服务与 reload 闭包——必须在其后注册（引用先声明）。
   * quit/submit 经驱动活句柄（chat 件未装载时 no-op——命令面仍在，对话循环不在）。 */
  ctx.effect(() =>
    registerBuiltinCommands({
      commands: channels.commands,
      ui,
      skills,
      // quit/submit 前台聚焦活路由（S1——/new 换驱动后命令面直达新聚焦；quit 路
      // 的驱动 quit resolve 带动前台退出聚合 promise，TUI 等待位不断流；注册表空
      //〔件未装载/persist:false〕no-op——命令面仍在，对话循环不在）
      quit: () => registry.focused()?.driver.requestQuit(),
      submit: (text) => registry.focused()?.driver.submit(text),
      newSession: startNewSession,
      // /app 多会话前台面（S3——组合根闭包绑 chat 件注册表；命令壳只做清单
      // 格式化与双寻址解析，路由原语全在 registry 程序面）
      apps: {
        list() {
          const focusId = registry.focus.sessionId;
          let retiredCount = 0;
          const active: { sessionId: string; running: boolean; focused: boolean }[] = [];
          for (const entry of registry.entries.values()) {
            const sessionId = entry.session.header.sessionId;
            if (entry.retired) {
              retiredCount += 1;
              continue;
            }
            active.push({
              sessionId,
              running: entry.driver.isRunning,
              focused: sessionId === focusId,
            });
          }
          return { active, retiredCount };
        },
        switchTo: (sessionId) => registry.switchTo(sessionId),
        open: () => {
          const entry = registry.open();
          return entry === undefined ? undefined : { sessionId: entry.session.header.sessionId };
        },
        /* -- 第三纵切进入面：/app <id> 应用进入。available = 在册且组件齐备的
         * 应用（缺场应用不披露——应用级隔离的清单面镜像，诊断走 dump-config）；
         * registered = 在册全量（缺场也在——/app <id> 应用寻址门用：在册即路由
         * enter，缺场应用得到精确的「组件缺场」报错而非误落会话寻址的「无此
         * 会话」，D1-d 死防御支）；enter = 解析 + 缺场拒 + open({app})（会话打
         * 标/装配默认位/审批预设随 open 一条龙）。返回面带 ok 判别——命令壳只
         * 格式化不判错。 */
        registered: () => [...officialApps.values()].map((manifest) => ({ id: manifest.id, label: manifest.label })),
        available: () =>
          [...officialApps.values()]
            .filter((manifest) => !appGaps.has(manifest.id))
            .map((manifest) => ({ id: manifest.id, label: manifest.label })),
        enter: (appId: string): { ok: true; sessionId: string } | { ok: false; error: string } => {
          const manifest = officialApps.get(appId);
          if (manifest === undefined) {
            const ids = [...officialApps.keys()].join('、');
            return {
              ok: false,
              error: `未知应用：${appId}${ids === '' ? '（在册应用：无）' : `（在册应用：${ids}）`}`,
            };
          }
          const missing = appGaps.get(appId);
          if (missing !== undefined) {
            return {
              ok: false,
              error: `应用 ${appId} 组件缺场（${missing.join('、')}）——应用级隔离，不可进入；dump-config 查诊断`,
            };
          }
          const entry = registry.open({ app: manifest });
          if (entry === undefined) {
            return { ok: false, error: '现在不能进入（无持久层），稍后再试' };
          }
          return { ok: true, sessionId: entry.session.header.sessionId };
        },
      },
      appsService, // ctx.apps 服务（⑨ provide——命令壳与宿主同源）
      reload, // 组合根 reload 闭包（⑨ 定义——busy/error/payload 三面）
      // /usage 取数闭包：绑持久层活连接（诊断面无库时给说明行——面板零写入，
      // 库连接在关停序列中先于命令面注销而 close，通道壳兜底为通知）
      usage: persistence
        ? () => formatUsagePanel(persistence.store.connection)
        : () => '用量面板不可用（诊断面无持久层——persist:false）',
      // /allowlist 取数面（接线批 Commit B）：跨会话免问清单的枚举/撤销
      allowlist,
    }),
  );

  /* ---- ⑩ 交互模式：根审批 answerer 接 ctx.ui（headless 无应答者 = fail-closed） ----
   * 本 answerer 服务**根** approval（ctx.exec/ctx.fetch 服务路的 ask——全局三件
   * 消费面）；这些 ask 无 ownership/approvalId 标签（无驱动语境）= v1 已知形态
   * （S5 契约篇审批归属行注记——F9）。主应用驱动的 ask 走驱动 fresh 作用域的
   * answerer（带 [app·会话] 标签 + 「始终允许」三态化）——fresh 不 fork 根，两路
   * emit 各归各 scope，无瀑布交叠。根路**不三态化**：requestEscalation 唯一调用
   * 点在 bash 工具件（绑驱动 approval），根路 ask 恒无草案载荷——三选分支是
   * 死码（「无消费者的匹配器不预造」判据，与 gate 层判定收窄 fs 族同源裁决）。 */
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
    // 活取值（前台聚焦条目投影——/new 后指向新会话；chat 件未装载时恒 undefined）
    get session(): Session | undefined {
      return registry.focused()?.session;
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
    appsService,
    /** 官方应用清单（③c 装载期解析——静态数据，不随 /reload 变） */
    apps: officialApps,
    // 活取值（/reload 重装载后按新组合树重算）——接口上仍是 readonly，实现为 getter
    get appGaps(): ReadonlyMap<string, readonly string[]> {
      return appGaps;
    },
    model,
    workspace,
    sandboxMode,
    // 活取值（S2 诊断物化：无会话语境的 systemPrompt 投影——条目各自的串在
    // 各自 header/loop 面，此处仅供 dump-config 等诊断打印字符量级）
    get systemPrompt(): string {
      return materializeSystemPrompt();
    },
    skillLocations: locations,
    // 活取值（前台聚焦条目投影——chat 件装载后即首个驱动；诊断装配/overlay 禁用两形为 undefined）
    get conversation(): ConversationDriver | undefined {
      return registry.focused()?.driver;
    },
    // S1 注册表与前台宿主（恒在——空表/no-op 形见接口注释）
    drivers: registry,
    front: chatBundle.front,
    newSession: startNewSession,
    reload,
    /** 优雅关停：abort-all → 等全部驱动结算（quiesce 断言）→ flush 屏障 → 全部条目 session_shutdown → 关库 → ctx 回卷（§1.3 多驱动版编排 + S6 形态⑤，S1 全条目化） */
    async shutdown() {
      // abort-all（§1.3 N>1 序① / S6 形态⑤）：对全部条目调 driver.retire（仅
      // abort——不经 registry.retire 的 busy 拒/退役标记/域回卷三件）——防不经
      // requestQuit 前置扇出的直接调用路（测试收尾/fatal 路后续）在跑 run 挂死
      // settle；停摆不 resolve quit（退出聚合只认 requestQuit，关停扇出不误触）
      for (const entry of registry.entries.values()) entry.driver.retire();
      // 全部驱动结算（含退役保留者——迟到 run 收尾；从未起跑/已结算者即回）
      await Promise.allSettled([...registry.entries.values()].map((entry) => entry.driver.settle()));
      // try/finally：flush/close 任一失败也要 ctx.dispose 回卷（独立重读轮 #16
      // 复核——dispose 是资源必达件，不因持久层收尾异常被跳过；dispose 自身
      // 异常已被 context 回卷隔离逐条吞噬，不会反向炸关停序列）
      try {
        // quiesce 断言（§1.3 N>1 序② / S6 形态⑤）：全 settle 后仍有非退役驱动
        // isRunning = 关停序写点漂移（settle 与 running 复位的配对被破）——拒进
        // flush（防「flush 时仍有在写者」撕裂尾；断言是防不是治，正确性兜底是
        // 恢复协议）。放 try 内：抛出走 finally ctx 回卷（资源必达件不因断言跳过）
        const stillRunning = [...registry.entries.values()].filter((entry) => !entry.retired && entry.driver.isRunning);
        if (stillRunning.length > 0) {
          throw new AppError(
            APP_SHUTDOWN_QUIESCE_VIOLATED,
            `关停 quiesce 断言失败：${stillRunning.length} 个非退役驱动仍在跑（${stillRunning
              .map((entry) => entry.session.header.sessionId.slice(0, 8))
              .join('、')}）`,
          );
        }
        // 变更监听先退订：后续 ctx 回卷逐件注销应用工具/段时的广播不再触发
        // writeHeader/提示词重建（库未关也不落关停期快照——非模型可见时点）
        unwatchChangeEvents();
        // Job 排空主路径（骨架篇 §6.2）：全量 cancel + await 全部结算——子代理等
        // 后台任务的 executor 在结算路里可能还要写子会话事件，必须在 flush 屏障
        // 前收口（作用域回卷的 fire-and-forget 兜底只管异常路径，见 jobs.ts）
        await jobs.drain();
        // worker 域收编（契约篇 §1.7 关停编舞：jobs drain 之后、persistence.close
        // 之前——域死回卷/在途结算不再产生待落盘面；两舰队同批，与 ctx LIFO 同段）
        ring1Fleet.terminateAll('进程关停域收编');
        appFleet.terminateAll('进程关停域收编');
        await persistence?.flush();
        // session_shutdown 钩子（骨架篇 §1.3 序⑤ / 契约篇钩子表，S1 全条目化）：
        // 全部条目（含退役保留者——迟到结算已收口）各发一次，统一在 flush 之后
        //（应用清理器不再产生待落盘事件）。二十九批增补 8②：目录 mode 切
        // parallel（全等待 + 单失败隔离）+ 装配层单条目 2s bounded 等待（与子代理
        // dispose 位同享 emitSessionShutdownBounded 公共件）——超时 warn 后继续
        // 不阻塞退出；「全部清理器」不含 worker 域应用（terminate 先于本序、
        // 监听器已回卷）。逐条目 await：会话清理器间无并发收益、且单条目超时
        // 不放大为整段超时
        for (const entry of registry.entries.values()) {
          await emitSessionShutdownBounded(ctx, entry.session.header.sessionId);
        }
        await persistence?.close();
      } finally {
        await ctx.dispose();
      }
    },
  };
}
