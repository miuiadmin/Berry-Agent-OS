/**
 * 13.0 灵魂版 — 统一状态缓存。
 *
 * 纯内存的 KV 存储，用于管理 session/task 级别的临时状态。
 * Kernel 内部使用，不持久化（Kernel 重启后状态丢失可接受——session 已终止）。
 *
 * 命名空间约定（§4.4.5）：
 *   - intent_anchor:    key={sessionId}       — Brain 路由时产出的意图锚定
 *   - correction:       key={sessionId}:{taskId} — Brain 纠偏指令
 *   - active_scope:     key={taskId}           — 当前 task 的权限 scope
 *   - behavior_note:    key={sessionId}        — 跨 task 的行为习惯纠偏
 *   - inter_agent_budget: key={sessionId}      — 跨 agent 预算用量
 *   - mission_context:  key={sessionId}        — 当前活跃的 mission 上下文
 */

/** 纠偏指令（存入 correction 命名空间） */
export interface CorrectionEntry {
  /** Brain 的纠偏指令（自然语言） */
  instruction: string;
  /** 严重程度 — Brain LLM 自己判断 */
  severity: 'low' | 'medium' | 'high';
  /** 硬约束修改（scope 层强制执行） */
  scopeUpdate?: {
    /** 禁止访问的路径模式 */
    blockPaths?: string[];
    /** 禁止使用的工具 */
    blockTools?: string[];
    /** 额外约束（自然语言） */
    constraints?: string[];
  };
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
}

/** 行为笔记（存入 behavior_note 命名空间） */
export interface BehaviorNote {
  /** 纠偏指令 */
  instruction: string;
  /** 创建时间 */
  createdAt: number;
}

/** 跨 agent 预算（存入 inter_agent_budget 命名空间） */
export interface InterAgentBudget {
  /** 已消耗的跨 agent token 数 */
  tokensUsed: number;
  /** 跨 agent request 总次数 */
  requestCount: number;
  /** session 总 token 预算 */
  totalBudget: number;
}

/**
 * 统一状态缓存 — Kernel 内部使用。
 *
 * 两层 Map 结构：namespace → key → JSON-serialized value。
 * 所有 value 在存储时 JSON 序列化，读取时反序列化。
 */
export class StateCache {
  /** namespace → (key → JSON string) */
  private store = new Map<string, Map<string, string>>();

  /**
   * 按 (namespace, key) 存储值。
   * value 会被 JSON.stringify 序列化。
   */
  set(namespace: string, key: string, value: unknown): void {
    let nsMap = this.store.get(namespace);
    if (!nsMap) {
      nsMap = new Map();
      this.store.set(namespace, nsMap);
    }
    nsMap.set(key, JSON.stringify(value));
  }

  /**
   * 按 (namespace, key) 读取值。
   * 返回 undefined 如果不存在。
   */
  get<T = unknown>(namespace: string, key: string): T | undefined {
    const nsMap = this.store.get(namespace);
    if (!nsMap) return undefined;
    const raw = nsMap.get(key);
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as T;
  }

  /**
   * 按 (namespace, key) 删除值。
   */
  delete(namespace: string, key: string): void {
    const nsMap = this.store.get(namespace);
    if (!nsMap) return;
    nsMap.delete(key);
    // 命名空间为空时清理
    if (nsMap.size === 0) {
      this.store.delete(namespace);
    }
  }

  /**
   * 清除某个 key 下所有 namespace 的条目。
   * 用途：task 结束时按 taskId 清理所有相关状态。
   */
  deleteByKey(key: string): void {
    for (const [, nsMap] of this.store) {
      nsMap.delete(key);
    }
  }

  /**
   * 清除某个 namespace 下所有 key。
   * 用途：session 结束时按 namespace 批量清理。
   */
  deleteByNamespace(namespace: string): void {
    this.store.delete(namespace);
  }

  /**
   * 检查某个 (namespace, key) 是否存在。
   */
  has(namespace: string, key: string): boolean {
    const nsMap = this.store.get(namespace);
    return nsMap !== undefined && nsMap.has(key);
  }

  /**
   * 列出某个 namespace 下所有 key。
   */
  keys(namespace: string): string[] {
    const nsMap = this.store.get(namespace);
    if (!nsMap) return [];
    return [...nsMap.keys()];
  }

  /**
   * 获取某个 namespace 下的条目数量。
   */
  size(namespace: string): number {
    const nsMap = this.store.get(namespace);
    return nsMap?.size ?? 0;
  }

  /**
   * 清空所有状态。
   */
  clear(): void {
    this.store.clear();
  }
}
