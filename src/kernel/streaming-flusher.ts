import type { TaskManager } from './task-manager.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('streaming-flusher');

/** 每个活跃任务的刷写状态 */
interface FlushEntry {
  /** 上次成功 flush 时的文本长度 */
  lastFlushedLength: number;
  /** 上次的 reasoning 长度 */
  lastReasoningLength: number;
  /** 最近一次累积的完整文本（dispose 兜底用） */
  pendingText: string;
  /** 最近一次累积的完整 reasoning */
  pendingReasoning: string;
  /** 延迟刷写定时器 */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 流式内容定时刷写器。
 *
 * 在流式响应过程中，将 `pending.draftResponse` 中已积累的文本
 * 定期（默认 2s）flush 到 `agent_tasks.output_payload`。
 * 这样前端断连/刷新后，可从 `/state` API 恢复已生成的内容。
 *
 * 设计原则：
 * - 不阻塞 text_delta 推送（flush 走 setTimeout 异步）
 * - 节流：至少 50 字符变化 且 ≥2s 间隔
 * - 幂等：complete() 改变 status 后，flush UPDATE 变 no-op
 */
export class StreamingFlusher {
  private entries = new Map<string, FlushEntry>();
  /** 已完成的 task ID 集合，防止 remove() 后 onTextAccumulated 重建 entry */
  private completed = new Set<string>();
  /** flush 间隔（毫秒） */
  private readonly intervalMs: number;
  /** 触发 flush 的最小新增字符数 */
  private readonly minDeltaChars: number;

  constructor(
    private taskManager: TaskManager,
    opts?: { intervalMs?: number; minDeltaChars?: number },
  ) {
    this.intervalMs = opts?.intervalMs ?? 2000;
    this.minDeltaChars = opts?.minDeltaChars ?? 50;
  }

  /**
   * 通知有新文本累积。内部判断是否需要调度 flush。
   * @param taskId 任务 ID
   * @param fullText 当前完整的累积文本
   * @param reasoning 当前完整的推理文本（可选）
   */
  onTextAccumulated(taskId: string, fullText: string, reasoning?: string): void {
    // 已完成的任务不再接受新文本
    if (this.completed.has(taskId)) return;

    let entry = this.entries.get(taskId);
    if (!entry) {
      entry = { lastFlushedLength: 0, lastReasoningLength: 0, pendingText: '', pendingReasoning: '', timer: null };
      this.entries.set(taskId, entry);
    }

    // 持续记录最近一次的累积内容（dispose 时用来兜底 flush）
    entry.pendingText = fullText;
    if (reasoning !== undefined) entry.pendingReasoning = reasoning;

    // 检查文本变化量是否达到阈值
    const textDelta = fullText.length - entry.lastFlushedLength;
    const reasoningDelta = (reasoning?.length ?? 0) - entry.lastReasoningLength;
    if (textDelta < this.minDeltaChars && reasoningDelta < this.minDeltaChars) return;

    // 已有 timer 在等待，不重复调度
    if (entry.timer) return;

    // 调度延迟 flush
    const capturedText = fullText;
    const capturedReasoning = reasoning;
    entry.timer = setTimeout(() => {
      this.flush(taskId, capturedText, capturedReasoning);
    }, this.intervalMs);
  }

  /**
   * 任务完成/失败时清理。不做额外 flush（complete() 会写最终 output_payload）。
   */
  remove(taskId: string): void {
    if (!taskId) return;
    this.completed.add(taskId);
    // 防止 completed set 无限增长（单用户场景下不会超过几百）
    if (this.completed.size > 500) {
      const iter = this.completed.values();
      for (let i = 0; i < 250; i++) iter.next();
      const remaining = new Set<string>();
      for (const v of iter) remaining.add(v);
      this.completed.clear();
      for (const v of remaining) this.completed.add(v);
    }
    const entry = this.entries.get(taskId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(taskId);
  }

  /**
   * 清理所有 timer，**并同步 flush 所有未 flush 的累积文本到 DB**。
   * 用于进程退出 / SIGTERM 路径防止 < 2s partial 文本丢失。
   * flush 同步执行（better-sqlite3）保证 SIGKILL 之外都能落库。
   */
  dispose(): void {
    for (const [taskId, entry] of this.entries) {
      if (entry.timer) clearTimeout(entry.timer);
      // 同步 flush 未落库的累积内容（仅在 lastFlushedLength < pendingText.length 时）
      if (entry.pendingText.length > entry.lastFlushedLength) {
        try {
          this.taskManager.flushStreamingContent(taskId, entry.pendingText, entry.pendingReasoning);
          logger.info({ taskId, chars: entry.pendingText.length - entry.lastFlushedLength }, 'dispose() 兜底 flush 流式内容');
        } catch (err) {
          logger.warn({ err, taskId }, 'dispose() 兜底 flush 失败（任务可能已结束）');
        }
      }
    }
    this.entries.clear();
  }

  private flush(taskId: string, fullText: string, reasoning?: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;

    entry.timer = null;
    entry.lastFlushedLength = fullText.length;
    entry.lastReasoningLength = reasoning?.length ?? 0;

    try {
      this.taskManager.flushStreamingContent(taskId, fullText, reasoning);
    } catch (err) {
      logger.debug({ err, taskId }, '流式内容 flush 失败（任务可能已结束）');
    }
  }
}
