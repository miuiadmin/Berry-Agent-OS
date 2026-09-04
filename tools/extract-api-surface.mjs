#!/usr/bin/env node
/**
 * API 治理抽取器（契约篇 §6.13.1 六真相源 → surface.json，第八十七批批 2）。
 *
 * 产机器可读 API 面清单：顶层 exports[]（逐符号 { symbol, module, tier, since,
 * formFactors, forwarded?, deprecated? }）+ 顶层 capabilities[]（能力面声明）+
 * 顶层 enforcement 纪元章（§6.13.4 点火可见性——全面复盘 20260903-91 刀五：
 * 从 API_ENFORCEMENT_IGNITED 常量单源盖章 'pre-ignition'|'ignited'，点火翻转日
 * 即面快照 diff → PR 裁决标签闸接管 + COMPATIBILITY.md 纪元行渲染）。
 * 消费方两处：
 * - `check-api` 查 1 drift 闸——快照 ≠ 抽取真值即红（面漂移当场抓）；
 * - 构建链拷入 `dist/api/surface.json`（装载门 §6.13.4 / ctx.host §6.13.5 运行时读）。
 *
 * 六真相源与各自提取法（规范 §6.13.1「抽取器落码形态」）：
 * 1. 六虚拟键真身——`berryagent` 键 = contracts 公开根（index.ts）全部导出符号
 *    （值 + 类型）：**token 扫描器**逐符号提取（typescript 7 = tsgo 原生编译器，
 *    经典 createProgram API 已退役——用 `typescript/unstable/ast` 的 createScanner
 *    令牌流走顶层 export 语句，格式无关、注释/字符串天然安全）；typebox 三键以
 *    **转发条目**收录（forwarded: true 不展开上游 100+ 导出——M4 豁免面）；
 *    `berryagent/llm` = providerApiFace 键集、`berryagent/sqlite` =
 *    createAppSqliteFace() 产物键集（jiti 运行时面单源提取，loader 注入物同源）。
 * 2. ctx 服务面——SERVICE_CATALOG（jiti：目录项承袭）+ faceInterface 契约接口
 *    成员枚举（§6.13.4 刀 B 方法级符号——`服务名.成员名` 逐符号进 exports[]）。
 * 3+4. 钩子与事件词汇（码面同载体 contracts/events.ts，冷读 n2 单源防双记）：
 *    LIVE_EVENT_CATALOG ∪ 官方件声明层（obs/events.ts OBS_EVENTS）为活体面；
 *    SessionEvent 目录 = jiti 副作用收割（先 import 全部注册方模块再
 *    listSessionEventTypes——check-events 先例同构）。
 * 5. 应用清单 schema——MANIFEST_API_KEYS（jiti）。
 * 6. data.json 词表——DATA_DESCRIPTOR_API_KEYS（jiti）。
 *
 * tier 载体分职（§6.13.3 批 2 精化）：键级读 VIRTUAL_API_KEYS tier 列；目录宿主
 * 符号读注册表定义项 tier 必填字段；自由符号（公开根非转译直导出）读 JSDoc 标签
 * ——现役为零（index.ts 纯 `export *`），token 扫描器对 index.ts 直导出兜底扫
 * `@stable/@experimental/@deprecated` 标签（发现直导出而无标签 = 抽取期 fail-loud，
 * check-api 查 2 同律执法）。
 *
 * 自检（fail-loud）：token 扫描集必须是 jiti 运行时 barrel 值导出集的超集——
 * 扫描器漏任何值导出立即炸（类型导出无运行时对照，靠扫描器纪律 + drift 闸双保险）。
 *
 * CLI：`node tools/extract-api-surface.mjs --write` 落快照 src/contracts/api-surface.json；
 * 缺省打印真值（check-api 经模块导入消费 extractSurface()，不走 CLI）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import * as ts from 'typescript/unstable/ast';

/** 仓库根（脚本位置上一级——check-topology/copy-app-assets 同款锚定） */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** contracts 公开根（单一真相根——§6.3 第 5 条） */
const BARREL_PATH = join(REPO_ROOT, 'src/contracts/index.ts');
/** 快照提交位（受 check-api drift 闸守护——§6.13.1 快照双位其一） */
const SNAPSHOT_PATH = join(REPO_ROOT, 'src/contracts/api-surface.json');

/** jiti 实例（catalog/registry 真相源运行时面导入——check-events 先例同构） */
const jiti = createJiti(import.meta.url);
/** 便利导入：仓库内相对路径 → 模块运行时面 */
const imp = (rel) => jiti.import(fileURLToPath(new URL(rel, import.meta.url)));

/* ---------------- token 扫描器：TS 源顶层 export 语句逐符号提取 ---------------- */

/**
 * 顶层导出形态（token 扫描产物——值与类型不分（面清单两者同收））：
 * - local：本文件声明导出（export const/interface/type/... 或 export { A } 无 from）
 * - reexport：export { ... } from 'mod' / export * from 'mod' —— internal 时递归
 * - forwarded：reexport 目标是包说明符（typebox 族——上游承诺面，记载不承诺）
 */
/**
 * 单文件顶层导出扫描产物：
 * - names = 导出名 → forwarded（包说明符转发）
 * - stars = 星出模块说明符清单（一文件可多条；internal 由调用方递归——公开根
 *   条目数随公开面演进，不锚定具体数字〔遗漏大扫 20260904 #18——硬编码计数
 *   必再漂〕）
 * - tags = 自由符号标级载体（§6.13.3 批 2 tier 载体分职）：本地声明形直导出
 *   名（export const/function/... 声明形、export { A } 无 from 花括清单形——含
 *   export type { A } 前置 type 形，第十一轮遗漏大扫 20260904-b A5/A7 补全）
 *   → 紧前 JSDoc 标签（'stable'|'experimental'|'deprecated'）；无紧前 JSDoc 块
 *   或块内无标签词 → null；转译形（具名转发/命名空间转发）不入 Map——键集即
 *   「根本地直导出全集」，freeSymbolTier 的 undefined 分支因此 = 真转译形。
 *   check-api 查 2 自由符号半边与 freeSymbolTier 裁决消费
 */
export function scanTopLevelExports(sourceText) {
  const scanner = ts.createScanner(99 /* ESNext */, /* skipTrivia */ true);
  scanner.setText(sourceText);
  /**
   * 模板字面量协议栈（TS 解析器同款 reScan 编舞的独立扫描器版）：TemplateHead
   * 的 `${` 开一帧（帧值 = 插值表达式内花括深度）；帧顶深度 0 时到来的 `}` 是
   * 插值收口——必须 reScanTemplateToken 收编为 TemplateMiddle/Tail，否则该 `}`
   * 之后的闭合反引号会被当**新模板头**吞掉其后代码直到下个反引号，吞掉的
   * `{`/`}` 令模块级深度计永久失步（errors.ts 模板文案实证）。Middle 尾随的
   * `${` 续开插值（帧保留），Tail 收帧。
   */
  const templateStack = [];
  const step = () => {
    const t = scanner.scan();
    if (t === ts.SyntaxKind.TemplateHead) {
      templateStack.push(0);
    } else if (t === ts.SyntaxKind.CloseBraceToken && templateStack.length > 0) {
      if (templateStack[templateStack.length - 1] === 0) {
        const r = scanner.reScanTemplateToken();
        if (r === ts.SyntaxKind.TemplateTail) templateStack.pop();
        // TemplateMiddle：文本尾随 `${` ——同帧续开插值，深度保持 0
        return r;
      }
      templateStack[templateStack.length - 1]--;
    } else if (t === ts.SyntaxKind.OpenBraceToken && templateStack.length > 0) {
      templateStack[templateStack.length - 1]++;
    }
    return t;
  };
  /** 导出名 → 转发标记（重名后者覆盖——contracts 无冲突星出，出现即真实 TS 错） */
  const names = new Map();
  /** 星出说明符清单（一文件可多条；internal 由调用方递归） */
  const stars = [];
  /** 自由符号标级载体（仅声明形直导出——见函数头注 tags 语义） */
  const tags = new Map();
  /** 模块级花括深度（模板栈空时才计——export 关键字只在深度 0 生效） */
  let depth = 0;
  let token = step();
  /** 声明关键字集合（export const/function/... 后跟标识符的声明形） */
  const isDeclKeyword = (k) =>
    k === ts.SyntaxKind.ConstKeyword ||
    k === ts.SyntaxKind.LetKeyword ||
    k === ts.SyntaxKind.VarKeyword ||
    k === ts.SyntaxKind.FunctionKeyword ||
    k === ts.SyntaxKind.ClassKeyword ||
    k === ts.SyntaxKind.InterfaceKeyword ||
    k === ts.SyntaxKind.EnumKeyword ||
    k === ts.SyntaxKind.TypeKeyword;
  const text = () => scanner.getTokenText();
  while (token !== ts.SyntaxKind.EndOfFile) {
    const inTemplate = templateStack.length > 0;
    if (!inTemplate && token === ts.SyntaxKind.OpenBraceToken) depth++;
    else if (!inTemplate && token === ts.SyntaxKind.CloseBraceToken) depth = Math.max(0, depth - 1);
    if (token === ts.SyntaxKind.ExportKeyword && depth === 0 && !inTemplate) {
      // —— 解析一个顶层 export 语句（语句内 token 就地消费，不回流外层深度计）——
      // export 关键字自身的源内起点（skipTrivia 下 getTokenStart 即 token 起点，
      // 不含前导空白/注释）——声明形直导出的紧前 JSDoc 标级提取以此为锚
      const exportStart = scanner.getTokenStart();
      const exported = [];
      let moduleSpec = null; // 非空 = reexport 形
      let star = false;
      let t = step();
      // 穿透修饰前缀（declare/abstract/async/default 的组合与后续声明关键字）
      while (
        t === ts.SyntaxKind.DeclareKeyword ||
        t === ts.SyntaxKind.AbstractKeyword ||
        t === ts.SyntaxKind.AsyncKeyword ||
        t === ts.SyntaxKind.DefaultKeyword
      ) {
        t = step();
      }
      /**
       * 花括清单体解析（export { A, B as C, type D } [from 'mod']）：收集导出名
       * （别名后名）+ from 说明符。直书花括形与 `export type { T }` 前置 type
       * 关键字形同体共用（第十一轮遗漏大扫 20260904-b A7 修死：修前 type 前置
       * 形被 isDeclKeyword 分支吃掉——该分支 step 后只认 Identifier，`{` 直接
       * 蒸发，整条语句零记账，类型面静默缺席快照）。调用时 scanner 停在 `{`。
       */
      const parseBraceList = () => {
        let t = step();
        while (t !== ts.SyntaxKind.CloseBraceToken && t !== ts.SyntaxKind.EndOfFile) {
          if (t === ts.SyntaxKind.Identifier) {
            const id = text();
            t = step();
            // `A as B`：导出名 = B（别名后名）；裸 A：导出名 = A
            if (t === ts.SyntaxKind.AsKeyword) {
              t = step(); // 越过 as → 别名标识符 B
              if (t === ts.SyntaxKind.Identifier) exported.push(text());
              t = step();
            } else {
              exported.push(id);
            }
          } else {
            t = step(); // 逗号 / type 关键字（inline type 修饰，名在后续 Identifier）
          }
        }
        t = step(); // 越过 CloseBrace
        if (t === ts.SyntaxKind.FromKeyword) {
          step(); // 'mod'
          moduleSpec = stripQuotes(text());
        }
      };
      if (t === ts.SyntaxKind.AsteriskToken) {
        // export * [as N] from 'mod'
        star = true;
        t = step();
        if (t === ts.SyntaxKind.AsKeyword) {
          // `* as N`：命名空间转发名 = as 之后的标识符——先步到 N 再取 text()
          //（双步后取值会错拿 N 的下一 token，见具名分支同型注）
          t = step();
          if (t === ts.SyntaxKind.Identifier) exported.push(text());
          t = step();
          // 命名空间转发形到此为止（遗漏大扫 20260904 #12）：ns 本身已是面符号
          // （运行时 barrel 仅 ns 一键可及），目标模块不再收编——目标进 stars
          // 会被闭包递归展开成幻影面符号（目标私有导出被物化为顶层 API 面）
          star = false;
        }
        if (t === ts.SyntaxKind.FromKeyword) {
          step(); // 'mod'
          moduleSpec = stripQuotes(text());
        }
      } else if (t === ts.SyntaxKind.OpenBraceToken) {
        // export { A, B as C, type D } [from 'mod']
        parseBraceList();
      } else if (isDeclKeyword(t)) {
        // export const/function/class/interface/enum/type X —— 名 = 首个标识符。
        // type 关键字歧义（勘正——第十一轮遗漏大扫 20260904-b A7）：`export type
        // X = ...` 声明 vs `export type { A }` 转发；修前行内注释宣称「后者下一
        // token 是 {，已被上方 OpenBrace 分支的顺序兜住」不实——该分支只测
        // export 后首 token，type 后的 `{` 到不了那里，实况是整条漏收。此处
        // 显式分腿：type 后 `{` 形转花括清单体（同体解析），Identifier 形照旧
        const isTypeKw = t === ts.SyntaxKind.TypeKeyword;
        t = step();
        if (isTypeKw && t === ts.SyntaxKind.OpenBraceToken) {
          parseBraceList();
        } else if (t === ts.SyntaxKind.Identifier) {
          exported.push(text());
        }
      }
      const forwarded = moduleSpec !== null && !moduleSpec.startsWith('.');
      // 无 from 的具名清单（直书花括形与 type 前置形）= 本地声明形直导出（头注
      // 形态分类「local」列）：紧前 JSDoc 标级入 tags——与声明关键字形同律统一
      // 在语句尾收口（声明形恒无 from，行为不变）。修前该形收名不收标签：自由
      // 符号静默落键级 tier、@experimental 意图被丢弃（第十一轮遗漏大扫
      // 20260904-b A5）——rootTags 键集因此补全为「根本地直导出全集」，
      // freeSymbolTier 的 undefined 分支即真转译形，查 2 与抽取侧双闸同闭
      if (moduleSpec === null) {
        const tier = jsdocTierBefore(sourceText, exportStart);
        for (const n of exported) tags.set(n, tier);
      }
      for (const n of exported) names.set(n, { forwarded });
      if (star && moduleSpec !== null) stars.push(moduleSpec);
    }
    token = step();
  }
  return { names, stars, tags };
}

/**
 * 取紧前 JSDoc 块的标级标签（自由符号标级载体提取——§6.13.3 批 2）。
 * 「紧前」判据：export 关键字之前、与其只隔空白的最后一个块注释；块形必须是
 * JSDoc（双星开器）——单星普通注释形不认。
 * 开器定位（第十一轮遗漏大扫 20260904-b A6 修死）：块注释词法上不可嵌套——
 * 真开器与 close 之间不可能存在别的 `*/ `，但体内可含任意 `; /*` 文本（glob 示例
 * `src/*.ts` 等）；修前无界 `lastIndexOf('/*')` 会把开器错定位到体内最后一个
 * `/*` 上（块起点错位 → 非双星形 → 标签静默丢失假红）。修后从 close 端向前
 * 迭代候选开器，取第一个满足「双星形起 + 其后首个闭器恰为 close」者：体内
 * glob 序列被跳过（非双星形）；穿越中间代码抓到更早 JSDoc 的候选被拒（其
 * 首闭器是该 JSDoc 自己的 close 而非目标 close）；紧随的单星普通注释截断
 * 前置 JSDoc 的既有行为由两判据同守（普通注释非双星被跳过 + 其前方
 * JSDoc 的首闭器不指向目标 close）。
 * @param {string} sourceText 源文件全文
 * @param {number} exportStart export 关键字的源内起点（scanTopLevelExports 内锚）
 * @returns {'stable'|'experimental'|'deprecated'|null} 标签词；无紧前 JSDoc 块或块内无标签词 → null
 */
function jsdocTierBefore(sourceText, exportStart) {
  const before = sourceText.slice(0, exportStart);
  const close = before.lastIndexOf('*/');
  if (close === -1) return null; // 前文无注释块
  // 紧前性：注释闭器与 export 之间只允许空白——夹有实码即非本声明的文档块
  if (before.slice(close + 2).trim() !== '') return null;
  // 开器候选向前迭代（词法正确形——见函数头注）：全部候选失败 = 无紧前 JSDoc
  let open = -1;
  for (let from = close - 1; from >= 0;) {
    const cand = before.lastIndexOf('/*', from);
    if (cand === -1) break;
    if (before.startsWith('/**', cand) && before.indexOf('*/', cand + 2) === close) {
      open = cand;
      break;
    }
    from = cand - 1;
  }
  if (open === -1) return null;
  const block = before.slice(open, close + 2);
  const m = block.match(/@(stable|experimental|deprecated)\b/);
  return m === null ? null : m[1];
}

/** 字符串字面量去引号（token 文本含成对引号） */
function stripQuotes(s) {
  return s.slice(1, -1);
}

/**
 * 公开根传递闭包：从 index.ts 出发递归解星出/具名转发，收集全部导出符号。
 * internal（相对说明符）递归进目标文件再扫；包说明符（typebox 族）标 forwarded。
 * @returns {{ symbols: { name: string, forwarded: boolean }[], rootTags: Map<string, string|null> }}
 *   symbols 含直导出与转发（值与类型同收）；rootTags = 公开根本地声明形直导出的
 *   JSDoc 标级载体（仅根文件采集——递归内部文件的直导出走键级，不适用标签载体）
 */
function collectBarrelSymbols() {
  /** name → forwarded */
  const out = new Map();
  /** 公开根声明形直导出的标级载体（tier 载体分职——§6.13.3 批 2） */
  const rootTags = new Map();
  /** 递归防护（环 = 结构错误，fail-loud） */
  const visiting = new Set();
  const visit = (absPath, isRoot) => {
    if (visiting.has(absPath)) throw new Error(`contracts 再导出成环：${absPath}`);
    visiting.add(absPath);
    const src = readFileSync(absPath, 'utf8');
    const { names, stars, tags } = scanTopLevelExports(src);
    for (const [name, info] of names) {
      out.set(name, { name, forwarded: info.forwarded === true });
    }
    if (isRoot) {
      for (const [name, tier] of tags) rootTags.set(name, tier);
    }
    for (const spec of stars) {
      if (!spec.startsWith('.')) continue;
      // internal 星出：递归目标文件（'./x.js' → 同目录 x.ts；目录 → index.ts）
      visit(resolveTsPath(dirname(absPath), spec), false);
    }
    // 包说明符星出（export * from 'pkg'）：转发记号由具名转发条目承载，星出整体
    // 展开上游面超出豁免面（M4 不展开）——contracts 现役 typebox 走具名转发
    visiting.delete(absPath);
  };
  visit(BARREL_PATH, true);
  return {
    symbols: [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    rootTags,
  };
}

/**
 * 自由符号标级裁决（§6.13.3 批 2 tier 载体分职的抽取侧兑现——遗漏大扫
 * 20260904 #4/#5）：声明形直导出（rootTags 有键）标级 = 紧前 JSDoc 标签；
 * 转译形（rootTags 无键——星出收编/具名转发）维持键级 tier。
 * 标签缺席（null）= 闸面漏洞——fail-loud 拒绝静默降级键级（查 2 应已拦截，
 * 此处是抽取侧兜底，两道执法互为印证）。
 * @param {Map<string, string|null>} rootTags 公开根声明形直导出标级载体
 * @param {{ name: string, forwarded: boolean }} symbol 闭包收集的单个符号
 * @param {{ tier: string }} berryKey 键级载体（VIRTUAL_API_KEYS 的 berryagent 键）
 * @returns {string} 该符号落快照的 tier
 */
export function freeSymbolTier(rootTags, symbol, berryKey) {
  const tag = rootTags.get(symbol.name);
  if (tag === undefined) return berryKey.tier; // 转译形——键级统治
  if (tag === null) {
    throw new Error(
      `自由符号 ${symbol.name} 是公开根声明形直导出但无 @stable/@experimental/@deprecated 标签——` +
        'check-api 查 2 应已红（逐符号执法）；抽取器拒绝静默降级键级，先补标签或改回转译形',
    );
  }
  return tag;
}

/** 相对 .js 说明符 → 源 .ts 路径（目录说明符 → index.ts；.js 后缀剥换 .ts） */
function resolveTsPath(baseDir, spec) {
  const noExt = resolve(baseDir, spec);
  const asTs = noExt.endsWith('.js') ? noExt.slice(0, -3) + '.ts' : noExt;
  try {
    readFileSync(asTs);
    return asTs;
  } catch {
    return join(noExt, 'index.ts');
  }
}

/* ---------------- 服务面契约接口寻址与成员枚举（§6.13.4 刀 B——方法级符号） ---------------- */

/**
 * 模板安全步进扫描器工厂（scanTopLevelExports 协议的复用与加固件——刀 B）：
 * - TemplateHead 的 `${` 开帧（帧值 = 插值内花括深度）；帧顶深度 0 的 `}` 必须
 *   reScanTemplateToken 收编为 TemplateMiddle/Tail，否则闭合反引号被当新模板头
 *   吞掉其后代码、花括深度永久失步（errors.ts 模板文案实证——协议全文见
 *   scanTopLevelExports 头注）。Middle 尾随 `${` 续开插值（帧保留），Tail 收帧。
 * - **斜杠消歧（刀 B 加固——全仓走查的前置条件）**：独立扫描器无 parser 语境，
 *   `/` 的正则/除号两义须词法替代——前 token 可终结表达式（标识符/字面量/
 *   闭括/this 族……）即除号；否则 tryScan 试探 reScanSlashToken，产物是
 *   RegularExpressionLiteral 且未跨行（正则不含裸换行——isUnterminated 探针）
 *   即整枚正则单 token 收编（其内 `#`/括号不再碎 token 化——碎化下字符类内
 *   `#` 被当私有名起点产零宽 PrivateIdentifier 死循环，channels/mention.ts
 *   MENTION_TOKEN 正则实证）；试探失败回退除号（除位语境接受 SlashToken）。
 *   歧义残留面（非终结语境的双除号同线等）由零宽哨兵兜底转 fail-loud。
 * - **零宽哨兵（刀 B 加固）**：step 产出与上一步同起点的非 EOF token 即 throw
 *   ——零宽 token 永不前进 = 词法失步死循环，挂死形态一律转抽取期红。
 * @param {string} sourceText 待扫描源文本
 * @returns {{ step: () => number, text: () => string, inTemplate: () => boolean, start: () => number }}
 */
function createTemplateSafeScanner(sourceText) {
  const scanner = ts.createScanner(99 /* ESNext */, /* skipTrivia */ true);
  scanner.setText(sourceText);
  /** 「前 token 可终结表达式」判据集（斜杠消歧的除位语境——除号左操作数形态） */
  const DIVISION_PRECEDERS = new Set([
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.BigIntLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.CloseParenToken,
    ts.SyntaxKind.CloseBracketToken,
    ts.SyntaxKind.PlusPlusToken,
    ts.SyntaxKind.MinusMinusToken,
    ts.SyntaxKind.ThisKeyword,
    ts.SyntaxKind.SuperKeyword,
    ts.SyntaxKind.TrueKeyword,
    ts.SyntaxKind.FalseKeyword,
    ts.SyntaxKind.NullKeyword,
    ts.SyntaxKind.VoidKeyword,
  ]);
  /** 模板字面量协议栈（帧值 = 插值表达式内花括深度） */
  const templateStack = [];
  /** 上一个 step 产出的 token kind（斜杠消歧语境锚；-1 = 首步恒非除位） */
  let prevKind = -1;
  /** 上一个 step 产出的 token 起点（零宽哨兵对照位；-1 = 首步） */
  let lastStart = -1;
  const step = () => {
    let t = scanner.scan();
    // 斜杠消歧：非除位语境的 `/` 试探正则整枚收编（见头注——碎化即死循环面）
    if (t === ts.SyntaxKind.SlashToken && !DIVISION_PRECEDERS.has(prevKind)) {
      const kept = scanner.tryScan(() => {
        const r = scanner.reScanSlashToken();
        return r === ts.SyntaxKind.RegularExpressionLiteral && !scanner.isUnterminated();
      });
      if (kept) t = ts.SyntaxKind.RegularExpressionLiteral;
      // 试探失败已回退——t 维持 SlashToken（除号语境接受）
    }
    // 零宽哨兵：同起点非 EOF 重复 = 零宽 token 死循环（词法失步）——fail-loud
    if (t !== ts.SyntaxKind.EndOfFile && scanner.getTokenStart() === lastStart) {
      throw new Error(
        `词法失步：token ${ts.SyntaxKind[t]} 于位 ${scanner.getTokenStart()} 零宽重复` +
          `（正则/私有名消歧遗漏形态——检查源文本该位）`,
      );
    }
    lastStart = scanner.getTokenStart();
    prevKind = t;
    if (t === ts.SyntaxKind.TemplateHead) {
      templateStack.push(0);
    } else if (t === ts.SyntaxKind.CloseBraceToken && templateStack.length > 0) {
      if (templateStack[templateStack.length - 1] === 0) {
        const r = scanner.reScanTemplateToken();
        if (r === ts.SyntaxKind.TemplateTail) templateStack.pop();
        // 哨兵锚随 reScan 产物同步（同位再标记者——TemplateMiddle/Tail 起点
        // 与原 CloseBrace 同位，属合法一步；锚更新防下一步误报零宽）
        lastStart = scanner.getTokenStart();
        prevKind = r;
        return r;
      }
      templateStack[templateStack.length - 1]--;
    } else if (t === ts.SyntaxKind.OpenBraceToken && templateStack.length > 0) {
      templateStack[templateStack.length - 1]++;
    }
    return t;
  };
  // start()：当前 token 源内起点（skipTrivia 下不含前导空白/注释——定位锚）
  return {
    step,
    text: () => scanner.getTokenText(),
    inTemplate: () => templateStack.length > 0,
    start: () => scanner.getTokenStart(),
  };
}

/**
 * 单文件顶层 `export interface 名` 声明定位器（刀 B 接口索引的文件级扫描件）：
 * token 走查产出 名 → 体文本（体开 `{` 与配对闭 `}` 之间，不含外围花括）。
 * 三态行进：深度 0 扫描态（只在花括深度 0 认 export——嵌套 namespace 体内的
 * interface 不收，本仓服务面契约接口恒顶层导出，缺席即 SERVICE_CATALOG 寻址
 * 零源 fail-loud）→ 头部态（`interface 名` 已见、等体开器：extends/泛型段以
 * `<>` 深度计穿行——类型位无比较运算符，`<` 恒泛型开器；`>>`/`>>>` 是合并
 * token 按 `>` 字符数折算递减〔嵌套泛型闭包不漏计〕；`<>` 内平衡花括另计，
 * 不误认体开器；`=>` 与 `>` 是不同 token，箭头返回型不扰角深度）→ 体收集态
 * （花括配对至归零收体——方括/圆括内花括恒平衡，字符串单 token、模板协议
 * 在 step 内，皆不破坏配对）。
 * @param {string} sourceText 源文件全文
 * @returns {Map<string, string>} 接口名 → 体文本
 */
export function findExportedInterfaces(sourceText) {
  const { step, text, inTemplate, start } = createTemplateSafeScanner(sourceText);
  /** 名 → 体文本 */
  const out = new Map();
  /** 头部态载荷（angle = `<>` 深度；headerBrace = angle>0 段内花括深度） */
  let header = null;
  /** 体收集态：体文本起点（体开 `{` 之后）；-1 = 非体收集态 */
  let bodyStart = -1;
  /** 体收集态花括深度 */
  let bodyDepth = 0;
  /** 体收集态携带的接口名（header 清空后保名至闭 `}` 收体） */
  let pendingName = null;
  /** 扫描态花括深度（export 只在深度 0 认） */
  let depth = 0;
  let token = step();
  while (token !== ts.SyntaxKind.EndOfFile) {
    if (!inTemplate()) {
      if (bodyStart !== -1) {
        // 体收集态：配对闭 `}` 归零即收体（体文本止于其起点——不含闭器）
        if (token === ts.SyntaxKind.OpenBraceToken) bodyDepth++;
        else if (token === ts.SyntaxKind.CloseBraceToken) {
          bodyDepth--;
          if (bodyDepth === 0) {
            out.set(pendingName, sourceText.slice(bodyStart, start()));
            pendingName = null;
            bodyStart = -1;
            depth = 0;
          }
        }
      } else if (header === null) {
        if (token === ts.SyntaxKind.OpenBraceToken) depth++;
        else if (token === ts.SyntaxKind.CloseBraceToken) depth--;
        if (depth === 0 && token === ts.SyntaxKind.ExportKeyword) {
          // 预读 export 后是否 interface 名序列（非 interface 形照常前行——
          // token 已前进无妨，深度 0 才认 export，语句体内无 export）
          let t = step();
          if (t === ts.SyntaxKind.InterfaceKeyword) {
            t = step();
            if (t === ts.SyntaxKind.Identifier) header = { name: text(), angle: 0, headerBrace: 0 };
          }
        }
      } else if (token === ts.SyntaxKind.LessThanToken) header.angle++;
      else if (token === ts.SyntaxKind.GreaterThanToken) header.angle = Math.max(0, header.angle - 1);
      else if (token === ts.SyntaxKind.GreaterThanGreaterThanToken) header.angle = Math.max(0, header.angle - 2);
      else if (token === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken)
        header.angle = Math.max(0, header.angle - 3);
      else if (token === ts.SyntaxKind.OpenBraceToken) {
        if (header.angle === 0 && header.headerBrace === 0) {
          // 体开器：体文本自 `{` 之后起
          pendingName = header.name;
          bodyStart = start() + 1;
          bodyDepth = 1;
          header = null;
        } else {
          header.headerBrace++;
        }
      } else if (token === ts.SyntaxKind.CloseBraceToken) {
        header.headerBrace = Math.max(0, header.headerBrace - 1);
      }
    }
    token = step();
  }
  return out;
}

/**
 * 全仓顶层导出接口索引（刀 B——SERVICE_CATALOG faceInterface 寻址单源）：
 * 递归收集 src/ 下非测试 .ts 源文件的全部 `export interface` 声明。索引值 =
 * 声明数组（名 + 体 + 源路径）；同名多源**不在此炸**（非服务面接口跨模块同名
 * 是 TS 合法形态），仅在 SERVICE_CATALOG 实际寻址撞名时 fail-loud（寻址单义
 * 性——撞名消歧先于落码）。
 * @returns {Map<string, { body: string, path: string }[]>} 接口名 → 声明数组
 */
export function buildInterfaceIndex(rootDir) {
  /** 递归收集非测试 .ts 源文件（.test.ts / .d.ts 剔除；排序保遍历序稳定） */
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts') && !ent.name.endsWith('.d.ts')) files.push(p);
    }
  };
  walk(rootDir);
  const index = new Map();
  for (const f of files) {
    for (const [name, body] of findExportedInterfaces(readFileSync(f, 'utf8'))) {
      const hits = index.get(name) ?? [];
      hits.push({ body, path: f });
      index.set(name, hits);
    }
  }
  return index;
}

/**
 * 接口体成员枚举器（刀 B——`服务名.成员名` 方法级符号的成员清单源）。
 * 词法走查接口体文本，产出成员名清表——方法与属性同收（属性成员
 * 〔ApprovalService.policyMode 形〕也是面承诺，同入清单）。词法规则（接口体
 * 是纯类型位——无正则字面量，花括失步面天然收窄）：
 * - 注释/字符串由 scanner（skipTrivia + 字符串单 token）天然跳过——JSDoc 内
 *   花括与字符串内 `;` 不误判（多行 JSDoc 含 `{@link …}` 实证安全）；
 * - 模板字面量类型走 step 内 templateStack 协议（插值内花括不渗深度计）；
 * - 深度计 {}[]() 合计（`<>` 不计——类型位 `<...>` 内不可能裸 `;`：泛型实参
 *   内的 `;` 必居对象字面量型 `{}` 内部，`Parameters<X['k']>[0]` 形方括自平衡）；
 * - 深度 0 的 `;` = 成员终结（prettier 分号纪律保证成员恒 `;` 收尾）；
 * - 成员名 = 成员起点后首个标识符——**上下文关键字同收**（`get`/`set`/`type`
 *   等作成员名是合法 TS：JobsServiceFace.get 实证——isKeywordKind 判据收编，
 *   `readonly` 修饰符与 `new` 构造签名头除外〔修饰/签名关键字非名〕）；`'引号
 *   名'` 字符串头成员收去引号文本；起点是 `[`（索引签名）/`(`（调用签名）/`<`
 *   （泛型调用签名）/`new`（构造签名）的无名成员——跳过至终结符不计（幻影
 *   防线：索引签名值部的类型名不得被误收为成员）；
 * - **重载同名录收**（方法重载签名组是同一 API 符号——AppsService.uninstall
 *   双相重载实证：inspect 相 + execute 相两签名一符号）——Set 去重保首现序。
 * 深度负向即 throw（词法失步 fail-loud——接口体花括必然平衡）。
 * @param {string} bodyText 接口体文本（`export interface X {` 与配对 `}` 之间）
 * @returns {string[]} 成员名清表（声明序，重载去重后）
 */
export function enumerateInterfaceMembers(bodyText) {
  const { step, text, inTemplate } = createTemplateSafeScanner(bodyText);
  /** 成员名清表（声明序，重载去重后） */
  const members = [];
  /** 重载去重账（名 → 已收标记） */
  const seen = new Set();
  /** {}[]() 合计深度（`<>` 不计——见头注） */
  let depth = 0;
  /** 当前成员名：null = 尚在找首标识符 */
  let name = null;
  /** 无名成员跳过旗（索引签名/调用签名/泛型调用签名/构造签名） */
  let skipping = false;
  let token = step();
  while (token !== ts.SyntaxKind.EndOfFile) {
    if (!inTemplate()) {
      // 成员起点判定在深度调整之前（起点 `[`/`(`/`<` 尚未入深度计——正是
      // 「起点即开括」的判据位）
      const atMemberStart = depth === 0 && name === null && !skipping;
      if (atMemberStart) {
        const isNameToken =
          token === ts.SyntaxKind.Identifier ||
          // 上下文关键字作成员名（get/set/type/of/……合法 TS）——修饰符与
          // 构造签名关键字（readonly/new）除外：它们非名，名在后续 token
          (ts.isKeywordKind(token) && token !== ts.SyntaxKind.ReadonlyKeyword && token !== ts.SyntaxKind.NewKeyword);
        if (isNameToken) name = text();
        else if (token === ts.SyntaxKind.StringLiteral) name = stripQuotes(text());
        else if (
          token === ts.SyntaxKind.OpenBracketToken ||
          token === ts.SyntaxKind.OpenParenToken ||
          token === ts.SyntaxKind.LessThanToken ||
          token === ts.SyntaxKind.NewKeyword
        ) {
          skipping = true;
        }
      }
      if (
        token === ts.SyntaxKind.OpenBraceToken ||
        token === ts.SyntaxKind.OpenBracketToken ||
        token === ts.SyntaxKind.OpenParenToken
      ) {
        depth++;
      } else if (
        token === ts.SyntaxKind.CloseBraceToken ||
        token === ts.SyntaxKind.CloseBracketToken ||
        token === ts.SyntaxKind.CloseParenToken
      ) {
        depth--;
        if (depth < 0) throw new Error(`接口体词法失步：闭括深度负向（体文本花括不平衡？）`);
      }
      if (depth === 0 && token === ts.SyntaxKind.SemicolonToken) {
        if (name !== null) {
          // 重载签名组一符号：同名录收（首现序）
          if (!seen.has(name)) {
            members.push(name);
            seen.add(name);
          }
          name = null;
        }
        skipping = false;
      }
    }
    token = step();
  }
  // 尾成员宽容收口：prettier 保证 `;`，缺号（手工格式）不丢成员
  if (name !== null && !seen.has(name)) members.push(name);
  return members;
}

/* ---------------- 公开根分桶不变式（§6.13.4 刀 A——api.ts 顶层导出两桶执法） ---------------- */

/**
 * api.ts internal 机制桶白名单（§6.13.4 公开根分桶——七符号逐名闭集单点）。
 * 这些是宿主治理机制符号（键表/服务目录/点火位/装载门与实验门裁决核/宿主面
 * 物化），不是应用作者可消费面——内核消费全深导 contracts/api.js，永不进公开
 * 根 re-export。新增/改名 api.ts 顶层导出时必须二选一分类：进公开桶
 * （contracts/index.ts 显式 re-export）或进本白名单——未分类即 extractSurface
 * fail-loud（分桶不变式，审计 R4-D1：星出时代机制符号实测标 stable 进面）。
 */
export const INTERNAL_API_EXPORTS = new Set([
  'VIRTUAL_API_KEYS',
  'SERVICE_CATALOG',
  'API_ENFORCEMENT_IGNITED',
  'adjudicateApiGate',
  'assertExperimentalDeclared',
  'requireCapabilities',
  'materializeHostFace',
]);

/**
 * 分桶不变式执法（纯函数——导出供回归锁直锁）：api.ts 全部顶层导出名（token
 * 扫描，值与类型同收）必须恰落两桶之一——公开桶（公开根面符号闭包）或 internal
 * 白名单。三向违例皆 throw（fail-loud；经查 1 面 = 快照漂移永不静默过闸）：
 * 1. 未分类：api.ts 新顶层导出两桶皆不在——先分类再落码（防新符号静默进公开
 *    面标 stable——判级引擎执法失真面的根源）；
 * 2. internal 漏桶：白名单符号出现在公开根面——机制符号不是应用 API；
 * 3. 白名单死名：api.ts 已无该名而白名单残留——改名/删除后烂尾即炸。
 * @param {Iterable<string>} apiNames api.ts 全部顶层导出名（扫描器产物）
 * @param {Iterable<string>} barrelFaceNames 公开根传递闭包全部导出名
 * @param {Iterable<string>} [whitelist] internal 桶白名单（缺省 INTERNAL_API_EXPORTS——测试注入专用）
 */
export function assertApiBucketPartition(apiNames, barrelFaceNames, whitelist = INTERNAL_API_EXPORTS) {
  const api = new Set(apiNames);
  const face = new Set(barrelFaceNames);
  const unclassified = [...api].filter((n) => !face.has(n) && !whitelist.has(n));
  if (unclassified.length > 0) {
    throw new Error(
      `api.ts 顶层导出未分桶：${unclassified.join(', ')}——公开桶（contracts/index.ts 显式 re-export）与 ` +
        `internal 白名单（extract-api-surface INTERNAL_API_EXPORTS）二选一分类后再落码（§6.13.4 公开根分桶——防机制符号静默进公开面）`,
    );
  }
  const leaked = [...whitelist].filter((n) => face.has(n));
  if (leaked.length > 0) {
    throw new Error(
      `internal 机制符号漏进公开桶：${leaked.join(', ')}——机制符号不是应用 API，内核消费深导 contracts/api.js，` +
        `公开根 re-export 须移除（§6.13.4 公开根分桶）`,
    );
  }
  const dead = [...whitelist].filter((n) => !api.has(n));
  if (dead.length > 0) {
    throw new Error(
      `internal 白名单死名：${dead.join(', ')}——api.ts 已无此名（改名/删除后白名单烂尾），同步 INTERNAL_API_EXPORTS`,
    );
  }
}

/* ---------------- 六真相源抽取主流程 ---------------- */

/**
 * 抽取 API 面清单真值（check-api 查 1 与构建链共用此单源）。
 * @returns {{ apiVersion: string, exports: object[], capabilities: object[] }}
 */
export async function extractSurface() {
  // —— 真相源 #1：六键真身 ——
  const apiMod = await imp('../src/contracts/api.ts');
  const VIRTUAL_API_KEYS = apiMod.VIRTUAL_API_KEYS;
  const SERVICE_CATALOG = apiMod.SERVICE_CATALOG;
  const DATA_DESCRIPTOR_API_KEYS = apiMod.DATA_DESCRIPTOR_API_KEYS;
  const CAPABILITIES = apiMod.CAPABILITIES;
  const keyEntry = (key) => {
    const e = VIRTUAL_API_KEYS.find((k) => k.key === key);
    if (e === undefined) throw new Error(`VIRTUAL_API_KEYS 缺键：${key}（键表是单源，先补键表）`);
    return e;
  };
  const ALL_FF = ['standalone', 'daemon', 'server'];
  // 形态集规范化拷贝（升序）：formFactors 是集合语义，api.ts 键表里的数组书写
  // 序不得渗进快照字节——否则键表重排 = 假面 diff → PR 闸第二刀假红（快照变而
  // 渲染面全序不变）。所有落快照点统一走本拷贝。
  const ff = (list) => [...list].sort();

  // —— #1a：berryagent 键（token 扫描 + jiti 值面自检）——
  const { symbols: barrelSymbols, rootTags } = collectBarrelSymbols();
  // —— 分桶不变式（§6.13.4 刀 A）：api.ts 顶层导出（扫描器——值与类型同收）×
  // 公开根面闭包 × internal 白名单三向执法——新顶层导出未分类 / internal 漏桶 /
  // 白名单死名皆 fail-loud（经查 1 面 = 分桶漂移永不静默过闸）
  const apiScan = scanTopLevelExports(readFileSync(join(REPO_ROOT, 'src/contracts/api.ts'), 'utf8'));
  assertApiBucketPartition(
    apiScan.names.keys(),
    barrelSymbols.map((s) => s.name),
  );
  const runtimeBarrel = await imp('../src/contracts/index.ts');
  const runtimeNames = Object.keys(runtimeBarrel).sort();
  const scannedNames = new Set(barrelSymbols.map((s) => s.name));
  const missed = runtimeNames.filter((n) => !scannedNames.has(n));
  if (missed.length > 0) {
    throw new Error(`token 扫描器漏值导出（自检红——扫描器与运行时面漂移，修扫描器）：${missed.join(', ')}`);
  }
  const berryKey = keyEntry('berryagent');
  const exports = barrelSymbols.map((s) => ({
    symbol: s.name,
    module: 'berryagent',
    // 自由符号标级裁决（遗漏大扫 20260904 #4/#5）：声明形直导出走 JSDoc 标签、
    // 转译形维持键级；标签缺席 fail-loud（查 2 先红、此处兜底）
    tier: freeSymbolTier(rootTags, s, berryKey),
    since: berryKey.since,
    formFactors: ff(berryKey.formFactors),
    ...(s.forwarded ? { forwarded: true } : {}),
  }));

  // —— #1b：typebox 三键（转发条目——M4 豁免面，不展开上游导出）——
  // 四符号 Type/Static/TSchema/Value 由规范点名；typebox/compile 记 Compile/Code 两符号
  const TYPEBOX_FORWARDED = [
    ['typebox', 'Type'],
    ['typebox', 'Static'],
    ['typebox', 'TSchema'],
    ['typebox/value', 'Value'],
    ['typebox/compile', 'Compile'],
    ['typebox/compile', 'Code'],
  ];
  for (const [key, symbol] of TYPEBOX_FORWARDED) {
    const e = keyEntry(key);
    exports.push({
      symbol,
      module: key,
      tier: e.tier,
      since: e.since,
      formFactors: ff(e.formFactors),
      forwarded: true,
    });
  }

  // —— #1c：第五键 berryagent/llm（providerApiFace 键集——loader 注入物单源）——
  const providerFaceMod = await imp('../src/llm/provider-face.ts');
  const llmFace = providerFaceMod.providerApiFace;
  if (llmFace === undefined) throw new Error('provider-face 未导出 providerApiFace（第五键注入物单源漂移）');
  const llmKey = keyEntry('berryagent/llm');
  for (const symbol of Object.keys(llmFace).sort()) {
    exports.push({
      symbol,
      module: 'berryagent/llm',
      tier: llmKey.tier,
      since: llmKey.since,
      formFactors: ff(llmKey.formFactors),
    });
  }

  // —— #1d：第六键 berryagent/sqlite（createAppSqliteFace 产物键集——缺省参零副作用）——
  const sqliteMod = await imp('../src/persist/app-sqlite.ts');
  const sqliteFace = sqliteMod.createAppSqliteFace();
  const sqliteKey = keyEntry('berryagent/sqlite');
  for (const symbol of Object.keys(sqliteFace).sort()) {
    exports.push({
      symbol,
      module: 'berryagent/sqlite',
      tier: sqliteKey.tier,
      since: sqliteKey.since,
      formFactors: ff(sqliteKey.formFactors),
    });
  }

  // —— #2：ctx 服务面目录（服务名 + 方法级符号——§6.13.4 刀 B）——
  // 宿主 apiVersion 前置读（原在快照收尾处——grandfathering 需先于服务域取值）：
  // 新增成员 since = 入面档时当前 apiVersion（package.json 预置号随 release 联动）；
  // 不可读/非法 JSON 即 fail-loud（快照自描述依赖 apiVersion 字段）
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    } catch (err) {
      throw new Error(`package.json 不可读或非法 JSON（extract-api-surface 依赖 apiVersion 字段）：${err.message}`);
    }
  })();
  // 已提交快照 services 域 since 账本（grandfathering 单源——刀 B）：存量符号
  // 承袭快照旧值、新符号落当前 apiVersion；快照缺席（首跑形态）走 ?? 兜底。
  // 读工作树快照位：快照重生成幂等（承袭值已含新符号时结果不变）
  const prevSince = new Map();
  try {
    for (const e of JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')).exports ?? []) {
      if (e.module === 'services') prevSince.set(e.symbol, e.since);
    }
  } catch {
    // 快照文件缺席（首跑形态）——账本空表，全部落 pkg.apiVersion
  }
  // 全仓接口索引（faceInterface 寻址——18 服务契约接口散住 contracts 与宿主
  // 模块〔冷读 CR2〕，全仓索引是唯一不漏形；撞名/零源在寻址点 fail-loud）
  const interfaceIndex = buildInterfaceIndex(join(REPO_ROOT, 'src'));
  /** faceInterface 寻址（三向 fail-loud：零源/撞源/枚举词法失步皆抽取期红） */
  const lookupFace = (entry) => {
    const hits = interfaceIndex.get(entry.faceInterface) ?? [];
    if (hits.length === 0) {
      throw new Error(
        `faceInterface 零源：${entry.name} → ${entry.faceInterface}（全仓非测试源无此顶层导出接口——` +
          `先补契约接口声明或正名目录项，§6.13.4 刀 B）`,
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `faceInterface 撞源：${entry.faceInterface} 见于 ${hits.map((h) => h.path).join(' 与 ')}——` +
          `寻址单义性，先改名消歧（§6.13.4 刀 B）`,
      );
    }
    return hits[0];
  };
  for (const entry of SERVICE_CATALOG) {
    // 服务名符号（目录级——DEP 可整体废弃；since 承袭快照）
    exports.push({
      symbol: entry.name,
      module: 'services',
      tier: entry.tier,
      since: prevSince.get(entry.name) ?? pkg.apiVersion,
      formFactors: ff(ALL_FF),
    });
    // 方法级符号（§6.13.4 刀 B）：枚举契约接口成员，`服务名.成员名` 一符号——
    // tier/formFactors 承袭目录项；since grandfathering（存量承袭快照、新增落
    // 当前 apiVersion——冷读 CR3：恒承袭使新增成员盖服务诞生版之戳，DEP 窗口
    // 算术坐标失锚）。成员面 = 契约接口声明面（provide 对象 satisfies 本型，
    // 面漂移编译期即红）——方法增删自此对 diff/判级/查 9/COMPATIBILITY 全链可见
    for (const member of enumerateInterfaceMembers(lookupFace(entry).body)) {
      const symbol = `${entry.name}.${member}`;
      exports.push({
        symbol,
        module: 'services',
        tier: entry.tier,
        since: prevSince.get(symbol) ?? pkg.apiVersion,
        formFactors: ff(ALL_FF),
      });
    }
  }

  // —— #3+#4a：钩子与活体事件词汇（同载体单源——冷读 n2）：目录 ∪ 官方件声明层 ——
  const eventsMod = await imp('../src/contracts/events.ts');
  const obsEventsMod = await imp('../src/obs/events.ts');
  const liveDefs = [...eventsMod.LIVE_EVENT_CATALOG, ...(obsEventsMod.OBS_EVENTS ?? [])];
  for (const def of liveDefs) {
    exports.push({
      symbol: def.name,
      module: 'live-events',
      tier: def.tier,
      since: '1.0',
      formFactors: ff(ALL_FF),
    });
  }

  // —— #4b：durable 会话事件词汇（jiti 副作用收割——check-events 先例同构）——
  await imp('../src/contracts/session-events.ts');
  await imp('../src/session/event-types.ts');
  await imp('../src/memory/diff.ts');
  await imp('../src/compaction/events.ts');
  await imp('../src/checkpoint/events.ts');
  await imp('../src/goal/events.ts');
  // 废弃遥测词汇（§6.13.7 批 3）：registerSessionEventType 副作用收割——导入即登记
  await imp('../src/contracts/deprecations.ts');
  const sessionEventsMod = await imp('../src/contracts/session-events.ts');
  for (const def of sessionEventsMod.listSessionEventTypes()) {
    exports.push({
      symbol: def.type,
      module: 'session-events',
      tier: def.tier,
      since: '1.0',
      formFactors: ff(ALL_FF),
    });
  }

  // —— #5：应用清单键目录 ——
  const appMod = await imp('../src/contracts/app.ts');
  for (const entry of appMod.MANIFEST_API_KEYS) {
    exports.push({
      symbol: entry.key,
      module: 'manifest',
      tier: entry.tier,
      since: '1.0',
      formFactors: ff(ALL_FF),
    });
  }

  // —— #6：data.json 词表 ——
  for (const entry of DATA_DESCRIPTOR_API_KEYS) {
    exports.push({
      symbol: entry.key,
      module: 'data-keys',
      tier: entry.tier,
      since: '1.0',
      formFactors: ff(ALL_FF),
    });
  }

  // —— 能力面（顶层 capabilities[]——§6.13.5 ctx.host 派生源）——
  const capabilities = CAPABILITIES.map((c) => ({
    name: c.name,
    formFactors: ff(c.formFactors),
    providedBy: c.providedBy,
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // —— #7：DEP 注册簿 join（§6.13.6 废弃载荷终段——批 3）——
  // 注册簿是 tier=deprecated 的单源：命中 module::symbol 坐标即改标 tier 并挂
  // deprecated 载荷 { dep, removalIn, replacement }；反向 fail-loud——注册簿指向
  // 面清单缺席的坐标 = 登记漂移（登记了不存在/已删的面，抽取期即炸不待查 3）
  const depMod = await imp('../src/contracts/deprecations.ts');
  const surfaceKey = (e) => `${e.module}::${e.symbol}`;
  const exportByKey = new Map(exports.map((e) => [surfaceKey(e), e]));
  for (const reg of depMod.DEPRECATIONS) {
    const target = exportByKey.get(reg.symbol);
    if (target === undefined) {
      throw new Error(`DEP 注册簿 symbol 不在面清单：${reg.symbol}（先修注册簿坐标——废弃登记指向不存在的面）`);
    }
    target.tier = 'deprecated';
    target.deprecated = { dep: reg.dep, removalIn: reg.removalIn, replacement: reg.replacement };
  }

  // 宿主 apiVersion 读已前置至 #2 服务域（grandfathering 取值先序——刀 B）：
  // pkg 变量在彼处带 fail-loud 包装（package.json 不可读即炸），此处不再重读

  // —— 点火位盖章（§6.13.4 点火可见性——全面复盘 20260903-91 刀五）——
  // enforcement 纪元章从 API_ENFORCEMENT_IGNITED 单源派生：点火翻转日即面快照
  // diff（PR 裁决标签闸强制接走——api-break: 语义）+ COMPATIBILITY.md 纪元行。
  // 散拷禁律不破：此处只读常量（与 adjudicateApiGate 消费面同源同值），不改不散播
  const enforcement = apiMod.API_ENFORCEMENT_IGNITED ? 'ignited' : 'pre-ignition';

  exports.sort((a, b) =>
    a.module === b.module ? (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) : a.module < b.module ? -1 : 1,
  );
  return { apiVersion: pkg.apiVersion, enforcement, exports, capabilities };
}

/** 快照 JSON 稳定序列化（drift diff 可读——2 空格缩进 + 尾换行） */
export function serializeSurface(surface) {
  return JSON.stringify(surface, null, 2) + '\n';
}

/* ---------------- CLI 入口（--write 落快照；缺省打印） ---------------- */
const isCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const surface = await extractSurface();
  if (process.argv.includes('--write')) {
    writeFileSync(SNAPSHOT_PATH, serializeSurface(surface));
    console.log(
      `已落 API 面快照：${SNAPSHOT_PATH}（exports ${surface.exports.length} / capabilities ${surface.capabilities.length} / enforcement ${surface.enforcement}）`,
    );
  } else {
    console.log(serializeSurface(surface));
  }
}
