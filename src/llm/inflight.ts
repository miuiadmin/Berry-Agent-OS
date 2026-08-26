/**
 * L1 llm — per-provider 在飞请求计数器（S4 前置债批，骨架篇 §3.2 前置债③）。
 *
 * 多驱动并发是现实形态（主对话 + N 子代理 + complete 单发同 provider），
 * 在飞帽 = 进程内背压：达帽**显式拒绝**（技术栈篇 §4.4 背压三件套进程内版——
 * 「显式拒绝，非有界排队」定调，不造排队口子）。
 *
 * 两出口同源计数（知 provider 的调用点有两个）：
 * - createStreamFn 主循环路：达帽编码为流内 error 事件（永不抛错契约保持，
 *   errorCode=LLM_INFLIGHT_LIMIT 归 transient 桶——会话层 auto-retry 退避后
 *   槽已释放重试成功，拒绝与重试天然咬合）；
 * - ctx.llm.complete 单发路：达帽同拒上抛（pi-ai 正则归 non-retryable）——
 *   过载期单发失败由调用方自然重试（记忆提取下轮 / compaction 下次触发）。
 *
 * 释放双保险（幂等）：消费面 for-await 的迭代 return() + 终态路径的 result()
 * 兜底——任一先到即减计数，重复调用无害。
 */

/** 在飞名额：一次性句柄，release 幂等（多次调用只减一次） */
export interface InFlightSlot {
  release(): void;
}

/**
 * per-provider 在飞计数器（装配处构造一份、两出口共享传入——「唯一知 provider
 * 的层」以模块内共享面形式成立，per-provider 名实相符）。
 */
export class InFlightTracker {
  /** 每 provider 在飞上限（0 = 不限——单机缺省 4，多驱动背压缺省开） */
  private readonly max: number;
  /** provider → 当前在飞数（0 时删键防泄漏增长） */
  private readonly counts = new Map<string, number>();

  constructor(maxPerProvider: number) {
    this.max = maxPerProvider;
  }

  /**
   * 尝试占一个名额（达帽返回 null = 显式拒绝信号，调用方按各自出口编码错误）。
   * @param provider 供应商标识（AssistantMessage.provider / 模型解析所得）
   */
  tryAcquire(provider: string): InFlightSlot | null {
    if (this.max <= 0) return NOOP_SLOT; // 0 = 不限：恒成功且不计数
    const current = this.counts.get(provider) ?? 0;
    if (current >= this.max) return null;
    this.counts.set(provider, current + 1);
    let released = false;
    return {
      release: () => {
        if (released) return; // 幂等：迭代 return() 与 result() 双路径只会生效一次
        released = true;
        const now = this.counts.get(provider) ?? 1;
        if (now <= 1) this.counts.delete(provider);
        else this.counts.set(provider, now - 1);
      },
    };
  }
}

/** 不限档的空名额（release 无操作——不计数也不减） */
const NOOP_SLOT: InFlightSlot = { release: () => undefined };
