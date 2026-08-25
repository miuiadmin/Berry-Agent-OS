/**
 * L1 agent — 待注入消息队列（骨架篇 §4.2，pi PendingMessageQueue 蓝本）。
 *
 * 队列是 loop 仅有的可变状态（经 getSteeringMessages / getFollowUpMessages
 * 取数口接入），语义上不可拆出内核——不为排队再造新概念。inject 不进 loop
 * （会话日志层操作，loop 完全无感知）。
 */

import type { AgentMessage } from '../contracts/messages.js';

/**
 * 排空点注入策略：
 * - "all"：该排空点注入全部排队消息；
 * - "one-at-a-time"（默认拍板值）：只注入最旧一条，其余留队待后续排空点。
 */
export type QueueMode = 'all' | 'one-at-a-time';

/** steering / followUp 两通道共用的队列实现（steeringMode / followUpMode 各自独立可配） */
export class PendingMessageQueue {
  /** 排队消息（旧在前） */
  private messages: AgentMessage[] = [];
  /** 注入策略（可运行期调整） */
  mode: QueueMode;

  constructor(mode: QueueMode = 'one-at-a-time') {
    this.mode = mode;
  }

  /** 入队（队尾） */
  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  /** 是否有排队消息（loop 内层循环条件之一） */
  hasItems(): boolean {
    return this.messages.length > 0;
  }

  /** 排空：按 mode 取一批（one-at-a-time 只取最旧一条，其余留队） */
  drain(): AgentMessage[] {
    if (this.mode === 'all') {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const oldest = this.messages[0];
    if (!oldest) {
      return [];
    }
    this.messages = this.messages.slice(1);
    return [oldest];
  }

  /** 清空（会话关停/丢弃待注入消息时） */
  clear(): void {
    this.messages = [];
  }
}
