/**
 * subagent 模块 — in-process provider（骨架篇 §6.1「每子独立装配 dsh-10」+ 纵切二落码注记）。
 *
 * 子会话 = 同进程新 loop 实例。**装配本体在工厂回调**（app/官方件闭包注入——本模块
 * 不反向依赖组合根，只依赖 agent 公开的 RunResult 型）：工厂内 createContext + 工具
 * 管道 + 守门 + 审批 never + persistence.forkSession(origin:'delegation') + startRun。
 * 硬规则：禁止子代理共享根 ctx 管道后靠调用期识别 caller——per-child 隔离装配解决。
 *
 * provider 自持三职：
 * 1. **token 预算帽**（pi-5：v1 有帽）：onUsage 计数（工厂接进子 loop 的 message_end
 *    观测），触帽即 abort 取消控制器（与 dispose/cancel 同一信号源），结算映射点改判
 *    stopReason='max-tokens'（裸 loop 无此终态——§6.1 枚举映射注）；
 * 2. **深度执法**（§6.5 单调下界）：fork 后读子 header.delegationDepth，超
 *    min(request.maxDepth, 装配默认帽) 即 SUBAGENT_DEPTH_EXCEEDED，子装配即刻销毁；
 * 3. **结算映射**：RunResult → SubagentResult（output = 最后一条非空 assistant 文本；
 *    failed → error；aborted 且触帽 → max-tokens）。
 */
import { AppError, SUBAGENT_DEPTH_EXCEEDED, describeError } from '../contracts/errors.js';
import type { AssistantMessage, Usage } from '../contracts/llm.js';
import type {
  SubagentExecution,
  SubagentProvider,
  SubagentResult,
  SubagentStart,
  SubagentStopReason,
} from '../contracts/subagent.js';
import type { RunResult } from '../agent/loop.js';
import type { Session } from '../session/session.js';

/** 工厂入参：任务 + 取消信号 + 用量上报（provider 侧计数执帽的唯一数据源） */
export interface InProcessChildFactoryOptions {
  /** 已过能力协商的任务请求（prompt/persona/toolFilter/maxDepth 等） */
  readonly request: SubagentStart;
  /** 取消信号（dispose/cancel/预算帽触顶共此一源——子只认一个信号） */
  readonly signal: AbortSignal;
  /** 子 llm 调用用量上报（工厂接进子 loop message_end 观测——assistant 消息 usage 面） */
  readonly onUsage: (usage: Usage) => void;
}

/** 工厂产物：provider 只见的抽象面（session 供深度执法/结算折叠；run 一次性） */
export interface InProcessChild {
  /** 子会话（fork origin='delegation'——header.delegationDepth 已 +1） */
  readonly session: Session;
  /** 一次性驱动子 loop（provider 恰调一次；返回后子装配可释放） */
  run(): Promise<RunResult>;
  /** 释放子装配（幂等；§6.2 dispose 序列的工厂半边——flush/shutdown 编排在纵切三落） */
  dispose(): Promise<void> | void;
}

/** 每子装配工厂（app/官方件闭包注入——subagent 模块不反向依赖组合根） */
export type InProcessChildFactory = (opts: InProcessChildFactoryOptions) => InProcessChild;

/** provider 组装选项 */
export interface InProcessProviderOptions {
  /** 每子独立装配工厂（必备） */
  readonly factory: InProcessChildFactory;
  /** token 预算帽（子累计 totalTokens 触帽即 abort 改判 max-tokens；缺省 100_000） */
  readonly tokenBudget?: number;
  /** 委派深度默认帽（与请求 maxDepth 取 min 执法；缺省 3） */
  readonly maxDepth?: number;
}

/** 空用量基线（onUsage 从未上报时结算省略 usage 段——外部报不上则省的同形） */
const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};

/** 用量累加（字段级求和；可选段有则累、无则保持缺省） */
function addUsage(acc: Usage, delta: Usage): Usage {
  return {
    input: acc.input + delta.input,
    output: acc.output + delta.output,
    cacheRead: acc.cacheRead + delta.cacheRead,
    cacheWrite: acc.cacheWrite + delta.cacheWrite,
    ...(acc.cacheWrite1h !== undefined || delta.cacheWrite1h !== undefined
      ? { cacheWrite1h: (acc.cacheWrite1h ?? 0) + (delta.cacheWrite1h ?? 0) }
      : {}),
    ...(acc.reasoning !== undefined || delta.reasoning !== undefined
      ? { reasoning: (acc.reasoning ?? 0) + (delta.reasoning ?? 0) }
      : {}),
    totalTokens: acc.totalTokens + delta.totalTokens,
  };
}

/** 最后一条非空 assistant 文本（§6.1 结算契约 output 定义；无则空串） */
function lastAssistantText(result: RunResult): string {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i]!;
    // AgentMessage 联合含 CustomMessage（role: string），role 判别不收窄——显式收形
    if (message.role !== 'assistant') continue;
    const assistant = message as AssistantMessage;
    const text = assistant.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { text: string }).text)
      .join('');
    if (text.trim() !== '') return text;
  }
  return '';
}

/**
 * 创建 in-process provider（v1 能力面：depthLimit/toolFilter/persona 声明支持，
 * outputSchema 不声明——pi-ai 无结构化输出腿，LLM_COMPLETE_SCHEMA_UNSUPPORTED 同源事实）。
 */
export function createInProcessProvider(opts: InProcessProviderOptions): SubagentProvider {
  const tokenBudget = opts.tokenBudget ?? 100_000;
  const defaultMaxDepth = opts.maxDepth ?? 3;

  const provider: SubagentProvider = {
    name: 'in-process',
    capabilities: { outputSchema: false, depthLimit: true, toolFilter: true, persona: true },

    start(request: SubagentStart): SubagentExecution {
      // 取消单源：dispose / Job cancel / 预算帽触顶都只 abort 这一个控制器
      const controller = new AbortController();
      /** 累计用量（EMPTY 基线起步；从未上报则结算省略 usage） */
      let usage: Usage | undefined;
      /** 预算帽触顶标记（结算映射点改判 max-tokens 的依据） */
      let capTripped = false;
      const onUsage = (delta: Usage): void => {
        usage = usage === undefined ? { ...delta } : addUsage(usage, delta);
        if (!capTripped && usage.totalTokens >= tokenBudget) {
          capTripped = true;
          controller.abort(); // 触帽即 abort（pi-5：无帽子代理让预算体系形同虚设）
        }
      };

      // 每子独立装配（dsh-10）：工厂闭包持父 Session/persistence/管道零件
      const child = opts.factory({ request, signal: controller.signal, onUsage });

      // 深度执法（§6.5）：fork 后子 header 已带单调深度——超帽即毁，不留半活子
      const effectiveMaxDepth = Math.min(request.maxDepth ?? Number.POSITIVE_INFINITY, defaultMaxDepth);
      if (child.session.header.delegationDepth > effectiveMaxDepth) {
        void Promise.resolve(child.dispose()).catch(() => undefined); // 销毁失败不掩拒因（日志面归工厂）
        throw new AppError(
          SUBAGENT_DEPTH_EXCEEDED,
          `委派深度超帽：子 delegationDepth=${child.session.header.delegationDepth} > 上限 ${effectiveMaxDepth}（§6.5 单调下界执法，子装配已销毁）`,
        );
      }

      // 一次性驱动 + 结算映射（async 体兜同步抛——result 永不 reject）
      const result: Promise<SubagentResult> = (async () => {
        let runResult: RunResult;
        try {
          runResult = await child.run();
        } catch (err) {
          return { output: '', diagnostic: describeError(err), stopReason: 'error' };
        }
        const stopReason: SubagentStopReason =
          runResult.status === 'completed'
            ? 'completed'
            : runResult.status === 'aborted'
              ? // 触帽的 abort 改判 max-tokens（裸 loop 无此终态——枚举映射注）
                capTripped
                ? 'max-tokens'
                : 'aborted'
              : 'error';
        return {
          output: lastAssistantText(runResult),
          ...(runResult.errorMessage !== undefined || capTripped
            ? {
                // 触帽时帽文案优先（它解释 aborted→max-tokens 改判的因果；loop 的
                // errorMessage 只是通用取消语——次序颠倒会让 max-tokens 带着「取消」谜面）
                diagnostic: capTripped
                  ? `token 预算帽触顶（累计 ${usage?.totalTokens ?? 0} ≥ ${tokenBudget}）`
                  : runResult.errorMessage,
              }
            : {}),
          ...(usage !== undefined ? { usage } : {}),
          stopReason,
        };
      })();

      // dispose 幂等：abort 请求 → run 结算后释放子装配（finally 恰一次语义由 disposed 标记保证）
      let disposed = false;
      const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        controller.abort();
        void result
          .then(
            () => child.dispose(),
            () => child.dispose(),
          )
          .catch(() => undefined); // 工厂半边的释放异常不掩结算（纵切三补完整序列的日志面）
      };

      return { id: child.session.header.sessionId, result, dispose };
    },
  };

  return provider;
}
