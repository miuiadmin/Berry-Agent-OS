/**
 * 键盘交互共享工具。
 *
 * 目前只收口「箭头键 Tab 导航」这一处跨页面重复逻辑；
 * 后续若有其它键盘行为复用，可继续放这里。
 */

import type { KeyboardEvent } from "react";

/**
 * 箭头键 Tab 导航：ArrowRight/Down → 下一个、ArrowLeft/Up → 上一个，循环取模。
 *
 * SchedulerPage 与 SettingsPage 的 Tab 栏都手写了这套一模一样的逻辑，
 * 抽成共享函数后两处共用，避免改一处漏一处。
 *
 * - 命中方向键时自动 preventDefault，避免页面滚动。
 * - currentKey 不在 keys 中则忽略（防御性，正常不应发生）。
 *
 * 泛型 T 保证 onMove 收到的 key 与 keys 元素同类型（如 SchedulerPage 的 TabKey 联合）。
 *
 * @param e 键盘事件
 * @param keys 有序的 tab key 数组（建议传模块级常量）
 * @param currentKey 当前 tab 的 key
 * @param onMove 切换到目标 key（通常是 setTab / handleTabChange）
 */
export function moveTabOnArrow<T extends string>(
  e: KeyboardEvent,
  keys: readonly T[],
  currentKey: T,
  onMove: (key: T) => void,
): void {
  const idx = keys.indexOf(currentKey);
  if (idx < 0) return;
  const len = keys.length;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    e.preventDefault();
    onMove(keys[(idx + 1) % len]!);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    onMove(keys[(idx - 1 + len) % len]!);
  }
}
