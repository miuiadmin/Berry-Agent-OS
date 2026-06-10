/**
 * 13.0 灵魂版 — 目标 Agent 并发控制队列。
 *
 * 问题：3 个 agent 同时 request Learning，Learning 是单进程单 LLM 上下文，
 *       不能同时处理 3 个独立问题。
 *
 * 解决方案：请求队列 + 拒绝策略（§4.4.1）
 *   - 每个 agent 维护一个 FIFO 请求队列
 *   - 每个 agent 同时只处理一个请求（串行处理）
 *   - 队列深度上限 3，超出立即拒绝
 *   - 单个请求最长等待 30s，超时自动出队并拒绝
 *
 * Agent 的 LLM 看到超时/拒绝后自行决定是否重试（不自动重试，见 §5.3.9）。
 */

/** 排队中的请求 */
export interface QueuedRequest {
  /** 请求发起方 agent */
  fromAgent: string;
  /** 请求的唯一标识 */
  requestId: string;
  /** resolve 回调（成功时调用） */
  resolve: (value: void) => void;
  /** reject 回调（失败/超时时调用） */
  reject: (reason: Error) => void;
  /** 入队时间（毫秒时间戳） */
  enqueuedAt: number;
  /** 超时定时器 ID */
  timerId?: ReturnType<typeof setTimeout>;
}

/** 队列配置 */
export interface AgentQueueConfig {
  /** 每个 agent 的最大排队深度（默认 3） */
  maxQueueDepth: number;
  /** 单个请求最大等待时间（毫秒，默认 30s） */
  maxWaitMs: number;
}

/** 默认配置 */
const DEFAULT_CONFIG: AgentQueueConfig = {
  maxQueueDepth: 3,
  maxWaitMs: 30_000,
};

/**
 * Agent 请求队列 — 按 target agent 维护 FIFO 队列。
 *
 * 使用方式：
 *   1. KernelRouter 在收到跨 agent request 后调用 enqueue()
 *   2. 队列自动按 FIFO 串行处理
 *   3. 处理完成后（agent 回复了 turn.final）调用 complete()
 *   4. 超时/拒绝通过 reject 回调通知发起方
 */
export class AgentRequestQueue {
  /** 每个 agent 的 FIFO 请求队列 */
  private queues = new Map<string, QueuedRequest[]>();
  /** 每个 agent 当前是否正在处理请求 */
  private processing = new Map<string, boolean>();
  /** 配置 */
  private config: AgentQueueConfig;

  constructor(config?: Partial<AgentQueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 将请求加入目标 agent 的队列。
   *
   * @returns Promise<void> — resolve 表示轮到该请求处理，reject 表示被拒绝
   * @throws agent_busy — 队列已满
   * @throws agent_timeout — 等待超时
   */
  enqueue(targetAgent: string, request: Omit<QueuedRequest, 'enqueuedAt' | 'timerId'>): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(targetAgent) || [];

      // 队列深度限制：超出立即拒绝
      if (queue.length >= this.config.maxQueueDepth) {
        reject(new Error(`agent_busy: ${targetAgent} has ${queue.length} pending requests`));
        return;
      }

      const entry: QueuedRequest = {
        ...request,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };

      // 超时定时器
      entry.timerId = setTimeout(() => {
        this.removeEntry(targetAgent, entry);
        reject(new Error(`agent_timeout: request to ${targetAgent} waited ${this.config.maxWaitMs}ms`));
      }, this.config.maxWaitMs);

      queue.push(entry);
      this.queues.set(targetAgent, queue);

      // 尝试立即处理
      this.tryProcess(targetAgent);
    });
  }

  /**
   * 目标 agent 完成了当前请求的处理。
   * 调用此方法后队列会自动处理下一个排队的请求。
   */
  complete(targetAgent: string): void {
    this.processing.set(targetAgent, false);
    this.tryProcess(targetAgent);
  }

  /**
   * 获取目标 agent 当前的排队深度。
   */
  getQueueDepth(targetAgent: string): number {
    return this.queues.get(targetAgent)?.length ?? 0;
  }

  /**
   * 目标 agent 是否正在处理请求。
   */
  isProcessing(targetAgent: string): boolean {
    return this.processing.get(targetAgent) ?? false;
  }

  /**
   * 清除目标 agent 的所有队列（agent 崩溃时调用）。
   * 所有排队的请求都会被 reject。
   */
  clearForAgent(targetAgent: string, reason: string): void {
    const queue = this.queues.get(targetAgent);
    if (queue) {
      for (const entry of queue) {
        if (entry.timerId) clearTimeout(entry.timerId);
        entry.reject(new Error(`agent_unavailable: ${targetAgent} — ${reason}`));
      }
      this.queues.delete(targetAgent);
    }
    this.processing.delete(targetAgent);
  }

  /**
   * 清空所有队列。
   */
  clearAll(reason: string): void {
    for (const [agent] of this.queues) {
      this.clearForAgent(agent, reason);
    }
  }

  // ─── 内部方法 ───

  /**
   * 尝试处理目标 agent 队列中的下一个请求。
   * 仅当 agent 当前不忙（processing=false）且队列非空时才处理。
   */
  private tryProcess(targetAgent: string): void {
    // 已经在处理中，不重复触发
    if (this.processing.get(targetAgent)) return;

    const queue = this.queues.get(targetAgent);
    if (!queue || queue.length === 0) return;

    // 取出队首请求
    const entry = queue.shift()!;
    if (entry.timerId) clearTimeout(entry.timerId);

    // 清理空队列
    if (queue.length === 0) {
      this.queues.delete(targetAgent);
    }

    // 标记为处理中
    this.processing.set(targetAgent, true);

    // resolve — 告诉调用方可以开始处理
    entry.resolve();
  }

  /**
   * 从队列中移除指定条目（超时时使用）。
   */
  private removeEntry(targetAgent: string, entry: QueuedRequest): void {
    const queue = this.queues.get(targetAgent);
    if (!queue) return;
    const idx = queue.indexOf(entry);
    if (idx !== -1) queue.splice(idx, 1);
    if (queue.length === 0) {
      this.queues.delete(targetAgent);
    }
  }
}
