/**
 * cron.review LLM 审核核心逻辑（§17.4 巨石拆解——从 brain/entry.ts 提取）。
 *
 * 复杂/长输出的 LLM 审核（buildCronReviewPrompt → chat → parseCronReviewResult）。
 * 规则化快速/中等通过（不调 LLM）留在 entry.ts（decisionRecorder 闭包依赖）。
 */

import type { ModelMessage } from '../../../contracts/model.js';
import { buildCronReviewSystemPrompt, buildCronReviewUserPrompt, parseCronReviewResult } from './prompts.js';

type ChatFn = (messages: ModelMessage[], options: Record<string, unknown>) => Promise<{ content: string }>;

/**
 * cron.review LLM 审核（复杂/长输出路径）。
 * @param description cron 任务描述
 * @param output      cron 任务输出
 * @param chat        LLM chat 函数
 * @param name        brain agent 名
 * @param taskId      cron 任务 id
 * @returns parseCronReviewResult（verdict + confidence + reason + correctedOutput）
 */
export async function evaluateCronReview(
  description: string,
  output: string,
  chat: ChatFn,
  name: string,
  taskId: string,
) {
  const systemPrompt = buildCronReviewSystemPrompt();
  const userPrompt = buildCronReviewUserPrompt(description, output);
  const result = await chat([{ role: 'user', content: userPrompt }], {
    system: systemPrompt,
    maxTokens: 1024,
    temperature: 0.2,
    agent: name,
    purpose: 'brain_cron_review',
    sessionId: `cron:${taskId}`,
  });
  return parseCronReviewResult(result.content);
}
