/**
 * todo 常驻面板——GET /api/sessions/:id/todo + SSE 两帧驱动的呈现面。
 *
 * - 数据两源一真相：拉取腿定基，todo/write 帧全量替换、user/message 帧归零
 *   （CR-1——『用户输入段』边界）；todo === null（无表）整体收起；
 * - 只读呈现（状态迁移是模型职权——checkbox 交互属刀三呈现增强）。
 */

import type { TodoItem } from './types';

/** 状态图元三值（与 chat 件 TodoStatus 对齐的呈现映射） */
const GLYPH: Readonly<Record<string, string>> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

/** 面板属性：todo = null 收起 */
interface TodoPanelProps {
  readonly todo: readonly TodoItem[] | null;
}

/** todo 常驻面板（右栏） */
export function TodoPanel({ todo }: TodoPanelProps) {
  if (todo === null || todo.length === 0) return null;
  const inProgress = todo.filter((t) => t.status === 'in_progress').length;
  const done = todo.filter((t) => t.status === 'completed').length;
  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-neutral-800">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-neutral-400">任务清单</span>
        <span className="text-xs text-neutral-500">
          {done}/{todo.length}
          {inProgress > 0 ? ` · 进行 ${inProgress}` : ''}
        </span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {todo.map((t, i) => {
          const active = t.status === 'in_progress';
          const complete = t.status === 'completed';
          return (
            <li
              key={`${i}-${t.content}`}
              className={`rounded-md px-2 py-1.5 text-sm ${complete ? 'text-neutral-500' : 'text-neutral-200'}`}
              style={
                active ? { borderLeft: '2px solid var(--accent)', background: 'rgba(255,255,255,0.03)' } : undefined
              }
            >
              <span className="mr-1.5 select-none" style={active ? { color: 'var(--accent)' } : undefined}>
                {GLYPH[t.status] ?? '○'}
              </span>
              {/* in_progress 行优先 activeForm（「正在做什么」贴当前态——与 TUI 同规） */}
              {active && t.activeForm !== undefined ? t.activeForm : t.content}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
