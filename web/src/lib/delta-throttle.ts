/**
 * 流式 text/thinking delta 合并节流器（性能优化）。
 *
 * 问题：一次对话后端逐 token emit 1188 个 stream.block(text)，前端每个 delta → setState + 全列表
 * re-render，1188 次渲染卡死主线程 → WS heartbeat（60s 无消息）误断，用户看到"响应一半断掉"。
 * 本节流器按 blockId 累积 delta，requestAnimationFrame 下一帧合并回调一次（一帧内多次 push 只触发
 * 一次 flush），把 1188 次 setState 压到 ~60fps。
 *
 * 设计要点：
 *   - 按 blockId 分组累积（一个消息至多一个 text + 一个 thinking blockId，Map size ≤2，无内存隐患）。
 *   - rAF 调度：与浏览器渲染节拍对齐，flush 后紧跟一次 paint 不浪费 setState；后台标签页 rAF 自动暂停
 *     （切回前台由 visibilitychange → flushNow 兜底）。
 *   - flushNow 同步冲刷：流结束 / unmount / 切后台 / 切 session 时调用，保证 delta 不丢、blocks 不残缺。
 *   - 仅服务 text/thinking delta（高频）；tool/delegation/review（出生即终态、低频）不经过本节流器。
 */

/** 一个待 flush 的合并 delta（按 blockId 聚合后的一次回放单元） */
export interface PendingDelta {
  sessionId: string;
  messageId: string;
  /** 稳定 blockId（text=`${messageId}#text`，thinking=`${messageId}#thinking`），前端按此 upsert 追加 */
  blockId: string;
  blockType: 'text' | 'thinking';
  /** 合并后的 delta（同 blockId 多次 push 的 delta 拼接结果） */
  delta: string;
  ts: number;
  taskId?: string;
  correlationId?: string;
}

export class DeltaThrottle {
  /** key=blockId，value=累积的合并 delta（同 blockId 拼接） */
  private buffer = new Map<string, PendingDelta>();
  /** rAF 调度句柄；null=无待 flush 调度 */
  private rafId: number | null = null;

  /**
   * @param onFlush flush 时回调（rAF 帧或 flushNow），传入当前所有累积的合并 delta。
   *   回调内对每个 delta 调一次 applyBlock（store setState），一帧至多一次 setState/blockId。
   */
  constructor(private readonly onFlush: (deltas: PendingDelta[]) => void) {}

  /**
   * text/thinking delta 进入累积；调度 rAF 下一帧 flush。
   * 幂等：已有 rAF 在等待时不重复调度（一帧内多次 push 只排一次 rAF）。
   */
  push(d: PendingDelta): void {
    if (!d.delta) return; // 空 delta 不入 buffer（防无意义 flush）
    const existing = this.buffer.get(d.blockId);
    if (existing) {
      existing.delta += d.delta; // 同 blockId 拼接
    } else {
      this.buffer.set(d.blockId, { ...d });
    }
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.drain();
      });
    }
  }

  /**
   * 立即同步冲刷（流结束 result/cancelled / unmount / 切后台 visibilitychange / 切 session）。
   * 取消待 rAF + 同步 drain，保证残留 delta 不丢、blocks 不残缺。
   */
  flushNow(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.drain();
  }

  /** 内部：取出全部累积 delta，清空 buffer，回调 onFlush */
  private drain(): void {
    if (this.buffer.size === 0) return;
    const all = [...this.buffer.values()];
    this.buffer.clear();
    this.onFlush(all);
  }
}
