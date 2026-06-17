/**
 * 16.0 重构——session-manager 对话内联持久化（从 session-manager.ts 提取）。
 *
 * persistInlineBlocks + saveUserMessage（对话内联 doc 22 的两个入库漏斗），
 * 行为保持式提取。纯函数（依赖 message-blocks-repo + block-collector + genId）。
 */
import type { PendingRequest } from '../session-manager.js';
import type { Block } from '../../contracts/message-blocks.js';
import { genId } from '../../utils/id.js';
import { getLogger } from '../../utils/logger.js';
import { disposeBlockCollector } from '../block-collector.js';
import { persistAssistantTurn, persistUserMessage } from '../../memory/message-blocks-repo.js';

const logger = getLogger('session-manager');

/**
 * 对话内联（doc 22）：assistant 唯一落库漏斗。
 * collector key = pending.delegationTaskId ?? pending.taskId。
 * 有 collector → dispose 取 Block[]；无 collector → 降级单 text block。
 */
export function persistInlineBlocksImpl(pending: PendingRequest, persistContent: string): void {
  const key = pending.delegationTaskId ?? pending.taskId;
  try {
    let blocks: Block[] | undefined;
    let messageId: string | undefined;
    if (key) {
      const collector = disposeBlockCollector(key);
      if (collector) {
        blocks = collector.buildBlocks({ reasoning: pending.reasoning, draftResponse: persistContent });
        messageId = collector.messageId;
      }
    }
    if ((!blocks || blocks.length === 0) && persistContent) {
      blocks = [{ type: 'text', text: persistContent }];
      messageId = genId('msg');
    }
    if (blocks && blocks.length > 0 && messageId) {
      persistAssistantTurn({ messageId, sessionId: pending.sessionId, taskId: key, blocks });
    }
  } catch (err) {
    logger.error({ err, sessionId: pending.sessionId, key }, 'persistInlineBlocks 落 blocks 失败（不阻塞对话收尾）');
  }
}

/** user 消息入口入库（幂等由 clientMsgId 触发） */
export function saveUserMessageImpl(sessionId: string, content: string, options: { clientMsgId?: string } = {}): { id: string; deduplicated: boolean } {
  try {
    return persistUserMessage({ sessionId, content, clientMsgId: options.clientMsgId });
  } catch (err) {
    logger.warn({ err, sessionId, clientMsgId: options.clientMsgId }, 'user 消息入口入库失败，将依赖下游 conversation agent 兜底');
    return { id: '', deduplicated: false };
  }
}
