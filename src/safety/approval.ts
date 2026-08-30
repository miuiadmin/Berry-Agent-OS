/**
 * L3 safety — ApprovalService（骨架篇 §8.3 钉死）。
 *
 * outcome 闭集 allowed-once / rejected / cancelled / unavailable：
 * - ask（默认）：以 waterfall 派发给已注册的 answerer（通道应用在
 *   approval/answer 上短路返回三值决策）；无人应答 fail-closed → unavailable；
 * - never：确定性拒绝（CI / 无人值守姿态）。
 * 升权审批（§7.4）与守门审批（safety gate）共用本服务，reason 区分。
 *
 * 审批对落日志（§8.4）：asked + decided 经注入 sink 落 durable 事件
 * （app 装配层接线 session.append）——tools 不依赖 session 的同款注入
 * 模式；回放时决策已是既成事实，不重问。
 */

import { randomUUID } from 'node:crypto';
import type { Context, Disposer } from '../context/types.js';
import { chainBackground } from '../context/chain.js';
import type { ApprovalOutcome, ApprovalPolicyMode, ApprovalRequest, AllowlistDraft } from './types.js';

/** answerer 监听的活体事件名（waterfall 语义：短路返回 ApprovalAnswer 四值，调 next() = 本行不接） */
export const APPROVAL_ANSWER_EVENT = 'approval/answer';

/**
 * run 信号桥接（interrupt 小刀：契约篇 §6.8——两 answerer 共用单源）：把
 * ApprovalRequest.signal（发起 run 的取消信号）桥进 answerer 的 per-request
 * controller——abort 同 reason，run abort 与竞速败腿收束汇入同一撤销面。
 * 已 abort 的 signal 同步触发（abort 事件只发一次，只挂监听则死路）。
 * @returns 监听摘除函数（ask 结算时调用——迟到 abort 落在已结算提问上 no-op
 * 无害，摘除是刀 A「任何结算路径摘监听」同款不变式纪律非正确性依赖）
 */
export function bridgeApprovalSignal(req: ApprovalRequest, controller: AbortController): () => void {
  const runSignal = req.signal;
  if (runSignal === undefined) return () => {};
  const relay = (): void => controller.abort(runSignal.reason);
  if (runSignal.aborted) relay();
  else runSignal.addEventListener('abort', relay, { once: true });
  return () => runSignal.removeEventListener('abort', relay);
}

/** 审批对落 durable 的形态（与 session 事件 approval/asked + approval/decided 一一对应） */
export interface ApprovalDecisionSink {
  /** approval/asked 载荷（落日志时机 = 请求发出时） */
  asked(payload: { readonly approvalId: string; readonly summary: string }): void;
  /** approval/decided 载荷（落日志时机 = 决议产生时；与 asked 同 turn 内） */
  decided(payload: { readonly approvalId: string; readonly decision: ApprovalDecisionValue }): void;
}

/**
 * durable 决议五值（2026-08-27「始终允许」批扩 'always'——与应答闭集 + unavailable
 * 对齐：approve = 批一次、always = 授权常驻写条目，审计语义不同不合并；
 * 无草案 always 视同 approve 落账——decision 记有效行为，'always' 值仅当
 * 条目真实写入时使用）
 */
export type ApprovalDecisionValue = 'approve' | 'reject' | 'cancel' | 'unavailable' | 'always';

/** ctx.approval 服务面（应用经 ctx.get<ApprovalService>('approval') 取用） */
export interface ApprovalService {
  /** 动作级审批：一次请求 → 一个 outcome（闭集，绝不悬空） */
  ask(req: ApprovalRequest): Promise<ApprovalOutcome>;
  /** 当前策略档（诊断/审计输出用） */
  readonly policyMode: ApprovalPolicyMode;
}

/** 组装选项 */
export interface ApprovalServiceOptions {
  /** 策略档（缺省 'ask'；never = 无人值守确定性拒绝） */
  readonly policy?: ApprovalPolicyMode;
  /** durable 审批对接线（缺省不落——测试/无会话场景；app 装配层接 session.append） */
  readonly sink?: ApprovalDecisionSink;
  /**
   * 归属闭包（S5 骨架篇 §8.3：装配期织入 ask 载荷的 ownership 标签——
   * chat 件 open() 传本驱动 {sessionId, appId}；组合根全局实例不传 = 无标签，
   * exec/fetch 服务路的弹窗无标签属 v1 已知形态）
   */
  readonly ownership?: { readonly sessionId: string; readonly appId?: string };
  /**
   * 「始终允许」条目写入回调（骨架篇 §8.4 增补 2 落码形态③织入位）：answerer
   * 返回 'always' 且载荷带草案时调用——装配层接 AllowlistStore.add（幂等）。
   * 缺省不传 = always 面关闭（视同 approve，零副作用）。
   */
  readonly persistAllowlist?: (draft: AllowlistDraft) => void;
}

/**
 * outcome → durable 决议值映射。allowed-once 落日志记 approve——「批了这一次」；
 * always 单列（第二参数，条目真实写入时的决议值——与 approve 审计语义不同）。
 */
function outcomeToDecision(outcome: ApprovalOutcome, alwaysWritten: boolean): ApprovalDecisionValue {
  if (outcome === 'allowed-once') return alwaysWritten ? 'always' : 'approve';
  switch (outcome) {
    case 'rejected':
      return 'reject';
    case 'cancelled':
      return 'cancel';
    case 'unavailable':
      return 'unavailable';
  }
}

/**
 * 组装审批服务并挂进 ctx（provide('approval')，随作用域 LIFO 回卷）。
 * 每次 ask 独立 approvalId（randomUUID）——审批对以此为关联键落日志。
 */
export function createApprovalService(ctx: Context, opts: ApprovalServiceOptions = {}): ApprovalService {
  const policy = opts.policy ?? 'ask';
  const sink: ApprovalDecisionSink = opts.sink ?? { asked: () => {}, decided: () => {} };

  const service: ApprovalService = {
    policyMode: policy,

    async ask(req) {
      const approvalId = randomUUID();
      // 审批对第一腿：请求落日志（turn-enclosed 的开头）
      sink.asked({ approvalId, summary: req.summary });

      // S5 归属织入（骨架篇 §8.3）：ownership 装配期闭包 + priority 调用链取数 +
      // approvalId——三者都是 answerer 的消费面，守门/执行机制不按它们分支
      const enriched: ApprovalRequest = {
        ...req,
        approvalId,
        ...(opts.ownership !== undefined ? { ownership: opts.ownership } : {}),
        priority: chainBackground() ? 'background' : 'interactive',
      };

      let outcome: ApprovalOutcome;
      // always 是否真实写入条目（决议落账值分流：真写入才落 'always'——§8.4 增补 2 落码形态⑤）
      let alwaysWritten = false;
      if (policy === 'never') {
        // never：确定性拒绝，不派发 answerer（无人值守姿态没有「问谁」）
        outcome = 'rejected';
      } else {
        // ask：waterfall 派发——answerer 短路返回四值；全链无人应答 = undefined
        const answer = await ctx.waterfall<'approve' | 'reject' | 'cancel' | 'always' | undefined>(
          APPROVAL_ANSWER_EVENT,
          enriched,
          () => undefined,
        );
        if (answer === 'always') {
          // 「始终允许」（骨架篇 §8.4 增补 2）：批准本次 + 授权写跨会话条目。
          // 载荷无草案 = answerer 面本不该呈现该选项，防御收口视同 approve
          // （零草案零副作用——§8.3 钉死）；写入回调未装配同口径。
          if (enriched.suggestedEntry !== undefined && opts.persistAllowlist !== undefined) {
            opts.persistAllowlist(enriched.suggestedEntry);
            alwaysWritten = true;
          }
          outcome = 'allowed-once';
        } else {
          outcome =
            answer === 'approve'
              ? 'allowed-once'
              : answer === 'reject'
                ? 'rejected'
                : answer === 'cancel'
                  ? 'cancelled'
                  : // 无人应答 fail-closed：unavailable 不是「稍后再试」，是本次不放行
                    'unavailable';
        }
      }

      // 审批对第二腿：决议落日志（与 asked 同 turn 内；回放恢复不重问的依据）
      sink.decided({ approvalId, decision: outcomeToDecision(outcome, alwaysWritten) });
      return outcome;
    },
  };

  ctx.provide('approval', service);
  return service;
}
