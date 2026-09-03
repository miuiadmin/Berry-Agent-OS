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
 * 该 token（符号段代换后补尾空格、文件段代换 `@path#name `）。键盘：↑↓ 移动
 * 高亮、Enter/Tab 接受、Esc 关闭（弹层开时 Enter 不触发提交——补全优先）。
 *
 * 候选形（TUI-7，20260904——与 TUI 侧 channels/mention.ts 同笔同形）：文件段
 * 候选的目录条目携尾 '/'（服务端 webui/files.ts 同批）——目录接受不补尾空格
 * （token 不断，续走钻取）、文件接受补尾空格（token 收弹）；含空白的路径
 * 上屏采 `@"路径"` 引号形（裸形尾空格会击穿 token 判据字符类）；引号形目录
 * 接受后光标落闭引前（续输入继续落在引号内，续钻不断链——pi-tui 本地腿
 * 同形）。token 判据引号感知（`@"my dir/sub` 闭合/未闭合两形都命中）。
 *
 * 候选来源键（契约篇 §6.8 补裁，全面复盘 20260903 #13）：候选数组永远记生成
 * 它的查询身份（档位+pathPrefix）；取数落定与查询换代竞速、消费面读前键比对
 * 两腿守门——陈旧候选不渲染也不可接受（Enter 落回原文提交），防抖窗内新查询
 * 弹层呈空列表（loading 期空列表是诚实态）。
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
 *
 * 文件段引号感知（TUI-7，与 TUI 侧 FILE_SEGMENT_TOKEN 同笔同形）：路径段可
 * 为 `@"含空格路径` 引号形（闭引可有可无——引号形目录接受后光标落闭引前，
 * 续钻时闭引在光标后）。
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
  // 文件段：@path（引号形 `"…` 剥引号取真实前缀——闭引开引各至多一枚）
  const file = /(^|\s)@("[^"]*"?|[^@\s#]*)$/.exec(before);
  if (file !== null) {
    const seg = file[2]!;
    const pathPrefix = seg.startsWith('"') ? seg.replace(/^"|"$/g, '') : seg;
    return { start: file.index + file[1]!.length, end: before.length, pathPrefix };
  }
  return null;
}

/** 防抖间隔（毫秒）——逐字符输入不逐键打服务面 */
const DEBOUNCE_MS = 150;

/** 读前键门的空态常量（模块级共享引用——避免每次渲染造新数组身份） */
const NO_FILES: readonly string[] = [];
const NO_SYMBOLS: readonly SymbolItem[] = [];

/** 查询身份键（候选来源键——契约篇 §6.8 候选来源键补裁）：档位 + pathPrefix
 *  唯一标识一次取数；写侧守门（取数落定比对当前查询）与读侧键门（消费面读前
 *  比对 candidatesKey）共用同一键形 */
function queryKeyOf(q: MentionQuery): string {
  return q.symbolPrefix === undefined ? `files:${q.pathPrefix}` : `symbols:${q.pathPrefix}`;
}

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
  /** 当前查询身份键的同步镜像（候选来源键写侧腿）：effect 起点同步写——取数
   *  回调落定时与之比对，换代即弃置（陈旧取数落定/乱序应答两竞速一并守死） */
  const queryKeyRef = useRef('');
  /** 当前补全查询（null = 弹层关） */
  const [query, setQuery] = useState<MentionQuery | null>(null);
  /** 文件候选（files 档） */
  const [files, setFiles] = useState<string[]>([]);
  /** 符号候选（symbols 档） */
  const [symbols, setSymbols] = useState<SymbolItem[]>([]);
  /** 候选身份键（候选来源键读侧腿）：候选数组生成时的查询键——消费面读前
   *  比对当前查询，不匹配视为无候选（陈旧候选不可渲染不可接受） */
  const [candidatesKey, setCandidatesKey] = useState('');
  /** 符号档提示文案（预热中 / 无符号——替代空列表的诚实呈现） */
  const [symbolHint, setSymbolHint] = useState('');
  /** 高亮下标（↑↓ 移动、Enter/Tab 接受） */
  const [active, setActive] = useState(0);
  /** 取数中旗（弹层占位文案用） */
  const [loading, setLoading] = useState(false);

  /** 读前键门（候选来源键读侧腿，全面复盘 20260903 #13）：候选数组只在与当前
   *  查询同键时可见——陈旧取数落定/乱序应答/防抖窗内换代一律视为无候选（计数/
   *  键盘接受/渲染/鼠标接受全消费面走这两数组，陈旧项进不了 DOM 也接受不了） */
  const filesShown: readonly string[] =
    query !== null && query.symbolPrefix === undefined && candidatesKey === `files:${query.pathPrefix}`
      ? files
      : NO_FILES;
  const symbolsShown: readonly SymbolItem[] =
    query !== null && query.symbolPrefix !== undefined && candidatesKey === `symbols:${query.pathPrefix}`
      ? symbols
      : NO_SYMBOLS;

  /** 当前档候选总数（高亮循环上界）——读经键门数组（陈旧候选不计入） */
  const count = query?.symbolPrefix === undefined ? filesShown.length : symbolsShown.length;

  /* 值/光标变化 → 判档 + 防抖取数（弹层生命周期随 token 存亡） */
  useEffect(() => {
    const q = value === '' || disabled ? null : parseMention(value.slice(0, caretRef.current));
    // 候选来源键写侧腿（全面复盘 20260903 #13）：effect 起点同步镜像当前键——
    // 后落定的取数回调据此判换代（含查询关闭 '' 形态，陈旧落定一律弃置）
    queryKeyRef.current = q === null ? '' : queryKeyOf(q);
    setQuery(q);
    setActive(0);
    setSymbolHint('');
    if (q === null) return;
    const key = queryKeyOf(q);
    setLoading(true);
    const timer = setTimeout(() => {
      /** 落定守门：查询已换代即弃置（本轮回调全部 no-op——状态留待新查询自家的取数） */
      const stale = (): boolean => queryKeyRef.current !== key;
      if (q.symbolPrefix === undefined) {
        // 第一段：文件行走（失败静默收弹——补全不因取数错打断输入）
        fetchFiles(q.pathPrefix)
          .then((list) => {
            if (stale()) return;
            setFiles(list);
            setCandidatesKey(key);
          })
          .catch(() => {
            if (stale()) return;
            setFiles([]);
            setCandidatesKey(key);
          })
          .finally(() => {
            if (!stale()) setLoading(false);
          });
      } else {
        // 第二段：documentSymbol（404 → null = 无符号档；warming 如实提示）
        fetchSymbols(q.pathPrefix)
          .then((res) => {
            if (stale()) return;
            setSymbols(res === null ? [] : [...res.symbols]);
            setCandidatesKey(key);
            if (res === null) setSymbolHint('无符号（文件不在盘或语言不支持）');
            else if (res.warming === true) setSymbolHint('语言服务器预热中，稍后再试');
            else if (res.symbols.length === 0) setSymbolHint('无符号');
          })
          .catch(() => {
            if (stale()) return;
            setSymbols([]);
            setCandidatesKey(key);
            setSymbolHint('符号取数失败');
          })
          .finally(() => {
            if (!stale()) setLoading(false);
          });
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer); // token 继续变 → 旧防抖取消（逐键收敛到最后形态）
    // files/symbols/candidatesKey 不入依赖（它们是本 effect 的产物非输入）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, disabled]);

  /** 文件候选上屏形（TUI-7）：含空白路径采 `@"路径"` 引号形（裸形尾空格击穿
   *  token 判据字符类，含空格路径无法正确上屏）；与 TUI 侧 mentionValue 同笔同形 */
  function fileInsertion(file: string): string {
    return file.includes(' ') ? `@"${file}"` : `@${file}`;
  }

  /** 文件候选接受后缀（TUI-7）：目录不补尾空格（token 不断——续走钻取），
   *  文件补尾空格（token 收弹——再 @ 再触发） */
  function fileSuffix(file: string): string {
    return file.endsWith('/') ? '' : ' ';
  }

  /** 接受候选：代换 token（@path / @path#name）+ 尾空格 + 光标归位。
   *  引号形目录（后缀空）光标落闭引前——续输入继续落在引号内，续钻不断链
   *  （TUI-7，pi-tui 本地腿同形：caretOffset = insertion.length - 1） */
  function accept(insertion: string, suffix: string = ' '): void {
    const q = query;
    const input = inputRef.current;
    if (q === null || input === null) return;
    const next = `${value.slice(0, q.start)}${insertion}${suffix}${value.slice(q.end)}`;
    onChange(next);
    const caretInsideQuote = insertion.endsWith('"') && suffix === '';
    const caret = q.start + insertion.length + suffix.length - (caretInsideQuote ? 1 : 0);
    // caretRef 同步先行（遗漏大扫 20260902 #10 测试暴露的真缺陷）：value 变化
    // 触发的重解析 effect（宏任务）先于 rAF（render 阶段）跑——若 caretRef 仍
    // 是旧光标位，新值按旧位切片（如 '@s'）重命中 token，弹层立即重开 +
    // 防抖后重复取数，「代换即收弹（尾空格断 token）」落空。同步更新后
    // effect 以新光标切片（代换串 + 尾空格）断 token 收弹；rAF 只留 DOM 光
    // 标移动（受控值重渲染会重置光标，须下一帧拨回）
    caretRef.current = caret;
    requestAnimationFrame(() => {
      input.setSelectionRange(caret, caret);
    });
    setQuery(null); // 代换即收弹（尾空格断 token——再 @ 再触发；目录续钻走 parseMention 重开）
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
      // IME 组字判据（20260901-d #12，契约篇 §6.8 两段式条勘正）：组字确认的
      // Enter（isComposing=true）本意是上屏组字文本——不截不 preventDefault、
      // 放行给 IME（截获则 accept 的受控 value 覆写会中断组字会话，输入结果非
      // 用户所打；与下方提交分支同款判据）。Tab/方向键无 IME 语义保留现行为
      if (e.key === 'Enter' && e.nativeEvent.isComposing) return;
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        // 接受读键门数组：count>0 已保证非空，?? '' 仅防御位（active 循环界内）
        if (query.symbolPrefix === undefined) {
          const f = filesShown[active] ?? '';
          accept(fileInsertion(f), fileSuffix(f)); // 目录不补尾空格（TUI-7 续钻）
        } else accept(`@${query.pathPrefix}#${symbolsShown[active]?.name ?? ''}`);
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
                工作区文件{loading ? '…' : `（${filesShown.length}）`}
              </div>
              {filesShown.map((f, i) => (
                <button
                  key={f}
                  className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs ${
                    i === active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300'
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // 不夺输入焦点（mousedown 先于 blur）
                    accept(fileInsertion(f), fileSuffix(f)); // 目录不补尾空格（TUI-7 续钻）
                  }}
                  title={f}
                >
                  {f}
                </button>
              ))}
              {!loading && filesShown.length === 0 && (
                <div className="px-3 py-2 text-xs text-neutral-600">无匹配文件</div>
              )}
            </>
          ) : (
            /* 第二段：documentSymbol 候选（404/warming/空集 → 提示行） */
            <>
              <div className="border-b border-neutral-800 px-3 py-1 text-xs text-neutral-500">
                {query.pathPrefix} 的符号{loading ? '…' : `（${symbolsShown.length}）`}
              </div>
              {symbolsShown.map((s, i) => (
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
