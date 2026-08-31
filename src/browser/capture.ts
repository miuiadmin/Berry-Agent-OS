/**
 * L3 browser — per-session 捕获态（契约篇 §6.10 console 捕获 / a11y ref 表 /
 * dialog 自动 dismiss 条款，第四十九批刀二）。
 *
 * 事件源 = 引擎 browser 级单连接上的 target 级事件（按 CDP sessionId 分流后
 * 路由进本件——分流住 engine，语义处理住此处）。纯同步零 IO：dialog 的
 * 应答动作（Page.handleJavaScriptDialog）由调用方（engine 路由层）持 rpc 回发
 * ——本件只产出「该做什么」的判定，不发协议。
 */

/** console 环形缓冲条目（browser_console 工具返回面的单条形态） */
export interface ConsoleEntry {
  /** 单调序号（per-session 计数——工具结果可按它判先后/去重） */
  readonly seq: number;
  /** 条目类别：console API / 未捕获异常 / JS dialog（自动 dismiss 记一条） */
  readonly kind: 'console' | 'exception' | 'dialog';
  /** 级别（consoleAPICalled.type 或异常/dialog 固定档） */
  readonly level: 'log' | 'info' | 'warning' | 'error' | 'debug';
  /** 人读文本（参数拼接 / 异常描述 / dialog 消息） */
  readonly text: string;
  /** 事件时间戳（CDP timestamp——Unix epoch 毫秒） */
  readonly at: number;
}

/** 环形缓冲帽（规范钉死 200 条——旧条目滚动挤出） */
const CONSOLE_RING_CAP = 200;

/**
 * console 环形缓冲（per-session）。push 端 = 引擎事件路由；读端 =
 * browser_console 工具（最新在前）。
 */
export class ConsoleRing {
  /** 环形存储（写序append；超帽丢头部最旧） */
  private readonly buf: ConsoleEntry[] = [];
  /** per-session 单调序号（seq 连续性 = 截断可见性判据） */
  private nextSeq = 1;

  /** 追加一条（超帽挤出最旧） */
  push(entry: Omit<ConsoleEntry, 'seq'>): ConsoleEntry {
    const full: ConsoleEntry = { seq: this.nextSeq++, ...entry };
    this.buf.push(full);
    if (this.buf.length > CONSOLE_RING_CAP) this.buf.shift();
    return full;
  }

  /** 全量读取（最新在前——工具面「先看最新」消费序） */
  entries(): readonly ConsoleEntry[] {
    return [...this.buf].reverse();
  }
}

/** a11y ref 表条目（browser_snapshot 写入；click/type 查表消费） */
export interface SnapshotRefEntry {
  /** backendNodeId（DOM.getBoxModel 的锚——ref 的物证键） */
  readonly backendNodeId: number;
  /** role / name（快照时点快照——人读复核面） */
  readonly role: string;
  readonly name: string;
}

/**
 * 单 session 捕获态：console 环形缓冲 + 最近一次快照的 ref 表。
 * 生命周期 = context 同步（engine 建 context 时创建、回收时丢弃——
 * refs 表随快照整体换代，禁跨快照混用）。
 */
export class SessionCapture {
  readonly console = new ConsoleRing();
  /**
   * 最近快照 ref 表（@eN → 节点锚）。per-snapshot 换代语义：snapshot 工具
   * 整表替换；click/type 查表 miss = ref 过期 → 提示重拍快照（fail-loud）。
   */
  refs = new Map<string, SnapshotRefEntry>();
}

/** 事件处理判定产物（调用方据此回发协议——本件零协议发送） */
export interface CaptureOutcome {
  /** JS dialog 到场：需回发 Page.handleJavaScriptDialog({accept:false}) */
  readonly dialog?: { readonly message: string; readonly type: string };
}

/** RemoteObject 结构子集（consoleAPICalled.args 元素——值/描述两取） */
interface RemoteObjectLike {
  readonly type?: string;
  readonly value?: unknown;
  readonly description?: string;
}

/** exceptionDetails 结构子集（exceptionThrown 载荷） */
interface ExceptionDetailsLike {
  readonly text?: string;
  readonly exception?: { readonly description?: string; readonly value?: unknown };
}

/** consoleAPICalled.type → 环形缓冲 level 档（闭集外的归 log） */
const CONSOLE_TYPE_LEVELS: Readonly<Record<string, ConsoleEntry['level']>> = {
  log: 'log',
  info: 'info',
  warning: 'warning',
  error: 'error',
  debug: 'debug',
  verbose: 'debug',
  dir: 'log',
  dirxml: 'log',
  table: 'log',
  trace: 'log',
  group: 'log',
  groupCollapsed: 'log',
  groupEnd: 'log',
  clear: 'log',
  count: 'log',
  assert: 'error',
  timeEnd: 'log',
};

/** RemoteObject → 人读文本（原始值直取；对象/函数取 description） */
function remoteObjectText(obj: RemoteObjectLike): string {
  if (
    obj.description !== undefined &&
    obj.type !== undefined &&
    obj.type !== 'string' &&
    obj.type !== 'number' &&
    obj.type !== 'boolean'
  ) {
    return obj.description;
  }
  if (obj.value !== undefined) {
    return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value);
  }
  if (obj.description !== undefined) return obj.description;
  return obj.type ?? 'undefined';
}

/**
 * 单事件路由（纯同步）：console/异常/dialog 三类进环形缓冲；dialog 另出
 * 判定（调用方回发 dismiss）。未知事件静默（协议面宽进——新事件零破坏）。
 * @returns 处理判定（无动作 = undefined）
 */
export function applyCaptureEvent(
  capture: SessionCapture,
  method: string,
  params: unknown,
  at: number = Date.now(),
): CaptureOutcome | undefined {
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const type = typeof p.type === 'string' ? p.type : 'log';
      const args = Array.isArray(p.args) ? (p.args as RemoteObjectLike[]) : [];
      capture.console.push({
        kind: 'console',
        level: CONSOLE_TYPE_LEVELS[type] ?? 'log',
        text: args.map(remoteObjectText).join(' ') || '(空)',
        at,
      });
      return undefined;
    }
    case 'Runtime.exceptionThrown': {
      const d = (p.exceptionDetails ?? {}) as ExceptionDetailsLike;
      const text =
        d.exception?.description ??
        (d.exception?.value === undefined ? d.text : String(d.exception.value)) ??
        '未捕获异常';
      capture.console.push({ kind: 'exception', level: 'error', text, at });
      return undefined;
    }
    case 'Page.javascriptDialogOpening': {
      const message = typeof p.message === 'string' ? p.message : '';
      const type = typeof p.type === 'string' ? p.type : 'alert';
      capture.console.push({ kind: 'dialog', level: 'warning', text: `[${type}] ${message}（已自动 dismiss）`, at });
      return { dialog: { message, type } };
    }
    default:
      return undefined;
  }
}
