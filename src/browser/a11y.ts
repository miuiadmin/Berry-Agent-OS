/**
 * L3 browser — a11y 快照渲染（契约篇 §6.10 a11y/ref 模型段，第四十九批刀二）。
 *
 * 输入 = DOM.getFlattenedDocumentTree 的扁平节点表（真 Chrome 形态：nodeId/
 * parentId 同空间引用 + 每节点带 backendNodeId），输出 = 人读缩进树文本 +
 * 可交互节点 ref 表（@eN → backendNodeId 锚——click/type 坐标派的查表键）。
 *
 * 纯函数零 IO：role/name 推导规则全在此单点（规范钉死：aria role 属性优先 →
 * tag 隐式映射 → generic；name 链 aria-label > alt > placeholder > title >
 * 子树文本首段截断 80 字符）。
 */

/** 扁平文档节点（CDP DOM.Node 结构子集——桥层只透传这三族键） */
export interface FlatDocNode {
  /** CDP nodeId（树内引用空间——parentId 的键空间） */
  readonly nodeId?: number;
  /** 协议物证键（boxModel/ref 表的锚——真 Chrome 恒在） */
  readonly backendNodeId: number;
  /** DOM nodeType（1 元素 / 3 文本 / 9 文档 / 11 shadow root） */
  readonly nodeType: number;
  /** 大写标签名（'#document'/'#text' 等特殊名同 CDP） */
  readonly nodeName: string;
  /** 文本节点值 */
  readonly nodeValue?: string;
  /** 扁平属性表 [k, v, k, v, ...] */
  readonly attributes?: readonly string[];
  /** 父节点 nodeId（根节点缺席） */
  readonly parentId?: number;
}

/** ref 表条目（snapshot 产物——engine capture.refs 的写入形态） */
export interface A11yRef {
  /** 引用名（@e0 起 per-snapshot 递增） */
  readonly ref: string;
  /** 坐标派锚（DOM.getBoxModel({backendNodeId})） */
  readonly backendNodeId: number;
  readonly role: string;
  readonly name: string;
}

/** 快照产物（browser_snapshot 工具返回面） */
export interface A11ySnapshot {
  /** 人读缩进树文本（interactive 行尾带 @eN） */
  readonly text: string;
  /** ref 表（与文本 @eN 一一对应） */
  readonly refs: readonly A11yRef[];
  /** 文本超帽截断旗（true = 树过深/过宽，尾行带截断注记） */
  readonly truncated: boolean;
}

/** 快照文本帽（64KiB——超帽停止渲染并注记，防巨页打爆上下文） */
export const SNAPSHOT_MAX_BYTES = 64 * 1024;

/** name 截断长（子树文本首段上限——人读面足够定位） */
const NAME_MAX_CHARS = 80;

/** tag（小写）→ 隐式 role 映射表（无 aria role 属性时的推导层） */
const TAG_ROLE: Readonly<Record<string, string>> = {
  a: 'link', // 无 href 的 a 归 generic——见 roleOf 特判
  button: 'button',
  textarea: 'textbox',
  select: 'combobox',
  option: 'option',
  optgroup: 'group',
  img: 'img',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  header: 'banner',
  footer: 'contentinfo',
  form: 'form',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  thead: 'rowgroup',
  tbody: 'rowgroup',
  label: 'label',
  p: 'paragraph',
  svg: 'graphics',
  video: 'video',
  audio: 'audio',
  canvas: 'canvas',
  dialog: 'dialog',
  output: 'status',
  progress: 'progressbar',
  meter: 'meter',
  details: 'group',
  summary: 'disclosure',
};

/** input[type] → role 映射（type 缺省/未知归 textbox） */
const INPUT_TYPE_ROLE: Readonly<Record<string, string>> = {
  text: 'textbox',
  search: 'searchbox',
  email: 'textbox',
  url: 'textbox',
  tel: 'textbox',
  password: 'textbox',
  number: 'spinbutton',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  color: 'textbox',
  date: 'textbox',
  'datetime-local': 'textbox',
  time: 'textbox',
  month: 'textbox',
  week: 'textbox',
  file: 'button',
  submit: 'button',
  reset: 'button',
  button: 'button',
  image: 'button',
};

/** 可交互 role 集（标 @eN 进 ref 表——click/type/press 的合法靶） */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'slider',
  'switch',
  'treeitem',
]);

/** 扁平属性表 → 对象视图（[k, v, ...] → Record） */
function attrsOf(node: FlatDocNode): Record<string, string> {
  const out: Record<string, string> = {};
  const a = node.attributes;
  if (a === undefined) return out;
  for (let i = 0; i + 1 < a.length; i += 2) out[a[i]!.toLowerCase()] = a[i + 1]!;
  return out;
}

/** 元素节点 role 推导（aria role 属性 > tag 隐式映射 > generic） */
function roleOf(tag: string, attrs: Record<string, string>): string {
  const aria = attrs['role'];
  if (aria !== undefined && aria.trim() !== '') return aria.trim().split(/\s+/)[0]!;
  if (tag === 'a' && attrs['href'] === undefined) return 'generic'; // 无 href 锚点不可交互
  if (tag === 'input') return INPUT_TYPE_ROLE[attrs['type'] ?? 'text'] ?? 'textbox';
  return TAG_ROLE[tag] ?? 'generic';
}

/** 空白归一（任意空白串压成单空格 + 去首尾） */
function normalizeWs(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * 子树文本（深度优先收集文本节点值——name 推导链最末位取值源）。
 * 短路设计：已够 NAME_MAX_CHARS×2 即停（长文本页防全树扫描）。
 */
function subtreeText(nodeId: number, byId: Map<number, FlatDocNode>, childrenOf: Map<number, number[]>): string {
  const parts: string[] = [];
  let budget = NAME_MAX_CHARS * 2;
  const walk = (id: number): void => {
    if (budget <= 0) return;
    const n = byId.get(id);
    if (n === undefined) return;
    if (n.nodeType === 3 && n.nodeValue !== undefined) {
      const t = normalizeWs(n.nodeValue);
      if (t !== '') {
        parts.push(t);
        budget -= t.length;
      }
    }
    const kids = childrenOf.get(id);
    if (kids !== undefined) for (const k of kids) walk(k);
  };
  walk(nodeId);
  return parts.join(' ');
}

/** 元素显式名（aria-label > alt > placeholder > title——属性四链，不含子树文本） */
function explicitNameOf(attrs: Record<string, string>): string {
  for (const key of ['aria-label', 'alt', 'placeholder', 'title']) {
    const v = normalizeWs(attrs[key] ?? '');
    if (v !== '') return v.slice(0, NAME_MAX_CHARS);
  }
  return '';
}

/** 元素 name 推导（显式属性四链 > 子树文本首段） */
function nameOf(attrs: Record<string, string>, subtree: string): string {
  const explicit = explicitNameOf(attrs);
  if (explicit !== '') return explicit;
  return subtree.slice(0, NAME_MAX_CHARS);
}

/**
 * 渲染 a11y 快照（纯函数）。
 *
 * 遍历序 = 文档序（childrenOf 按 nodeId 出现序保序）；文档根渲染为 `page`；
 * 文本节点不单独出行（并入父元素 name）；元素行 = 缩进 + role + "name"；
 * interactive 行尾追加 ` @eN` 并记 ref。
 */
export function renderAccessibilitySnapshot(
  nodes: readonly FlatDocNode[],
  maxBytes: number = SNAPSHOT_MAX_BYTES,
): A11ySnapshot {
  const byId = new Map<number, FlatDocNode>();
  const childrenOf = new Map<number, number[]>();
  const roots: number[] = [];
  // 建索引：nodeId 空间父子边（nodeId 缺席节点不可引用——防御位跳过）
  for (const n of nodes) {
    if (n.nodeId !== undefined) byId.set(n.nodeId, n);
  }
  for (const n of nodes) {
    if (n.nodeId === undefined) continue;
    const pid = n.parentId;
    if (pid === undefined || !byId.has(pid)) {
      roots.push(n.nodeId);
      continue;
    }
    const bucket = childrenOf.get(pid);
    if (bucket === undefined) childrenOf.set(pid, [n.nodeId]);
    else bucket.push(n.nodeId);
  }

  const lines: string[] = [];
  const refs: A11yRef[] = [];
  let bytes = 0;
  let truncated = false;

  /** 单行追加（超帽即置截断旗并停止追加——refs 仍保留已发条目） */
  const pushLine = (line: string): boolean => {
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + cost > maxBytes) {
      truncated = true;
      return false;
    }
    lines.push(line);
    bytes += cost;
    return true;
  };

  /** 深度优先渲染（返回 false = 已截断，上层停走） */
  const render = (nodeId: number, depth: number): boolean => {
    const n = byId.get(nodeId);
    if (n === undefined) return true;
    if (n.nodeType === 9) {
      // 文档根：渲染为 page 行（url 不在 DOM 域取值面，工具层另取），子树照走
      if (!pushLine('page')) return false;
    } else if (n.nodeType === 1) {
      const tag = n.nodeName.toLowerCase();
      const attrs = attrsOf(n);
      const role = roleOf(tag, attrs);
      const subtree = subtreeText(nodeId, byId, childrenOf);
      const name = nameOf(attrs, subtree);
      const interactive = INTERACTIVE_ROLES.has(role);
      let line = `${'  '.repeat(depth)}${role}`;
      if (name !== '') line += ` "${name}"`;
      if (interactive) {
        const ref = `@e${refs.length}`;
        refs.push({ ref, backendNodeId: n.backendNodeId, role, name });
        line += ` ${ref}`;
      }
      // 出行裁决：none/presentation（显式装饰）与**匿名 generic**（无显式属性名
      // 的 div/span 套层——页面噪音大头；判据只认 aria-label 等属性名，子树文本
      // 不算——文本由语义子孙自己出行）不出行，但下方子树照递归（generic 里藏
      // interactive 是常态，剪枝会丢 ref）；有名 generic（aria-label 来源）保留。
      const anonymous = role === 'generic' && explicitNameOf(attrs) === '';
      if (!(role === 'none' || role === 'presentation' || anonymous)) {
        if (!pushLine(line)) return false;
      }
    }
    // 文本/注释等非元素节点并入父 name（不单独出行）——只走子树
    const kids = childrenOf.get(nodeId);
    if (kids !== undefined) {
      for (const k of kids) {
        if (!render(k, depth + 1)) return false;
      }
    }
    return true;
  };

  for (const r of roots) {
    if (!render(r, 0)) break;
  }
  if (truncated) {
    lines.push(`（快照超 ${Math.floor(maxBytes / 1024)}KiB 已截断——页面过大，建议分区操作或直接用 selector 侧工具）`);
  }
  return { text: lines.join('\n'), refs, truncated };
}
