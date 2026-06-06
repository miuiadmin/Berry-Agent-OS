/**
 * StreamDispatcher — 把 kernel 业务路径的「流式/dialogue 事件」从「业务 → ws.Socket 直写」
 * 改为「业务 → EventBus.emit → StreamDispatcher → 各 transport 订阅者」。
 *
 * 目标：kernel 不再持有任何 user-side ws.Socket 引用，所有用户面推送走订阅模型。
 *
 * 设计：
 * - StreamEvent 是 4 个 stream.* + dialogue.status 事件的 union。
 * - 一个 taskId 可被多个 subscriber 订阅（多端/CLI/WS 共享同一份流）。
 * - StreamDispatcher 内部订阅 EventBus 4 个事件，fan-out 到所有相关 subscriber。
 * - subscriber.push() 返回 false 表示该订阅者已死（如 socket destroyed），Dispatcher 会自动清理。
 * - 单个 subscriber 失败用 logger.error 包裹，不影响其他 subscriber。
 */

import { getEventBus } from './event-bus.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('stream-dispatcher');

/** StreamDispatcher 转发的所有事件类型 */
export type StreamEvent =
  | {
      kind: 'stream.text_delta';
      taskId: string;
      sessionId: string;
      text: string;
      correlationId?: string;
    }
  | {
      kind: 'stream.reasoning_delta';
      taskId: string;
      sessionId: string;
      text: string;
      correlationId?: string;
    }
  | {
      kind: 'stream.tool_call';
      taskId: string;
      sessionId: string;
      toolName: string;
      input: unknown;
      result?: unknown;
      isError?: boolean;
      durationMs?: number;
      correlationId?: string;
    }
  | {
      kind: 'dialogue.status';
      dialogueId: string;
      sessionId: string;
      status: 'started' | 'round_complete' | 'ended';
      from: string;
      to: string;
      round: number;
    };

/**
 * Transport 订阅者接口：每个实现负责把事件写到自己的通道（WS / CLI / 持久化等）。
 * - `id` 用于日志和去重
 * - `push` 返回 false 时表示该订阅者已死，Dispatcher 会从 taskId 列表中移除
 */
export interface TransportSubscriber {
  id: string;
  push(event: StreamEvent): boolean;
}

/**
 * StreamDispatcher 单例：维护 taskId → subscribers 的映射，并把 EventBus 事件 fan-out 给订阅者。
 *
 * 内部订阅 4 个 EventBus 事件：
 * - stream.text_delta
 * - stream.reasoning_delta
 * - stream.tool_call
 * - dialogue.status（独立维度，按 dialogueId 反查涉及的 taskId）
 *
 * 线程安全：本类只运行在 Node.js 单线程下，无需锁。
 */
export class StreamDispatcher {
  /** taskId → 该 task 的所有订阅者（一个 task 可多端订阅） */
  private byTask = new Map<string, Set<TransportSubscriber>>();
  /** dialogueId → 涉及到的 taskId 集合（dialogue 内多 task 共享推送） */
  private byDialogue = new Map<string, Set<string>>();
  /** subscriberId → subscriber 实例（用于按 id 查找，便于 cleanup） */
  private allSubscribers = new Map<string, TransportSubscriber>();
  /** EventBus 解绑函数，启动时收集，shutdown 时统一调用 */
  private busUnsubscribers: Array<() => void> = [];
  private started = false;

  /**
   * 启动：订阅 EventBus 的 4 个事件。重复调用幂等。
   */
  init(): void {
    if (this.started) return;
    const bus = getEventBus();
    this.busUnsubscribers.push(
      bus.on('stream.text_delta', (p) => this.fanOutByTask('stream.text_delta', p.taskId, p)),
    );
    this.busUnsubscribers.push(
      bus.on('stream.reasoning_delta', (p) => this.fanOutByTask('stream.reasoning_delta', p.taskId, p)),
    );
    this.busUnsubscribers.push(
      bus.on('stream.tool_call', (p) => this.fanOutByTask('stream.tool_call', p.taskId, p)),
    );
    this.busUnsubscribers.push(
      bus.on('dialogue.status', (p) => this.fanOutByDialogue(p)),
    );
    this.started = true;
    logger.debug('StreamDispatcher initialized');
  }

  /**
   * 关闭：解绑所有 EventBus 订阅并清空本地状态。
   */
  shutdown(): void {
    for (const off of this.busUnsubscribers) {
      try { off(); } catch (err) { logger.error({ err }, 'unsubscribe failed'); }
    }
    this.busUnsubscribers = [];
    this.byTask.clear();
    this.byDialogue.clear();
    this.allSubscribers.clear();
    this.started = false;
  }

  /**
   * 订阅指定 taskId 的流式事件。
   * 返回 unsubscribe 函数，调用后立即从所有相关 map 移除。
   *
   * 同一个 subscriber 重复订阅同一 taskId：去重。
   */
  subscribe(taskId: string, subscriber: TransportSubscriber): () => void;
  /** 重载：可同时把 taskId 关联到一个 dialogueId（dialogue 状态广播时 fan-out 到 task 的所有 subscriber） */
  subscribe(taskId: string, dialogueId: string | undefined, subscriber: TransportSubscriber): () => void;
  subscribe(
    taskId: string,
    dialogueIdOrSub: string | TransportSubscriber | undefined,
    maybeSub?: TransportSubscriber,
  ): () => void {
    const subscriber = (typeof dialogueIdOrSub === 'object' ? dialogueIdOrSub : maybeSub) as TransportSubscriber;
    const dialogueId = typeof dialogueIdOrSub === 'string' ? dialogueIdOrSub : undefined;

    let set = this.byTask.get(taskId);
    if (!set) {
      set = new Set();
      this.byTask.set(taskId, set);
    }
    set.add(subscriber);
    this.allSubscribers.set(subscriber.id, subscriber);

    if (dialogueId) {
      let dialogueSet = this.byDialogue.get(dialogueId);
      if (!dialogueSet) {
        dialogueSet = new Set();
        this.byDialogue.set(dialogueId, dialogueSet);
      }
      dialogueSet.add(taskId);
    }

    return () => this.removeSubscriber(taskId, subscriber, dialogueId);
  }

  /**
   * 取消单个 subscriber 的所有订阅（socket 关闭、WS 断连等场景）。
   */
  removeSubscriberById(subscriberId: string): void {
    const subscriber = this.allSubscribers.get(subscriberId);
    if (!subscriber) return;
    for (const [taskId, set] of this.byTask) {
      if (set.has(subscriber)) {
        set.delete(subscriber);
        if (set.size === 0) this.byTask.delete(taskId);
      }
    }
    this.allSubscribers.delete(subscriberId);
  }

  // R6-7: 删除 subscriberCount() 探测孔（dead code — 无 caller）。
  // 取消订阅 / 添加订阅由 Set.add / Set.delete 自然处理，无需查询接口。

  /**
   * 内部：按 taskId 扇出 stream 事件给所有 subscriber。
   * 失败/已死 subscriber 单独处理，不影响其他订阅者。
   *
   * kind 标识 stream 事件类型；payload 是 EventBus 原始 payload（已含 taskId，不含 kind）。
   */
  private fanOutByTask(kind: StreamEvent['kind'], taskId: string, rest: Record<string, unknown>): void {
    const set = this.byTask.get(taskId);
    if (!set || set.size === 0) return;
    const event = { kind, taskId, ...rest } as StreamEvent;
    for (const sub of [...set]) {
      let alive = true;
      try {
        alive = sub.push(event);
      } catch (err) {
        alive = false;
        logger.error({ err, subscriberId: sub.id, taskId, kind }, 'subscriber.push failed');
      }
      if (!alive) {
        set.delete(sub);
        this.allSubscribers.delete(sub.id);
        logger.debug({ subscriberId: sub.id, taskId }, 'subscriber 已死，自动清理');
      }
    }
    if (set.size === 0) this.byTask.delete(taskId);
  }

  /**
   * 内部：按 dialogueId 反查所有相关 taskId，再 fan-out。
   */
  private fanOutByDialogue(
    payload: { dialogueId: string; sessionId: string; status: 'started' | 'round_complete' | 'ended'; from: string; to: string; round: number },
  ): void {
    const taskIds = this.byDialogue.get(payload.dialogueId);
    if (!taskIds || taskIds.size === 0) return;
    const { dialogueId, ...rest } = payload;
    for (const taskId of taskIds) {
      this.fanOutByTask('dialogue.status', taskId, rest);
    }
  }

  /**
   * 内部：单订阅者退订
   */
  private removeSubscriber(taskId: string, subscriber: TransportSubscriber, dialogueId?: string): void {
    const set = this.byTask.get(taskId);
    if (set) {
      set.delete(subscriber);
      if (set.size === 0) this.byTask.delete(taskId);
    }
    if (dialogueId) {
      const dialogueSet = this.byDialogue.get(dialogueId);
      if (dialogueSet) {
        dialogueSet.delete(taskId);
        if (dialogueSet.size === 0) this.byDialogue.delete(dialogueId);
      }
    }
    // 全局 subscriber 索引只在「该 subscriber 没有任何 task 订阅」时才删除
    let hasAny = false;
    for (const s of this.byTask.values()) {
      if (s.has(subscriber)) { hasAny = true; break; }
    }
    if (!hasAny) this.allSubscribers.delete(subscriber.id);
  }
}

// ─── 模块级单例 ─────────────────────────────────────────────────────────────

let instance: StreamDispatcher | null = null;

/** 初始化 StreamDispatcher 单例并启动 EventBus 订阅 */
export function initStreamDispatcher(): StreamDispatcher {
  if (!instance) instance = new StreamDispatcher();
  instance.init();
  return instance;
}

/** 获取当前 StreamDispatcher 单例（未初始化时抛错） */
export function getStreamDispatcher(): StreamDispatcher {
  if (!instance) throw new Error('StreamDispatcher not initialized');
  return instance;
}

/** 重置（仅用于测试） */
export function resetStreamDispatcher(): void {
  if (instance) instance.shutdown();
  instance = null;
}
