/**
 * L4 channels — @-mention 符号段补全 provider（channels 批刀 B，契约篇 §6.8）。
 *
 * 组合委托 provider：输入 token 匹配两段式判据（`@path#sym`——与 webui
 * MentionInput 判据字面一致；宿主/前端互禁 import〔刀二 CR-9〕，物理上是
 * 双份字面量，**改动两处同笔**）时拦截，调注入的 symbolsFor face 拿该文件
 * documentSymbol 补全；不匹配时原样委托内层 provider（命令补全等既有行为
 * 零漂移）。
 *
 * 诚实边界：face undefined（lsp 行未装/无路由/根外/熔断）= **委托腿回归**
 * （inner 重获全权——lsp 行回卷后 TUI 补全面回到未包装状态）；warming 档
 * （语言服务器预热中）→ 无弹层不提示（pi-tui 弹层无提示行机制，不为 TUI
 * 造新机制——SPA 有提示行、TUI 诚实收窄）。
 */

import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@earendil-works/pi-tui/dist/autocomplete.js';

/**
 * documentSymbol 查询面（刀三行面晚绑桥第二消费点——lsp 行 apply 挂真身、
 * 回卷摘除）。结构类型：channels 不 import lsp/webui（拓扑边零新增）。
 * undefined = 404 档（无路由/根外/熔断/行未装）；warming = 语言服务器预热中。
 * line 1-based、kind 为 LSP SymbolKind 数值（协议直传——人话不可读，TUI 呈
 * 现只用行号）。
 */
export type SymbolsFace = (path: string) => Promise<
  | {
      readonly symbols: readonly { readonly name: string; readonly line?: number; readonly kind?: number }[];
      readonly warming?: boolean;
    }
  | undefined
>;

/**
 * 两段式 token 判据（符号段）：光标前文本以 `@路径#符号片段` 收尾——'@' 须
 * 紧跟行首/空白（邮箱样误触不触发），段内字符禁空白与 '@' '#'。字面与 webui
 * MentionInput 的 parseMention 符号段分支一致（双份维护，改动两处同笔）。
 */
const MENTION_TOKEN = /(^|\s)@([^@\s#]*)#([^@\s#]*)$/;

/** 从光标左侧文本解析两段 token（不匹配 = null——非符号段语境，走委托腿） */
function mentionTokenAt(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
): { readonly start: number; readonly path: string; readonly symbolPrefix: string; readonly token: string } | null {
  const line = lines[cursorLine];
  if (line === undefined) return null;
  const before = line.slice(0, cursorCol);
  const m = MENTION_TOKEN.exec(before);
  if (m === null) return null;
  const path = m[2]!;
  const symbolPrefix = m[3]!;
  return { start: m.index + m[1]!.length, path, symbolPrefix, token: `@${path}#${symbolPrefix}` };
}

/** 符号条目 description：1-based 行号（kind 为 SymbolKind 数值人话不可读——TUI 不显） */
function describeSymbol(symbol: { readonly line?: number }): string | undefined {
  return symbol.line === undefined ? undefined : `:${symbol.line}`;
}

/**
 * 组装 @-mention 符号段 provider。
 *
 * @param inner 内层 provider（CombinedAutocompleteProvider——命令/@ 文件段
 *   既有三面；非两段 token 全部原样委托，含 shouldTriggerFileCompletion——
 *   漏转第三面则斜杠命令语境 Tab 行为漂移）
 * @param symbolsFor documentSymbol 查询面（undefined = 404 档 → 无弹层）
 */
export function createMentionProvider(inner: AutocompleteProvider, symbolsFor: SymbolsFace): AutocompleteProvider {
  return {
    // 触发字沿用内层声明（若有）——本 provider 不新增触发字，'#' 已在编辑器
    // 缺省触发字表（DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS @/#）
    ...(inner.triggerCharacters !== undefined ? { triggerCharacters: inner.triggerCharacters } : {}),

    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const token = mentionTokenAt(lines, cursorLine, cursorCol);
      if (token === null) {
        // 非两段语境：原样委托（命令补全/文件段行走——既有行为零漂移）
        return inner.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      // 符号段拦截：face undefined = 404 档（lsp 行未装/无路由/根外/熔断）
      // ——**委托腿回归**（验收 h）：inner 重获对输入的全权裁决（lsp 行回卷后
      // TUI 补全面回到未包装状态；今日 fd 未接 → @ 腿恒空 → 实效仍无弹层，
      // 但裁决权归 inner，不为 404 档私造第二裁决点）
      const result = await symbolsFor(token.path);
      if (result === undefined) return inner.getSuggestions(lines, cursorLine, cursorCol, options);
      // warming 档：语言服务器预热中——无弹层不提示（face 在场，不退委托：
      // 预热是暂态非「无话可说」；pi-tui 弹层无提示行机制，不为 TUI 造新机制）
      if (result.warming === true) return null;
      // 名称前缀过滤（symbolPrefix 空 = 全量——刚敲 '#' 的第一拍）
      const items: AutocompleteItem[] = result.symbols
        .filter((symbol) => symbol.name.startsWith(token.symbolPrefix))
        .map((symbol) => ({
          value: `@${token.path}#${symbol.name}`,
          label: symbol.name,
          ...(describeSymbol(symbol) !== undefined ? { description: describeSymbol(symbol) } : {}),
        }));
      if (items.length === 0) return null; // 无命中 = 无弹层（与空文件段同形）
      return { items, prefix: token.token };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const token = mentionTokenAt(lines, cursorLine, cursorCol);
      if (token === null) {
        // 非两段语境（内层条目的接受路）：原样委托
        return inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      // 整 token 代换（从 '@' 起点到光标）+ 尾空格——与 SPA 符号段代换
      // （`@path#name `）同形：补全后直接接续正文，不打字员手动补格
      const line = lines[cursorLine]!;
      const replacement = `${item.value} `;
      const next = line.slice(0, token.start) + replacement + line.slice(cursorCol);
      const out = lines.slice();
      out[cursorLine] = next;
      return { lines: out, cursorLine, cursorCol: token.start + replacement.length };
    },

    // 第三面委托（内层未实现时省略——保持 undefined 语义由编辑器自理）
    ...(inner.shouldTriggerFileCompletion !== undefined
      ? {
          shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
            return inner.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol);
          },
        }
      : {}),
  };
}
