/**
 * Agent 崩溃期间的消息缓冲管理器
 *
 * R15 解耦审计：从 core-service.ts startInternal 内联的
 * crashedAgents Set + messageBuffer 数组 + crashBufferTimer 提取为独立类。
 *
 * 问题：
 * 1. 原实现中 10s 安全网和正常完成的 drain 逻辑是复制粘贴
 * 2. messageBuffer 全局共享但 crash handler 是 per-agent 的——
 *    同时崩溃两个 agent 时一个 handler 完成会释放另一个的消息
 *
 * 解决：按 agent name 隔离缓冲，drain 逻辑统一为一个方法。
 */

import type { RouteRequestPayload } from '../contracts/routing.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('crash-buffer');

/** 单条缓冲消息 */
interface BufferedMessage {
  payload: RouteRequestPayload;
  correlationId: string;
}

/** 消息路由器接口（仅暴露 sendRouteRequest） */
interface MessageRouter {
  sendRouteRequest(payload: RouteRequestPayload, correlationId: string): void;
}

export class CrashBufferManager {
  /** 正在崩溃处理中的 agent 集合 */
  private crashedAgents = new Set<string>();

  /** 按 agent name 隔离的消息缓冲 */
  private buffers = new Map<string, BufferedMessage[]>();

  /** per-agent 安全网定时器 */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 安全网超时（毫秒） */
  private readonly safetyTimeoutMs: number;

  constructor(options?: { safetyTimeoutMs?: number }) {
    this.safetyTimeoutMs = options?.safetyTimeoutMs ?? 10_000;
  }

  /**
   * 标记 agent 进入崩溃处理状态，缓冲后续消息
   *
   * @param name 崩溃的 agent name
   */
  markCrashed(name: string): void {
    this.crashedAgents.add(name);
    // 初始化该 agent 的缓冲队列
    if (!this.buffers.has(name)) {
      this.buffers.set(name, []);
    }
    // 清除旧的安全网定时器（如果有）
    const oldTimer = this.timers.get(name);
    if (oldTimer) clearTimeout(oldTimer);

    logger.debug({ agent: name }, 'agent 标记为崩溃状态，开始缓冲消息');
  }

  /**
   * 判断 agent 是否处于崩溃处理中
   */
  isCrashed(name: string): boolean {
    return this.crashedAgents.has(name);
  }

  /**
   * 缓冲一条消息（crash handler 执行期间新到达的消息）
   */
  bufferMessage(payload: RouteRequestPayload, correlationId: string): void {
    // 找到第一个正在崩溃的 agent，缓冲到其队列
    // （正常情况下同一时刻只有一个 agent 在崩溃）
    for (const [name, buffer] of this.buffers) {
      if (this.crashedAgents.has(name)) {
        buffer.push({ payload, correlationId });
        logger.debug({ agent: name, correlationId }, '消息已缓冲');
        return;
      }
    }
  }

  /**
   * 设置安全网定时器：超时后自动释放该 agent 的缓冲
   *
   * @param name agent name
   * @param router 消息路由器（用于 drain）
   */
  setSafetyTimer(name: string, router: MessageRouter): void {
    const timer = setTimeout(() => {
      logger.warn({ agent: name, timeoutMs: this.safetyTimeoutMs }, '崩溃安全网超时，强制释放缓冲');
      this.drainBuffer(name, router);
      this.crashedAgents.delete(name);
      this.timers.delete(name);
    }, this.safetyTimeoutMs);

    this.timers.set(name, timer);
  }

  /**
   * 释放指定 agent 的崩溃状态，并 drain 其缓冲消息
   *
   * @param name agent name
   * @param router 消息路由器（用于 drain）
   */
  release(name: string, router: MessageRouter): void {
    // 清除安全网定时器
    const timer = this.timers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(name);
    }

    // drain 缓冲消息
    this.drainBuffer(name, router);

    // 清除崩溃标记
    this.crashedAgents.delete(name);

    logger.debug({ agent: name }, 'agent 崩溃处理完成，缓冲已释放');
  }

  /**
   * 释放指定 agent 的缓冲消息到消息路由器
   */
  private drainBuffer(name: string, router: MessageRouter): void {
    const buffer = this.buffers.get(name);
    if (!buffer || buffer.length === 0) {
      this.buffers.delete(name);
      return;
    }

    const count = buffer.length;
    while (buffer.length > 0) {
      const { payload, correlationId } = buffer.shift()!;
      router.sendRouteRequest(payload, correlationId);
    }
    this.buffers.delete(name);

    logger.info({ agent: name, count }, '缓冲消息已释放到路由器');
  }

  /**
   * 销毁所有状态（服务关闭时调用）
   */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.crashedAgents.clear();
    this.buffers.clear();
  }
}
