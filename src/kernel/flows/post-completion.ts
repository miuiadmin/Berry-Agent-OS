/**
 * 16.0 §17.4 delegation-orchestrator 巨石拆解——后完成学习序列提取（第 11 步）。
 *
 * 从 delegation-orchestrator.ts 搬出 onConversationCompleted + dispatchFeedbackExtraction
 * （行为保持，仅把 this.* 依赖改成显式参数）。这是对话/任务完成后统一的「后完成学习」序列。
 *
 * R15 解耦审计：final.response handler 和 handleTaskReviewResult 中 queueEvolution +
 * queueCapabilityEvolution + extract_feedback + worldModel 4 步几乎逐行重复，提取为统一
 * helper 消除补丁式复制粘贴。
 */

import type { SessionManager } from '../session-manager.js';
import type { WorldModelRuntime } from '../world-model.js';
import type { ToolBlock } from '../../contracts/message-blocks.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('orchestrator');

/** 后完成学习序列依赖注入 + 跨集群回调 */
export interface PostCompletionDeps {
  readonly sessionManager: SessionManager;
  readonly worldModel: WorldModelRuntime | null;
  /** 模块任务派发回调（主类 dispatchModuleTask，extract_feedback 任务用） */
  dispatchModuleTask(input: {
    sessionId: string;
    taskType: string;
    requester: string;
    inputPayload: Record<string, unknown>;
    foreground?: boolean;
    correlationId?: string;
    targetAgentOverride?: string;
  }): Promise<{ taskId: string; targetAgent: string }>;
}

/**
 * 统一的 feedback extraction dispatch helper（逐字搬运）。
 *
 * R15 解耦审计：extract_feedback 的 dispatchModuleTask 调用在 orchestrator 中出现 5 处
 * （auto-approve / drift-timeout / drift-approve / final.response / handleTaskReviewResult），
 * 参数结构完全相同。提取为一行调用。
 *
 * @param sessionId          对话 session
 * @param userMessage        用户原始消息
 * @param assistantResponse  助手回复内容
 * @param requester          请求来源（'brain_learning' 或 'post_review'）
 * @param deps               依赖注入 + 跨集群回调
 */
export function dispatchFeedbackExtraction(
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
  requester: 'brain_learning' | 'post_review',
  deps: PostCompletionDeps,
): void {
  const { dispatchModuleTask } = deps;
  dispatchModuleTask({
    sessionId,
    taskType: 'extract_feedback',
    requester,
    inputPayload: { taskType: 'extract_feedback', userMessage, assistantResponse },
  }).catch((err) => {
    logger.debug({ err, sessionId }, 'Feedback extraction dispatch failed');
  });
}

/**
 * 对话完成后统一的「后完成学习」序列（逐字搬运）。
 *
 * R15 解耦审计：final.response handler 和 handleTaskReviewResult 中 queueEvolution +
 * queueCapabilityEvolution + extract_feedback + worldModel 4 步几乎逐行重复，提取为统一
 * helper 消除补丁式复制粘贴。
 *
 * 序列：
 *   1. queueEvolution（usage evolution 提取）
 *   2. queueCapabilityEvolution（能力进化信号）
 *   3. dispatchFeedbackExtraction（brain_learning requester）
 *   4. worldModel.updateFromConversation（推断 activeGoals）
 *
 * @param sessionId          对话 session
 * @param userMessage        用户原始消息
 * @param assistantResponse  最终回复内容
 * @param toolCalls          本轮工具调用（可选）— 传给 World Model 推断 activeGoals
 * @param deps               依赖注入 + 跨集群回调
 */
export function onConversationCompleted(
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
  /** 本轮工具调用（ToolBlock[]，来自 BlockCollector —— 审核链单一源）；World Model 仅读 .name 推断 activeGoals */
  toolCalls: ToolBlock[] | undefined,
  deps: PostCompletionDeps,
): void {
  const { sessionManager, worldModel } = deps;
  sessionManager.queueEvolution(sessionId, userMessage, assistantResponse);
  sessionManager.queueCapabilityEvolution(sessionId, userMessage, assistantResponse);
  dispatchFeedbackExtraction(sessionId, userMessage, assistantResponse, 'brain_learning', deps);
  worldModel?.updateFromConversation({
    userMessage,
    assistantResponse,
    toolCalls,
    sessionId,
  });
}
