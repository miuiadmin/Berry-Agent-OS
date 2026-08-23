/**
 * subagent 模块 — ctx.subagents 服务实现（骨架篇 §6.1 落码注记，2026-08-24 纵切二）。
 *
 * 服务面统一持有两件事（provider 只见已协商的 SubagentStart）：
 * 1. **能力协商布尔检查**（start 前 fail-loud——请求携带 outputSchema/maxDepth/
 *    toolFilter/persona 任一而 provider 未声明对应能力 → SUBAGENT_CAPABILITY_UNSUPPORTED，
 *    不做运行时协商【dsh】）；
 * 2. **background 模式 Job 接线**（§6.2 一次性两形态）：background:true →
 *    ctx.jobs.create(kind='subagent') 立即返回 job 句柄；stopReason → Job 终态映射
 *    在此唯一持有（completed→completed / aborted→killed / error·max-tokens·refusal
 *    及其余→failed）；Job cancel signal 接 provider dispose——cancel 即子收工。
 */
import {
  AppError,
  SUBAGENT_CAPABILITY_UNSUPPORTED,
  SUBAGENT_PROVIDER_DUPLICATE,
  SUBAGENT_PROVIDER_NOT_FOUND,
} from '../contracts/errors.js';
import type {
  SubagentProvider,
  SubagentProviderInfo,
  SubagentRequest,
  SubagentRun,
  SubagentStart,
  SubagentStopReason,
  SubagentsServiceFace,
} from '../contracts/subagent.js';
import type { JobTerminal, JobsServiceFace } from '../contracts/jobs.js';
import type { ContextScope, Disposer } from '../context/types.js';

/** stopReason → Job 终态映射（§6.2 落码注记钉死：aborted→killed、error/其余失败→failed） */
function stopReasonToJobTerminal(stopReason: SubagentStopReason): JobTerminal {
  if (stopReason === 'completed') return 'completed';
  if (stopReason === 'aborted') return 'killed';
  return 'failed'; // error / max-tokens / refusal 及扩展词汇一律失败族
}

/** 请求面四能力位 → 能力声明键（协商检查的映射表：请求带字段 ⇔ provider 声明布尔） */
const CAPABILITY_KEYS: readonly {
  readonly requestField: keyof SubagentStart & keyof SubagentRequest;
  readonly capability: keyof SubagentProvider['capabilities'];
}[] = [
  { requestField: 'outputSchema', capability: 'outputSchema' },
  { requestField: 'maxDepth', capability: 'depthLimit' },
  { requestField: 'toolFilter', capability: 'toolFilter' },
  { requestField: 'persona', capability: 'persona' },
];

/**
 * 创建 ctx.subagents 具名服务（组合根 provide('subagents') 所注对象）。
 *
 * @param scope 根作用域（服务注销挂点）
 * @param opts.jobs Job 注册表（background 模式用——装配 ④c 先提供，此处显式传入
 *   免服务定位器间接层）
 */
export function createSubagentsService(scope: ContextScope, opts: { jobs: JobsServiceFace }): SubagentsServiceFace {
  const logger = scope.logger;
  /** 已注册 provider 表（注册序保持——list 披露面稳定） */
  const providers = new Map<string, SubagentProvider>();

  const service: SubagentsServiceFace = {
    register(provider: SubagentProvider): Disposer {
      if (providers.has(provider.name)) {
        throw new AppError(
          SUBAGENT_PROVIDER_DUPLICATE,
          `子代理 provider 重复注册：${provider.name}（词汇表拒绝静默覆盖）`,
        );
      }
      providers.set(provider.name, provider);
      logger.debug('subagent provider 注册', { name: provider.name });
      return () => {
        // 幂等注销：仅当仍是本实现时删除（防误撤他者后来的同位注册）
        if (providers.get(provider.name) === provider) providers.delete(provider.name);
      };
    },

    list(): readonly SubagentProviderInfo[] {
      return [...providers.values()].map((provider) => ({ name: provider.name, capabilities: provider.capabilities }));
    },

    start(request: SubagentRequest): SubagentRun {
      const provider = providers.get(request.provider);
      if (provider === undefined) {
        throw new AppError(
          SUBAGENT_PROVIDER_NOT_FOUND,
          `子代理 provider 未注册：${request.provider}（已注册：${[...providers.keys()].join(', ') || '（无）'}）`,
        );
      }
      // 能力协商布尔检查（start 前 fail-loud——不做运行时协商【dsh】）：
      // 请求面任一能力位有值 ⇔ provider 须声明对应能力
      for (const { requestField, capability } of CAPABILITY_KEYS) {
        if (request[requestField] !== undefined && !provider.capabilities[capability]) {
          throw new AppError(
            SUBAGENT_CAPABILITY_UNSUPPORTED,
            `provider ${request.provider} 未声明能力 ${capability}，请求携带 ${requestField} 即拒（启动时布尔检查，不做运行时协商）`,
          );
        }
      }
      // 剥离路由/形态字段——provider 只见 SubagentStart
      const { provider: _name, background, ...start } = request;
      const execution = provider.start(start);

      if (!background) {
        return { ...execution, provider: provider.name };
      }

      /* ---- background 接线（§6.2：注册进 Job 注册表并立即返回 jobId）----
       * 服务面 = Job executor：子结算（或异常兜底）落 Job 终态；
       * Job cancel → abort signal 接 execution.dispose（cancel 即子收工）。 */
      const { handle, signal, settle } = opts.jobs.create({
        kind: 'subagent',
        ...(request.ownerSessionId !== undefined ? { ownerSessionId: request.ownerSessionId } : {}),
        ...(request.label !== undefined ? { label: request.label } : {}),
      });
      if (signal.aborted)
        execution.dispose(); // 极端窗口：create 前已有人 cancel（Job 建即 stopping）
      else signal.addEventListener('abort', () => execution.dispose(), { once: true });
      // 结算路：SubagentResult → Job 终态（映射唯一持有处）；异常兜底 failed
      void execution.result.then(
        (result) => {
          settle(stopReasonToJobTerminal(result.stopReason), {
            ...(result.stopReason === 'completed'
              ? { output: result.output }
              : // 失败族 error 段载 diagnostic（缺省落 stopReason 本身）
                { error: result.diagnostic ?? String(result.stopReason) }),
          });
        },
        (err) => {
          // 防御路：execution.result 契约永不 reject，此处只兜 provider 违约
          settle('failed', { error: err instanceof Error ? err.message : String(err) });
        },
      );
      const run: SubagentRun = { ...execution, provider: provider.name, job: handle };
      return run;
    },
  };

  return service;
}
