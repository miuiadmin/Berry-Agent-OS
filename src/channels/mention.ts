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
 *
 * 第十轮 TUI 专项扫雷三笔（TUI-4/7/9，20260904）：
 * - **TUI-4 非文件段语境分流**：file wrap 的 token 判据不命中时不再一律
 *   委托内层——内层 Combined 的本地腿（force Tab 文件补全 / './x' '~/' 路径
 *   前缀 readdir 行走）在 attach 形态拿的是客户端本地 cwd，是错工作区。
 *   仅斜杠命令语境（判据镜像 Combined：非 force + 光标前行首 '/'——命令
 *   注册表是客户端本地数据，无工作区漂移）放行委托，其余收窄 null。
 * - **TUI-7 候选形对齐**：含空白的路径 value 采 `@"路径"` 引号形（裸形
 *   `@my notes.md ` 的尾空格击穿 token 判据字符类）；目录候选不补尾空格
 *   （续走钻取）——两形均与 pi-tui 本地腿 buildCompletionValue/applyCompletion
 *   同形。token 判据引号感知（`@"my dir/sub` 续钻不断链）。
 * - **TUI-9 face 拒绝不崩进程**：pi-tui 编辑器 fire-and-forget 调 provider
 *   （void 调用），face rejection 不捕即 unhandledRejection → signals.ts
 *   exit(1) 整进程死。两 wrap 拦截腿一律 try/catch → null（收弹不崩——
 *   与「命令错误是数据不是崩溃」同律）；options.signal 透传 face（换代
 *   即中止在飞取数）。
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
 *
 * 第二参 signal（TUI-9）：编辑器补全换代时传入的中止信号——face 应随行断
 * 请求（在飞取数不再有意义）。可选参：既有单参 lambda 依旧可赋值（缺参函数
 * 可赋给多参签名——组合根零改动），透传与否则由 face 实现者自决。
 */
export type SymbolsFace = (
  path: string,
  signal?: AbortSignal,
) => Promise<
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
      //
      // TUI-9：face 拒绝（网络/解码/中止等）= 补全失败非进程级事件——收弹
      // null 不冒泡（编辑器 fire-and-forget 调用，rejection 不捕即
      // unhandledRejection → signals.ts exit(1) 整进程死）；signal 透传 face
      //（编辑器换代即中止——在飞取数不再有意义）。
      let result: Awaited<ReturnType<SymbolsFace>>;
      try {
        result = await symbolsFor(token.path, options.signal);
      } catch {
        return null;
      }
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
 *
 * 目录条目携尾 '/'（TUI-7——与 pi-tui 本地腿目录形一致：label/value 皆尾
 * 斜杠，接受侧据此不补尾空格以续走钻取）。
 *
 * 第二参 signal（TUI-9，同 SymbolsFace）：编辑器补全换代中止信号，可选参。
 */
export type FilesFace = (
  prefix: string,
  signal?: AbortSignal,
) => Promise<{ readonly files: readonly string[] } | undefined>;

/**
 * 单段式 token 判据（文件段注入键）：光标前文本以 `@路径片段` 收尾（无 '#'——
 * 有 '#' 即符号段语境，归符号段 provider）；'@' 须紧跟行首/空白。与两段式
 * 判据互斥：FILE_TOKEN 排除 '#'、MENTION_TOKEN 必含 '#'。
 *
 * 引号感知（TUI-7）：路径段可为 `@"含空格路径` 引号形（闭引可有可无——接受
 * 目录候选后光标落闭引前，续钻时闭引在光标后；光标行至末尾则闭引在场）。
 * 与 pi-tui 本地腿 extractQuotedPrefix 同语义。
 */
const FILE_SEGMENT_TOKEN = /(^|\s)@("[^"]*"?|[^@\s#]*)$/;

/**
 * 文件候选 value 形（TUI-7）：与 pi-tui 本地腿 buildCompletionValue 同形——
 * 含空白的路径采 `@"路径"` 引号形（裸形 `@my notes.md ` 的尾空格会击穿
 * token 判据字符类 `[^@\s#]*`，含空格路径根本无法正确上屏）；其余裸形。
 */
function mentionValue(file: string): string {
  return file.includes(' ') ? `@"${file}"` : `@${file}`;
}

/** 从光标左侧文本解析单段 token（不匹配 = null——非文件段语境，走分流腿） */
function fileTokenAt(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
): { readonly start: number; readonly pathPrefix: string; readonly token: string } | null {
  const line = lines[cursorLine];
  if (line === undefined) return null;
  const m = FILE_SEGMENT_TOKEN.exec(line.slice(0, cursorCol));
  if (m === null) return null;
  const seg = m[2]!;
  // 引号形剥引号进 face 查询（开闭各至多一枚——token 判据已保证形态）；
  // token 串保留引号原形（prefix 锚与代换切面按用户实打文本计）
  const pathPrefix = seg.startsWith('"') ? seg.replace(/^"|"$/g, '') : seg;
  return { start: m.index + m[1]!.length, pathPrefix, token: `@${seg}` };
}

/**
 * 组装 @-mention 文件段注入 provider（filesFor 在场时的外层包装）。
 *
 * @param inner 内层 provider（CombinedAutocompleteProvider 或符号段包装——
 *   非单段 token 仅斜杠命令语境委托三面（TUI-4 分流），余者收窄 null）
 * @param filesFor 工作区文件查询面（undefined 结果 = 无弹层，不回委托——
 *   face 在场即宣告真源在远端，本地 fd 发现序对 attach 是错工作区）
 */
export function createFileSegmentProvider(inner: AutocompleteProvider, filesFor: FilesFace): AutocompleteProvider {
  return {
    ...(inner.triggerCharacters !== undefined ? { triggerCharacters: inner.triggerCharacters } : {}),

    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const token = fileTokenAt(lines, cursorLine, cursorCol);
      if (token === null) {
        // 非文件段语境分流（TUI-4）：filesFor 在场即宣告文件补全真源在远端，
        // 内层 Combined 的本地腿会拿 attach 客户端本地 cwd 冒充 daemon 工作
        // 区——force Tab 文件补全（extractPathPrefix force 恒返前缀 → 本地
        // readdir 行走）与 './x' '~/' 路径前缀腿全数收窄 null（无弹层诚实
        // 缺席）。唯一放行：斜杠命令语境（判据镜像 Combined：非 force +
        // 光标前文本以 '/' 起——命令注册表是客户端本地数据面，无工作区漂移
        // 可言）。两段 token 到达本分支只经外层符号段包装的 404 委托腿——
        // 同被收窄（内层 @ 模糊腿是 fd 本地行走，同属错工作区）。
        const line = lines[cursorLine] ?? '';
        const isSlashContext = options.force !== true && line.slice(0, cursorCol).startsWith('/');
        if (!isSlashContext) return null;
        return inner.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      // TUI-9：face 拒绝（网络/解码/中止等）= 收弹 null 不冒泡（编辑器
      // fire-and-forget 调用，rejection 即 unhandledRejection 崩进程）；
      // signal 透传 face（编辑器换代即中止在飞取数）
      let result: Awaited<ReturnType<FilesFace>>;
      try {
        result = await filesFor(token.pathPrefix, options.signal);
      } catch {
        return null;
      }
      // face 无话可说（404/连接失败）：无弹层不提示——诚实收窄，不回委托腿
      if (result === undefined) return null;
      // 防御性前缀过滤（服务端已过滤；face 若给全量也保正确——空前缀 = 全量）
      const items: AutocompleteItem[] = result.files
        .filter((file) => file.startsWith(token.pathPrefix))
        .map((file) => ({ value: mentionValue(file), label: file }));
      if (items.length === 0) return null; // 无命中 = 无弹层（与本地空走同形）
      return { items, prefix: token.token };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const token = fileTokenAt(lines, cursorLine, cursorCol);
      if (token === null) {
        // 非文件段语境（内层条目的接受路）：原样委托
        return inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      // 整 token 代换（从 '@' 起点到光标）——与 pi-tui 本地腿 applyCompletion
      // 严格同形（TUI-7）：目录（label 尾 '/'）不补尾空格（token 不断——续走
      // 钻取）；文件补尾空格（token 收弹）。引号形目录光标落闭引前（用户续
      // 输入继续落在引号内，续钻判据 `@"…` 不断链）；引号形文件光标落闭引后
      const line = lines[cursorLine]!;
      const isDirectory = item.label.endsWith('/');
      const suffix = isDirectory ? '' : ' ';
      const hasTrailingQuote = item.value.endsWith('"');
      const cursorOffset = isDirectory && hasTrailingQuote ? item.value.length - 1 : item.value.length;
      const replacement = `${item.value}${suffix}`;
      const next = line.slice(0, token.start) + replacement + line.slice(cursorCol);
      const out = lines.slice();
      out[cursorLine] = next;
      return { lines: out, cursorLine, cursorCol: token.start + cursorOffset + suffix.length };
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
