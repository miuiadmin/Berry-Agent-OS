/**
 * L4 channels — @-mention 组合委托 provider 双件（符号段 + 文件段注入键）。
 *
 * 符号段（channels 批刀 B，契约篇 §6.8）：输入 token 匹配两段式判据
 * （`@path#sym`——与 webui MentionInput 判据字面一致；宿主/前端互禁
 * import〔刀二 CR-9〕，物理上是双份字面量，**改动两处同笔**）时拦截，
 * 调注入的 symbolsFor face 拿该文件 documentSymbol 补全；不匹配时原样
 * 委托内层 provider（命令补全等既有行为零漂移）。
 *
 * 文件段（daemon 刀二前置小改，契约篇 §6.8）：`filesFor` 注入键在场时拦截
 * 单段 token（`@路径片段`——无 '#'），补全真源切到注入 face（attach 客户端
 * 远程路由 GET /api/workspace/files）；缺省不包装，本地 fd 发现序不变。
 * 两段 token 空间判据互斥（文件段排除 '#'、符号段必含 '#'），双包装叠加
 * 次序无关。
 *
 * 诚实边界：符号段 face undefined（lsp 行未装/无路由/根外/熔断）= **委托腿
 * 回归**（inner 重获全权）；warming 档（语言服务器预热中）→ 无弹层不提示。
 * 文件段 face undefined = **无弹层不回委托**——face 在场即宣告「真源在
 * 远端」，回委托等于拿 attach 本地 cwd 冒充 daemon 工作区（漂移风险），
 * 404/连接失败一律诚实收窄。
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

/**
 * 工作区文件查询面（daemon 刀二 filesFor 注入键）：prefix = 用户 `@` 后已
 * 输入的路径片段（空串 = 全部），返回 root 相对路径候选（前缀序）；undefined
 * = 无话可说（404/连接失败——无弹层，不回委托腿）。结构类型：channels 不
 * import webui/app（拓扑边零新增），真身由 attach 客户端远程路由。
 */
export type FilesFace = (prefix: string) => Promise<{ readonly files: readonly string[] } | undefined>;

/**
 * 单段式 token 判据（文件段注入键）：光标前文本以 `@路径片段` 收尾（无 '#'——
 * 有 '#' 即符号段语境，归符号段 provider）；'@' 须紧跟行首/空白。与两段式
 * 判据互斥：FILE_TOKEN 排除 '#'、MENTION_TOKEN 必含 '#'。
 */
const FILE_SEGMENT_TOKEN = /(^|\s)@([^@\s#]*)$/;

/** 从光标左侧文本解析单段 token（不匹配 = null——非文件段语境，走委托腿） */
function fileTokenAt(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
): { readonly start: number; readonly pathPrefix: string; readonly token: string } | null {
  const line = lines[cursorLine];
  if (line === undefined) return null;
  const m = FILE_SEGMENT_TOKEN.exec(line.slice(0, cursorCol));
  if (m === null) return null;
  const pathPrefix = m[2]!;
  return { start: m.index + m[1]!.length, pathPrefix, token: `@${pathPrefix}` };
}

/**
 * 组装 @-mention 文件段注入 provider（filesFor 在场时的外层包装）。
 *
 * @param inner 内层 provider（CombinedAutocompleteProvider 或符号段包装——
 *   非单段 token 全部原样委托三面）
 * @param filesFor 工作区文件查询面（undefined 结果 = 无弹层，不回委托——
 *   face 在场即宣告真源在远端，本地 fd 发现序对 attach 是错工作区）
 */
export function createFileSegmentProvider(inner: AutocompleteProvider, filesFor: FilesFace): AutocompleteProvider {
  return {
    ...(inner.triggerCharacters !== undefined ? { triggerCharacters: inner.triggerCharacters } : {}),

    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const token = fileTokenAt(lines, cursorLine, cursorCol);
      if (token === null) {
        // 非文件段语境（命令补全/两段符号 token）：原样委托
        return inner.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      const result = await filesFor(token.pathPrefix);
      // face 无话可说（404/连接失败）：无弹层不提示——诚实收窄，不回委托腿
      if (result === undefined) return null;
      // 防御性前缀过滤（服务端已过滤；face 若给全量也保正确——空前缀 = 全量）
      const items: AutocompleteItem[] = result.files
        .filter((file) => file.startsWith(token.pathPrefix))
        .map((file) => ({ value: `@${file}`, label: file }));
      if (items.length === 0) return null; // 无命中 = 无弹层（与本地空走同形）
      return { items, prefix: token.token };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const token = fileTokenAt(lines, cursorLine, cursorCol);
      if (token === null) {
        // 非文件段语境（内层条目的接受路）：原样委托
        return inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      // 整 token 代换（从 '@' 起点到光标）+ 尾空格——与符号段代换同形
      const line = lines[cursorLine]!;
      const replacement = `${item.value} `;
      const next = line.slice(0, token.start) + replacement + line.slice(cursorCol);
      const out = lines.slice();
      out[cursorLine] = next;
      return { lines: out, cursorLine, cursorCol: token.start + replacement.length };
    },

    // 第三面委托（斜杠命令语境 Tab 行为——漏转则漂移，与符号段同款）
    ...(inner.shouldTriggerFileCompletion !== undefined
      ? {
          shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
            return inner.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol);
          },
        }
      : {}),
  };
}
