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
import { AppError, COMPOSITION_ROW_INVALID, PLUGIN_LOAD_FAILED, describeError } from '../contracts/errors.js';
import { TOOLS_CHANGE_EVENT } from '../contracts/tools.js';
import { PROMPTS_CHANGE_EVENT, registerPromptsService } from './prompts.js';
import type { AgentTool } from '../contracts/tools.js';
import type { ContextScope } from '../context/types.js';
import { createContext } from '../context/context.js';
import { loadPlugins, type PluginSkillsInfo } from '../context/loader.js';
import { Persistence, createPluginSqliteFace, localDayStartMs, spentBackgroundTokensSince } from '../persist/index.js';
import type { LlmRuntime, Provider } from '../llm/index.js';
import { createLlmRuntime, createLlmService, createStreamFn, providerApiFace } from '../llm/index.js';
import type { ToolsService } from '../tools/registry.js';
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
import { isCoreSessionEventType } from '../contracts/session-events.js';
import { SESSION_CORE_TYPE_FORBIDDEN, SESSION_FORMAT_UNSUPPORTED } from '../contracts/errors.js';
import type { SessionEvent } from '../contracts/events.js';
import type { DurableSinks, ConversationDriver, DriverRegistry, FrontHost } from '../chat/index.js';
import { createChatPlugin } from '../chat/index.js';
import {
  createPathsService,
  loadComposition,
  assertRing1Required,
  diffRing1Rows,
  RING1_REQUIRED_ROW_IDS,
  type CompositionReport,
} from './composition.js';
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
   * 组合树目录（overlay.yaml 与插件装机子树的根；缺省 dataDir()——
   * 测试注入临时目录，与生产路径完全同构）
   */
  readonly compositionDir?: string;
  /**
   * tick 单发 runner 覆盖（scheduler 件闭包注入——缺省 createTickRunner 真
   * spawn；测试注入假 runner 记 prompt 断言触发链，不真起子进程）
   */
  readonly tickRunner?: (prompt: string) => Promise<import('../scheduler/index.js').TickRunResult>;
  /**
   * web 件依赖覆盖（生产零参——真 fetch/真 DNS/件级限流单例；组合根全栈
   * 测试注入 fetchImpl/lookup——服务与工具同一卫生件的回归锁在此层验）
   */
  readonly webOverrides?: import('../web/index.js').WebPluginOverrides;
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
   * 只留三件：工具快照活数组（唯一须按值先行的分配）、sandbox 盖章、durable
   * 转发壳——壳已收窄为 gate/approval 两路（handle 半边随驱动直绑退役：管道
   * 守门/审批对的落账路由 = 调用链 → 注册表 → 前台聚焦，registry.routed()）。 */
  // loop 工具快照的活数组（组合根分配、chat 件每次 open 填帧）：loop 每次模型
  // 请求与每次 tool call 查找都读 context.tools——原位替换（length=0 + push）即达
  // loop，含 run 中途；tools_change 时在 ⑧ 接线处刷新（per-driver 化是 S2 域）
  const toolView: AgentTool[] = [];
  /** sandbox 档事实盖章（内核守门面数据 + dedup 内建；件在会话边界调时点——内核有数据，应用有时点） */
  const stampSandboxFacts = (target: Session): void => {
    const last = [...target.events].reverse().find((e) => e.type === 'sandbox/mode');
    if ((last?.data as { mode?: string } | undefined)?.mode !== sandboxMode) {
      target.append('sandbox/mode', { mode: sandboxMode });
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
  /** 应用预算表（id → budget.dailyTokens；未入表 = 未声明 = 恒 true 不闸） */
  const appBudgets = new Map<string, number>();
  for (const [id, manifest] of officialApps) {
    if (manifest.budget?.dailyTokens !== undefined) {
      appBudgets.set(id, manifest.budget.dailyTokens);
    }
  }
  /** context_transform 桥（契约篇 §2.2 增补 5② + S1 双参）：loop 私有回调桥为根
   * 总线瀑布——根 ctx 恒存活（插件监听集随 /reload 更替），驱动绑此桥跨重装载
   * 稳定；sessionId 作第二种子穿透给 handler（差分/检索按归属会话路由） */
  const transformContext = (messages: AgentMessage[], sessionId: string): Promise<AgentMessage[]> =>
    ctx.waterfall('context_transform', messages, sessionId, (final: AgentMessage[]) => final);

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
   * persist:false）——inject 是 Kahn 硬依赖，缺供即启动断言拒启。 */
  ctx.provide('sessions', {
    appendEvent: (type: string, data: unknown): SessionEvent | undefined => {
      // 核心词判据单一来源（contracts——注册侧同尺，两道闸一道判据）
      if (isCoreSessionEventType(type)) {
        throw new AppError(
          SESSION_CORE_TYPE_FORBIDDEN,
          `核心事件词汇不允许插件经 ctx.sessions.appendEvent 写入：${type}（内核词写入权属宿主，插件请注册自有词汇）`,
        );
      }
      return registry.routed()?.session.append(type, data);
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
  });

  /* ---- ④e 组合树装载前置 + Ring 1 行树化（契约篇 §5.1 节奏表第一刀：tools 行起算） ----
   * Ring 1 必备行挂**独立装载锚**（ring1Anchor——宿主装配期专用锚，与插件锚
   * 分离：/reload 只 dispose 插件锚，Ring 1 行不被动不回卷，仅 boot 生效）。
   * tools 行产物（ctx.tools 服务 + 三段管道 + fs/检索工具族）是 ⑥b exec、
   * ⑧ 工具快照接线、⑨ chat 件的先行依赖——组合树装载与官方件注册表因之整体
   * 前置到宿主装配期；chat 件对 tools 的依赖改经 ctx.get（件 inject 声明驱动
   * Kahn 轮次，apply 期取必居值）。 */
  const compositionDir = opts.compositionDir ?? dataDir();
  ctx.provide('paths', createPathsService(compositionDir, workspace));
  const plugins = createPluginsService({ dataDir: compositionDir });
  ctx.provide('plugins', plugins);
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
  /** 拒启收尾（Ring 1 与 Ring 2 启动断言同形）：先收尾持久层再回卷 ctx，抛聚合清单 */
  const refuseBoot = async (code: string, message: string): Promise<never> => {
    try {
      await persistence?.flush();
      await persistence?.close();
    } finally {
      await ctx.dispose();
    }
    throw new AppError(code, message);
  };
  // loop 工具快照活数组已上移 ③b（S1——chat 件 open 与早期闭包都按值引用它，
  // 是唯一须先于官方件注册表在场的分配）；tools_change 刷新接线在 ⑧
  // 官方件注册表（契约篇 §6.1 `builtin:` 前缀唯一解析面）：官方随包件闭包注入
  // 宿主活资源（官方件 = 宿主装配特权——不新开 ctx 服务名）。persist:false 时
  // 无 store，memory 官方件降级空转（warn 进日志）；subagent 真工厂闭包 streamFn/
  // model/活会话引用/父沙箱档/根总线（app/subagent-factory.ts——每子独立装配序）；
  // chat 件收会话选择/驱动/ctx.agent 四件（件聚落 src/chat/plugin.ts）——无条件注入，
  // 无持久层时件自降级空转（装载面完好——dump-config 诊断树不断链）；
  // scheduler 件收 gate 判据两闭包 + runner（spawn 组装在 app/scheduler-runner.ts
  // ——argv 公式 + env set 注入 + 10 分钟超时，席 13 第一刀）；
  // tools 件收管道 gate 落点 + safety 同源可写根推导器（Ring 1 行树化批）
  const tickRunner =
    opts.tickRunner ??
    createTickRunner({
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
  const chatBundle = createChatPlugin({
    ...(persistence ? { persistence } : {}),
    resumeSession: opts.resumeSession,
    rootCtx: ctx,
    workspace,
    model,
    sandboxMode,
    streamFn,
    convertToLlm: (messages) => defaultConvertToLlm(messages, reportDroppedRole),
    transformContext,
    getSystemPrompt: () => systemPrompt,
    toolView,
    stampSandboxFacts,
  });
  /** 会话驱动注册表（S1 单真相——Map<sessionId, DriverEntry> + 前台聚焦指针） */
  const registry = chatBundle.registry;
  const builtins = createBuiltinRegistry({
    ...(persistence ? { store: persistence.store } : {}),
    ...(persistence ? { goalConnection: persistence.store.connection } : {}),
    schedulerDeps: {
      runJob: tickRunner,
      // S1 升格：任一驱动在跑即 busy（多会话并存——单槽投影退役）
      isAgentBusy: () => [...registry.entries.values()].some((entry) => entry.driver.isRunning),
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
    // tools 件闭包（Ring 1 行树化批）：gate/decision durable 落点绑转发壳
    //（件绑定后落账生效）；可写根推导器 = safety/roots 同源产物（tools 不
    // import safety——拓扑单向，fence 与守门行两层正交同源由宿主单点接线）
    toolsDeps: {
      gateSink: durableForward.gate,
      writableRoots: createRootsProvider({ workspace, mode: () => sandboxMode }),
      workspace: () => workspace,
    },
    // web 件测试注入缝（生产零参——真 fetch/真 DNS；组合根全栈测试注入
    // fetchImpl/lookup 假实现，mock 停在外部边界非中间层）
    webOverrides: opts.webOverrides,
    workspace: () => workspace,
    // 声明式子代理发现位置（镜像 skills ⑥⑦ 形态：workspace 同源 + homeDir 测试缝）
    agentLocations: opts.agentLocations ?? defaultAgentLocations(workspace, { homeDir: opts.homeDir, trusted: true }),
    subagentFactory: createSubagentChildFactory({
      ...(persistence ? { persistence } : {}),
      // fork 源读点④（骨架篇 §9.3）：链 → 注册表 → 前台聚焦——子工厂在父 tool
      // call 链内调 getSession（链在场=父会话），命令面/程序面调用落聚焦
      getSession: () => registry.routed()?.session,
      streamFn,
      model,
      convertToLlm: (messages) => defaultConvertToLlm(messages, reportDroppedRole),
      workspace,
      sandboxMode,
      rootCtx: ctx,
    }),
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
  const ring1Plan = composition.plan.filter((row) => RING1_REQUIRED_ROW_IDS.includes(row.id));
  const ring1Load = await loadPlugins(ring1Anchor, ring1Plan, { virtualFaces });
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
   * 三段管道 + ctx.tools 服务 + fs 工具族/检索族的原硬装配已整体入列组合树
   * 第七行（src/tools/plugin.ts——apply 于 ring1Anchor）；守门行仍在 ⑥ 经
   * tools_pre_execute 事件 prepend 占首位（管道无关接线，见 gate.ts）。 */

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
  // loop 工具快照的活数组在 ④e 分配（Ring 1 行树化批——组合树装载前置后须先于
  // 官方件注册表在场）；本段只做变更监听接线
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
  // tools_change → 刷新 loop 工具快照 + 即时落 request/header 快照（骨架篇 §9.2
  // 接线义务；会话篇 §1.3 腿 2「仅变化才快照」——writeHeader 内建 diff，toolSchemas
  // 变了才落 reason=change，run 中途换工具也当场留痕）。注册在装配期 fs 工具族
  // 之后：装配期注册不触发（首张 header 仍由首 run 落）；chat 件未装载时注册表
  // 空——数组照刷（无 run 即无模型可见性），header 落账自然跳过
  const unwatchToolsChange = ctx.on(TOOLS_CHANGE_EVENT, () => {
    const fresh = tools.list().map((def) => tools.toAgentTool(def));
    toolView.length = 0;
    toolView.push(...fresh);
    if (loadWindow) return; // 装载窗口内不逐条落账——窗口收口统一落
    writeHeadersAll();
  });
  // prompts_change → 重建系统提示词 + 即时落 header 快照（pi-4(a) 落码形态④，与
  // tools_change 同族）：段集只在装载//reload 两时点变（注册/注销即广播）；装配层
  // 同点完成重建——订阅者是观测刷新，不承担重建。writeHeader 内建 diff：段内容
  // 变了才落 reason=change，没变不污染日志
  const unwatchPromptsChange = ctx.on(PROMPTS_CHANGE_EVENT, () => {
    rebuildSystemPrompt();
    if (loadWindow) return; // 装载窗口内不逐条落账——窗口收口统一落
    writeHeadersAll();
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
    const opened = registry.open();
    if (opened === undefined) return undefined;
    if (previous !== undefined && previous !== opened) registry.retire(previous.session.header.sessionId);
    // /new 重建时点（pi-4(a) 落码形态③）：具名段重物化——简报等段内容随新会话
    // 快照冻结（旧会话会话内不漂移的对称面：跨会话时点刷新）
    rebuildSystemPrompt();
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
  // 锚是活绑定（/reload dispose 后重 fork）；Ring 2 装载计划 = 全树剔除 Ring 1
  // 必备行（④e 已装载——双装载即 TOOL_DUPLICATE 事态，结构上排除）
  let pluginAnchor: ContextScope = ctx.fork({ name: 'plugins' });
  const ring2Plan = composition.plan.filter((row) => !RING1_REQUIRED_ROW_IDS.includes(row.id));
  const ring2Load = await loadPlugins(pluginAnchor, ring2Plan, {
    registerSkills: registerPluginSkills,
    virtualFaces,
  });
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
  // boot 装载窗口收口：此后运行时注册（tools_change/prompts_change）即时落
  // header change 快照——装载期中间态已被首请求的 initial 快照整体收编
  loadWindow = false;

  /** 组合树全量重载（/reload 主体；TUI 薄壳直调——对账逻辑不进壳面） */
  const reload = async (): Promise<ReloadResult> => {
    // run 进行中拒绝（与 /new 同准入判据——loop 正引用工具快照与提示词，不换装配；
    // S1：任一非退役驱动在跑即 busy——多会话并存时全树装配不换）
    if ([...registry.entries.values()].some((entry) => !entry.retired && entry.driver.isRunning)) {
      return { busy: true };
    }
    // overlay 校验先行：树坏不动旧装配（旧锚回卷是不可逆动作——先验后拆）
    let fresh: CompositionReport;
    try {
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
      await pluginAnchor.dispose(); // LIFO 级联回卷：工具卸载（tools_change 即时刷新）+ 监听/服务/词汇注销
      pluginAnchor = ctx.fork({ name: 'plugins' });
      // Ring 2/3 计划 = 新树剔除 Ring 1 必备行（ring1Anchor 永不重装载——双装
      // 即 TOOL_DUPLICATE 事态，结构上排除）
      const ring2Fresh = fresh.plan.filter((row) => !RING1_REQUIRED_ROW_IDS.includes(row.id));
      const load = await loadPlugins(pluginAnchor, ring2Fresh, {
        registerSkills: registerPluginSkills,
        virtualFaces,
      });
      composition = fresh;
      // 合并回灌（Ring 1 行沿用 boot 装载结果 = 运行时真值：行仍激活中）
      plugins.applyLoad(fresh, {
        activated: [...ring1Load.activated, ...load.activated],
        failed: [...ring1Load.failed, ...load.failed],
        skipped: [...ring1Load.skipped, ...load.skipped],
      }); // 同实例就地更新（失败行进 list 状态面——进程存活）
      rebuildSystemPrompt();
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
    // 活取值（/reload 重建系统提示词后取新值）
    get systemPrompt(): string {
      return systemPrompt;
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
    /** 优雅关停：等全部驱动结算 → flush 屏障 → 全部条目 session_shutdown → 关库 → ctx 回卷（§1.3 编排，S1 全条目化） */
    async shutdown() {
      // 全部驱动结算（含退役保留者——迟到 run 收尾；从未起跑/已结算者即回）
      await Promise.allSettled([...registry.entries.values()].map((entry) => entry.driver.settle()));
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
