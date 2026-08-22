/**
 * L1 session — 事件 data 快照与冻结（会话篇 §1.2 append 流水线步骤①②）。
 *
 * 单遍校验 + 拷贝：递归读一次即产出快照副本（getter 双读免疫），同时确保
 * 结果是纯 JSON 值（可被 SQLite 与任何读侧无损序列化）。deepFreeze 冻结后
 * 任何持有者都改不动事件日志里的数据——不可变性靠语言机制，不靠约定。
 */

import { AppError } from '../contracts/errors.js';

/**
 * 单遍 JSON 校验 + 快照拷贝。
 * 仅接受 null / boolean / number(有限) / string / 纯对象 / 数组；
 * undefined / function / symbol / bigint / NaN·Infinity / 类实例（Date、Map 等）/ 循环引用一律拒绝。
 * @param value 待校验的载荷
 * @param path 诊断用字段路径（顶层传 'data'）
 * @returns 深拷贝快照（与原值再无引用共享）
 * @throws AppError SESSION_EVENT_DATA_INVALID
 */
export function snapshotJsonValue(value: unknown, path: string): unknown {
  return snap(value, path, new Set());
}

/** 递归实现：ancestors 记录当前路径上的祖先对象，用于循环引用检测 */
function snap(value: unknown, path: string, ancestors: Set<object>): unknown {
  // 原始值：null/boolean/string 直接过；number 必须有限（JSON.stringify 会把 NaN/Infinity 变 null，显式拒绝）
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw dataInvalid(path, 'number 必须有限（NaN/Infinity 不可序列化）');
    }
    return value;
  }
  // 显式拒绝的非 JSON 类型
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    throw dataInvalid(path, `不允许的值类型：${typeof value}`);
  }
  // 对象/数组：类实例（Date/Map/Set/自定义类）原型非 Object/Array 原型，拒绝
  if (typeof value !== 'object') {
    throw dataInvalid(path, `不允许的值类型：${typeof value}`);
  }
  if (ancestors.has(value as object)) {
    throw dataInvalid(path, '循环引用');
  }
  const proto = Object.getPrototypeOf(value);
  const isPlainObject = proto === Object.prototype || proto === null;
  const isPlainArray = Array.isArray(value) && proto === Array.prototype;
  if (!isPlainObject && !isPlainArray) {
    throw dataInvalid(path, '只接受纯对象/数组（类实例请先转纯 JSON 结构）');
  }
  ancestors.add(value as object);
  try {
    if (Array.isArray(value)) {
      const out = new Array<unknown>(value.length);
      for (let i = 0; i < value.length; i++) {
        out[i] = snap(value[i], `${path}[${i}]`, ancestors);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      // 每个属性只读一次（snap 内完成校验+拷贝），属性描述符（getter 等）不会二次触发
      out[key] = snap((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value as object);
  }
}

/** 统一的非法载荷报错构造 */
function dataInvalid(path: string, why: string): AppError {
  return new AppError('SESSION_EVENT_DATA_INVALID', `事件 data 非法于 ${path}：${why}`);
}

/**
 * 深冻结（返回同引用）：递归 Object.freeze 数组与纯对象。
 * 冻结的是快照副本，外部原对象不受影响；配合快照实现「写入后不可变」。
 * 已冻结节点用 WeakSet 跳过，防环形结构死循环。
 */
export function deepFreeze<T>(value: T): T {
  freezeWalk(value as unknown, new WeakSet<object>());
  return value;
}

function freezeWalk(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') {
    return; // 原始值无需冻结
  }
  const obj = value as object;
  if (seen.has(obj)) {
    return; // 已访问（环形结构或共享引用），跳过
  }
  seen.add(obj);
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    freezeWalk((obj as Record<string, unknown>)[key], seen);
  }
}

/** 序列化字节数（体积护栏用；UTF-8 真实字节，中英文案一致对待） */
export function jsonBytes(value: unknown): number {
  // 值域已由 snapshotJsonValue 保证纯 JSON，stringify 不会失败；数字精度以 JS 原生为准
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}
