/**
 * dialogue.observe handler（§17.4 巨石拆解——从 brain/entry.ts 提取）。
 *
 * 异步监听 agent 间对话：累积消息 + 规则式干预（循环检测/不确定性检测）+
 * 每 3 轮语义对齐检测（drift check LLM）。dialogueBuffers 完全自包含于本模块。
 */

import type Database from 'better-sqlite3';
import type { IpcMessage } from '../../../kernel/types.js';
import type { TurnCorrectionPayload } from '../../../contracts/delegation.js';
import type { DialogueObservePayload } from '../../../contracts/dialogue.js';
import { safeSlice } from '../../../utils/safe-slice.js';
import { getLogger } from '../../../utils/logger.js';

/** deps 注入 */
export interface DialogueHandlerDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipc: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llm: any;
  name: string;
}

/** 对话 buffer（每个 dialogueId 保留最近 10 条消息 + 最后活动时间） */
type DialogueBuffer = { messages: Array<{ from: string; content: string; round: number }>; lastActivity: number };

/**
 * 注册 dialogue.observe handler（§17.4 整组提取）。
 * dialogueBuffers Map 完全自包含——entry.ts 不再持有。
 */
export function setupDialogueHandler(deps: DialogueHandlerDeps): void {
  const { ipc, llm, name } = deps;
  const logger = getLogger('brain-dialogue');
  const dialogueBuffers = new Map<string, DialogueBuffer>();

  ipc.onMessage('dialogue.observe', async (msg: IpcMessage) => {
    const payload = msg.payload as DialogueObservePayload;
    const { message, currentRound } = payload;
    const dialogueId = message.dialogueId;

    // 累积对话消息（保留最近 10 条）
    if (!dialogueBuffers.has(dialogueId)) {
      dialogueBuffers.set(dialogueId, { messages: [], lastActivity: Date.now() });
    }
    const buffer = dialogueBuffers.get(dialogueId)!;
    buffer.messages.push({ from: message.from, content: safeSlice(message.content, 500), round: currentRound });
    if (buffer.messages.length > 10) buffer.messages.shift();
    buffer.lastActivity = Date.now();

    // 规则式干预判断（不调 LLM，保持低成本）
    let intervention: { instruction: string; reason: string } | null = null;

    // 规则 1：对话轮次过多且无进展（循环检测）
    const maxObserveRounds = parseInt(process.env.AGENT_OBSERVE_MAX_ROUNDS ?? '8', 10);
    if (currentRound >= maxObserveRounds) {
      const recentContents = buffer.messages.slice(-4).map((m) => m.content);
      const hasRepetition = recentContents.some((c, i) => i > 0 && recentContents[i - 1].slice(0, 100) === c.slice(0, 100));
      if (hasRepetition) {
        intervention = { instruction: '对话陷入循环。请总结已有信息，做出决策或直接回复用户。不要继续追问。', reason: 'dialogue_loop_detected' };
      }
    }

    // 规则 2：连续 3 次不确定（needsClarification 模式检测）
    if (!intervention && buffer.messages.length >= 6) {
      const lastThreeReplies = buffer.messages.filter((m) => m.from !== 'conversation').slice(-3);
      const uncertainCount = lastThreeReplies.filter((m) => m.content.includes('需要确认') || m.content.includes('不确定') || m.content.includes('请提供更多')).length;
      if (uncertainCount >= 3) {
        intervention = { instruction: '目标智能体连续表示不确定。考虑直接询问用户获取必要信息，或基于现有信息做出最佳判断。', reason: 'repeated_uncertainty' };
      }
    }

    // 发送纠偏（IPC turn.correction）
    if (intervention) {
      logger.info({ dialogueId, reason: intervention.reason, round: currentRound }, 'brain:dialogue intervention');
      ipc.send('turn.correction', 'core', { delegationId: dialogueId, action: 'adjust' as const, instruction: intervention.instruction } satisfies TurnCorrectionPayload, msg.correlationId ?? msg.id);
    }

    // 每 3 轮做语义对齐检测（仅当有 intentAnchor 且无规则式干预时）
    if (!intervention && currentRound > 0 && currentRound % 3 === 0 && payload.intentAnchor) {
      try {
        const { buildDriftCheckPrompt, parseDriftCheckResult } = await import('../../../kernel/drift-detector.js');
        const recentContent = buffer.messages.slice(-3).map((m) => `[${m.from}]: ${m.content}`).join('\n');
        const prompt = buildDriftCheckPrompt(payload.intentAnchor, recentContent, 'dialogue');
        const result = await llm.current.chat([{ role: 'user', content: prompt }], { system: '你是语义对齐检测器。只输出 JSON。', maxTokens: 200, temperature: 0, agent: name, purpose: 'drift_detection' });
        const signal = parseDriftCheckResult(result.content, 'dialogue');
        if (signal.needsIntervention && signal.alignmentScore < 0.5) {
          logger.info({ dialogueId, score: signal.alignmentScore, desc: safeSlice(signal.driftDescription, 100) }, 'brain:dialogue semantic drift');
          ipc.send('turn.correction', 'core', {
            delegationId: dialogueId, action: 'adjust' as const,
            instruction: `对话可能偏离了用户原始意图。用户的目标是："${payload.intentAnchor.goal}"。${signal.driftDescription ? `当前问题：${signal.driftDescription}。` : ''}请重新对齐用户意图后继续。`,
          } satisfies TurnCorrectionPayload, msg.correlationId ?? msg.id);
        }
      } catch (err) {
        logger.debug({ err, dialogueId }, 'dialogue semantic drift check failed, skipping');
      }
    }

    // 定期清理过期 buffer（5 分钟无活动）
    for (const [id, buf] of dialogueBuffers) {
      if (Date.now() - buf.lastActivity > 5 * 60_000) dialogueBuffers.delete(id);
    }
  });
}
