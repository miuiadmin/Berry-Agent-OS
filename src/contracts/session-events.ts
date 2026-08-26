/**
 * L0 contracts — durable 会话事件类型注册表（会话篇 §1.1 核心词汇 / §2.1
 * 插件扩展词汇；2026-08-25 Hermes 探针 #19 收口后自 session 模块迁入——
 * 单一来源住 contracts，session/event-types 再导出、旧消费面零改动；
 * berryagent 虚拟面随之可取，与 messages.ts #16 收口同款）。
 *
 * 与错误码同纪律（内核篇 §5.3）：词汇显式注册、运行时可枚举、CI 可校验。
 * 核心清单之外，插件可经 registerSessionEventType 显式注册扩展类型——
 * 未知类型且非 ignorable，读侧整体拒绝（SESSION_FORMAT_UNSUPPORTED）。
 *
 * 双入口纪律（与消息角色 contracts/messages.ts 同构，会话篇 §2.1 落码注记）：
 * - 插件面 registerPluginSessionEventType（ctx.registerSessionEventType 落点）：
 *   作用域化——注销器挂 ctx effect 栈，/reload 销锚即词汇随插件回卷、重装重注册
 *   （jiti moduleCache:false 下裸模块级注册会撞重复注册，插件面必须作用域化）；
 *   核心词拒注册 SESSION_CORE_TYPE_FORBIDDEN（与 appendEvent 写侧同码——
 *   注册侧先拦，伪造词汇与伪造写入同罪）。
 * - 宿主面 registerSessionEventType：模块级直调（官方件随包代码存在、组合
 *   无关——memory/diff 保持模块顶层注册：旧日志可读性不随组合树行装载漂移）。
 */

import { AppError, SESSION_CORE_TYPE_FORBIDDEN, SESSION_FORMAT_UNSUPPORTED } from './errors.js';

/** 事件类别三分法（会话篇 §1.1）：决定事件在投影/存储分层中的处理方式 */
export type SessionEventCategory =
  /** 表面事件：构成派生表面（模型历史投影输入）——user/message、assistant/message、tool/call、tool/result、todo/write */
  | 'surface'
  /** 快照事件：组装参数变化时整体重写（request/header） */
  | 'snapshot'
  /** log-only：落日志即目的（不进表面推导）——approval/*、gate/decision、sandbox/mode、llm/usage，以及 turn 边界与种子标记等结构事件 */
  | 'log-only';

/** 事件类型注册项 */
export interface SessionEventTypeDefinition {
  /** 事件类型词汇，小写斜线式 `<域>/<动作>` */
  readonly type: string;
  /** 类别三分法归属 */
  readonly category: SessionEventCategory;
  /** true = 读侧可以不认识此类型（向前兼容）；缺省 false = 未知即整体拒绝 */
  readonly ignorable?: boolean;
  /**
   * 预留词汇：当前无宿主写点、但属已拍板词汇表的预留项（如 todo/write——
   * 随 M2+ 工作台三件落码）。check-events「每目录项 ≥1 写点」方向据此
   * 显式豁免（契约篇 §6.3 第 4 条落码注记）——豁免必须声明，不静默。
   */
  readonly reserved?: boolean;
}

/** 类型词汇格式：小写字母/数字/连字符段，至少一个斜线分隔（`<域>/<动作>`） */
const TYPE_FORMAT = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/;

/** 已注册事件类型表（模块级单例：type → 定义） */
const registry = new Map<string, SessionEventTypeDefinition>();

/**
 * 共享注册核：格式/占用检查 + 入表（入口各自做核心词检查后调用）。
 * @returns 注销函数（仅当仍是本定义时移除——防误注销后来者；二次注销无害）
 */
function addToRegistry(def: SessionEventTypeDefinition): () => void {
  if (!TYPE_FORMAT.test(def.type)) {
    throw new AppError(SESSION_FORMAT_UNSUPPORTED, `事件类型格式非法：${def.type}（应为小写斜线式 <域>/<动作>）`);
  }
  if (registry.has(def.type)) {
    throw new AppError(SESSION_FORMAT_UNSUPPORTED, `事件类型重复注册：${def.type}`);
  }
  registry.set(def.type, def);
  return () => {
    if (registry.get(def.type) === def) {
      registry.delete(def.type);
    }
  };
}

/**
 * 注册一个事件类型（宿主面入口；核心清单在下方模块加载时已全量注册）。
 * 重复注册或格式非法直接抛错——事件词汇必须在装配期钉死，不留运行时漂移。
 * @returns 注销函数（官方件随包常驻通常不调；测试清理用）
 */
export function registerSessionEventType(def: SessionEventTypeDefinition): () => void {
  return addToRegistry(def);
}

/**
 * 注册一个事件类型（插件面入口——`ctx.registerSessionEventType` 的落点）。
 * 核心词拒绝：与 appendEvent 写侧 SESSION_CORE_TYPE_FORBIDDEN 同码，注册侧
 * 先拦——插件不得伪造内核词（sendUserMessage 归因/守门结算语义绑宿主写点）。
 * @returns 注销函数（ctx 面已自动挂作用域 effect 栈；此处直调则由调用方自理）
 */
export function registerPluginSessionEventType(def: SessionEventTypeDefinition): () => void {
  if (coreTypes.has(def.type)) {
    throw new AppError(SESSION_CORE_TYPE_FORBIDDEN, `核心事件类型禁止插件注册：${def.type}（内核词写入权属宿主）`);
  }
  return addToRegistry(def);
}

/** 查询类型定义；未注册返回 undefined（调用方按 ignorable 语义决定拒绝与否） */
export function getSessionEventType(type: string): SessionEventTypeDefinition | undefined {
  return registry.get(type);
}

/** 枚举全部已注册事件类型（CI 校验 / 诊断输出用） */
export function listSessionEventTypes(): SessionEventTypeDefinition[] {
  return [...registry.values()].sort((a, b) => a.type.localeCompare(b.type));
}

/* ------------------------------------------------------------------ */
/* 核心清单（首批 14 类，模块加载时注册）                                */
/* ------------------------------------------------------------------ */

/**
 * 核心事件类型词汇。类别归属依据会话篇 §1.1 三分法；turn/start、turn/end、
 * session/end-seed 属结构标记（不进表面推导），归 log-only。
 */
export const CORE_EVENT_TYPES: readonly SessionEventTypeDefinition[] = [
  { type: 'turn/start', category: 'log-only' },
  { type: 'turn/end', category: 'log-only' },
  { type: 'user/message', category: 'surface' },
  { type: 'assistant/message', category: 'surface' },
  { type: 'tool/call', category: 'surface' },
  { type: 'tool/result', category: 'surface' },
  { type: 'todo/write', category: 'surface', reserved: true },
  { type: 'request/header', category: 'snapshot' },
  { type: 'session/end-seed', category: 'log-only' },
  { type: 'approval/asked', category: 'log-only' },
  { type: 'approval/decided', category: 'log-only' },
  { type: 'gate/decision', category: 'log-only' },
  { type: 'sandbox/mode', category: 'log-only' },
  { type: 'llm/usage', category: 'log-only' },
  { type: 'llm/retry', category: 'log-only' },
  // 卸载落账（契约篇 §3.4 第二刀，2026-08-27 刀 2）：宿主写点（组合根
  // emitUninstalled——uninstall 真身住 Ring 0「装」职能），核心词身份自动拒
  // 插件面注册/伪造（SESSION_CORE_TYPE_FORBIDDEN 双闸同判据）；复数域 = 管理面
  // 词汇，与活体目录 plugins/uninstalled 同词双落地（总线 + 会话流）
  { type: 'plugins/uninstalled', category: 'log-only' },
];

/** 核心词集合（插件面拒注册的判据——含 reserved 预留词，核心族一体保护） */
const coreTypes = new Set(CORE_EVENT_TYPES.map((def) => def.type));

/**
 * 是否核心事件词（内核词——写入权与注册权均属宿主）：appendEvent 写侧与
 * registerPluginSessionEventType 注册侧同判据单一来源（两道闸一道尺）。
 */
export function isCoreSessionEventType(type: string): boolean {
  return coreTypes.has(type);
}

for (const def of CORE_EVENT_TYPES) {
  registerSessionEventType(def);
}
