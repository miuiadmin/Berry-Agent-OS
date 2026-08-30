/**
 * 输入面 @-mention 两段补全（契约篇 §6.8 刀三呈现增强）。
 *
 * 两段式（聊天输入无打开文件上下文——documentSymbol 补全先锚文件）：
 * - `@` → 工作区文件路径补全（GET /api/workspace/files?prefix=——gitignore
 *   语义 + 双帽，目录也可补全）；
 * - `@path#` → 该文件 documentSymbol 二级补全（GET /api/workspace/symbols
 *   ?path=；404 降级 = 只留文件段〔无路由/根外/熔断/文件不在盘〕；warming 档
 *   = 语言服务器预热中——fire-and-forget，不等待拉起）。
 *
 * 触发判据 = 光标前的末 token 形态（`@片段` / `@路径#片段`）；选中断言代换
 * 该 token（文件段代换后补尾空格、符号段代换 `@path#name `）。键盘：↑↓ 移动
 * 高亮、Enter/Tab 接受、Esc 关闭（弹层开时 Enter 不触发提交——补全优先）。
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { fetchFiles, fetchSymbols } from './api';
import type { SymbolItem } from './types';

/** 光标前末 token 的两段判别产物（null = 无补全上下文） */
interface MentionQuery {
  /** '@' 起始下标（token 在输入串中的起点——接受代换的切面） */
  readonly start: number;
  /** 光标位置（代换右切面） */
  readonly end: number;
  /** 第一段：@ 后已输入的路径片段 */
  readonly pathPrefix: string;
  /** 第二段（symbols 档独有）：# 后已输入的符号片段 */
  readonly symbolPrefix?: string;
}

/**
 * 解析光标前文本的末 token（`@xxx` 文件段 / `@xxx#yyy` 符号段）。
 * '@' 必须紧跟行首或空白（邮箱样误触不触发）；段内字符禁空白与 '@' '#'。
 */
function parseMention(before: string): MentionQuery | null {
  // 符号段先试（更长的形态）：@path#sym
  const sym = /(^|\s)@([^@\s#]*)#([^@\s#]*)$/.exec(before);
  if (sym !== null) {
    return {
      start: sym.index + sym[1]!.length,
      end: before.length,
      pathPrefix: sym[2]!,
      symbolPrefix: sym[3]!,
    };
  }
  // 文件段：@path
  const file = /(^|\s)@([^@\s#]*)$/.exec(before);
  if (file !== null) {
    return { start: file.index + file[1]!.length, end: before.length, pathPrefix: file[2]! };
  }
  return null;
}

/** 防抖间隔（毫秒）——逐字符输入不逐键打服务面 */
const DEBOUNCE_MS = 150;

/** 输入面属性（受控 value + 提交上抛——提交语义与既有 footer 输入一致） */
interface MentionInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly disabled: boolean;
  readonly placeholder: string;
}

/** 带两段 @-mention 补全的输入面（footer 用） */
export function MentionInput({ value, onChange, onSubmit, disabled, placeholder }: MentionInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  /** 光标同步镜像——effect 里解析用（onChange 时点已更新，ref 免重渲染依赖） */
  const caretRef = useRef(0);
  /** 当前补全查询（null = 弹层关） */
  const [query, setQuery] = useState<MentionQuery | null>(null);
  /** 文件候选（files 档） */
  const [files, setFiles] = useState<string[]>([]);
  /** 符号候选（symbols 档） */
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  /** 符号档提示文案（预热中 / 无符号——替代空列表的诚实呈现） */
  const [symbolHint, setSymbolHint] = useState('');
  /** 高亮下标（↑↓ 移动、Enter/Tab 接受） */
  const [active, setActive] = useState(0);
  /** 取数中旗（弹层占位文案用） */
  const [loading, setLoading] = useState(false);

  /** 当前档候选总数（高亮循环上界） */
  const count = query?.symbolPrefix === undefined ? files.length : symbols.length;

  /* 值/光标变化 → 判档 + 防抖取数（弹层生命周期随 token 存亡） */
  useEffect(() => {
    const q = value === '' || disabled ? null : parseMention(value.slice(0, caretRef.current));
    setQuery(q);
    setActive(0);
    setSymbolHint('');
    if (q === null) return;
    setLoading(true);
    const timer = setTimeout(() => {
      if (q.symbolPrefix === undefined) {
        // 第一段：文件行走（失败静默收弹——补全不因取数错打断输入）
        fetchFiles(q.pathPrefix)
          .then((list) => setFiles(list))
          .catch(() => setFiles([]))
          .finally(() => setLoading(false));
      } else {
        // 第二段：documentSymbol（404 → null = 无符号档；warming 如实提示）
        fetchSymbols(q.pathPrefix)
          .then((res) => {
            setSymbols(res === null ? [] : [...res.symbols]);
            if (res === null) setSymbolHint('无符号（文件不在盘或语言不支持）');
            else if (res.warming === true) setSymbolHint('语言服务器预热中，稍后再试');
            else if (res.symbols.length === 0) setSymbolHint('无符号');
          })
          .catch(() => {
            setSymbols([]);
            setSymbolHint('符号取数失败');
          })
          .finally(() => setLoading(false));
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer); // token 继续变 → 旧防抖取消（逐键收敛到最后形态）
    // files/symbols 不入依赖（它们是本 effect 的产物非输入）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, disabled]);

  /** 接受候选：代换 token（@path / @path#name）+ 尾空格 + 光标归位 */
  function accept(insertion: string): void {
    const q = query;
    const input = inputRef.current;
    if (q === null || input === null) return;
    const next = `${value.slice(0, q.start)}${insertion} ${value.slice(q.end)}`;
    onChange(next);
    const caret = q.start + insertion.length + 1;
    requestAnimationFrame(() => {
      input.setSelectionRange(caret, caret);
      caretRef.current = caret;
    });
    setQuery(null); // 代换即收弹（尾空格断 token——再 @ 再触发）
  }

  /** 键盘编舞：弹层开时 ↑↓/Enter/Tab/Esc 全截（Enter 不冒泡成提交） */
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (query !== null && count > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % count);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + count) % count);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (query.symbolPrefix === undefined) accept(`@${files[active] ?? ''}`);
        else accept(`@${query.pathPrefix}#${symbols[active]?.name ?? ''}`);
        return;
      }
    }
    if (e.key === 'Escape' && query !== null) {
      e.preventDefault();
      setQuery(null); // 显式关闭（token 变更前不再自动重开——onchange 重解析）
      return;
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmit();
  }

  /** 弹层开态（有查询即开——空候选 + 提示文案也开：诚实呈现档） */
  const open = query !== null;
  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          caretRef.current = e.target.selectionStart ?? 0;
          onChange(e.target.value);
        }}
        onClick={(e) => {
          caretRef.current = e.currentTarget.selectionStart ?? 0;
        }}
        onKeyUp={(e) => {
          caretRef.current = e.currentTarget.selectionStart ?? 0;
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-[28rem] max-w-[80vw] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl">
          {query.symbolPrefix === undefined ? (
            /* 第一段：文件路径候选（目录也在列——@path 导航面） */
            <>
              <div className="border-b border-neutral-800 px-3 py-1 text-xs text-neutral-500">
                工作区文件{loading ? '…' : `（${files.length}）`}
              </div>
              {files.map((f, i) => (
                <button
                  key={f}
                  className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs ${
                    i === active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300'
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // 不夺输入焦点（mousedown 先于 blur）
                    accept(`@${f}`);
                  }}
                  title={f}
                >
                  {f}
                </button>
              ))}
              {!loading && files.length === 0 && <div className="px-3 py-2 text-xs text-neutral-600">无匹配文件</div>}
            </>
          ) : (
            /* 第二段：documentSymbol 候选（404/warming/空集 → 提示行） */
            <>
              <div className="border-b border-neutral-800 px-3 py-1 text-xs text-neutral-500">
                {query.pathPrefix} 的符号{loading ? '…' : `（${symbols.length}）`}
              </div>
              {symbols.map((s, i) => (
                <button
                  key={`${s.name}-${i}`}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs ${
                    i === active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300'
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    accept(`@${query.pathPrefix}#${s.name}`);
                  }}
                  title={s.name}
                >
                  <span className="truncate font-mono">{s.name}</span>
                  {s.line !== undefined && <span className="shrink-0 text-neutral-600">:{s.line}</span>}
                </button>
              ))}
              {symbolHint !== '' && !loading && <div className="px-3 py-2 text-xs text-neutral-600">{symbolHint}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
