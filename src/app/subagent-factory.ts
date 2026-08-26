/**
 * L5 app — in-process 子代理真工厂（骨架篇 §6.1 纵切四落码注记，subagent 纵切四）。
 *
 * 组合根闭包零件：`createSubagentChildFactory(deps)` 把装配层的活资源（streamFn/
 * model/活会话引用/persistence/父沙箱档位/根总线）闭包进 `InProcessChildFactory`。
 * 每子装配序（dsh-10 隔离纪律）：独立 createContext（**fresh 不 fork 根**——共享
 * 注册表的 fork 会把子 provide 写穿到根）→ 子工具管道 + 工具面派生（父注册表
 * 可见面滤排除集 + 自建 fs 族，toolFilter include 过滤）→ 审批 never + 守门行（父
 * 档**快照**——§6.5 委托时点常量闭包）→ forkSession(origin:'delegation')（无父/
 * 无持久层降级内存 Session）→ 根总线发 session_start → startRun 一次性驱动 →
 * dispose = 纵切三序列（shutdown 转发根总线）。
 */

import { createContext } from '../context/context.js';
import { runInSessionChain } from '../context/chain.js';
import type { AgentMessage } from '../contracts/messages.js';
import { startRun } from '../agent/loop.js';
import type { RunResult } from '../agent/loop.js';
import type { AssistantMessage, Message, StreamFn } from '../contracts/llm.js';
import { createDurableSinks } from '../chat/index.js';
import { createChildSessionDisposer, type FlushBarrier } from './subagent-child.js';
import type { InProcessChild, InProcessChildFactory } from '../subagent/inprocess.js';
import { Session, lastClosedTurnBoundary } from '../session/index.js';
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
  /** 父会话活引用（/new 换指后读到新会话——委派即 fork 当前会话） */
  readonly getSession: () => Session | undefined;
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
  /** 根总线（session_start/session_shutdown 的 keyed 通知面——插件在根作用域） */
  readonly rootCtx: ContextScope;
}

/** 子代理缺省系统提示词（静态——persona 请求位未携带时兜底） */
const DEFAULT_CHILD_PROMPT = [
  '你是被委派的子代理：接收一条任务指令，用可用工具完成任务，最后用一条完整的文本消息汇报结果。',
  '你的汇报文本会被原样交回委派方——把结论写在最后那条消息里，不要省略关键细节。',
].join('\n');

/** 子装配派生排除集（S2 契约篇 §5.4 第 6 条）：read/write/edit/ls 的 execute
 *  闭包绑**父驱动观察态**（fs 观察态 per-driver 语义——子必须自建零观察起步）；
 *  bash 的闭包绑父侧审批服务（子审批 never 的确定性拒绝会被父交互审批绕过，
 *  拍板 #17 排除）。名单外的全局层 def（find/grep、memory 五件、fetch 等）无
 *  会话状态（dsh-10 边界三判①），原样复用。 */
const CHILD_TOOL_EXCLUSION = new Set(['read', 'write', 'edit', 'ls', 'bash']);

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
    const parent = deps.getSession();
    const session =
      parent !== undefined && deps.persistence !== undefined
        ? deps.persistence.forkSession(parent, {
            origin: 'delegation',
            boundary: lastClosedTurnBoundary(parent.events),
          })
        : new Session({ origin: 'delegation', delegationDepth: 1 });

    /* ---- ③ durable 接线（子会话事件日志——与主装配同款映射）---- */
    const sinks = createDurableSinks(session);

    /* ---- ④ 子工具面 = 派生 + 自建 fs（S2 契约篇 §5.4 第 6 条子装配派生）----
     * 派生腿：父注册表取「父可见面」——父会话在场 = listFor(父会话)（全局层 ∪
     * 父域；父域里的 fs 四名被排除集滤掉），无父会话（persist:false 诊断形态）
     * = list() 全局层同口径——滤排除集五名得 derived defs。复用 def 经**子**
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
    const derivedFace = parent !== undefined ? parentTools.listFor(parent.header.sessionId) : parentTools.list();
    const derived = derivedFace.filter((def) => !CHILD_TOOL_EXCLUSION.has(def.name));
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

    /* ---- ⑥ delegation fork 上总线：session_start（插件 keyed 初始化子会话态——
     * 与 durable session/event 镜像同总线，载荷 sessionId 即归属键）---- */
    deps.rootCtx.emit('session_start', { sessionId: session.header.sessionId, origin: 'delegation' });

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
            messages: [],
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

    /* ---- ⑧ dispose 序列（纵切三 helper）：flush 屏障 → shutdown（根总线 keyed）→ 回卷 ---- */
    const disposer = createChildSessionDisposer({
      persistence: deps.persistence ?? NOOP_BARRIER,
      sessionId: session.header.sessionId,
      // 转发体：session_shutdown 发根总线（插件在根——与 ⑥ 对称），dispose 落子本尊
      childCtx: {
        emit: (event: 'session_shutdown', data: { sessionId: string }) => deps.rootCtx.emit(event, data),
        dispose: () => childCtx.dispose(),
      },
    });

    const child: InProcessChild = { session, run, dispose: disposer };
    return child;
  };
}
