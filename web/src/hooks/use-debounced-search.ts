/**
 * useDebouncedSearch — 防抖搜索 hook。
 *
 * 返回一个防抖的 setter 函数，延迟指定毫秒数后才更新搜索值。
 * 适用于搜索输入框的实时过滤场景，避免每次按键都触发查询。
 *
 * 自动在组件卸载时清理待处理的定时器。
 */

import { useState, useMemo, useEffect } from "react";

interface DebouncedSetter {
  /** 防抖设置的函数——调用后不会立即更新 search 值，而是延迟 debounceMs 毫秒 */
  (value: string): void;
  /** 取消尚未执行的防抖更新 */
  cancel: () => void;
}

/**
 * 防抖搜索 hook。
 *
 * @param debounceMs 防抖延迟毫秒数，默认 300ms
 * @returns [search, debouncedSetter]
 *   - search: 当前生效的搜索词（经过防抖延迟后的值）
 *   - debouncedSetter: 防抖设置函数，用于绑定到 input 的 onChange
 */
export function useDebouncedSearch(debounceMs = 300): [string, DebouncedSetter] {
  const [search, setSearch] = useState("");

  const debouncedSearch = useMemo(() => {
    let timer: ReturnType<typeof setTimeout>;
    const debounced = (value: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => setSearch(value), debounceMs);
    };
    /** 取消待处理的防抖更新 */
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }, [debounceMs]);

  // 组件卸载时清理防抖定时器，防止内存泄漏
  useEffect(() => {
    return () => { debouncedSearch.cancel(); };
  }, [debouncedSearch]);

  return [search, debouncedSearch];
}
