/**
 * L3 web — HTML→文本自写简版剥标签（契约篇 §1.5.2 ①，技术栈篇 §2 零新依赖）。
 *
 * 哲学钉死（规范冷读 #8）：**块删清单封闭三件不再扩**（script/style/noscript），
 * 其余元素一律标签剥；剥标签视图 = **JS 开启渲染近似**——无 JS 降级站正文住
 * noscript 的场景同理接受，不为它扩清单。textarea 等 RCDATA 内字面 `<script>`
 * 文本会被裸标签剥误删（丢文本非安全问题）——简版声明的接受面。
 *
 * 管线：块删（含未闭合尾部块）→ 块级标签转行（保段落结构）→ 剩余标签剥 →
 * 实体解码（命名 + 十进制/十六进制数字）→ 空白压缩（行内多空格并一、3+ 空行压一）。
 */

/** 块删目标（script 正文是代码、style 正文是样式、noscript 正文是无 JS 降级面——三件全删，清单封闭） */
const STRIP_BLOCKS = 'script|style|noscript';

/** 块级元素（开闭标签都转为换行——正文保段落/列表/表格行结构） */
const BLOCK_TAGS =
  'address|article|aside|blockquote|body|br|caption|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|legend|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

/** 命名实体表（HTML 高频件——全量 2000+ 实体表不引依赖，覆盖正文常见即止） */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  dagger: '†',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  laquo: '«',
  raquo: '»',
  rarr: '→',
  larr: '←',
  uarr: '↑',
  darr: '↓',
};

/** 实体解码：命名表 + `&#123;` 十进制 + `&#x1F;` 十六进制（未知实体原样保留——不吞正文） */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * HTML 源文本 → 纯文本（S 量级零依赖——非浏览器面渲染，够用即止的模型面预处理）。
 * markdown 转换不做（规范挂账）；调用方负责字节预算（本函数只做形态转换）。
 */
export function htmlToText(html: string): string {
  let text = html
    // ① 块删三件：闭合块整体删（大小写不敏感；`[\s\S]*?` 非贪婪跨行）
    .replace(new RegExp(`<(${STRIP_BLOCKS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi'), '')
    // ① 补：未闭合的尾部块（截断 HTML 的悬开 script/style——残留正文比代码噪声更伤模型）
    .replace(new RegExp(`<(${STRIP_BLOCKS})\\b[^>]*>[\\s\\S]*$`, 'gi'), '')
    // ② HTML 注释删（条件注释/构建注释对模型面纯噪声）
    .replace(/<!--[\s\S]*?-->/g, '')
    // ③ 块级标签 → 换行（保段落结构；开闭标签同转）
    .replace(new RegExp(`<\\/?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    // ④ 其余标签裸剥（inline 标签 a/span/em/code…——属性内含 `>` 的场景接受损耗，简版声明）
    .replace(/<[^>]+>/g, '');

  // ⑤ 实体解码（在标签剥之后——属性值已随标签丢弃，只解码正文实体）
  text = decodeEntities(text);

  // ⑥ 空白压缩：行内 [ \t]+ 并一空格 → 行 trim → 3+ 连空行压一空行
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
