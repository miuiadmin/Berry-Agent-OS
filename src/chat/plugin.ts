/**
 * L4 chat — 对话应用官方件（契约篇 §5.4 应用面第一纵切：`builtin:chat` 显式化；铭牌批件聚落 src/chat/）。
 *
 * 官方默认层**首行**（Ring 2 真·可卸——overlay 禁用即首启无对话循环，宿主照启：
 * 装/守/存职能与 /plugins、/reload 壳命令完好；命题 §3.5「对话是应用不是内核」
 * 的运行时证明）。件本体四件（自组合根 assembly 迁入，2026-08-24 规范先行）：
 *
 * ① ConversationDriver 构造——**factory 级单例**：/reload 销锚重装载时件被
 *    重新 apply，但驱动与时间线必须存续（重装载是插件面变更，不是会话变更），
 *    故构造只在首个 apply 执行一次，重装载 apply 只重接 provide/控制面；
 * ② durable 接线（boot 会话的 createDurableSinks 三路 sink 绑定——转发壳在
 *    组合根，/new 换指由组合根编排侧写同一活引用槽）；
 * ③ resume 续接策略（latestSessionId 按 cwd 续接最新 / 显式 id 续接 / 回落
 *    新建 + 恢复协议补齐 + request/header 差分化 initial/resume/change——
 *    技术栈篇 §5「默认续接最新会话」）；
 * ④ ctx.agent 具名服务 provide（sendUserMessage / onRunSettled——服务与驱动
 *    同件同生命周期，晚绑定 attach 挂点退役；goal 等消费方 inject/optionalInject
 *    结构性取得，chat 行居默认层首行 → 轮次激活先于一切消费方 apply）。
 *
 * 会话选择属对话应用（无对话运行则无会话——「哪段对话续接」是应用行为，事件
 * 日志机制才是内核）；sandbox 档事实是宿主守门面，盖章函数由组合根注入、件在
 * 会话边界时点调用（内核有数据，应用有时点）。
 */

import { AppError, AGENT_DELIVER_AS_UNSUPPORTED, describeError } from '../contracts/errors.js';
import type { UserMessage, MessageSource, Message, StreamFn } from '../contracts/llm.js';
import type { AgentMessage } from '../contracts/messages.js';
import type { RunStatus } from '../agent/events.js';
import type { AgentTool } from '../contracts/tools.js';
import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import type { Context, Disposer } from '../context/types.js';
import type { Session } from '../session/session.js';
import type { Persistence } from '../persist/index.js';
import type { ToolsService } from '../tools/registry.js';
import type { SandboxMode } from '../safety/index.js';
import type { DurableSinks } from './durable.js';
import { createDurableSinks, projectedToAgentMessages } from './durable.js';
import type { ConversationDriver } from './conversation.js';
import { ConversationDriver as ConversationDriverClass } from './conversation.js';

/**
 * 对话应用 id（apps/chat.app.yaml 清单的 id——会话域打标、resume 域查询、
 * request/header 载荷腿共用同一字面量；默认入口期 chat 兼任默认应用，第十七批）。
 */
export const CHAT_APP_ID = 'chat';

/* ------------------------------------------------------------------ */
/* ctx.agent 服务面（自 agent-service.ts 迁入——attach 退役后服务与     */
/* 驱动同件构造，无游离态；类型面公开导出不变，消费方局部结构面免改动） */
/* ------------------------------------------------------------------ */

/** sendUserMessage 可选项（骨架篇 §9.3 签名） */
export interface SendUserMessageOptions {
  /** 注入归因（会话篇 §3.1 dsh-8 词汇——如 'plugin:goal'）；缺省不落字段（读侧视为 'user'） */
  readonly source?: MessageSource;
  /** true = 自激唤醒（计入自激预算 maxConsecutiveWakes——闲时 followUp 前 check、超帽降级 inject）；缺省 false（用户手写语义恢复预算） */
  readonly backgroundWake?: boolean;
  /**
   * run 级工具白名单（第二十四批题3a——无人值守收窄投影，仅 backgroundWake 投递
   * 携带才有意义）：实际开起的 run 批全为 wake 消息时生效，多源取交集；用户消息
   * 混批不收窄。见 ConversationDriver.DeliverOptions.toolFilter。
   */
  readonly toolFilter?: readonly string[];
  /** 定向投递（'steer'/'inject'）——M2+ 预留位，显式携带即 AGENT_DELIVER_AS_UNSUPPORTED */
  readonly deliverAs?: 'steer' | 'inject';
}

/** run 结算载荷（onRunSettled 订阅面——status 三值对齐 RunStatus） */
export interface RunSettled {
  /** 本 run 终态（completed / aborted / failed——含异常兜底合成路） */
  readonly status: RunStatus;
}

/** ctx.agent 服务面（provide('agent') 的形状——插件经 inject 'agent' 结构性取得） */
export interface AgentServiceFace {
  /** 三通道注入（构造 UserMessage 经 driver.deliver 透传；返回 void——steer 入队语义下 run 边界模糊，§9.3 ask 是等待结果的另一面 ⏳） */
  sendUserMessage(content: string | UserMessage['content'], opts?: SendUserMessageOptions): void;
  /** 订阅 run 结算（每个 run 终结派发一次；Disposer 注销——挂 ctx.effect 即随插件回卷） */
  onRunSettled(cb: (settled: RunSettled) => void): Disposer;
}

/* ------------------------------------------------------------------ */
/* 件 ↔ 组合根 控制面                                                   */
/* ------------------------------------------------------------------ */

/**
 * 件暴露给组合根的控制面（apply 末尾写入 deps.chatRef；件未激活/无持久层时空）：
 * 组合根保留 /new 编排与 tools_change/prompts_change 装配接线（骨架篇 §9.2
 * 装配层接线义务），件内状态经本面驱动。
 */
export interface ChatControls {
  /** 落 request/header 快照（diff 语义内建——仅组装参数变化才落；/reload 收口与窗口外变更走此口） */
  writeHeader(): void;
  /** /new 会话边界复位：header 差分基线清零 + 首快照名分复位 initial */
  resetHeaderState(): void;
  /** /new 时间线原位重置（run 中返回 false——组合根已先行 isRunning 准入判据，此处防御位） */
  resetTimeline(): boolean;
}

/** 件构造依赖（装配期活闭包——官方件 = 宿主装配特权，不新开 ctx 服务名） */
export interface ChatPluginDeps {
  /** 启动会话策略原样透传（true = 按 cwd 续接最新；string = 显式 id；缺省 = 新建） */
  readonly resumeSession?: boolean | string;
  /** 持久层（缺省 = persist:false 诊断面——件降级空转，不起驱动不供 agent） */
  readonly persistence?: Persistence;
  /** 工作区根（latestSessionId 归属键 / 会话 cwd） */
  readonly workspace: string;
  /** 模型标识（loop 配置 + request/header 快照腿） */
  readonly model: string;
  /** 沙箱档（request/header 快照 config 腿） */
  readonly sandboxMode: SandboxMode;
  /** streamFn（loop 配置——组合根 ④ 产物） */
  readonly streamFn: StreamFn;
  /** convertToLlm（loop 配置——组合根 convert 产物） */
  readonly convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  /** context_transform 桥（经根总线 waterfall——插件监听随 /reload 更替，桥本体用根 ctx 恒存活） */
  readonly transformContext: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
  /** 系统提示词活视图（/reload、/new 重建后取新值——writeHeader 与 loop 各时点求值） */
  readonly getSystemPrompt: () => string;
  /** 工具注册表服务（writeHeader 的 toolSchemas 腿 + toolView 首帧——内核单例，随 reload 不变） */
  readonly tools: ToolsService;
  /** loop 工具快照活数组（组合根分配、件填充首帧、组合根 tools_change 订阅原位刷新） */
  readonly toolView: AgentTool[];
  /** 会话换指回调（组合根 let session 槽 + resumed 旗标一次性回写） */
  readonly bindSession: (session: Session | undefined, resumed: boolean) => void;
  /** 当前会话活取值（writeHeader 落账读它——/new 换指后落新会话，闭包不随热切换重造） */
  readonly getSession: () => Session | undefined;
  /** durable 活引用槽（组合根持有转发壳——件在会话边界写槽换指） */
  readonly durableRef: { current: DurableSinks | undefined };
  /** durable 转发壳（驱动构造绑它——写侧永远转发到当前会话，跨 /new 热切换稳定） */
  readonly durableForward: DurableSinks;
  /** 驱动活句柄槽（组合根 runtime 面 / reload busy 判据 / 双入口读它——件构造后写入） */
  readonly driverRef: { current: ConversationDriver | undefined };
  /** 件控制面槽（writeHeader/resetHeaderState/resetTimeline——apply 末写入） */
  readonly chatRef: { current: ChatControls | undefined };
  /** sandbox 档事实盖章（内核守门面实现——dedup 内建；件在 boot 会话边界调用，/new 边界由组合根编排侧直调） */
  readonly stampSandboxFacts: (session: Session) => void;
}

/**
 * 构造 chat 官方件模块引用（builtins 注册表 `builtin:chat` 行）。
 *
 * 驱动为 factory 级单例（闭包持有）：首 apply 构造并绑槽，/reload 重装载的
 * apply 复用（时间线存续），只重接 ctx.agent provide 与 onRunSettled 接线
 * （挂 ctx.effect 随件锚回卷——旧订阅不泄漏）。
 */
export function createChatPlugin(deps: ChatPluginDeps): BuiltinPluginModule {
  /** 驱动单例（首 apply 构造；/reload 重装载复用——时间线与队列存续） */
  let driver: ConversationDriver | undefined;
  /** request/header 落账状态（factory 级——跨 /reload 存续，/new 由控制面复位） */
  const headerState: { last?: string; next: 'initial' | 'resume' | 'change' } = { next: 'initial' };

  return {
    name: 'chat',
    apply: (ctx: PluginContext) => applyChatPlugin(ctx, deps, headerState, driver, (d) => (driver = d)),
  };
}

/** 件 apply 本体（boot 全量接线；/reload 重装载走复用支线） */
async function applyChatPlugin(
  ctx: PluginContext,
  deps: ChatPluginDeps,
  headerState: { last?: string; next: 'initial' | 'resume' | 'change' },
  driver: ConversationDriver | undefined,
  setDriver: (driver: ConversationDriver) => void,
): Promise<void> {
  // persist:false 降级：无持久层即无会话可续、无驱动可起（dump-config 诊断面
  // 不起驱动——件空转 warn；goal 等消费方经 optionalInject 降级，启动断言不响）
  if (!deps.persistence) {
    ctx.logger.warn('无持久层（persist:false）——chat 官方件空转：不建会话、不起驱动、不供 agent 服务');
    return;
  }

  /* ---- /reload 重装载支线：驱动单例已在——只重接 provide 与结算接线 ---- */
  if (driver !== undefined) {
    provideAgentService(ctx, driver);
    return;
  }

  /* ---- ③ 会话选择（技术栈篇 §5：显式 id / 按 cwd 最新 → 续接；回落新建） ---- */
  // 恢复协议语义半边（会话篇 §4）：孤儿配对补 closer——append 即进 write-behind
  //（关停屏障保证落盘），日志闭合后投影才可安全续跑
  const persistence = deps.persistence;
  const targetId =
    typeof deps.resumeSession === 'string'
      ? deps.resumeSession
      : deps.resumeSession === true
        ? // chat 域含 NULL 存量回退（契约篇 §5.4 冷读裁决）：NULL = builtin:chat 落地前
          // 的存量会话，默认入口的域含历史全量（存量不回填但续接不弃养）
          persistence.latestSessionId(deps.workspace, { app: CHAT_APP_ID, includeNullApp: true })
        : undefined;
  let session: Session | undefined;
  let resumed = false;
  if (targetId !== undefined) {
    const loaded = persistence.loadSession(targetId);
    if (loaded) {
      loaded.recoverFromInterruption();
      session = loaded;
      resumed = true;
    }
    // 目标不存在回落新建：启动策略是「续接优先」不是「必须续接」
  }
  // 新建会话打标 chat 域（默认启动即 app='chat'——血缘显式打标，不做投影推断）
  session ??= persistence.createSession({ cwd: deps.workspace, profile: 'default', app: CHAT_APP_ID });

  // 组合根槽位回写（let session / resumed 旗标——llm onUsage、ctx.sessions、
  // goal wasResumed 等组合根闭包经此读当前值；goal 轮次激活晚于本 apply，读必定居值）
  deps.bindSession(session, resumed);
  // ② durable 接线（boot 会话三路 sink 绑进组合根活引用槽——转发壳已就位，
  // pipeline 守门/审批对在构造期绑壳，此刻起落账到当前会话；model 腿供
  // llm/usage 前台折叠的回退值——底账统一，契约篇 §5.4）
  deps.durableRef.current = createDurableSinks(session, { model: deps.model });
  // session_start（契约篇 §2.2 session 层 emit 行）：会话建立/恢复闭合后必发
  // 一次——插件初始化会话级状态的锚点；origin 对齐首张 header 的 reason 语义
  //（resume = 恢复闭合含崩溃修复，initial = 新建）。装载序上本事件先于一切
  // 消费方插件的 plugin/activated，时序事实与组合根直发形态等价
  ctx.emit('session_start', { sessionId: session.header.sessionId, origin: resumed ? 'resume' : 'initial' });
  // sandbox 档事实盖章（内核守门面数据 + 应用会话边界时点；dedup 内建——
  // 续接同档不重复落，事件序与组合根直装形态一致：session_start → sandbox/mode）
  deps.stampSandboxFacts(session);
  // 首张 header 名分（续接会话 resume / 新会话 initial——此后变化 change）
  headerState.next = resumed ? 'resume' : 'initial';

  /* ---- ③ request/header 差分化闭包（会话篇 §1.3：仅组装参数变化才落新快照） ---- */
  // 落账读活会话（deps.getSession——/new 换指后落新会话，闭包不随热切换重造）
  const writeHeader = (): void => {
    const current = deps.getSession();
    if (current === undefined) return; // 防御：无会话即无处落账（结构上不可达）
    const payload = {
      config: { model: deps.model, sandbox: deps.sandboxMode },
      systemPrompt: deps.getSystemPrompt(),
      toolSchemas: deps.tools.list().map((def) => ({ name: def.name, parameters: def.parameters })),
    };
    const serialized = JSON.stringify(payload);
    if (serialized === headerState.last) return; // 组装参数未变——不落新快照
    // app 腿在序列化基线之外追加（会话域打标的载荷腿——会话内恒定，不参与 diff；
    // 与 sessions.app 同源，血缘显式打标的证据腿，契约篇 §5.4）
    current.append('request/header', { ...payload, app: CHAT_APP_ID, reason: headerState.next });
    headerState.last = serialized;
    headerState.next = 'change';
  };

  /* ---- ① 驱动构造（活数组上下文 + steering/followUp 共用队列） ---- */
  // 续接会话：历史投影回读作时间线种子（恢复协议已补齐闭合——投影无敞开 turn）
  const messages: AgentMessage[] = resumed ? projectedToAgentMessages(session.deriveMessages()) : [];
  // loop 工具快照首帧（活数组组合根分配——装载窗口内后续插件工具经组合根
  // tools_change 订阅原位刷新，件只填首帧 fs 族）
  deps.toolView.length = 0;
  deps.toolView.push(...deps.tools.list().map((def) => deps.tools.toAgentTool(def)));
  const fresh = new ConversationDriverClass({
    context: {
      // getter 活视图：/reload 重建后 loop 每次模型请求取到新提示词
      get systemPrompt() {
        return deps.getSystemPrompt();
      },
      messages,
      tools: deps.toolView,
    },
    loopConfig: {
      streamFn: deps.streamFn,
      model: deps.model,
      convertToLlm: deps.convertToLlm,
      // context_transform 桥（契约篇 §2.2 增补 5②）：loop 私有配置回调桥为
      // 总线瀑布——桥经根 ctx（deps.transformContext），/reload 后监听集即新集
      transformContext: (batch) => deps.transformContext(batch),
    },
    durable: deps.durableForward,
    writeHeader,
  });
  setDriver(fresh);
  deps.driverRef.current = fresh;
  // 件控制面（组合根 /new 编排与装配接线消费；resetTimeline 委派驱动）
  deps.chatRef.current = {
    writeHeader,
    resetHeaderState: () => {
      headerState.last = undefined;
      headerState.next = 'initial';
    },
    resetTimeline: () => fresh.resetTimeline(),
  };

  /* ---- ④ ctx.agent 具名服务 provide（与驱动同件同生命周期） ---- */
  provideAgentService(ctx, fresh);
}

/**
 * provide ctx.agent（apply 每次执行——/reload 销锚即随件回卷，重装载重建）：
 * face 与订阅表为 per-apply 新造，onRunSettled 总派发器挂 ctx.effect 随锚
 * 注销（旧 apply 的派发器在锚 dispose 时退订，不泄漏不重复派发）。已持旧
 * face 引用的消费方不受回卷影响——face 闭包持有驱动单例，续跑注入持续可用。
 */
function provideAgentService(ctx: PluginContext, driver: ConversationDriver): void {
  /** onRunSettled 订阅表（派发快照遍历——派发中注销/新订不炸迭代） */
  const subscribers = new Set<(settled: RunSettled) => void>();
  /** 单订阅者派发壳（违约隔离：抛错 logger 吞掉，不断结算链） */
  const dispatch = (settled: RunSettled): void => {
    for (const cb of [...subscribers]) {
      try {
        cb(settled);
      } catch (err) {
        ctx.logger.error('agent.onRunSettled 订阅者违约（已隔离）', { error: describeError(err) });
      }
    }
  };
  const face: AgentServiceFace = {
    sendUserMessage(content, opts = {}) {
      // 预留位执法：定向投递不做半实现（缺省自适应即现行业务所需）
      if (opts.deliverAs !== undefined) {
        throw new AppError(
          AGENT_DELIVER_AS_UNSUPPORTED,
          `sendUserMessage 不支持显式 deliverAs=${opts.deliverAs}（三通道自适应缺省即现行业务所需；定向投递为 M2+ 预留位）`,
        );
      }
      const message: UserMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
      };
      driver.deliver(message, {
        backgroundWake: opts.backgroundWake === true,
        toolFilter: opts.toolFilter,
      });
    },
    onRunSettled(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
  ctx.provide('agent', face);
  // 驱动侧挂总派发器（effect 随件锚回卷——/reload 重装载后旧派发器退订）
  ctx.effect(() => driver.onRunSettled(dispatch));
}
