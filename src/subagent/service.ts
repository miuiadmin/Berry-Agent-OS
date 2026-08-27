/**
 * subagent 模块 — ctx.subagents 服务实现（骨架篇 §6.1 落码注记，2026-08-24 纵切二）。
 *
 * 服务面统一持有三件事（provider 只见已协商的 SubagentStart）：
 * 1. **能力协商布尔检查**（start 前 fail-loud——请求携带 outputSchema/maxDepth/
 *    toolFilter/persona/context 任一而 provider 未声明对应能力 → SUBAGENT_CAPABILITY_UNSUPPORTED，
 *    不做运行时协商【dsh】）；
 * 2. **background 模式 Job 接线**（§6.2 一次性两形态）：background:true →
 *    ctx.jobs.create(kind='subagent') 立即返回 job 句柄；stopReason → Job 终态映射
 *    在此唯一持有（completed→completed / aborted→killed / error·max-tokens·refusal
 *    及其余→failed）；Job cancel signal 接 provider dispose——cancel 即子收工；
 * 3. **结算回调 onSettle**（§6.4）：结算折叠 + 三通道通知的装配层挂点——
 *    background 链 settle → onSettle → dispose（通知先于子所有权释放）。
 */
import {
  AppError,
  SUBAGENT_CAPABILITY_UNSUPPORTED,
  SUBAGENT_PROVIDER_DUPLICATE,
  SUBAGENT_PROVIDER_NOT_FOUND,
  describeError,
} from '../contracts/errors.js';
import type {
  SubagentProvider,
  SubagentProviderInfo,
  SubagentRequest,
  SubagentResult,
  SubagentRun,
  SubagentSettlement,
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

/** 请求面五能力位 → 能力声明键（协商检查的映射表：请求带字段 ⇔ provider 声明布尔；
 * context 位 = 第三十一批 context 腿） */
const CAPABILITY_KEYS: readonly {
  readonly requestField: keyof SubagentStart & keyof SubagentRequest;
  readonly capability: keyof SubagentProvider['capabilities'];
}[] = [
  { requestField: 'outputSchema', capability: 'outputSchema' },
  { requestField: 'maxDepth', capability: 'depthLimit' },
  { requestField: 'toolFilter', capability: 'toolFilter' },
  { requestField: 'persona', capability: 'persona' },
  { requestField: 'context', capability: 'context' },
];

/**
 * 创建 ctx.subagents 具名服务（组合根 provide('subagents') 所注对象）。
 *
 * @param scope 根作用域（服务注销挂点）
 * @param opts.jobs Job 注册表（background 模式用——装配 ④c 先提供，此处显式传入
 *   免服务定位器间接层）
 * @param opts.onSettle 结算回调（§6.4 落码注记——装配层接通知器：结算折叠 llm/usage
 *   + 三通道通知）。background 链 = Job settle → onSettle → execution.dispose（通知
 *   先于子所有权释放）；foreground 链 = onSettle，dispose 归调用方。回调违约由
 *   logger 吞掉——不影响 Job 终态与后续 dispose（回调纪律同事件监听器隔离）
 */
export function createSubagentsService(
  scope: ContextScope,
  opts: { jobs: JobsServiceFace; onSettle?: (settlement: SubagentSettlement) => void },
): SubagentsServiceFace {
  const logger = scope.logger;
  /** 已注册 provider 表（注册序保持——list 披露面稳定） */
  const providers = new Map<string, SubagentProvider>();

  /** 结算回调的违约隔离壳（§6.4：通知失败不炸结算链） */
  const fireOnSettle = (settlement: SubagentSettlement): void => {
    if (opts.onSettle === undefined) return;
    try {
      opts.onSettle(settlement);
    } catch (err) {
      logger.error('subagent onSettle 回调违约（已隔离）', { error: describeError(err) });
    }
  };

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
      return [...providers.values()].map((provider) => ({
        name: provider.name,
        capabilities: provider.capabilities,
        ...(provider.description !== undefined ? { description: provider.description } : {}),
      }));
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
        // 前台链：结算即回调（dispose 归调用方——消费 result 后自释放）
        void execution.result.then((result) => fireOnSettle({ request, execution, result }));
        return { ...execution, provider: provider.name };
      }

      /* ---- background 接线（§6.2：注册进 Job 注册表并立即返回 jobId）----
       * 服务面 = Job executor：子结算（或异常兜底）落 Job 终态；
       * Job cancel → abort signal 接 execution.dispose（cancel 即子收工）。
       * 结算序（§6.4 落码注记）：settle → onSettle → dispose——通知先于子所有权释放。 */
      const { handle, signal, settle } = opts.jobs.create({
        kind: 'subagent',
        ...(request.ownerSessionId !== undefined ? { ownerSessionId: request.ownerSessionId } : {}),
        ...(request.label !== undefined ? { label: request.label } : {}),
      });
      if (signal.aborted)
        execution.dispose(); // 极端窗口：create 前已有人 cancel（Job 建即 stopping）
      else signal.addEventListener('abort', () => execution.dispose(), { once: true });
      // 结算路：SubagentResult → Job 终态（映射唯一持有处）；异常兜底 failed。
      // 兜底路合成 error 结算契约再回调——§6.4 无条件投递（失败恰恰是子没机会
      // report 的场景），违约 provider 也不例外
      void execution.result.then(
        (result) => {
          settle(stopReasonToJobTerminal(result.stopReason), {
            ...(result.stopReason === 'completed'
              ? { output: result.output }
              : // 失败族 error 段载 diagnostic（缺省落 stopReason 本身）
                { error: result.diagnostic ?? String(result.stopReason) }),
          });
          fireOnSettle({ request, execution, result, job: handle });
          execution.dispose(); // 释放子所有权（通知已发——顺序规则落码面）
        },
        (err) => {
          // 防御路：execution.result 契约永不 reject，此处只兜 provider 违约
          const diagnostic = err instanceof Error ? err.message : String(err);
          settle('failed', { error: diagnostic });
          fireOnSettle({
            request,
            execution,
            result: { output: '', diagnostic, stopReason: 'error' },
            job: handle,
          });
          execution.dispose();
        },
      );
      const run: SubagentRun = { ...execution, provider: provider.name, job: handle };
      return run;
    },
  };

  return service;
}
