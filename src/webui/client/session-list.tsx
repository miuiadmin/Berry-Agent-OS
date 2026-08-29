/**
 * 会话清单侧栏——GET /api/sessions 两源合并清单的呈现面 + 开新按钮。
 *
 * 行内信息：accent 色点（清单 theme 内嵌单源）/ 应用域 / cwd 尾段 / 相对
 * 时间 / 活·闭态。选中即切查看会话（App.select → 拉投影 + todo）。
 */

import type { SessionSummary } from './types';
import { relTime } from './app';

/** cwd 尾段（完整路径进 title 悬停——清单行宽度宝贵） */
function tail(path: string | undefined): string {
  if (path === undefined) return '';
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts.at(-1) ?? path;
}

/** 侧栏属性 */
interface SessionListProps {
  readonly sessions: readonly SessionSummary[];
  readonly viewedId: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly onOpen: () => void;
}

/** 会话清单侧栏（列表面板 + 头部开新按钮） */
export function SessionList({ sessions, viewedId, onSelect, onOpen }: SessionListProps) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-800">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-neutral-400">会话</span>
        <button
          className="rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-[var(--accent)] hover:text-[var(--accent)]"
          onClick={onOpen}
          title="开新会话（默认应用 · 驻留既有会话）"
        >
          + 开新
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-900 ${
                s.id === viewedId ? 'bg-neutral-900' : ''
              }`}
              style={s.id === viewedId ? { boxShadow: 'inset 2px 0 0 var(--accent)' } : undefined}
              onClick={() => onSelect(s.id)}
              title={s.cwd ?? s.id}
            >
              <span
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ background: s.accent ?? '#525252' }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.appId}</span>
                <span className="block truncate text-xs text-neutral-500">
                  {tail(s.cwd)}
                  {s.updatedAt !== undefined ? ` · ${relTime(s.updatedAt)}` : ''}
                </span>
              </span>
              {/* 活·闭态：闭 = 只读（灰）；活 = 绿点（可提交） */}
              {s.active ? (
                <span className="inline-block size-1.5 shrink-0 rounded-full bg-emerald-500" title="活会话" />
              ) : (
                <span className="shrink-0 text-xs text-neutral-600" title="已闭（只读）">
                  闭
                </span>
              )}
            </button>
          </li>
        ))}
        {sessions.length === 0 && <li className="px-3 py-4 text-xs text-neutral-600">暂无会话</li>}
      </ul>
    </aside>
  );
}
