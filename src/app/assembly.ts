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
 * 对话是应用不是内核（命题 §3.5）——overlay 禁用 chat 件即首启无对话
 * 循环、宿主照启（装/守/存职能与命令面完好）。
 *
 * 2026-08-26 S1 durable 键控总根因刀（多应用并行第一纵切，骨架篇 §9.3）：
 * 组合根四单槽（session/resumedFlag/durableRef + driverRef/chatRef）整体退役
 * 为 **DriverRegistry**（Map<sessionId, DriverEntry> + 前台聚焦指针——chat 件
 * 工厂 createChatPlugin 产物，组合根分配、件填充与消费）；全局绑定面（onUsage
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
  PLUGIN_LOAD_FAILED,
  describeError,
} from '../contracts/errors.js';
import { TOOLS_CHANGE_EVENT } from '../contracts/tools.js';
import { PROMPTS_CHANGE_EVENT, registerPromptsService } from './prompts.js';
import type { ToolsService } from '../tools/registry.js';
import type { ContextScope } from '../context/types.js';
import { createContext } from '../context/context.js';
import { createPluginJiti, importPluginEntry, loadPlugins, type PluginSkillsInfo } from '../context/loader.js';
import { RateLimiter } from '../context/rate-limit.js';
import {
  Persistence,
  createPluginSqliteFace,
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
import { getSessionEventType } from '../session/index.js';
import type { ProjectedMessage } from '../session/derive.js';
import { isCoreSessionEventType } from '../contracts/session-events.js';
import {
  EVENT_HANDLER_TIMEOUT,
  PLUGIN_EVENT_RATE,
  SESSION_CORE_TYPE_FORBIDDEN,
  SESSION_FORMAT_UNSUPPORTED,
  SESSION_SURFACE_OP_INVALID,
} from '../contracts/errors.js';
import type { EventQueryOptions, EventQueryResult, SessionEvent } from '../contracts/events.js';
import type { AgentServiceFace, DurableSinks, ConversationDriver, DriverRegistry, FrontHost } from '../chat/index.js';
import { createChatPlugin } from '../chat/index.js';
import {
  createPathsService,
  loadComposition,
  assertRing1Required,
  diffRing1Rows,
  safeModeComposition,
  RING1_REQUIRED_ROW_IDS,
  type CompositionReport,
} from './composition.js';
import { loadOfficialApps, assertAppComponents, resolveApp, mergeRequestForApp } from './app-registry.js';
import type { AppManifest } from '../contracts/app.js';
import { createBuiltinRegistry, collectBuiltinMigrations } from './builtins.js';
import { createMcpSpawner } from './mcp-spawn.js';
import { killTree } from '../exec/index.js';
import { createSubagentChildFactory } from './subagent-factory.js';
import { createTickRunner } from './scheduler-runner.js';
import { createTickOsRegistrar } from './tick-register.js';
import { createJobsService, createSubagentsService, createInProcessProvider } from '../subagent/index.js';
import { createAgentTool } from './subagent-plugin.js';
import type { SubagentSettlement } from '../contracts/subagent.js';
import { createSubagentNotifier } from './notify.js';
import { createPluginsService } from './plugins.js';
import type { PluginsService } from './plugins.js';
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
   * 组合树目录（overlay.yaml 与插件装机子树的根；缺省 dataDir()——
   * 测试注入临时目录，与生产路径完全同构）
   */
  readonly compositionDir?: string;
  /**
   * 安全模式（技术栈篇 §5 `--no-plugins`，2026-08-27 落码）：boot 组合树空装
   * ——默认层与 overlay 全跳过，只保 Ring 1 硬装配行（RING1_REQUIRED_ROW_IDS，
   * 否则 assertRing1Required 拒启）。boot 拒启自救位：坏插件锁死启动时经此旗标
   * 起最小内核（无驱动一等态：TUI 壳照启可退 / run 语义性失败）→ 修 overlay →
   * /reload 不受本旗标影响（fresh 读盘不过滤——救援环一进程内闭环）
   */
  readonly noPlugins?: boolean;
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
  readonly webOverrides?: import('../web/index.js').WebPluginOverrides;
  /**
   * context_transform 消费点挂起时钟（毫秒，缺省 5000——契约篇 §1.6 时钟族，
   * 2026-08-27 刀〇a）：桥上钩子挂起视为故障，超时抛 EVENT_HANDLER_TIMEOUT
   * 上抛走 run failed 现径（loop 零 try/catch 纪律）。测试面注小值验证超时路径；
   * 生产面用缺省。
   */
  readonly transformTimeoutMs?: number;
  /**
   * ctx.sessions 写面频率护栏（缺省容量 2000 / 1000 每分钟——契约篇 §1.6
   * 资源护栏族 #14，2026-08-27 刀〇b）：按**目标会话**令牌桶（归因 = 插件写
   * 落在归属会话），appendEvent / appendWithSurfaceOp 两口统一计费；计费在
   * session.append 成功之后（只对成功写扣费）。测试面注小桶验证执法路径。
   */
  readonly sessionRateLimit?: { capacity: number; perMinute: number };
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
   * 会话驱动（通道宿主面：submit / requestQuit）——**前台聚焦条目投影**（活取值）：
   * 件装载即就绪；persist:false 诊断装配或 overlay 禁用 chat 件时为 undefined
   * （宿主照启——命令面/插件管理完好，无对话循环）。跨 /new 稳定的完整面见
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
   * 组合树全量重载（/reload，契约篇 §1.3 落码形态）：run 进行中**排队不拒绝**
   *（2026-08-27 刀 2 改排队——单槽 coalesce：置 reloadPending 返 {queued:true}，
   * run 结算回调见全闲即自动排水执行；排队的 reload 失败不重排，错误经 ui.notify
   * 报请求方）；overlay 校验失败不动旧装配（error）；成功 = 锚 dispose → 重装 →
   * 系统提示词重建 → composition/reloaded 派发（payload 三份行 id 清单）。失败行
   * 逐行报告不杀进程（boot 与 /reload 两面失败语义之 /reload 半边）。
   */
  reload(): Promise<ReloadResult>;
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
  const { channels, ui } = registerChannelServices(ctx, {
    // UI 广播异常诊断（隔离案一第一刀 #3）：坏后端异常经根 logger 留痕——
    // 广播循环逐后端隔离，单后端抛错不毒调用方、不截断后续通道
    onUiError: (err, op) =>
      ctx.logger.error(`UI 广播异常已隔离（${op}）`, { error: err instanceof Error ? err.stack : String(err) }),
  });

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
  // 件未装载/无持久层时 routed() 恒 undefined——三路皆 no-op，与 persist:false 同款降级
  const durableForward: Omit<DurableSinks, 'handle'> = {
    gate: (payload) => registry.routed()?.durable.gate(payload),
    approval: {
      asked: (payload) => registry.routed()?.durable.approval.asked(payload),
      decided: (payload) => registry.routed()?.durable.approval.decided(payload),
    },
  };

  /* ---- ③c 官方应用清单装载（契约篇 §5.4 应用面第二纵切）----
   * 官方清单 = 宿主包内静态已知（仓库根 apps/*.app.yaml），装载期直接解析——
   * 解析/校验失败 = 启动断言拒启（官方件随包，坏 = 发版事故，宁拒绝不误读）；
   * 第三方清单 glob 发现面挂账随 ctx.plugins install。预算表随清单构建
   * （canAfford app 维数据源——④b llm 服务闭包读它，装载序上先行）。 */
  const officialApps = loadOfficialApps();
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
   * 总线瀑布——根 ctx 恒存活（插件监听集随 /reload 更替），驱动绑此桥跨重装载
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

  /* ---- ④b llm 具名服务（ctx.llm：插件单发补全唯一合法路径 + canAfford 预算闸门，骨架篇 §9.3） ---- */
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
          model: modelSpec,
          priority: result.priority,
          usage: { input: result.usage.input, output: result.usage.output },
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

  /* ---- ④f 会话事件服务（ctx.sessions，骨架篇 §9.2 落码）----
   * 写面：插件落 durable 事件的唯一正门（会话篇 §8 拍板落点）：appendEvent 走
   * 缺省路由闭包（S1：调用链 → 注册表 → 前台聚焦——registry.routed()；run 期
   * 插件工具落在归属会话，命令面落在聚焦会话）；无路由落点（诊断装配或 chat
   * 件未装载）返回 undefined，调用方各自降级。
   * 读面（2026-08-26 挖矿批 P0-1，会话篇 §3.2「当前会话只读投影」定形）：两读法
   * 锚定**当前会话**（与 sessionId 信封同源）——currentSessionId() 无落点返回
   * undefined；eventsOfType(type) 读**内存活日志**过滤枚举（与 appendEvent 同账
   * 零迟滞，write-behind 迟滞不影响读；返回过滤副本——append-only 不失效）。
   * 写读同规（B1 收口）：撞未注册词与写侧**同抛 SESSION_FORMAT_UNSUPPORTED**——
   * 读侧静默空数组 = 拼错事件名的无声死，禁止。
   * 核心词汇伪造防护：内核词（user/message 等核心 14 类）的写入权属宿主——归因
   *（sendUserMessage source）/审批/结算语义全绑在宿主写点，插件经服务面伪造即
   * SESSION_CORE_TYPE_FORBIDDEN 响亮拒绝（内核边界，契约篇）；读面核心词不禁
   *（已注册即返回——读不伪造任何宿主语义）。服务必须无条件 provide（即便
   * persist:false）——inject 是 Kahn 硬依赖，缺供即启动断言拒启。
   * 写面频率护栏（#14，2026-08-27 刀〇b）：按目标会话令牌桶（容量 2000 /
   * 1000 每分钟，RuntimeOptions.sessionRateLimit 可调）——归因裁决：服务面无
   * scope 键，目标会话（registry.routed）即天然键（插件写落在归属会话，失控
   * 洪水淹没的就是该会话）。计费在 session.append 成功之后（只对成功写扣费
   * ——未注册词/核心词执法先抛，不扣令牌）；宿主自身 durable 写点不经此面。 */
  const sessionRate = new RateLimiter(opts.sessionRateLimit ?? { capacity: 2000, perMinute: 1000 });
  /** 写面计费（两口共用）：session.append 成功返回后扣令牌，桶空 fail-loud */
  const chargeSessionWrite = (sessionId: string, face: string): void => {
    if (!sessionRate.tryCharge(sessionId)) {
      throw new AppError(
        PLUGIN_EVENT_RATE,
        `ctx.sessions.${face} 写入超频（会话 ${sessionId}——按目标会话计费）` +
          `：护栏 ${sessionRate.params.perMinute} 次/分钟（令牌桶：突发上限 ${sessionRate.params.capacity}、` +
          `回填 ${sessionRate.params.perMinute}/min；fail-loud 非静默丢弃，契约篇 §1.6 #14）`,
      );
    }
  };
  ctx.provide('sessions', {
    appendEvent: (type: string, data: unknown): SessionEvent | undefined => {
      // 核心词判据单一来源（contracts——注册侧同尺，两道闸一道判据）
      if (isCoreSessionEventType(type)) {
        throw new AppError(
          SESSION_CORE_TYPE_FORBIDDEN,
          `核心事件词汇不允许插件经 ctx.sessions.appendEvent 写入：${type}（内核词写入权属宿主，插件请注册自有词汇）`,
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
     * 插件携 surfaceOp 的 user/message 载体经宿主写权落账——核心词 user/message
     * 插件不可伪造（appendEvent 拒），遮蔽注入是唯一例外通道且四执法点在此收口：
     * ①载体型单边（仅 user/message——assistant/tool 词写权属 loop，非载体）；
     * ②必带遮蔽（无 surfaceOp 的注入一律走 sendUserMessage 归因正门）；
     * ③归因强制 plugin: 前缀（宿主代写 = 插件行为，归因必须落在插件名上）；
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
          `appendWithSurfaceOp 载体型单边：仅受理 user/message（收到 ${carrier.type}——assistant/tool 词写权属 loop，插件遮蔽载体只有 user/message 一型）`,
        );
      }
      const { surfaceOp } = carrier;
      if (!surfaceOp || surfaceOp.op !== 'replace') {
        throw new AppError(
          SESSION_SURFACE_OP_INVALID,
          'appendWithSurfaceOp 必带 replace 型 surfaceOp（无遮蔽的注入请走 sendUserMessage 归因正门）',
        );
      }
      if (typeof carrier.data.source !== 'string' || !carrier.data.source.startsWith('plugin:')) {
        throw new AppError(
          SESSION_SURFACE_OP_INVALID,
          `appendWithSurfaceOp 归因强制 plugin: 前缀（收到 ${String(carrier.data.source)}——宿主代写是插件行为，归因必须落在插件名上）`,
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
    /** 模型历史投影只读（增补 7 装配缺口第 2 件——插件读当前会话投影走此面，禁自扫原始流绕投影） */
    deriveMessages: (): ProjectedMessage[] => registry.routed()?.session.deriveMessages() ?? [],
    /**
     * 跨会话有界时间窗查询（会话篇 §3.4 单原语，2026-08-27 刀 1）——sanctioned
     * 直读事实表（不派生状态不攒第二份账）：管理面 events_query 工具与 uninstall
     * 受影响会话数反查的公共取数面。读物理库（write-behind 未 flush 尾部不可见
     * ——迟滞披露条），需精确可传 flushFirst: true（屏障内嵌参数不新开插件面
     * flush API）。persist:false 诊断装配 = 返空降级（deriveMessages 空数组同款）。
     */
    queryEvents: async (query: EventQueryOptions): Promise<EventQueryResult> => {
      if (persistence === undefined) return { rows: [], truncated: false };
      if (query.flushFirst === true) await persistence.flush(); // 屏障先于查询（全量 flush——查询本身跨会话）
      return persistence.queryEvents(query);
    },
  });

  /* ---- ④e 组合树装载前置 + Ring 1 行树化（契约篇 §5.1 节奏表第一刀：tools 行起算） ----
   * Ring 1 必备行挂**独立装载锚**（ring1Anchor——宿主装配期专用锚，与插件锚
   * 分离：/reload 只 dispose 插件锚，Ring 1 行不被动不回卷，仅 boot 生效）。
   * tools 行产物（ctx.tools 服务 + 三段管道 + 检索族；fs 族 S2 已迁 chat 件域
   * 注册）是 ⑥b exec、⑧ 工具快照接线、⑨ chat 件的先行依赖——组合树装载与
   * 官方件注册表因之整体前置到宿主装配期；chat 件对 tools 的依赖改经 ctx.get
   * （件 inject 声明驱动 Kahn 轮次，apply 期取必居值）。 */
  const compositionDir = opts.compositionDir ?? dataDir();
  ctx.provide('paths', createPathsService(compositionDir, workspace));
  /* 插件管理服务注入边（契约篇 §3.4 第二刀，2026-08-27 刀 2）：三个闭包引用的
   * persistence/virtualFaces/registry 均在本行之后才声明——TDZ 安全（闭包只在
   * install/update/uninstall 运行期被调，彼时装配已完成全部初始化）。
   * - loadEntry：词表账本收割面——与装载管线同一 jiti 工厂同一 import 门禁
   *   （virtualFaces + guardTransform），一次性装载读 name/events 词名；
   * - affectedSessionCounts：受影响会话计数取数面——flush 屏障内嵌（write-behind
   *   尾部对查询不可见）+ Store 全库精确聚合（latestSessionId 同族宿主侧直查）；
   * - emitUninstalled：卸载成功尾双落地——总线广播 + 当前会话流落账
   *   （plugins/uninstalled 核心词，无路由会话时总线面单落地）。 */
  const plugins = createPluginsService({
    dataDir: compositionDir,
    loadEntry: (entry) => importPluginEntry(createPluginJiti(virtualFaces), entry),
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
      ctx.emit('plugins/uninstalled', data);
      registry.routed()?.session.append('plugins/uninstalled', data);
    },
  });
  ctx.provide('plugins', plugins);
  /* worker 域舰队登记簿（契约篇 §1.7 K3-c）：各锚舰队建好后登记，拒启/关停
   * 收编遍历此簿——refuseBoot 定义先于舰队建立（装载期拒启路径），登记簿
   * 声明提前、引用延后，TDZ 安全（早期拒启时点簿为空 = 无域可收） */
  const fleets: BridgeFleet[] = [];
  /**
   * convertToLm 丢弃诊断上报（#16 拍板 (c) + 隔离案一第一刀 #2）：
   * ①未注册角色（无 reason）——蒸发陷阱留痕（可能是插件未装，debug 级）；
   * ②toLlm 抛错（带 reason）——插件 bug 已发生，按丢弃收尾不穿透杀 run。
   * 注册角色的 toLlm:null 是设计内过滤，不上报（免刷日志）。
   */
  const reportDroppedRole = (role: string, reason?: string): void => {
    ctx.logger.debug(
      reason !== undefined
        ? `convertToLm 丢弃消息：${role}（${reason}）`
        : `convertToLm 丢弃未注册角色消息：${role}（自定义角色须先注册——插件面 ctx.registerMessageRole，角色名必含 / 域前缀）`,
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
  // chat 件收会话选择/驱动/ctx.agent 四件（件聚落 src/chat/plugin.ts）——无条件注入，
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
   * createChatPlugin 产物 = {module, registry, front}：注册表由组合根此处分配、
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
  const subagentChildFactory = createSubagentChildFactory({
    ...(persistence ? { persistence } : {}),
    getSession: () => registry.routed()?.session,
    streamFn,
    model,
    convertToLlm: (messages) => defaultConvertToLlm(messages, reportDroppedRole),
    workspace,
    sandboxMode,
    rootCtx: ctx,
  });
  /** 沙箱 confine 服务（S5 bash 迁域上提至此：chat deps 需要 sandbox 实例作
   * bash def 构造原料，而 chatBundle 构造点在本行——实例无依赖可先行；provide
   * 挂 ⑥b 原位不动） */
  const sandbox = createSandboxService();
  const chatBundle = createChatPlugin({
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
    // deps（rootsProvider——见 chatBundle 接线处）
    toolsDeps: {
      gateSink: durableForward.gate,
      workspace: () => workspace,
    },
    // web 件测试注入缝（生产零参——真 fetch/真 DNS；组合根全栈测试注入
    // fetchImpl/lookup 假实现，mock 停在外部边界非中间层）
    webOverrides: opts.webOverrides,
    workspace: () => workspace,
    // 声明式子代理发现位置（镜像 skills ⑥⑦ 形态：workspace 同源 + homeDir 测试缝）
    agentLocations: opts.agentLocations ?? defaultAgentLocations(workspace, { homeDir: opts.homeDir, trusted: true }),
    // in-process 子装配工厂（subagent 件与 delegable 应用注册共用同一实例——
    // 每子独立装配 dsh-10，委派目标形态差异只在 mergeRequest 静态半边）
    subagentFactory: subagentChildFactory,
    // goal 工具三件//goal 命令的会话归属（同 routed 路由：run 期链内=归属会话，
    // TUI 命令面=聚焦会话）
    getSession: () => registry.routed()?.session,
    // boot 降级触发器活取值（goal apply 期读——chat 件（首行）先装载，读必居值；
    // S1：聚焦条目的 resumed 投影——运行期 resume 走 goal 的 session_start 订阅）
    wasResumed: () => registry.focused()?.resumed ?? false,
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
    sqlite: createPluginSqliteFace(resolvedDbPath),
  };
  // 组合树合成（overlay 后写胜出）。composition 是活绑定（/reload 重装载换树）
  let composition: CompositionReport = loadComposition(compositionDir, builtins);
  // 安全模式（--no-plugins，技术栈篇 §5）：boot 合成期过滤到 Ring 1 硬装配行
  // ——Ring 2/3 全跳过（官方默认层与 overlay 一视同仁）。只作用 boot：/reload
  // 的 fresh 读盘不过滤（救援环——boot 安全模式 → 修 overlay → /reload 恢复
  // 全树，进程内闭环，见 reload 内注记）
  if (opts.noPlugins) composition = safeModeComposition(composition);
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
  // ⑥b/⑧/⑨ 与后续装载行全局可见；锚永不重 fork，/reload 不动它）
  const ring1Anchor = ctx.fork({ name: 'ring1' });
  // worker 域监督编舞值（契约篇 §1.7 K3-c 宿主全局缺省，两舰队共用）：
  // 心跳 15s 节律 × 3 拍缺省 ≈ 45s 冻结判定（同步死循环/事件循环冻结可判可杀；
  // CPU 燃烧如实收窄不可判——打点照登）；JS 堆 512MB = 预算内存维度宿主缺省
  //（只限引擎堆非安全墙；分应用细配 = rowResourceLimits——应用清单 budget.memoryMb
  // 随第三纵切收键，见下方钩子注记）
  // worker 监督编舞 + 死亡结算状态回写（markFailed——域死行在 ctx.plugins.list
  // 状态源同步转 failed，与 plugin/failed 事件广播同一时点）
  const workerChoreography = {
    heartbeatMs: 15_000,
    resourceLimits: { maxOldGenerationSizeMb: 512 },
    // 按行覆盖（第三纵切 budget.memoryMb 落码形态）：应用组件命中的 worker 行
    // 按清单限值执行（键 = 行 plugin 装载身份串，与组件在场断言同键）；未命中
    // 回落全局 512MB。多应用共享组件已在 appMemoryMb 构建时取严（min）
    rowResourceLimits: (row: { readonly plugin?: string }): { maxOldGenerationSizeMb: number } | undefined => {
      const mb = row.plugin !== undefined ? appMemoryMb.get(row.plugin) : undefined;
      return mb !== undefined ? { maxOldGenerationSizeMb: mb } : undefined;
    },
    markFailed: plugins.markFailed,
  };
  // worker 域舰队·Ring 1 面（每 worker 行一域）：Ring 1 缺省全 builtin 行（恒
  // main 域），workerLoader 在此只为替换行保留同管线资格；锚永不重 fork——
  // 本舰队只在进程关停收编（/reload 不动 Ring 1）
  const ring1Fleet = createBridgeFleet({ root: ctx, anchor: () => ring1Anchor, ...workerChoreography });
  fleets.push(ring1Fleet); // 登记簿收录（refuseBoot/关停收编遍历面）
  const ring1Plan = composition.plan.filter((row) => RING1_REQUIRED_ROW_IDS.includes(row.id));
  const ring1Load = await loadPlugins(ring1Anchor, ring1Plan, { virtualFaces, workerLoader: ring1Fleet.loader });
  // Kahn 零进展残留行的孤儿域清割（行已进失败清单——防漏是舰队的存在理由）
  ring1Fleet.reapUnapplied('Ring 1 装载收口（Kahn 残留行清割）');
  if (ring1Load.failed.length > 0) {
    const lines = ring1Load.failed.map((row) => `  - [${row.code}] ${row.id}：${row.message}`);
    await refuseBoot(
      PLUGIN_LOAD_FAILED,
      `Ring 1 行装载失败（${lines.length} 行，plugin/failed 事件已逐行广播）：\n${lines.join('\n')}`,
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
   * （src/tools/plugin.ts——apply 于 ring1Anchor；fs 族 S2 迁 chat 件域注册）；
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
    render: () => {
      // 插件装载计数（environment 第五件，契约篇 §3.4）：缺省不注入即无此行——
      // environment 段先于装载物化，boot ⑨ 收口的重物化才让计数非零（B-1 落码
      // 义务）。render 时现取 = 快照语义（重建时点冻结）
      const pluginCounts = () => {
        const rows = plugins.list();
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
        pluginCounts,
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
  // 变了才落 reason=change，run 中途换工具也当场留痕）。S2 域路由：载荷带 domain
  // 键 = 域层变更只刷该域条目（chat 件 open 注册 fs 时即此形）；缺省 = 全局层变更
  // 刷全部条目（memory/exec/web/mcp 等行注册）。chat 件未装载时注册表空——自然
  // no-op（无条目即无快照面）
  const unwatchToolsChange = ctx.on(TOOLS_CHANGE_EVENT, (payload: unknown) => {
    const domain = (payload as { domain?: unknown } | undefined)?.domain;
    const domainKey = typeof domain === 'string' ? domain : undefined;
    for (const entry of registry.entries.values()) {
      if (entry.retired) continue;
      if (domainKey !== undefined && entry.session.header.sessionId !== domainKey) continue;
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
  // 变更事件族第 3 件，与 prompts_change 同构）：provider 链变更（插件热注册/
  // 卸载技能来源）即时重物化——渐进披露随 rematerializeAll 内的 skills.refresh()
  // 重扫。单一机制收口（树干原则）：boot ⑨ 装载窗口内事件照发、重物化即时幂等
  // （窗口收口由 header 落账闸统一），不加收口补丁——此前插件技能提供方
  // 装机即隐身，可见性靠 /reload //new 或无关插件注册段捎带 rebuild 的偶然耦合
  const unwatchSkillsChange = ctx.on(SKILLS_CHANGE_EVENT, () => {
    rematerializeAll();
    if (loadWindow) return; // 装载窗口内不逐条落账——窗口收口统一落
    writeHeadersAll();
  });
  /** 退订三个变更监听（关停序在 flush/close 前调用）：ctx 回卷会逐件注销插件工具/ 段/技能提供方（tools_change/prompts_change/skills_change 随之广播），若库已关监听仍在，会向死连接 append header、重物化简报段——关停期变更非模型可见时点且永不落盘，纯噪声 */
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
    const opened = registry.open();
    if (opened === undefined) return undefined;
    if (previous !== undefined && previous !== opened) registry.retire(previous.session.header.sessionId);
    return opened.session;
  };

  /* ---- ⑨ 组合树装载（Ring 2/3 行走树；Ring 1 行已在 ④e 独立锚装载——树化批） ----
   * 服务全部就位后再装插件（inject 依赖驱动轮次激活——宿主服务首轮即全就绪）；
   * **首行 chat 件装载即会话选择/驱动构造/ctx.agent provide 全就绪**（其后行的
   * 工具注册经 ⑧ 已接线的 tools_change 原位刷新 loop 工具快照，含 run 中途）。
   *
   * 卸载基底 = 插件锚作用域（§1.3 落码形态①）：全体插件 scope 自锚 fork、自定义
   * 事件词汇挂锚 effect——锚 dispose 即 LIFO 级联回卷一切插件注册（工具/监听/服务/
   * 词汇），/reload 的卸载半边由此成立；重锚 = ctx.fork 再派生（注册表同根共享）。
   * ring1Anchor 不在回卷面（Ring 1 行不回卷，契约篇 §5.1 /reload 语义）。chat 件
   * 的驱动注册表为工厂级（S1）——重装载 apply 复用全部条目（时间线存续），只
   * 重接 provide 服务面。jiti moduleCache:false 是两条缓存纪律的 v1 基底（重装即全依赖图
   * 重求值）。plugins 服务 provide 在 ④e 一次（§1.3 服务集恒定）：boot 与
   * /reload 经 applyLoad 就地更新状态，热应用期间服务引用永不断链。
   * 失败行两面语义（§1.6）：boot = 启动断言拒绝启动（先收尾持久层再回卷 ctx，抛全量
   * 清单）；/reload = 逐行响亮报告、进程存活（local 源「改动 + /reload 即见」环）。 */
  // 插件技能注册回调（契约篇 §1.2 第六件；拓扑 seam 落码形态——context 不引
  // skills，组合根在此桥接）：loadPlugins 在行作用域 fork 后、apply 之前逐声明行
  // 回调。桥接三件：包层 provider 工厂（skills 模块产）+ registerProvider（追加序
  // 即优先序——local-fs 装配序 ⑦ 已先注册，包内技能恒居最低层，用户本地永远压过
  // 包内）+ 挂行作用域 effect（行失败 / /reload 锚回卷即注销——技能是行资产）。
  // registerProvider → skills_change → 重建管线自然刷新，此处不另发 refresh
  //（双发 = 每插件双份全量重扫）。回调契约不抛错：factory/registerProvider 均纯装配
  const registerPluginSkills = (info: PluginSkillsInfo): void => {
    if (info.packageRoot === undefined) {
      // builtin 行（宿主函数件）默认无磁盘锚点——未自述 packageRoot 的 builtin
      // 件仍不可注册技能（契约篇 §3.4 两来源：builtin 自述〔admin 件先例〕/
      // 文件插件 entry 推导；两来源皆无才落此分支）
      ctx.logger.warn('builtin 件声明 skills 但未自述 packageRoot，暂不支持注册', { plugin: info.name, row: info.id });
      return;
    }
    const provider = createPackageSkillsProvider({
      pluginName: info.name,
      packageRoot: info.packageRoot,
      dirs: info.dirs,
    });
    info.scope.effect(() => skills.registerProvider(provider));
  };
  // 锚是活绑定（/reload dispose 后重 fork）；Ring 2 装载计划 = 全树剔除 Ring 1
  // 必备行（④e 已装载——双装载即 TOOL_DUPLICATE 事态，结构上排除）
  let pluginAnchor: ContextScope = ctx.fork({ name: 'plugins' });
  // worker 域舰队·Ring 2/3 面（与插件锚同寿命）：/reload 先 terminateAll 再随
  // 新锚重装载（舰队对象复用——登记簿已空、计数器累积 = 装机计数观测锚⑩）
  const pluginFleet = createBridgeFleet({ root: ctx, anchor: () => pluginAnchor, ...workerChoreography });
  fleets.push(pluginFleet); // 登记簿收录（refuseBoot/关停收编遍历面——/reload 单收本舰队不动 Ring 1）
  const ring2Plan = composition.plan.filter((row) => !RING1_REQUIRED_ROW_IDS.includes(row.id));
  const ring2Load = await loadPlugins(pluginAnchor, ring2Plan, {
    registerSkills: registerPluginSkills,
    virtualFaces,
    workerLoader: pluginFleet.loader,
  });
  // Kahn 残留行孤儿域清割（同 Ring 1 面防漏语义）
  pluginFleet.reapUnapplied('Ring 2/3 装载收口（Kahn 残留行清割）');
  // 装载结果合并回灌（ctx.plugins.list 唯一事实源 = 组合树全行——Ring 1 行状态
  // 同面可见；/reload 后 Ring 1 行沿用 boot 装载结果 = 运行时真值：行仍激活中）
  plugins.applyLoad(composition, {
    activated: [...ring1Load.activated, ...ring2Load.activated],
    failed: [...ring1Load.failed, ...ring2Load.failed],
    skipped: [...ring1Load.skipped, ...ring2Load.skipped],
  });
  if (plugins.list().some((row) => row.status === 'failed')) {
    const lines = plugins
      .list()
      .filter((row) => row.status === 'failed')
      .map((row) => `  - [${row.code}] ${row.id}：${row.message}`);
    await refuseBoot(
      PLUGIN_LOAD_FAILED,
      `插件启动断言失败（${lines.length} 行，plugin/failed 事件已逐行广播）：\n${lines.join('\n')}`,
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
     存续（④d 服务面同款）——/reload 只换插件面，应用注册表不动。 */
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
  // chat 件首会话 open() 早于装载收口，其 systemPrompt 首物化时点 plugins.list()
  // 尚空（applyLoad 合并回灌在后）——environment 插件计数行恒缺席。收口处补
  // 一次全段重物化，装载结果（含 environment 第五件计数）即时入首请求快照
  rematerializeAll();
  // boot 装载窗口收口：此后运行时注册（tools_change/prompts_change）即时落
  // header change 快照——装载期中间态已被首请求的 initial 快照整体收编
  loadWindow = false;

  /* ---- /reload 排队机制（契约篇 §3.4 第二刀，2026-08-27 刀 2）：busy 改单槽 coalesce ----
   * run 进行中的 reload 不再拒绝：置 reloadPending 返 {queued:true}（已排队再排
   * no-op），run 结算回调见**全闲**（任一非退役驱动 isRunning 即留待下次结算）
   * 自动排水执行。排水内竞速新 run（reload 又返 queued）= 静默重新置 pending；
   * 排水失败不重排（错误经 ui.notify 报请求方——通知文案与 commands.ts
   * notifyReloadResult 同口径，此处内联：commands 已 import 本模块 ReloadResult
   * 类型，反向 import 成环）。
   * 订阅面 = chat 件 ctx.agent.onRunSettled（工厂级订阅表跨 /reload 存续——订阅
   * 一次恒活）；chat 件可能 boot 装载失败/经 /reload 才上线：惰性武装
   *（once-guard，boot ⑨ 后与 busy 分支两处尝试；chat 未装载 = 无驱动 = 永不
   * busy = 排队面天然不需要，武装不成功静默无害）。 */
  let reloadPending = false;
  let reloadHookArmed = false;
  const armRunSettledHook = (): void => {
    if (reloadHookArmed) return;
    const agent = ctx.tryGet<AgentServiceFace>('agent');
    if (agent === undefined) return; // chat 件未上线——boot 收口与 busy 分支两处再试
    reloadHookArmed = true;
    agent.onRunSettled(() => {
      if (!reloadPending) return;
      // 排水条件 = 全闲：本驱动已结算，其余非退役驱动也须不在跑（多会话并存）
      if ([...registry.entries.values()].some((entry) => !entry.retired && entry.driver.isRunning)) return;
      reloadPending = false; // 先清再执行：失败不重排，竞速 queued 在结果面重置
      void reload().then((result) => {
        if (result.queued === true) {
          reloadPending = true; // 排水瞬间又有 run 起跑——留待该 run 结算再排（静默）
          return;
        }
        if (result.error !== undefined) {
          ui.notify(`排队的重载失败：${result.error}\n（原组合仍在运行——修正 overlay 后再试）`);
          return;
        }
        const payload = result.payload;
        if (payload !== undefined) {
          const parts = [`激活 ${payload.activated.length}`];
          if (payload.failed.length > 0) parts.push(`失败 ${payload.failed.length}（${payload.failed.join('、')}）`);
          parts.push(`跳过 ${payload.skipped.length}`);
          ui.notify(`排队的重载已执行：${parts.join('，')}`);
        }
      });
    });
  };

  /** 组合树全量重载单次执行体（/reload 主体；TUI 薄壳直调——对账逻辑不进壳面） */
  const reloadOnce = async (): Promise<ReloadResult> => {
    // run 进行中排队（刀 2 改排队不拒绝；loop 正引用工具快照与提示词，装配不换；
    // S1：任一非退役驱动在跑即排队——多会话并存时全树装配不换。单槽 coalesce：
    // 已排队再排 no-op；chat 件若此刻才上线顺手武装结算钩子）
    if ([...registry.entries.values()].some((entry) => !entry.retired && entry.driver.isRunning)) {
      reloadPending = true;
      armRunSettledHook();
      return { queued: true };
    }
    // overlay 校验先行：树坏不动旧装配（旧锚回卷是不可逆动作——先验后拆）
    let fresh: CompositionReport;
    try {
      // 安全模式旗标刻意不进本路径（技术栈篇 §5 救援环）：boot --no-plugins 起的
      // 最小内核在此读回全量树——修好 overlay 后 /reload 即恢复，无需重启进程
      fresh = loadComposition(compositionDir, builtins);
    } catch (err) {
      return { error: describeError(err) };
    }
    // Ring 1 行变更检测（契约篇 §5.1 /reload 语义）：Ring 1 行不回卷不重装载
    //（仅 boot 生效），合成结果变化只能报告——重启后生效，不静默吞
    const ring1RestartRequired = diffRing1Rows(composition, fresh);
    try {
      // 装载窗口开启：dispose+装载只刷活视图，收口由下方单张 change 统一落账
      loadWindow = true;
      // worker 域先于锚收编（契约篇 §1.7 /reload 编舞：terminate → 锚回卷 →
      // 重装载——行作用域随锚 LIFO 回卷，unload 联动因端点已 dispose 静默吸收
      // 是预期态；Ring 1 面不动——/reload 只换 Ring 2/3）
      pluginFleet.terminateAll('/reload 域收编');
      await pluginAnchor.dispose(); // LIFO 级联回卷：工具卸载（tools_change 即时刷新）+ 监听/服务/词汇注销
      pluginAnchor = ctx.fork({ name: 'plugins' });
      // Ring 2/3 计划 = 新树剔除 Ring 1 必备行（ring1Anchor 永不重装载——双装
      // 即 TOOL_DUPLICATE 事态，结构上排除）
      const ring2Fresh = fresh.plan.filter((row) => !RING1_REQUIRED_ROW_IDS.includes(row.id));
      const load = await loadPlugins(pluginAnchor, ring2Fresh, {
        registerSkills: registerPluginSkills,
        virtualFaces,
        // worker 行重装载同缝（boot ⑨ 同款）：舰队对象复用（terminateAll 已清
        // 登记），漏传此缝 = worker 行在 /reload 静默落 failed「装载器未注入」
        workerLoader: pluginFleet.loader,
      });
      composition = fresh;
      // 合并回灌（Ring 1 行沿用 boot 装载结果 = 运行时真值：行仍激活中）
      plugins.applyLoad(fresh, {
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
  /* /reload 串行链（刀 2）：并发调用（TUI 手动 + 排队排水自动）按序执行、各拿
   * 各的结果——排水竞速手动 reload 不再产生双 dispose/双装载竞态；排队在链上的
   * 调用真正轮到时才做 busy 判定（run 仍在跑则照常置 pending 返 queued）。 */
  let reloadChain: Promise<unknown> = Promise.resolve();
  const reload = (): Promise<ReloadResult> => {
    const run = reloadChain.then(reloadOnce);
    reloadChain = run.then(
      () => undefined,
      () => undefined, // 失败吸收进链（错误已由各调用方的结果面承载——链永不断流）
    );
    return run;
  };
  // boot ⑨ 收口武装结算钩子（chat 件已装载则一次成功；装载失败留待 busy 分支再试）
  armRunSettledHook();

  /* ---- ⑨b 内置命令（help/quit/new/skills/skill:<名> + 插件管理五件/reload） ----
   * 依赖 ⑨ 的 plugins 服务与 reload 闭包——必须在其后注册（引用先声明）。
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
         * enter = 解析 + 缺场拒 + open({app})（会话打标/装配默认位/审批预设随
         * open 一条龙）。返回面带 ok 判别——命令壳只格式化不判错。 */
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
      plugins, // ctx.plugins 服务（⑨ provide——命令壳与宿主同源）
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
        // 变更监听先退订：后续 ctx 回卷逐件注销插件工具/段时的广播不再触发
        // writeHeader/提示词重建（库未关也不落关停期快照——非模型可见时点）
        unwatchChangeEvents();
        // Job 排空主路径（骨架篇 §6.2）：全量 cancel + await 全部结算——子代理等
        // 后台任务的 executor 在结算路里可能还要写子会话事件，必须在 flush 屏障
        // 前收口（作用域回卷的 fire-and-forget 兜底只管异常路径，见 jobs.ts）
        await jobs.drain();
        // worker 域收编（契约篇 §1.7 关停编舞：jobs drain 之后、persistence.close
        // 之前——域死回卷/在途结算不再产生待落盘面；两舰队同批，与 ctx LIFO 同段）
        ring1Fleet.terminateAll('进程关停域收编');
        pluginFleet.terminateAll('进程关停域收编');
        await persistence?.flush();
        // session_shutdown 钩子（骨架篇 §1.3 序⑤ / 契约篇钩子表，S1 全条目化）：
        // 全部条目（含退役保留者——迟到结算已收口）各发一次，统一在 flush 之后
        //（插件清理器不再产生待落盘事件）；emit 异常隔离，单个清理器失败不拖垮关停
        for (const entry of registry.entries.values()) {
          ctx.emit('session_shutdown', { sessionId: entry.session.header.sessionId });
        }
        await persistence?.close();
      } finally {
        await ctx.dispose();
      }
    },
  };
}
