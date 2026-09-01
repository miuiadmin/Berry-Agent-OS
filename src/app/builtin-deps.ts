/**
 * 官方件 deps 装配聚落（组合根零改动纪律——内核与应用边界篇 §2.1，2026-08-31
 * 技术债批）：宿主活资源**单束**进（BuiltinHostResources——装配序产物经直值/
 * getter 收口）、各官方件闭包依赖派生出（BuiltinRegistryOptions）——assembly.ts
 * 只保装配序与资源束构造，**新官方件落码不触 assembly**（builtins.ts
 * collectBuiltinMigrations 同款纪律的推广）。
 *
 * 晚绑资源经 getter 过界：ui/cordoned/appGaps 是装配期 let 槽位（装载期回填/
 * 重赋），跨模块闭包不可能——资源束一律函数面。approvalFace 持有器留在
 * assembly（webClaimOf 安全接线共用同一 holder），经 mountApprovalClaim 函数面
 * 过界；symbolsFace 同款经 mountSymbols/symbolsFor 两函数面过界——holder 留
 * assembly（AppRuntime.symbolsFor 第三消费点直读闭包）。
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { openTurnDepth, type Persistence } from '../persist/index.js';
import type { LlmService } from '../llm/index.js';
import type { SandboxService } from '../safety/index.js';
import { killTree } from '../exec/index.js';
import { ChildRegistry, JsonRpcConnection } from '../mcp/index.js';
import { createMcpSpawner } from './mcp-spawn.js';
import { spawnEngineProcess } from './browser-spawn.js';
import type { BrowserAppDeps } from '../browser/index.js';
import type { LspAppDeps, LspServerConfig, LspSymbolsFace, SpawnedProcess } from '../lsp/index.js';
import { canonicalWorkspaceRoot } from '../context/workspace.js';
import { CHAT_APP_ID, foldCurrentTodo } from '../chat/index.js';
import type { DriverRegistry, DurableSinks, FrontHost } from '../chat/index.js';
import { deriveMessages } from '../session/index.js';
import type { GoalChannel } from '../goal/index.js';
import type { TickRunResult } from '../scheduler/index.js';
import type { WebAppOverrides } from '../web/index.js';
import { InflightGates } from '../web/index.js';
import type { WebuiApprovalMount, WebuiEphemeralAuthFace, WebuiSessionSummary } from '../webui/index.js';
import type { InProcessChildFactory } from '../subagent/inprocess.js';
import { defaultAgentLocations } from './agents-md.js';
import type { AgentLocation } from './agents-md.js';
import { resolveDefaultApp } from './app-registry.js';
import type { AppManifest, BuiltinAppModule, RowAppProbe } from '../contracts/app.js';
import type { UiService } from '../channels/index.js';
import { VERSION } from './version.js';
import type { TickOsRegistrar } from './tick-register.js';
import type { BuiltinRegistryOptions } from './builtins.js';

/** 宿主活资源束（assembly 装配序产物 → 官方件 deps 的唯一过界面） */
export interface BuiltinHostResources {
  /** 持久层（无持久层形态 = false/undefined——memory/goal/scheduler 等件降级空转） */
  readonly persistence: Persistence | false | undefined;
  /** canonical 工作区根（缺省 cwd；project-aliases 重定向已并入） */
  readonly workspace: string;
  /** 数据目录活取值（APP_DATA_DIR 覆盖；多次调用同值） */
  readonly dataDir: () => string;
  /** 沙箱 confine 服务（S5 bash 迁域上提产物——lsp/mcp spawner 复用同实例） */
  readonly sandbox: SandboxService;
  /** llm 服务（scheduler 件 canAfford 判据源） */
  readonly llmService: LlmService;
  /** durable 守门落账转发壳（tools 件 gateSink——路由走 registry 惰性引用） */
  readonly durableGate: DurableSinks['gate'];
  /** 行挂载目标投影探针（D1——tools/channels 件注册面路由判据） */
  readonly rowApp: RowAppProbe;
  /** 可写根活取值（memory 文件命令面 + chat 件 fs 族同一物理边界） */
  readonly rootsProvider: () => readonly string[];
  /** 官方应用清单（webui 件 accent 单源 + 默认应用解析） */
  readonly officialApps: Map<string, AppManifest>;
  /** 组件在场断言缺场表（let 重赋——getter 过界） */
  readonly appGaps: () => Map<string, readonly string[]>;
  /** 会话驱动注册表（S1 单真相——webui/checkpoint/subagent 消费） */
  readonly registry: DriverRegistry;
  /** chat 件模块（组合根 createChatApp 产物——默认层首行） */
  readonly chatModule: BuiltinAppModule;
  /** chat 件前台宿主（display 信封入列——Ring 1 不随 /reload 回卷） */
  readonly chatFront: FrontHost;
  /** goal↔chat↔lsp 三件通道（刀二计划态跨轮） */
  readonly goalChannel: GoalChannel;
  /** tick 单发 runner（spawn 组装在 app/scheduler-runner.ts） */
  readonly tickRunner: (prompt: string) => Promise<TickRunResult>;
  /** OS 定时注册器（launchd/crontab——app/tick-register.ts） */
  readonly osTickRegistrar: TickOsRegistrar;
  /** in-process 子装配工厂（subagent 件与 delegable 应用共用同一实例） */
  readonly subagentFactory: InProcessChildFactory | undefined;
  /** UI 服务（ring1 装载回填 let 槽位——getter 过界） */
  readonly ui: () => UiService;
  /** cordon 降级旗（D6 let 槽位——getter 过界） */
  readonly cordoned: () => boolean;
  /**
   * write-behind 运行态活取值（基建大扫 #27——health writeBehind 键数据源）：
   * `undefined` = 无持久层（:memory: 诊断形态——键缺席）。闩红积绿两独立
   * 判读：paused 与 cordoned 分立（详见 WebuiAppDeps.writeBehindStats 注）
   */
  readonly writeBehindStats: (() => { paused: boolean; sessions: number; events: number }) | undefined;
  /** 审批 claim 桥挂载点（approvalFace holder 留 assembly——webClaimOf 共用，函数面过界） */
  readonly mountApprovalClaim: (mount: WebuiApprovalMount) => () => void;
  /** documentSymbol 桥挂载点（symbolsFace holder 留 assembly——AppRuntime.symbolsFor 直读，函数面过界） */
  readonly mountSymbols: (face: LspSymbolsFace) => () => void;
  /**
   * 一次性鉴权面挂载点（复盘 S-1——webui 件自足 token 上交通道；
   * ephemeralAuthFace holder 留 assembly——AppRuntime.webuiEphemeralAuth 直
   * 读，函数面过界）。件本体仅 daemonAuth 注入缺席时调用（非 daemon 监听形态）
   */
  readonly mountEphemeralAuth: (face: WebuiEphemeralAuthFace) => () => void;
  /** documentSymbol 查询面（lsp 行缺席 = undefined——补全 404 语义） */
  readonly symbolsFor: LspSymbolsFace;
  /** UI 广播异常诊断面（channels 件 onUiError——ctx.logger 归因） */
  readonly logUiError: (err: unknown, op: string) => void;
  /** daemon token 鉴权物（daemon 形态注入；缺席 = 非 daemon 监听形态由 webui 件自足一次性 token——复盘 S-1「监听 ⇒ 鉴权」） */
  readonly daemonAuth: { readonly token: string } | undefined;
  /** web 件测试注入缝（生产零参——mock 停在外部边界） */
  readonly webOverrides: WebAppOverrides | undefined;
  /** 声明式子代理发现位置覆盖（缺省 defaultAgentLocations——workspace 同源） */
  readonly agentLocations: readonly AgentLocation[] | undefined;
  /** homeDir 测试缝（defaultAgentLocations 第二参） */
  readonly homeDir: string | undefined;
  /**
   * 进程形态（骨架篇 §6.8 刀三——goal 件 boot 降级判据第四条件）：tui/run/
   * tick/daemon 四值；dump-config 等诊断装配 undefined（保守降级维持现行为）
   */
  readonly processKind: 'tui' | 'run' | 'tick' | 'daemon' | undefined;
}

/**
 * lsp 件闭包组装（契约篇 §6.7 落码形态——组合根缝，mcp-spawn 同款纪律）：
 * - rootUri 物理根 = canonical 工作区根 realpath（M6 裁决——别名层排除；
 *   realpath 失败原样保留交 confine 后续层如实报错，realizeRoot 同款容错）；
 * - spawner 复用 createMcpSpawner 另建实例，workspace 腿传物理根——confine
 *   的 workspaceRoot/writableRoots 与 rootUri 同源（M7 裁决）；wrapper 在
 *   config.env 之上钉 TMPDIR=<dataDir>/lsp/tmp（external carrier 先例——
 *   防服务器临时文件写 /tmp 逃出可写根）；
 * - 登记簿/桥核/树杀全经注入：lsp 结构上不见 mcp/exec/safety。
 */
export function createLspAssemblyDeps(dataDirPath: string, sandbox: SandboxService, workspace: string): LspAppDeps {
  /** rootUri 物理根（惰性求值——装载期不求值，首连接才落地） */
  const rootPhysicalRoot = (): string => {
    const canonical = canonicalWorkspaceRoot(workspace);
    try {
      return realpathSync(canonical);
    } catch {
      return canonical;
    }
  };
  // 复用 mcp spawner 工厂另建实例（probe-once 旗独立于 mcp 实例——互不消耗）
  const rawSpawn = createMcpSpawner(dataDirPath, sandbox, rootPhysicalRoot());
  // per-域 TMPDIR 路径（external carrier 先例——防服务器临时文件写 /tmp 逃出
  // 可写根）；建目录惰性到首 spawn（行惰性无害 = 零落盘：dump-config 等诊断
  // 面构造 deps 不触盘）
  const lspTmp = join(dataDirPath, 'lsp', 'tmp');
  let tmpEnsured = false;
  return {
    spawnServer: async (config: LspServerConfig): Promise<SpawnedProcess> => {
      if (!tmpEnsured) {
        try {
          mkdirSync(lspTmp, { recursive: true });
        } catch {
          // 容错：read-only 数据域等极端形态——服务器写临时文件时如实报错
        }
        tmpEnsured = true;
      }
      const child = await rawSpawn({
        command: config.command,
        ...(config.args === undefined ? {} : { args: config.args }),
        // TMPDIR 叠在用户 env 之上（钉数据域——服务器临时文件不逃可写根）
        env: { ...config.env, TMPDIR: lspTmp },
      });
      return child; // SpawnedChild 与 SpawnedProcess 结构同形（帧无关桥投影）
    },
    killTree,
    registry: new ChildRegistry(join(dataDirPath, 'lsp', 'children.json')),
    rootPhysicalRoot,
    // 与 fs 工具族同 workspace 锚（resolveTarget 同式——相对路径解析一致性）
    resolvePath: (p: string): string => (isAbsolute(p) ? resolve(p) : resolve(workspace, p)),
    newConnection: (opts) => new JsonRpcConnection(opts),
  };
}

/**
 * browser 件闭包组装（契约篇 §6.10 引擎生命周期段 M1 裁决）：裸 spawn
 * （app/browser-spawn.ts——exec runArgv 是 run-to-completion 语义对长命引擎
 * 不适用，只复用 buildChildEnv/killTree 两原语）+ 登记簿
 * <dataDir>/browser/children.json + 桥核工厂注入（browser 结构上不见
 * mcp/exec——帧无关桥组合根装配，lsp 同款纪律）。
 */
export function createBrowserAssemblyDeps(dataDirPath: string, gates: BrowserAppDeps['gates']): BrowserAppDeps {
  return {
    dataDir: dataDirPath,
    spawnEngine: spawnEngineProcess,
    killTree,
    registry: new ChildRegistry(join(dataDirPath, 'browser', 'children.json')),
    newConnection: (opts) => new JsonRpcConnection(opts),
    gates,
  };
}

/**
 * 组装官方件注册表入参（assembly 唯一调用——deps 派生全量收敛于此）。
 * 派生式与原 assembly 内联形态逐字段同构（2026-08-31 技术债批平移，零语义变更）。
 */
export function assembleBuiltinDeps(host: BuiltinHostResources): BuiltinRegistryOptions {
  /** goal 工具三件//goal 命令的会话归属（同 routed 路由：run 期链内 = 归属会话） */
  const getSession = () => host.registry.routed()?.session;
  /**
   * 导航限流单例（契约篇 §6.10「第三消费位」——web 件 fetch 与 browser 件
   * browser_navigate 共享同一 InflightGates）：host.webOverrides.gates 在场则
   * 复用（注入缝生产消费合法——fetchImpl/lookup 先例同位），缺席新建；
   * 同一实例注 webOverrides.gates 与 browserDeps.gates 两处
   */
  const webGates = host.webOverrides?.gates ?? new InflightGates();
  // symbolsFace 持有器（刀三行面晚绑桥第二用例——lsp 行挂真身、行回卷摘除；
  // webui 侧 symbolsFor 经 holder 晚绑，缺席 = 补全 404）
  const persistence = host.persistence;
  return {
    ...(persistence ? { store: persistence.store } : {}),
    ...(persistence ? { goalConnection: persistence.store.connection } : {}),
    // goal↔chat↔lsp 通道（刀二）：goal 侧 = 段查询注册 + fold 消费；lsp 侧 =
    // 诊断查询迟到注入（同一实例——三件经同一桥）
    goalChannel: host.goalChannel,
    // 进程形态（刀三）：goal 件 boot 降级判据第四条件透传（undefined = 诊断
    // 装配保守降级——缺键不传维持 GoalAppDeps 可选语义）
    ...(host.processKind !== undefined ? { processKind: host.processKind } : {}),
    schedulerDeps: {
      runJob: host.tickRunner,
      osRegistrar: host.osTickRegistrar,
      // busy 判据（第二刀④）：turn/start·turn/end 配对深度投影——跨进程有效
      //（driverRef 进程内布尔退役）；persist:false 无账可读 = 0（诊断面不拦）
      turnDepth: persistence ? () => openTurnDepth(persistence.store) : () => 0,
      lastUserMessageAt: (): number | null => {
        let latest: number | null = null;
        for (const entry of host.registry.entries.values()) {
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
      },
      // canAfford 判据（第二刀④ never-unbounded 执法）：同一底账同一闸——
      // 复用 ④b 服务闭包（spend ledger = 日志投影，不建第二套账）
      backgroundAffordable: persistence ? () => host.llmService.canAfford('background') : () => true,
    },
    // mcp 件闭包（契约篇 §6.6 冷读 #1：spawn/kill 组装上提组合根——spawnServer
    // 在 app/mcp-spawn.ts，killTree 自 exec 公开面；登记簿根钉数据目录，与
    // overlay 同根不随会话漂移。confine 复用同源 sandbox 实例、workspace 锚
    // 同 rootsProvider——mcp 刀零新装配概念）
    mcpDeps: {
      spawnServer: createMcpSpawner(host.dataDir(), host.sandbox, host.workspace),
      killTree,
      dataDir: host.dataDir(),
    },
    // lsp 件闭包（默认层第十二行，契约篇 §6.7 冷读同款上提）：spawner 复用
    // createMcpSpawner 另建实例（workspace 腿传 rootUri 物理根）+ wrapper 覆盖
    // TMPDIR 钉 <dataDir>/lsp/tmp + 登记簿 <dataDir>/lsp/children.json + 桥核
    // 工厂注入 JsonRpcConnection（lsp 结构上不见 mcp——帧无关桥组合根装配）。
    // resolvePath 与 fs 工具族同 workspace 锚；刀三符号补全面挂桥（行面晚绑桥
    // 第二用例）：lsp 行 apply 挂真身、行回卷摘除——webui 侧 symbolsFor 经
    // holder 晚绑（缺席 = 补全 404）
    lspDeps: {
      ...createLspAssemblyDeps(host.dataDir(), host.sandbox, host.workspace),
      mountSymbols: host.mountSymbols,
    },
    // browser 件闭包（默认层第十六行，契约篇 §6.10——2026-08-31 第四十九批刀一）：
    // 裸 spawn + 树杀 + 登记簿 <dataDir>/browser/children.json + 桥核工厂——
    // browser 结构上不见 mcp/exec（OS 沙箱不 confine：本机引擎非第三方服务器
    // 代码，M2 裁决——与 mcp/lsp spawner 判据差异显式记此）
    browserDeps: createBrowserAssemblyDeps(host.dataDir(), webGates),
    // tools 件闭包（S2 fs 迁域后收窄）：gate/decision durable 落点绑转发壳
    //（件绑定后落账生效）+ 检索族路径锚。可写根推导器已随 fs 族迁 chat 件
    // deps（rootsProvider）。rowApp 探针 = D1 注册面隐式路由（挂应用的行注册
    // 落应用域层——探针活闭包，装载期恒现行树）
    toolsDeps: {
      gateSink: host.durableGate,
      workspace: () => host.workspace,
      rowApp: host.rowApp,
    },
    // web 件测试注入缝（生产零参——真 fetch/真 DNS；组合根全栈测试注入
    // fetchImpl/lookup，mock 停在外部边界非中间层）
    // web 件注入缝（原纯测试缝——gates 键升「生产接线位 + 测试缝」双语义：
    // 生产路径由 webGates 单例填充〔web/browser 两件共享，契约篇 §6.10〕，
    // fetchImpl/lookup 仍测试专用。host 在场时其 gates 已被 webGates 复用采纳）
    webOverrides: { ...host.webOverrides, gates: webGates },
    // 可写根活取值（memory 件文件命令面落盘判定；chatBundle 的 fs 可写根同源：
    // 同一 rootsProvider，文件命令与 fs 工具族同一物理边界）
    writableRoots: host.rootsProvider,
    workspace: () => host.workspace,
    // 声明式子代理发现位置（镜像 skills 装配形态：workspace 同源 + homeDir 测试缝）
    agentLocations:
      host.agentLocations ?? defaultAgentLocations(host.workspace, { homeDir: host.homeDir, trusted: true }),
    // in-process 子装配工厂（subagent 件与 delegable 应用注册共用同一实例——
    // 每子独立装配 dsh-10，委派目标形态差异只在 mergeRequest 静态半边）
    subagentFactory: host.subagentFactory,
    // goal 工具三件//goal 命令的会话归属（同 routed 路由：run 期链内 = 归属会话，
    // TUI 命令面 = 聚焦会话）
    getSession,
    // chat 件 bundle（S1 工厂化）：注册表/前台宿主由件构造、组合根在此分配持有
    //（早期闭包惰性引用 registry——TDZ 安全：全部运行期才调用）
    chat: host.chatModule,
    // checkpoint 件闭包（默认层第十一行，会话篇 §5.3）：activeSessions = 驱动
    // 注册表在册（未退役）会话活集合——prune 下界判据（大仓小帽不得自剪成
    //「无快照」；子代理等不可达会话不享下界）。晚绑同 getSession 形态
    checkpointDeps: {
      activeSessions: () =>
        new Set([...host.registry.entries.values()].filter((e) => !e.retired).map((e) => e.session.header.sessionId)),
    },
    // channels 件闭包（Ring 1 第十三行树化，契约篇 §6.8）：本体 = ② 段原装配
    // 参数平移（onUiError 广播异常诊断 + rowApp = D1 命令拒载探针）。恒传
    //（缺省即 D1 执法静默回归）
    channelsDeps: {
      onUiError: (err, op) => host.logUiError(err, op),
      rowApp: host.rowApp,
    },
    // webui 件闭包（默认层第十四行，契约篇 §6.8）：宿主面全闭包晚绑——行
    // enabled:false 时 apply 早退零触达，deps 恒传不随 enabled 变。五腿全经
    // registry/officialApps 活引用（装配序在前，运行期才调用）
    webuiDeps: {
      // display 信封入列：chat 件前台宿主无注销器（Ring 1 不随 /reload 回卷）
      //——channel.closed 旗标自守（dispose 后 sink no-op）
      addDisplay: (sink) => host.chatFront.addDisplay(sink),
      // 提交路由：仅未退役活条目收（retired/未知 id = false → 404）
      submitTo: (sessionId, text) => {
        const entry = host.registry.entries.get(sessionId);
        if (entry === undefined || entry.retired) return false;
        entry.driver.submit(text);
        return true;
      },
      // 历史投影：事件日志 deriveMessages。registry miss（已闭会话）走 store
      // 装载只读派生（刀二规范细化）：loadSession 纯读不 append（无 write-behind
      // 悬挂写）、不 recover 不注册——derive 一次即弃，孤儿 tool/call 容错在
      // deriveMessages 内建。两腿同形应答（undefined = 会话不存在）
      historyFor: (sessionId) => {
        const entry = host.registry.entries.get(sessionId);
        if (entry !== undefined) return deriveMessages(entry.session.events);
        const loaded = persistence ? persistence.loadSession(sessionId) : undefined;
        return loaded === undefined ? undefined : deriveMessages(loaded.events);
      },
      // todo 折叠（foldCurrentTodo 归一产物）：与 historyFor 同款两腿——活条目
      // 内存真相 ∪ 已闭 store 兜底（null = 无表合法档）。goal 段边界（刀二计划态
      // 跨轮）：goal active 期从激活锚折叠（user/message 不再是边界——SPA 呈现
      // 与 TUI 注入同一计划态）；通道 miss / 无 active 行 = run-scoped 现行为
      todoFor: (sessionId) => {
        /** goal 段锚活取（每次查询时点重查——goal 激活/停掉后呈现即时切段） */
        const boundary = host.goalChannel.goalScopeFor(sessionId)?.activatedSeq;
        const entry = host.registry.entries.get(sessionId);
        if (entry !== undefined) return foldCurrentTodo(entry.session.events, boundary);
        const loaded = persistence ? persistence.loadSession(sessionId) : undefined;
        return loaded === undefined ? undefined : foldCurrentTodo(loaded.events, boundary);
      },
      // 开新会话（刀二 = POST /api/sessions 腿）：registry.open() 一条龙——默认
      // 应用解析 per-open 活取、既有条目驻留不退役、切宿主前台 focus（/app new
      // 同款语义）。undefined 两因（无持久层/默认应用兜底态）由 open 内化，此
      // 处只透传。cwd/createdAt 取 store 行（write-behind 迟滞时缺省——可选键，
      // 清单下次刷新自然补齐）
      openSession: async () => {
        const entry = await host.registry.open();
        if (entry === undefined) return undefined;
        const id = entry.session.header.sessionId;
        const row = persistence ? persistence.store.recentSessions(50).find((r) => r.id === id) : undefined;
        const accent = host.officialApps.get(entry.appId)?.theme?.accent;
        return {
          id,
          appId: entry.appId,
          ...(row !== undefined && row.cwd !== null ? { cwd: row.cwd } : {}),
          ...(row === undefined ? {} : { createdAt: row.createdAt }),
          updatedAt: entry.session.events.at(-1)?.time,
          active: true,
          ...(accent === undefined ? {} : { accent }),
        };
      },
      // 会话清单两源合并：注册表活条目（内存真相，含 retired→active:false）∪
      // store 近史 50（旧会话迟滞披露——sync 不 flush，已决裁决：迟滞无害，
      // 活条目必在注册表）。条目 appId 权威；cwd/createdAt 取自 store 行
      //（SessionHeader 无此二列，缺行即 undefined）；updatedAt = 末事件时间
      sessionsFor: () => {
        // 近史行一次取出复用（活条目腿也只查这一份——同源两腿同真相）
        const recent = persistence ? persistence.store.recentSessions(50) : [];
        const summaries: WebuiSessionSummary[] = [];
        const seen = new Set<string>();
        for (const entry of host.registry.entries.values()) {
          seen.add(entry.session.header.sessionId);
          const row = recent.find((r) => r.id === entry.session.header.sessionId);
          // accent 单源 = 清单条目内嵌（D4 theme web 兑现——themeFor 键已退役）
          const accent = host.officialApps.get(entry.appId)?.theme?.accent;
          summaries.push({
            id: entry.session.header.sessionId,
            appId: entry.appId,
            ...(row !== undefined && row.cwd !== null ? { cwd: row.cwd } : {}),
            ...(row === undefined ? {} : { createdAt: row.createdAt }),
            updatedAt: entry.session.events.at(-1)?.time,
            active: !entry.retired,
            ...(accent === undefined ? {} : { accent }),
          });
        }
        for (const row of recent) {
          if (seen.has(row.id)) continue;
          // NULL app = 存量会话（app 列升级前的旧账）——归默认应用域（store 读脸
          // 注记「归并归调用侧」在此兑现；两跳回落 + 兜底 chat 锚与 resolveDefault 同源）
          const appId = row.app ?? resolveDefaultApp(host.officialApps, host.appGaps())?.id ?? CHAT_APP_ID;
          // 近史行经归并 appId 同样命中清单 accent（兜底腿与活条目腿同构）
          const accent = host.officialApps.get(appId)?.theme?.accent;
          summaries.push({
            id: row.id,
            appId,
            ...(row.cwd === null ? {} : { cwd: row.cwd }),
            createdAt: row.createdAt,
            ...(row.lastEventAt === null ? {} : { updatedAt: row.lastEventAt }),
            active: false,
            ...(accent === undefined ? {} : { accent }),
          });
        }
        return summaries;
      },
      // UI 服务晚绑（② 段 let 槽位——ring1 装载回填后闭包才可达）
      ui: () => host.ui(),
      // claim 桥挂载点（刀三行面晚绑桥第一用例；daemon 刀一拓宽为挂载对象）：
      // webui 行 apply 建 registry 后挂真身（claim + pendingCountBy）、ctx.effect
      // 回卷摘除——holder 置空后 answerer 竞速退回纯 TUI 腿、帽判据归零
      approvals: {
        mountClaim: host.mountApprovalClaim,
      },
      // 工作区根活取值（刀三 @-mention 文件补全行走锚）：原始 workspace——与
      // fs 工具族/LSP resolvePath 同锚（canonical 差集 v1 不入补全面，spec 钉死）
      workspaceRoot: () => host.workspace,
      // documentSymbol 查询晚绑桥（刀三行面晚绑桥第二用例——lsp 行挂真身；
      // 缺席 = 补全 404）
      symbolsFor: host.symbolsFor,
      // 打断腿（daemon 刀一·协议正确性层 = POST /api/sessions/:id/interrupt）：
      // 非退役条目且 run 在飞 → driver.interrupt()（abort 当轮 run——捎跑续批
      // 不传染，与 TUI Ctrl+C 同源面）；其余 false（404）。fire-and-forget：
      // interrupt 只发信号不等结算，端点语义即「已请求」
      interruptFor: (sessionId) => {
        const entry = host.registry.entries.get(sessionId);
        if (entry === undefined || entry.retired || !entry.driver.isRunning) return false;
        void entry.driver.interrupt();
        return true;
      },
      // cordon 旗活取值（D6）：降级面拒新写意图——submit/开新会话两端点 503，
      // decide/interrupt/SSE/读面不拒（收场依赖面保全），health 披露 degraded
      cordoned: () => host.cordoned(),
      // write-behind 运行态活取值（基建大扫 #27）：health writeBehind 键——闩态
      // + 积压两数（闩红积绿）；无持久层形态 undefined → 键缺席
      ...(host.writeBehindStats === undefined ? {} : { writeBehindStats: host.writeBehindStats }),
      // daemon token 鉴权物（P1）：daemon 形态注入（/api 族全量执法 + cookie
      // 桥）；缺席 = 非 daemon 监听形态——webui 件 apply 期自足生成一次性
      // token（复盘 S-1「监听 ⇒ 鉴权」——执法不再依赖组合形态的接线正确性）
      ...(host.daemonAuth === undefined ? {} : { auth: { token: host.daemonAuth.token } }),
      // 一次性鉴权面上交通道（复盘 S-1）：件自足生成后经此挂 holder（assembly
      // 侧 ephemeralAuthFace——AppRuntime.webuiEphemeralAuth + 入口披露消费）
      mountEphemeralAuth: host.mountEphemeralAuth,
      // 版本串（webui 边不含 app 模块——组合根注入）
      version: VERSION,
    },
  };
}
