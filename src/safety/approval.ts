/**
 * L3 safety — ApprovalService（骨架篇 §8.3 钉死）。
 *
 * outcome 闭集 allowed-once / rejected / cancelled / unavailable：
 * - ask（默认）：以 waterfall 派发给已注册的 answerer（通道插件在
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
import type { ApprovalOutcome, ApprovalPolicyMode, ApprovalRequest } from './types.js';

/** answerer 监听的活体事件名（waterfall 语义：短路返回 ApprovalAnswer 三值，调 next() = 本行不接） */
export const APPROVAL_ANSWER_EVENT = 'approval/answer';

/** 审批对落 durable 的形态（与 session 事件 approval/asked + approval/decided 一一对应） */
export interface ApprovalDecisionSink {
  /** approval/asked 载荷（落日志时机 = 请求发出时） */
  asked(payload: { readonly approvalId: string; readonly summary: string }): void;
  /** approval/decided 载荷（落日志时机 = 决议产生时；与 asked 同 turn 内） */
  decided(payload: { readonly approvalId: string; readonly decision: ApprovalDecisionValue }): void;
}

/** durable 决议四值（与 session ApprovalDecidedData.decision 对齐：approve/reject/cancel/unavailable） */
export type ApprovalDecisionValue = 'approve' | 'reject' | 'cancel' | 'unavailable';

/** ctx.approval 服务面（插件经 ctx.get<ApprovalService>('approval') 取用） */
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
}

/** outcome → durable 决议值映射（allowed-once 落日志记 approve——「批了这一次」） */
function outcomeToDecision(outcome: ApprovalOutcome): ApprovalDecisionValue {
  switch (outcome) {
    case 'allowed-once':
      return 'approve';
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
      if (policy === 'never') {
        // never：确定性拒绝，不派发 answerer（无人值守姿态没有「问谁」）
        outcome = 'rejected';
      } else {
        // ask：waterfall 派发——answerer 短路返回三值；全链无人应答 = undefined
        const answer = await ctx.waterfall<'approve' | 'reject' | 'cancel' | undefined>(
          APPROVAL_ANSWER_EVENT,
          enriched,
          () => undefined,
        );
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

      // 审批对第二腿：决议落日志（与 asked 同 turn 内；回放恢复不重问的依据）
      sink.decided({ approvalId, decision: outcomeToDecision(outcome) });
      return outcome;
    },
  };

  ctx.provide('approval', service);
  return service;
}
