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
import { describeError } from '../contracts/errors.js';
import type { ContextScope } from '../context/types.js';
import { createContext } from '../context/context.js';
import { Persistence } from '../persist/index.js';
import type { LlmRuntime, Provider } from '../llm/index.js';
import { createLlmRuntime, createStreamFn } from '../llm/index.js';
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
import { createDurableSinks } from './durable.js';
import type { DurableSinks } from './durable.js';
import { createCredentialStore } from './persist-bridge.js';
import { defaultConvertToLlm } from './convert.js';
import { registerBuiltinCommands } from './commands.js';
import { dbPath } from './paths.js';

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
}

/** 组合根产物（三个命令入口持有的运行时面） */
export interface BerryRuntime {
  /** 根作用域（插件 fork 的锚） */
  readonly ctx: ContextScope;
  /** 持久层（persist:false 时为 undefined） */
  readonly persistence: Persistence | undefined;
  /** 会话（persist:false 时为 undefined） */
  readonly session: Session | undefined;
  /** llm 运行时（streamFn 注入测试时仍存在——目录解析面可用） */
  readonly llm: LlmRuntime;
  /** 工具注册表（fs 四件已注册，管道已接） */
  readonly tools: ToolsService;
  readonly channels: ChannelsServiceEntity;
  readonly ui: UiService;
  readonly skills: SkillsService;
  readonly approval: ApprovalService;
  /** 生效组合（诊断输出用） */
  readonly model: string;
  readonly workspace: string;
  readonly sandboxMode: SandboxMode;
  readonly systemPrompt: string;
  /** 技能发现位置（dump-config 诊断输出用） */
  readonly skillLocations: readonly SkillLocation[];
  /** 会话驱动（通道宿主面：submit / requestQuit） */
  readonly conversation: ConversationDriver;
  /** 优雅关停（run 结算 → flush 屏障 → 关库 → ctx 回卷——骨架篇 §1.3 的进程内编排） */
  shutdown(): Promise<void>;
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
 * → 命令 → 驱动。全部注册走 ctx.provide/on/effect——作用域 dispose 即整体回卷。
 */
export function createBerryRuntime(opts: RuntimeOptions = {}): BerryRuntime {
  const workspace = opts.workspace ?? process.cwd();
  const model = opts.model ?? process.env['APP_MODEL'] ?? DEFAULT_MODEL;
  const sandboxMode = opts.sandboxMode ?? 'workspace-write';
  const persistEnabled = opts.persist !== false;

  /* ---- ① 根作用域（模块加载器/插件 fork 的锚） ---- */
  const ctx = createContext({ name: 'app' });

  /* ---- ② 通道与 UI 服务 ---- */
  const { channels, ui } = registerChannelServices(ctx);

  /* ---- ③ 持久层（persist:false 跳过——诊断面不落库） ---- */
  const persistence = persistEnabled ? Persistence.open({ path: opts.dbPath ?? dbPath() }) : undefined;
  const session = persistence?.createSession({ cwd: workspace, profile: 'default' });
  const durable = session ? createDurableSinks(session) : undefined;

  /* ---- ④ llm 运行时（凭证经 persist 适配注入；测试可整体换 streamFn） ---- */
  const llm = createLlmRuntime({
    ...(persistence ? { credentials: createCredentialStore(persistence.store) } : {}),
    ...(opts.providers ? { providers: opts.providers } : {}),
  });
  const streamFn: StreamFn = opts.streamFn ?? createStreamFn(llm);

  /* ---- ⑤ 工具注册表 + 三段管道（gate/decision 落 durable） ---- */
  const pipeline: ToolPipelineExecutor = createToolPipeline(ctx, {
    ...(durable ? { onGateDecision: durable.gate } : {}),
  });
  const tools = registerToolsService(ctx, { pipeline });
  // fs 工具族（可写根换 safety 推导——替换 tools 模块的 M1 过渡默认）
  const writableRoots = createRootsProvider({ workspace, entries: DEFAULT_CARVE_OUT_ENTRIES });
  const fsTools = createFsTools({ writableRoots, workspace: () => workspace });
  for (const def of fsTools.tools) tools.register(def);

  /* ---- ⑥ 审批 + 守门行（审批对落 durable） ---- */
  const approval = createApprovalService(ctx, {
    policy: opts.approvalPolicy ?? 'ask',
    ...(durable ? { sink: durable.approval } : {}),
  });
  ctx.effect(() => installSafetyGate(ctx, { approval, workspace, mode: () => sandboxMode }));
  // 沙箱档落 durable（fold：审计回放知道当轮档位）
  session?.append('sandbox/mode', { mode: sandboxMode });

  /* ---- ⑦ 技能（本地 provider 发现 + 渐进披露清单进系统提示词） ---- */
  const skills = createSkillsService();
  registerSkillsService(ctx, skills);
  const locations = opts.skillLocations ?? defaultSkillLocations(workspace, { homeDir: opts.homeDir, trusted: true });
  skills.registerProvider(createLocalSkillsProvider({ locations }));
  skills.refresh();
  const systemPrompt = [SYSTEM_PROMPT_BASE, skills.renderAvailableSkills()].filter((part) => part !== '').join('\n');

  /* ---- ⑧ 会话驱动（loop 上下文活数组 + steering/followUp 队列） ---- */
  const conversation = new ConversationDriver({
    context: {
      systemPrompt,
      messages: [],
      tools: tools.list().map((def) => tools.toAgentTool(def)),
    },
    loopConfig: {
      streamFn,
      model,
      convertToLlm: (messages) => defaultConvertToLlm(messages),
    },
    durable,
    ...(session
      ? {
          writeHeader: () => {
            session.append('request/header', {
              config: { model, sandbox: sandboxMode },
              systemPrompt,
              toolSchemas: tools.list().map((def) => ({ name: def.name, parameters: def.parameters })),
              reason: 'initial',
            });
          },
        }
      : {}),
  });

  /* ---- ⑨ 内置命令（help/quit/skills/skill:<名>） ---- */
  ctx.effect(() =>
    registerBuiltinCommands({
      commands: channels.commands,
      ui,
      skills,
      quit: () => conversation.requestQuit(),
      submit: (text) => conversation.submit(text),
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
    session,
    llm,
    tools,
    channels,
    ui,
    skills,
    approval,
    model,
    workspace,
    sandboxMode,
    systemPrompt,
    skillLocations: locations,
    conversation,
    /** 优雅关停：等 run 结算 → flush 屏障 → 关库 → ctx 回卷（§1.3 编排） */
    async shutdown() {
      await conversation.settle();
      // try/finally：flush/close 任一失败也要 ctx.dispose 回卷（独立重读轮 #16
      // 复核——dispose 是资源必达件，不因持久层收尾异常被跳过；dispose 自身
      // 异常已被 context 回卷隔离逐条吞噬，不会反向炸关停序列）
      try {
        await persistence?.flush();
        await persistence?.close();
      } finally {
        await ctx.dispose();
      }
    },
  };
}
