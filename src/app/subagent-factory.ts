/**
 * L5 app — in-process 子代理真工厂（骨架篇 §6.1 纵切四落码注记，subagent 纵切四）。
 *
 * 组合根闭包零件：`createSubagentChildFactory(deps)` 把装配层的活资源（streamFn/
 * model/活会话引用/persistence/父沙箱档位/根总线）闭包进 `InProcessChildFactory`。
 * 每子装配序（dsh-10 隔离纪律）：独立 createContext（**fresh 不 fork 根**——共享
 * 注册表的 fork 会把子 provide 写穿到根）→ 子工具管道 + 工具面派生（域键升级批：
 * 父注册表应用域视角 listFor(父 app)——驱动层内容结构上不在面，排除集随三层
 * 解缠退役；自建 fs 族，toolFilter include 过滤）→ 审批 never + 守门行（父
 * 档**快照**——§6.5 委托时点常量闭包）+ **守门行传导**（第三十一批 P1-4：
 * 根总线应用行 pre+post 两段委托时点快照 append 进子链——owner 前缀 + main
 * 行集判据、固定行/worker 行排除）→ forkSession(origin:'delegation')（无父/
 * 无持久层降级内存 Session）→ 根总线发 session_start → startRun 一次性驱动
 * （context 腿：请求携带 context 时父闭合边界投影尾 N 轮作消息种子）→
 * dispose = 纵切三序列（shutdown 转发根总线）。
 */

import { createContext, snapshotHandlers, appendHandlers } from '../context/context.js';
import { runInSessionChain } from '../context/chain.js';
import type { AgentMessage } from '../contracts/messages.js';
import { TOOL_POST_EXECUTE_EVENT, TOOL_PRE_EXECUTE_EVENT } from '../contracts/tools.js';
import { startRun } from '../agent/loop.js';
import type { RunResult } from '../agent/loop.js';
import type { AssistantMessage, Message, StreamFn } from '../contracts/llm.js';
import { createDurableSinks, projectedToAgentMessages } from '../chat/index.js';
import { createChildSessionDisposer, type FlushBarrier } from './subagent-child.js';
import type { InProcessChild, InProcessChildFactory } from '../subagent/inprocess.js';
import { Session, lastClosedTurnBoundary, deriveMessages } from '../session/index.js';
import type { ProjectedMessage } from '../session/index.js';
import type { Persistence } from '../persist/index.js';
import type { SandboxMode } from '../safety/index.js';
import { createApprovalService } from '../safety/approval.js';
import { installSafetyGate } from '../safety/gate.js';
import { createRootsProvider } from '../safety/index.js';
import { createToolPipeline } from '../tools/index.js';
import type { ToolPipelineExecutor } from '../tools/index.js';
import { registerToolsService } from '../tools/registry.js';
import type { ToolsService } from '../tools/registry.js';
import { createFsTools } from '../tools/fs.js';
import type { ContextScope } from '../context/types.js';

/** 真工厂依赖（组合根活闭包——全部随装配层状态活取值） */
export interface SubagentFactoryDeps {
  /** 持久层（forkSession + 定向 flush 屏障）；persist:false 诊断面 undefined */
  readonly persistence?: Persistence;
  /** 父驱动活取值（域键升级批：session 与 appId 原子同取——见 SubagentParent；
   *  /new 换指后读到新驱动——委派即 fork 当前会话；persist:false 诊断面 undefined） */
  readonly getParent: () => SubagentParent | undefined;
  /** 子模型流（与父驱动同源 streamFn——同凭证同 provider 层） */
  readonly streamFn: StreamFn;
  /** 子模型标识（llm/usage 折叠 model 腿同源） */
  readonly model: string;
  /** AgentMessage → LLM Message 转换器（与父驱动同款） */
  readonly convertToLlm: (messages: AgentMessage[]) => Message[];
  /** 工作区根（子 fs 工具可写域锚） */
  readonly workspace: string;
  /** 父沙箱档位（§6.5 快照语义：委托时点的父档，子装配内常量） */
  readonly sandboxMode: SandboxMode;
  /** 根总线（session_start/session_shutdown 的 keyed 通知面——应用在根作用域；
   *  亦为守门行传导的快照源） */
  readonly rootCtx: ContextScope;
  /**
   * 守门行传导判据（2026-08-27 第三十一批 P1-4——骨架篇 §6.1「守门行传导 +
   * context 腿」条）：`anchors` = 应用装载锚的 owner **完整前缀集**（`'app:apps:'`
   * 形——装配层从 fork 起名处构造，静态两锚）；`mainRows` = main 应用行 id 集
   * **活取**（每次委派取一次 = 委托时点快照；worker 行排除——桥转发器是 emit
   * 签名形态，进 waterfall 不调 next 即吞链）。固定行（owner = 根名）无锚前缀
   * 结构性排除——子代理审批 never 无人值守语义不被根面交互审批冒破。
   */
  readonly gateRowFilter: {
    readonly anchors: readonly string[];
    readonly mainRows: () => ReadonlySet<string>;
  };
}

/** context 腿尾轮装配帽（骨架篇 §6.1：N = min(请求值, 装配缺省帽 20 轮)） */
const CONTEXT_TURN_CAP = 20;

/**
 * 投影裁尾 N 轮（context 腿——user 消息边界裁切）：从尾向前找第 N 个 user
 * 投影，从它起取；user 边界数不足 N 时全量（不足即全给，无中间截断歧义）。
 *
 * @param projected 闭合边界内的父会话投影
 * @param turns     请求轮数（调用方已过 min 帽）
 */
function tailTurns(projected: readonly ProjectedMessage[], turns: number): ProjectedMessage[] {
  let seen = 0;
  for (let i = projected.length - 1; i >= 0; i -= 1) {
    if (projected[i]!.type === 'user') {
      seen += 1;
      if (seen >= turns) return projected.slice(i);
    }
  }
  return [...projected];
}

/** 子代理缺省系统提示词（静态——persona 请求位未携带时兜底） */
const DEFAULT_CHILD_PROMPT = [
  '你是被委派的子代理：接收一条任务指令，用可用工具完成任务，最后用一条完整的文本消息汇报结果。',
  '你的汇报文本会被原样交回委派方——把结论写在最后那条消息里，不要省略关键细节。',
].join('\n');

/** 父驱动活取值形状（域键升级批：session 与 appId 单次路由原子取——派生腿
 *  `listFor(父 app)` 需要应用域键，fork 源需要会话；两值同源防两次 routed()
 *  调用间聚焦漂移的读撕裂） */
export interface SubagentParent {
  /** 父会话活引用（fork 源——委派即 fork 当前会话） */
  readonly session: Session;
  /** 父会话所属应用域键（子装配派生面 = listFor(本键)） */
  readonly appId: string;
}

/** 无持久层的 no-op flush 屏障（诊断面子会话仅内存——序列形状保持三步） */
const NOOP_BARRIER: FlushBarrier = {
  async flush() {
    /* 内存会话无批量窗口——屏障恒已达成 */
  },
};

/**
 * 创建真工厂（每子独立装配）。
 *
 * @param deps 组合根活闭包依赖
 * @returns InProcessChildFactory（交 createInProcessProvider——provider 只见抽象面）
 */
export function createSubagentChildFactory(deps: SubagentFactoryDeps): InProcessChildFactory {
  return ({ request, signal, onUsage }) => {
    /* ---- ① 子作用域：fresh createContext（不 fork 根——dsh-10 写穿防线） ---- */
    const childCtx = createContext({ name: `subagent-child` });

    /* ---- ② 子会话：fork origin='delegation'（深度自动 +1；种子 = 父前缀含 sandbox 快照）----
     * 边界 = 最后闭合 turn 边界（会话篇 §5 delegation 缺省）：委派发生在父 turn
     * 敞开时（agent 工具在 turn 内执行），敞开段事件未定性不进种子。
     * 无父会话（persist:false）或无持久层：降级内存 Session（诊断面子代理仍可跑，
     * delegationDepth=1 语义 = 深度为 0 的虚拟父委出一层） */
    const parent = deps.getParent();
    // 闭合边界单点（fork 种子与 context 腿投影**同源**——第三十一批冷读 #3 修死：
    // 委派发生在父 turn 敞开时，敞开段未定性不进种子也不进模型可见面，
    // 「模型可见 ⊆ durable 种子」不变式保持）
    const closedBoundary = parent !== undefined ? lastClosedTurnBoundary(parent.session.events) : 0;
    const session =
      parent !== undefined && deps.persistence !== undefined
        ? deps.persistence.forkSession(parent.session, {
            origin: 'delegation',
            boundary: closedBoundary,
          })
        : new Session({ origin: 'delegation', delegationDepth: 1 });

    /* ---- ③ durable 接线（子会话事件日志——与主装配同款映射）---- */
    const sinks = createDurableSinks(session);

    /* ---- ④ 子工具面 = 派生 + 自建 fs（契约篇 §5.4 域键升级批·排除集结构化退役）----
     * 派生腿：父注册表取「父应用域视角」——父驱动在场 = listFor(父会话所属 app)
     * （全局层 ∪ 应用域[父 app]；驱动层内容〔fs 四名 + bash〕结构上不在本面——
     * 「−内核固定词五名」排除集随三层解缠退役，拍板 #17 从减法维护变结构默认：
     * bash 住驱动层、子代理无驱动层）。无父（persist:false 诊断形态）= list()
     * 全局层同口径——全局层本就不含驱动层内容，两路径语义同构。复用 def 经**子**
     * 注册表 toAgentTool 重绑子管道（三段守门走子档：审批 never + 父档快照），
     * 父注册表零写穿（childCtx fresh 注册表——派生只是 def 复制）。
     * 自建腿：createFsTools 零观察起步（子装配新语界，与父观察态互不可见）。
     * toolFilter include 名单对全集过滤（§6.3 声明即执法，不装再拦）。 */
    const pipeline: ToolPipelineExecutor = createToolPipeline(childCtx, { onGateDecision: sinks.gate });
    const tools: ToolsService = registerToolsService(childCtx, { pipeline });
    // 可写根走 safety 档位推导（与主装配同源；父档闭包快照见 ⑤ 注记）
    const writableRoots = createRootsProvider({ workspace: deps.workspace, mode: () => deps.sandboxMode });
    const fsTools = createFsTools({ writableRoots, workspace: () => deps.workspace });
    // 父注册表经根 ctx 取（delegate 工具执行时 Ring 1 tools 行必在场——boot 必备行）
    const parentTools = deps.rootCtx.get<ToolsService>('tools');
    const derived = parent !== undefined ? parentTools.listFor(parent.appId) : parentTools.list();
    const allTools = [...derived, ...fsTools.tools];
    const selected =
      request.toolFilter !== undefined ? allTools.filter((def) => request.toolFilter!.includes(def.name)) : allTools;
    for (const def of selected) tools.register(def);

    /* ---- ⑤ 审批 never + 守门行（子代理无人值守：升权确定性拒绝；档位 = 父快照常量）---- */
    const approval = createApprovalService(childCtx, { policy: 'never', sink: sinks.approval });
    childCtx.effect(() =>
      installSafetyGate(childCtx, {
        approval,
        workspace: deps.workspace,
        // 快照语义（§6.5）：委托时点的父档位闭包冻结——父档后续变化不传导已出膛的子
        mode: () => deps.sandboxMode,
      }),
    );

    /* ---- ⑤b 守门行传导（第三十一批 P1-4：委托时点快照传导——骨架篇 §6.1
     * 「守门行传导 + context 腿」条）----
     * 根总线应用行 pre+post 两段 append 进子链（子固定行之后、按根链注册序）——
     * 挖矿 B10「固定行进得了子管道、开放行进不去」的不对称收口。判据 = owner
     * 完整前缀 ∈ 锚集 + 行 id ∈ main 集（worker 行排除；固定行 owner = 根名
     * 结构性排除——子审批 never 不被根面交互审批冒破）。传导的是 handler 引用
     * 非重注册：闭包仍捕根作用域（读根服务行为正确）、owner 保真
     * （appendHandlers 直写不走 on()——on() 会把 owner 记成子作用域名）、
     * 子 dispose 不回卷根行。委托时点冻结：此后根链变化（/reload 等）不影响
     * 本子，新委派取新链。execute 段不传导（拍板题 2——替换执行体风险大）。 */
    {
      const { anchors, mainRows } = deps.gateRowFilter;
      for (const event of [TOOL_PRE_EXECUTE_EVENT, TOOL_POST_EXECUTE_EVENT] as const) {
        const entries = snapshotHandlers(deps.rootCtx, event).filter((entry) => {
          const anchor = anchors.find((prefix) => entry.owner.startsWith(prefix));
          return anchor !== undefined && mainRows().has(entry.owner.slice(anchor.length));
        });
        if (entries.length > 0) appendHandlers(childCtx, event, entries);
      }
    }

    /* ---- ⑥ delegation fork 上总线：session_start（应用 keyed 初始化子会话态——
     * 与 durable session/event 镜像同总线，载荷 sessionId 即归属键）---- */
    deps.rootCtx.emit('session_start', { sessionId: session.header.sessionId, origin: 'delegation' });

    /* context 腿（第三十一批）：请求携带 context 时，②同源闭合边界之内的父投影
     * 裁尾 N 轮（user 消息边界，min 请求值/装配帽 20）经 projectedToAgentMessages
     * 作子首请求 LLM 消息种子——durable 有上文、模型看见的豁口收口。子会话日志
     * 不双写父前缀（fork 种子已落）。缺省不携带；无父（persist:false 诊断面）
     * 降级空种子（诊断面本无上下文可带）。 */
    const seedMessages: AgentMessage[] =
      request.context !== undefined && parent !== undefined
        ? projectedToAgentMessages(
            tailTurns(
              deriveMessages(parent.session.events.slice(0, closedBoundary)),
              Math.min(request.context.recentTurns, CONTEXT_TURN_CAP),
            ),
          )
        : [];

    /* ---- ⑦ 一次性驱动（persona ?? 静态缺省；model 覆盖 = 声明式 agent frontmatter；
           emit 两路 = durable 落账 + usage 上报）----
     * 链写点③（S5 冷读闸 F3，骨架篇 §9.3）：startRun 边界包裹子会话——无此包裹
     * 则子内工具执行继承委派工具所在父 run 的链，子内 goal 落账/审批归属全数错挂
     * 父账。background 缺省 false（开起批是委派 prompt 非 backgroundWake 词汇；
     * 子代理审批 never 不派发，此列对子装配自身无消费面——服务的是「子链内
     * 经全局绑定面回读」的归因正确性）。 */
    const run = (): Promise<RunResult> =>
      runInSessionChain({ sessionId: session.header.sessionId }, () =>
        startRun(
          [{ role: 'user', content: request.prompt, timestamp: Date.now() }],
          {
            systemPrompt: request.persona ?? DEFAULT_CHILD_PROMPT,
            messages: seedMessages,
            tools: tools.list().map((def) => tools.toAgentTool(def)),
          },
          { streamFn: deps.streamFn, model: request.model ?? deps.model, convertToLlm: deps.convertToLlm },
          {
            signal,
            emit: (event) => {
              sinks.handle(event);
              // assistant 消息结算即上报用量（provider 预算帽唯一数据源——纵切二同款）
              if (event.type === 'message_end' && event.message.role === 'assistant') {
                const usage = (event.message as AssistantMessage).usage;
                if (usage) onUsage(usage);
              }
            },
          },
        ),
      );

    /* ---- ⑧ dispose 序列（纵切三 helper）：flush 屏障 → shutdown（根总线 keyed，parallel bounded）→ 回卷 ---- */
    const disposer = createChildSessionDisposer({
      persistence: deps.persistence ?? NOOP_BARRIER,
      sessionId: session.header.sessionId,
      // 转发体：session_shutdown 派发/日志转发根总线（应用在根——与 ⑥ 对称；目录
      // mode=parallel，bounded 等待住 child disposer 内公共件——二十九批增补 8②），
      // dispose 落子本尊
      childCtx: {
        parallel: (event, data) => deps.rootCtx.parallel(event, data),
        logger: deps.rootCtx.logger,
        dispose: () => childCtx.dispose(),
      },
    });

    const child: InProcessChild = { session, run, dispose: disposer };
    return child;
  };
}
