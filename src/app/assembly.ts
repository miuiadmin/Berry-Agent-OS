/**
 * L5 app — 组合根本体（骨架篇 §9：一切装配发生在这里，模块间零横向 import）。
 *
 * createBerryRuntime 把 M1 已落模块接线成真实可跑：
 * context 根作用域 → channels/ui → persist（session）→ llm（凭证适配注入）→
 * tools（fs 族 + 三段管道 + gate/decision durable）→ safety（审批 + 守门行 +
 * 可写根）→ skills（本地 provider + refresh）→ 内置命令 → 会话驱动。
 *
 * ConversationDriver 是「活数组 + 队列」的会话驱动（通道宿主面）：submit 在
 * running 时入 steering 队列、闲时直接开 run；run 自然停后余量按 followUp 续跑；
 * loop 级异常在此合成 error 收尾（骨架篇：run 级兜底在 app 不在内核）。
 */

import { PendingMessageQueue } from '../agent/queue.js';
import type { AgentEvent, AgentEventSink } from '../agent/events.js';
import type { AgentContext, AgentLoopConfig, RunResult } from '../agent/loop.js';
import { startRun } from '../agent/loop.js';
import type { AgentMessage } from '../agent/messages.js';
import type { AssistantMessage, StreamFn, Usage } from '../contracts/llm.js';
import { AppError, PLUGIN_LOAD_FAILED, describeError } from '../contracts/errors.js';
import { TOOLS_CHANGE_EVENT } from '../contracts/tools.js';
import { PROMPTS_CHANGE_EVENT, registerPromptsService } from './prompts.js';
import type { AgentTool } from '../contracts/tools.js';
import type { ContextScope } from '../context/types.js';
import { createContext } from '../context/context.js';
import { loadPlugins } from '../context/loader.js';
import { Persistence, localDayStartMs, spentBackgroundTokensSince } from '../persist/index.js';
import type { LlmRuntime, Provider } from '../llm/index.js';
import { createLlmRuntime, createLlmService, createStreamFn } from '../llm/index.js';
import { createToolPipeline } from '../tools/index.js';
import { registerToolsService } from '../tools/registry.js';
import type { ToolsService } from '../tools/registry.js';
import type { ToolPipelineExecutor } from '../tools/index.js';
import { createFsTools } from '../tools/fs.js';
import {
  APPROVAL_ANSWER_EVENT,
  createApprovalService,
  createRootsProvider,
  DEFAULT_CARVE_OUT_ENTRIES,
  installSafetyGate,
} from '../safety/index.js';
import type { ApprovalPolicyMode, ApprovalService, ApprovalRequest, SandboxMode } from '../safety/index.js';
import {
  createLocalSkillsProvider,
  createSkillsService,
  defaultSkillLocations,
  registerSkillsService,
} from '../skills/index.js';
import type { SkillLocation, SkillsService } from '../skills/index.js';
import { registerChannelServices } from '../channels/service.js';
import type { ChannelsServiceEntity } from '../channels/service.js';
import type { ChannelHost, UiService } from '../channels/types.js';
import type { Session } from '../session/session.js';
import { createDurableSinks, projectedToAgentMessages } from './durable.js';
import type { DurableSinks } from './durable.js';
import { createPathsService, loadComposition, type CompositionReport } from './composition.js';
import { createPluginsService } from './plugins.js';
import type { PluginsService } from './plugins.js';
import { createCredentialStore } from './persist-bridge.js';
import { defaultConvertToLlm } from './convert.js';
import { registerBuiltinCommands } from './commands.js';
import { dataDir, dbPath } from './paths.js';
import type { CompositionReloadedPayload } from '../contracts/events.js';

/** 缺省模型（Anthropic-first 拍板；APP_MODEL env 或 RuntimeOptions.model 覆盖） */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

/** M1 系统提示词基座（技能渐进披露清单在装配期拼接其后） */
const SYSTEM_PROMPT_BASE =
  'You are a terminal-based coding assistant. ' +
  'Use the available tools to read, write, and edit files in the workspace instead of guessing. ' +
  'Keep answers concise unless asked to elaborate.';

/** 零用量（error 合成消息用） */
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

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
   * 启动会话策略（技术栈篇 §5 拍板）：true = 按 cwd 续接最新会话（TUI 缺省）；
   * string = 显式续接指定 id；缺省 = 新建（run 一次性语义）。目标不存在回落新建
   */
  readonly resumeSession?: boolean | string;
  /**
   * 组合树目录（overlay.yaml 与插件装机子树的根；缺省 dataDir()——
   * 测试注入临时目录，与生产路径完全同构）
   */
  readonly compositionDir?: string;
}

/** 组合根产物（三个命令入口持有的运行时面） */
export interface BerryRuntime {
  /** 根作用域（插件 fork 的锚） */
  readonly ctx: ContextScope;
  /** 持久层（persist:false 时为 undefined） */
  readonly persistence: Persistence | undefined;
  /** 会话（persist:false 时为 undefined；/new 热切换后指向新会话——活取值） */
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
  /** 生效组合（诊断输出用） */
  readonly model: string;
  readonly workspace: string;
  readonly sandboxMode: SandboxMode;
  readonly systemPrompt: string;
  /** 技能发现位置（dump-config 诊断输出用） */
  readonly skillLocations: readonly SkillLocation[];
  /** 会话驱动（通道宿主面：submit / requestQuit） */
  readonly conversation: ConversationDriver;
  /** 开新会话（/new）：新 Session + durable 换指 + 时间线重置；无持久层或 run 进行中返回 undefined */
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

/** 会话驱动依赖（组合根装配产物注入） */
export interface ConversationDriverDeps {
  /** loop 上下文（messages 活数组——历史投影回读 + 新消息追加同一时间线） */
  readonly context: AgentContext;
  /** loop 配置基座（streamFn/model/convertToLlm；steering 取数口由驱动补齐） */
  readonly loopConfig: Omit<AgentLoopConfig, 'getSteeringMessages' | 'getFollowUpMessages'>;
  /** durable 接线（persist:false 时缺省） */
  readonly durable?: DurableSinks;
  /** 会话首 run 前落 request/header 快照（组合根闭包——驱动不知道快照内容） */
  readonly writeHeader?: () => void;
}

/**
 * 会话驱动：通道宿主面（ChannelHost）+ run 编排。
 *
 * 持有 loop 的活数组上下文与 steering/followUp 共用队列；emit 扇出到 durable +
 * 展示消费者（TUI）；run 级异常合成 error 收尾（loop 零 try/catch 的对价）。
 */
export class ConversationDriver implements ChannelHost {
  /** 待注入消息队列（running 期 = steering 逐条；run 间隙 = followUp 全量） */
  private readonly queue = new PendingMessageQueue();
  private readonly context: AgentContext;
  private readonly config: AgentLoopConfig;
  private readonly durable: DurableSinks | undefined;
  private readonly writeHeader: (() => void) | undefined;
  /** 展示消费者（TUI handle；headless 无）——emit 扇出的非持久化半边 */
  private readonly displays: AgentEventSink[] = [];
  /** run 取消信号（退出序列 / SIGINT 共用；一次性——abort 即终态） */
  private readonly abortController = new AbortController();
  /** request/header 是否已落（会话首个 run 前一次） */
  private headerWritten = false;
  /** 是否有 run 在跑（submit 的 steering/followUp 分流依据） */
  private running = false;
  /** 最近一次 launch 的完成信号（settle 等待用） */
  private runPromise: Promise<void> = Promise.resolve();
  private quitResolve!: () => void;
  /** 退出请求 promise（TUI Ctrl+D/Ctrl+C、run 入口 SIGINT resolve——命令入口 await 它） */
  readonly quit: Promise<void> = new Promise((resolve) => {
    this.quitResolve = resolve;
  });

  constructor(deps: ConversationDriverDeps) {
    this.context = deps.context;
    this.durable = deps.durable;
    this.writeHeader = deps.writeHeader;
    // steering 取数口驱动自持：仅 running 期供给（run 间隙的余量走 launch 的
    // followUp 循环，不经此口——两路取数同一条队列，分流点在时机不在通道）
    this.config = {
      ...deps.loopConfig,
      getSteeringMessages: async () => (this.running ? this.queue.drain() : []),
      getFollowUpMessages: async () => [],
    };
  }

  /** 注册展示消费者（emit 扇出追加；TUI 起屏时接 handle） */
  addDisplay(sink: AgentEventSink): void {
    this.displays.push(sink);
  }

  /** emit 扇出：durable 半边 + 全部展示消费者（顺序执行，与事件序列同序） */
  private readonly emit: AgentEventSink = (event) => {
    this.durable?.handle(event);
    for (const display of this.displays) display(event);
  };

  /** 普通消息提交（通道宿主面）：running 时入 steering 队列，闲时直接开 run */
  submit(text: string): void {
    void this.launch([{ role: 'user', content: text, timestamp: Date.now() }]);
  }

  /** 退出请求（通道宿主面）：abort 当前 run + resolve 退出 promise */
  requestQuit(): void {
    this.abortController.abort();
    this.quitResolve();
  }

  /** headless 单次执行：开一个 run 等终值（命令入口用；与 submit 互斥使用） */
  async submitOnce(text: string): Promise<RunResult | undefined> {
    return this.launch([{ role: 'user', content: text, timestamp: Date.now() }]);
  }

  /** 等待在跑的 run 结算（退出序列在 abort 后先等它收尾再 flush） */
  async settle(): Promise<void> {
    await this.runPromise;
  }

  /** 是否有 run 在跑（/new 会话热切换的准入判据——run 中不换时间线） */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 时间线原位重置（会话热切换 /new 用）：活数组引用不变、内容替换为新种子
   * （loop 持有的 context.messages 引用持续有效——单一时间线不变式不破），
   * 首 run 标记复位（新会话要重新落 request/header）。
   * @returns run 进行中返回 false（拒绝热切换，时间线原样）
   */
  resetTimeline(seed: readonly AgentMessage[] = []): boolean {
    if (this.running) return false;
    const messages = this.context.messages;
    messages.length = 0;
    messages.push(...seed);
    this.headerWritten = false;
    return true;
  }

  /**
   * 开 run（防重入：running 时全部转队列——followUp 语义自然兜住并发 submit）。
   * @returns 闲时启动的 run 终值；running 时的提交返回 undefined（结果经事件流）
   */
  private async launch(prompts: AgentMessage[]): Promise<RunResult | undefined> {
    if (this.running || this.abortController.signal.aborted) {
      for (const message of prompts) this.queue.enqueue(message);
      return undefined;
    }
    this.running = true;
    // finally 复位 running：run 终结（含异常）后新 submit 才能再开 run
    const attempt = this.runTurns(prompts).finally(() => {
      this.running = false;
    });
    this.runPromise = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  /** run 序列：首 run + followUp 续跑循环；异常兜底合成 error 收尾 */
  private async runTurns(prompts: AgentMessage[]): Promise<RunResult> {
    const hooks = { emit: this.emit, signal: this.abortController.signal };
    let result: RunResult | undefined;
    try {
      // 会话首 run 前落 request/header（组装参数证据腿）。挪进 try 是卡死窗口
      // 修复（独立重读轮 #23 复核）：原在 launch 的 running=true 之后、runTurns
      // 调用之前裸调——writeHeader 抛错时 finally 复位永不执行（attempt 未创建），
      // running 永久卡死 + void launch() 拒绝无人处理；try 内抛错走统一 catch
      if (!this.headerWritten) {
        this.headerWritten = true;
        this.writeHeader?.();
      }
      result = await startRun(prompts, this.context, this.config, hooks);
      // run 自然停：余量排队消息全量捞出续跑（followUp 唤醒）
      while (!this.abortController.signal.aborted && this.queue.hasItems()) {
        const batch: AgentMessage[] = [];
        while (this.queue.hasItems()) batch.push(...this.queue.drain());
        result = await startRun(batch, this.context, this.config, hooks);
      }
    } catch (error) {
      // 回调违约（loop 零 try/catch 的对价）：合成 error 消息补齐事件序列
      const message: AssistantMessage = {
        role: 'assistant',
        content: [],
        usage: NO_USAGE,
        stopReason: 'error',
        // 错误文案走统一口径（[CODE] 前缀进文本——骨架篇 §3.4 M1 过渡态），
        // 与 loop 工具结果 / stream-fn 流错误三处同款，杜绝 app 兜底吞码（生态读码 pi-2 补钉）
        errorMessage: describeError(error),
        timestamp: Date.now(),
      };
      this.emit({ type: 'message_start', message });
      this.emit({ type: 'message_end', message });
      // turn_end 必发（独立重读轮 #9 修复 b）：与 loop 自身 error 路径（loop 零重试
      // 短路处）同款纪律——catch 若只发 agent_end 不发 turn_end，日志留下敞开 turn，
      // 恢复协议对「孤儿 tool/call + 后续正常 turn」的复合形状判定失据
      this.emit({ type: 'turn_end', message, toolResults: [] });
      this.emit({ type: 'agent_end', status: 'failed', messages: [message] });
      result = {
        status: 'failed',
        messages: [message],
        stopReason: 'error',
        errorMessage: message.errorMessage,
      };
    }
    return result;
  }
}

/**
 * 组装 Berry 运行时（组合根唯一入口；三个命令入口共用）。
 * 装配顺序即依赖序：ctx → channels → persist → llm → tools → safety → skills
 * → 插件装载（⑨，组合树 Ring 2/3 行）→ 命令（⑨b，闭包引用 plugins/reload——
 * 须后于装载声明）→ 驱动。全部注册走 ctx.provide/on/effect——作用域 dispose 即整体回卷。
 * async：插件装载（jiti import + apply）是异步序列（契约篇 §1）。
 */
export async function createBerryRuntime(opts: RuntimeOptions = {}): Promise<BerryRuntime> {
  const workspace = opts.workspace ?? process.cwd();
  const model = opts.model ?? process.env['APP_MODEL'] ?? DEFAULT_MODEL;
  const sandboxMode = opts.sandboxMode ?? 'workspace-write';
  const persistEnabled = opts.persist !== false;

  /* ---- ① 根作用域（模块加载器/插件 fork 的锚） ---- */
  const ctx = createContext({ name: 'app' });

  /* ---- ② 通道与 UI 服务 ---- */
  const { channels, ui } = registerChannelServices(ctx);

  /* ---- ③ 持久层（persist:false 跳过——诊断面不落库） ---- */
  const persistence = persistEnabled
    ? Persistence.open({
        path: opts.dbPath ?? dbPath(),
        // session/event 活体镜像（契约篇 §2.2 emit 模式行）：SessionEvent 入
        // write-behind 队列后同步上总线，载荷 { sessionId, event } 信封（dsh-11
        // 规则——多会话并存时订阅方必须能从载荷分辨归属）。createSession /
        // loadSession / forkSession 三路接线统一经此镜像，/new 新会话自动同接线
        onLiveEvent: (sessionId, event) => ctx.emit('session/event', { sessionId, event }),
      })
    : undefined;
  // 启动会话策略（技术栈篇 §5 拍板）：显式 id / 按 cwd 最新 → 续接（loadSession
  // + 恢复协议补齐闭合）；不指定或目标不存在 → 新建。resumed 决定首张 header 的 reason
  let session: Session | undefined;
  let resumed = false;
  if (persistence) {
    const targetId =
      typeof opts.resumeSession === 'string'
        ? opts.resumeSession
        : opts.resumeSession === true
          ? persistence.latestSessionId(workspace)
          : undefined;
    if (targetId) {
      const loaded = persistence.loadSession(targetId);
      if (loaded) {
        // 恢复协议语义半边（会话篇 §4）：孤儿配对补 closer——append 即进
        // write-behind（关停屏障保证落盘），日志闭合后投影才可安全续跑
        loaded.recoverFromInterruption();
        session = loaded;
        resumed = true;
      }
      // 目标不存在回落新建：启动策略是「续接优先」不是「必须续接」
    }
    session ??= persistence.createSession({ cwd: workspace, profile: 'default' });
  }
  const durable = session ? createDurableSinks(session) : undefined;
  // durable 活引用（/new 会话热切换的换指点）：pipeline / 审批服务 / 驱动在构造期
  // 绑定接线点，经此转发壳读当前会话——热切换不动已建服务的绑定
  const durableRef: { current: DurableSinks | undefined } = { current: durable };
  const durableForward: DurableSinks | undefined = durable
    ? {
        handle: (event) => durableRef.current?.handle(event),
        gate: (payload) => durableRef.current?.gate(payload),
        approval: {
          asked: (payload) => durableRef.current?.approval.asked(payload),
          decided: (payload) => durableRef.current?.approval.decided(payload),
        },
      }
    : undefined;

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
      // write-behind 重试去重锚点）。session 为活引用——/new 热切换后记到新会话；
      // 无持久层（诊断装配）只 debug 不落账，读侧聚合缺省 0
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
    }),
  );

  /* ---- ⑤ 工具注册表 + 三段管道（gate/decision 落 durable） ---- */
  const pipeline: ToolPipelineExecutor = createToolPipeline(ctx, {
    ...(durableForward ? { onGateDecision: durableForward.gate } : {}),
  });
  const tools = registerToolsService(ctx, { pipeline });
  // fs 工具族（可写根换 safety 推导——替换 tools 模块的 M1 过渡默认）
  const writableRoots = createRootsProvider({ workspace, entries: DEFAULT_CARVE_OUT_ENTRIES });
  const fsTools = createFsTools({ writableRoots, workspace: () => workspace });
  for (const def of fsTools.tools) tools.register(def);

  /* ---- ⑥ 审批 + 守门行（审批对落 durable） ---- */
  const approval = createApprovalService(ctx, {
    policy: opts.approvalPolicy ?? 'ask',
    ...(durableForward ? { sink: durableForward.approval } : {}),
  });
  ctx.effect(() => installSafetyGate(ctx, { approval, workspace, mode: () => sandboxMode }));
  // 沙箱档落 durable（fold：审计回放知道当轮档位）。续接同档不重复落——fold 取
  // 最后一条，重复事件只污染日志（技术栈篇 §5 启动策略拍板注记）
  const lastMode = [...(session?.events ?? [])].reverse().find((e) => e.type === 'sandbox/mode');
  if ((lastMode?.data as { mode?: string } | undefined)?.mode !== sandboxMode) {
    session?.append('sandbox/mode', { mode: sandboxMode });
  }

  /* ---- ⑦ 技能（本地 provider 发现 + 渐进披露清单进系统提示词）----
   * 具名提示词段服务（ctx.prompts，pi-4(a) 拍板）：段注册表宿主拥有，分节序固定 =
   * 基座 → 技能渐进披露 → 具名段（id 字典序）；render() 仅在重建时点求值物化，
   * 段内容随快照冻结（禁整串替换与 per-run 重写两毒品形态——契约篇 §1.3 五件） */
  const prompts = registerPromptsService(ctx);
  const skills = createSkillsService();
  registerSkillsService(ctx, skills);
  const locations = opts.skillLocations ?? defaultSkillLocations(workspace, { homeDir: opts.homeDir, trusted: true });
  skills.registerProvider(createLocalSkillsProvider({ locations }));
  skills.refresh();
  // 系统提示词活视图（/reload 重建）：let 绑定 + rebuild 闭包改写——writeHeader 与
  // loop 上下文经 getter/闭包读当前值（loop 每次模型请求重读 context.systemPrompt，
  // /reload 后新提示词下次请求即见，不需要换 context 对象）
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

  /* ---- ⑧ 会话驱动（loop 上下文活数组 + steering/followUp 队列） ---- */
  // request/header 落账闭包（会话篇 §1.3）：仅组装参数变化时落新快照，reason
  // 三值——续接会话首张 resume、新会话首张 initial、此后变化 change。
  // session 是活绑定（/new 换指后 append 落到当前会话），闭包不随热切换重造
  const headerState: { last?: string; next: 'initial' | 'resume' | 'change' } = {
    next: resumed ? 'resume' : 'initial',
  };
  const writeHeader = session
    ? () => {
        const payload = {
          config: { model, sandbox: sandboxMode },
          systemPrompt,
          toolSchemas: tools.list().map((def) => ({ name: def.name, parameters: def.parameters })),
        };
        const serialized = JSON.stringify(payload);
        if (serialized === headerState.last) return; // 组装参数未变——不落新快照
        // 活绑定读取（/new 换指后落当前会话）；writeHeader 存在即持久层存在，
        // session 事实上恒有值——可选链只为通过 let 联合类型的收窄
        session?.append('request/header', { ...payload, reason: headerState.next });
        headerState.last = serialized;
        headerState.next = 'change';
      }
    : undefined;

  // loop 工具快照的活数组（骨架篇 §9.2 装配层接线义务）：loop 每次模型请求与
  // 每次 tool call 查找都读 context.tools——原位替换（length=0 + push）即达
  // loop，含 run 中途；数组引用由装配层持有，tools_change 时在 ⑧ 后接线处刷新
  const toolView: AgentTool[] = tools.list().map((def) => tools.toAgentTool(def));

  const conversation = new ConversationDriver({
    context: {
      // getter 活视图：/reload 重建后 loop 每次模型请求取到新提示词
      get systemPrompt() {
        return systemPrompt;
      },
      // 续接会话：历史投影回读作时间线种子（恢复协议已补齐闭合——投影无敞开 turn）
      messages: session && resumed ? projectedToAgentMessages(session.deriveMessages()) : [],
      tools: toolView,
    },
    loopConfig: {
      streamFn,
      model,
      convertToLlm: (messages) => defaultConvertToLlm(messages),
      // context_transform 桥接（契约篇 §2.2 增补 5②，骨架篇 §3.1 既有表述兑现）：
      // loop 的私有配置回调在此桥为总线瀑布——插件挂按需检索注入不再需要宿主特设
      // 通道；载荷 = contracts 标准 AgentMessage[]，逐 handler 经 next(newArgs)
      // 变换传播，链尾以最终参数回调（无监听/全放行 = 原样直通）
      transformContext: (messages) => ctx.waterfall('context_transform', messages, (final: AgentMessage[]) => final),
    },
    durable: durableForward,
    writeHeader,
  });

  // tools_change → 刷新 loop 工具快照 + 即时落 request/header 快照（骨架篇 §9.2
  // 接线义务；会话篇 §1.3 腿 2「仅变化才快照」——writeHeader 内建 diff，toolSchemas
  // 变了才落 reason=change，run 中途换工具也当场留痕，「模型可见即落日志」）。
  // 注册在装配期 fs 工具族之后：装配期注册不触发（首张 header 仍由首 run 落）
  ctx.on(TOOLS_CHANGE_EVENT, () => {
    const fresh = tools.list().map((def) => tools.toAgentTool(def));
    toolView.length = 0;
    toolView.push(...fresh);
    writeHeader?.();
  });

  // prompts_change → 重建系统提示词 + 即时落 header 快照（pi-4(a) 落码形态④，与
  // tools_change 同族）：段集只在装载//reload 两时点变（注册/注销即广播）；装配层
  // 同点完成重建——订阅者是观测刷新，不承担重建。writeHeader 内建 diff：段内容
  // 变了才落 reason=change，没变不污染日志
  ctx.on(PROMPTS_CHANGE_EVENT, () => {
    rebuildSystemPrompt();
    writeHeader?.();
  });

  /* ---- ⑧b 开新会话（/new 热切换）：新 Session + durable 换指 + 时间线重置 ---- */
  const startNewSession = (): Session | undefined => {
    // run 进行中拒绝热切换（时间线正被 loop 引用）；无持久层无事可做
    if (!persistence || conversation.isRunning) return undefined;
    const fresh = persistence.createSession({ cwd: workspace, profile: 'default' });
    session = fresh;
    durableRef.current = createDurableSinks(fresh);
    // 新会话首事件：沙箱档（新会话 fold 从零起步，必落）
    fresh.append('sandbox/mode', { mode: sandboxMode });
    // header 落账状态复位：新会话首快照 reason=initial、diff 基线清零
    headerState.last = undefined;
    headerState.next = 'initial';
    // /new 重建时点（pi-4(a) 落码形态③）：具名段重物化——简报等段内容随新会话
    // 快照冻结（旧会话会话内不漂移的对称面：跨会话时点刷新）
    rebuildSystemPrompt();
    conversation.resetTimeline();
    return fresh;
  };

  /* ---- ⑨ 组合树 + 插件装载（契约篇 §5.1/§1：Ring 2/3 行走树；Ring 0/1 仍硬装配，树化 seam） ----
   * 服务全部就位后再装插件（inject 依赖驱动轮次激活——宿主服务首轮即全就绪）；
   * 插件注册的工具经 ⑧ 已接线的 tools_change 原位刷新 loop 工具快照（含 run 中途）。
   *
   * 卸载基底 = 插件锚作用域（§1.3 落码形态①）：全体插件 scope 自锚 fork、自定义
   * 事件词汇挂锚 effect——锚 dispose 即 LIFO 级联回卷一切插件注册（工具/监听/服务/
   * 词汇），/reload 的卸载半边由此成立；重锚 = ctx.fork 再派生（注册表同根共享）。
   * jiti moduleCache:false 是两条缓存纪律的 v1 基底（重装即全依赖图重求值）。
   * plugins 服务 provide 一次（§1.3 服务集恒定）：boot 与 /reload 经 applyLoad 就地
   * 更新状态，热应用期间服务引用永不断链。
   * 失败行两面语义（§1.6）：boot = 启动断言拒绝启动（先收尾持久层再回卷 ctx，抛全量
   * 清单）；/reload = 逐行响亮报告、进程存活（local 源「改动 + /reload 即见」环）。 */
  const compositionDir = opts.compositionDir ?? dataDir();
  ctx.provide('paths', createPathsService(compositionDir));
  const plugins = createPluginsService({ dataDir: compositionDir });
  ctx.provide('plugins', plugins);
  // 锚是活绑定（/reload dispose 后重 fork）；composition 同为活绑定（/reload 重装载）
  let pluginAnchor: ContextScope = ctx.fork({ name: 'plugins' });
  let composition: CompositionReport = loadComposition(compositionDir);
  plugins.applyLoad(composition, await loadPlugins(pluginAnchor, composition.plan));
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

  /** 组合树全量重载（/reload 主体；TUI 薄壳直调——对账逻辑不进壳面） */
  const reload = async (): Promise<ReloadResult> => {
    // run 进行中拒绝（与 /new 同准入判据——loop 正引用工具快照与提示词，不换装配）
    if (conversation.isRunning) return { busy: true };
    // overlay 校验先行：树坏不动旧装配（旧锚回卷是不可逆动作——先验后拆）
    let fresh: CompositionReport;
    try {
      fresh = loadComposition(compositionDir);
    } catch (err) {
      return { error: describeError(err) };
    }
    try {
      await pluginAnchor.dispose(); // LIFO 级联回卷：工具卸载（tools_change 即时刷新）+ 监听/服务/词汇注销
      pluginAnchor = ctx.fork({ name: 'plugins' });
      const load = await loadPlugins(pluginAnchor, fresh.plan);
      composition = fresh;
      plugins.applyLoad(fresh, load); // 同实例就地更新（失败行进 list 状态面——进程存活）
      rebuildSystemPrompt();
      // 组装参数变化经 writeHeader 内建 diff 落 reason=change 快照（仅变化才落——
      // 提示词/工具面变了才写，没变不污染日志；无持久层为 no-op）
      writeHeader?.();
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
    }
  };

  /* ---- ⑨b 内置命令（help/quit/new/skills/skill:<名> + 插件管理五件/reload） ----
   * 依赖 ⑨ 的 plugins 服务与 reload 闭包——必须在其后注册（引用先声明）。 */
  ctx.effect(() =>
    registerBuiltinCommands({
      commands: channels.commands,
      ui,
      skills,
      quit: () => conversation.requestQuit(),
      submit: (text) => conversation.submit(text),
      newSession: startNewSession,
      plugins, // ctx.plugins 服务（⑨ provide——命令壳与宿主同源）
      reload, // 组合根 reload 闭包（⑨ 定义——busy/error/payload 三面）
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
    // 活取值（/new 热切换后指向新会话）——接口上仍是 readonly，实现为 getter
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
    model,
    workspace,
    sandboxMode,
    // 活取值（/reload 重建系统提示词后取新值）
    get systemPrompt(): string {
      return systemPrompt;
    },
    skillLocations: locations,
    conversation,
    newSession: startNewSession,
    reload,
    /** 优雅关停：等 run 结算 → flush 屏障 → 关库 → ctx 回卷（§1.3 编排） */
    async shutdown() {
      await conversation.settle();
      // try/finally：flush/close 任一失败也要 ctx.dispose 回卷（独立重读轮 #16
      // 复核——dispose 是资源必达件，不因持久层收尾异常被跳过；dispose 自身
      // 异常已被 context 回卷隔离逐条吞噬，不会反向炸关停序列）
      try {
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
