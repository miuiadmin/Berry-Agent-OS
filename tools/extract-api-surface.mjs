#!/usr/bin/env node
/**
 * API 治理抽取器（契约篇 §6.13.1 六真相源 → surface.json，第八十七批批 2）。
 *
 * 产机器可读 API 面清单：顶层 exports[]（逐符号 { symbol, module, tier, since,
 * formFactors, forwarded?, deprecated? }）+ 顶层 capabilities[]（能力面声明）。
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
 * 2. ctx 服务面——SERVICE_CATALOG（jiti）。
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
import { readFileSync, writeFileSync } from 'node:fs';
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
/** 单文件顶层导出扫描产物：names = 导出名 → forwarded（包说明符转发）；stars = 星出模块说明符清单一文件可多条
 * （check-api 查 2 自由符号半边消费——公开根自身的直导出形） */
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
  /** 星出说明符清单（一文件可多条——index.ts 即 13 条；internal 由调用方递归） */
  const stars = [];
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
        }
        if (t === ts.SyntaxKind.FromKeyword) {
          step(); // 'mod'
          moduleSpec = stripQuotes(text());
        }
      } else if (t === ts.SyntaxKind.OpenBraceToken) {
        // export { A, B as C, type D } [from 'mod']
        t = step();
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
          step();
          moduleSpec = stripQuotes(text());
        }
      } else if (isDeclKeyword(t)) {
        // export const/function/class/interface/enum/type X —— 名 = 首个标识符
        // （type 关键字歧义：`export type X = ...` 声明 vs `export type { A }` 转发；
        // 后者下一 token 是 {，已被上方 OpenBrace 分支的顺序兜住——此处必是声明）
        t = step();
        if (t === ts.SyntaxKind.Identifier) exported.push(text());
      }
      const forwarded = moduleSpec !== null && !moduleSpec.startsWith('.');
      for (const n of exported) names.set(n, { forwarded });
      if (star && moduleSpec !== null) stars.push(moduleSpec);
    }
    token = step();
  }
  return { names, stars };
}

/** 字符串字面量去引号（token 文本含成对引号） */
function stripQuotes(s) {
  return s.slice(1, -1);
}

/**
 * 公开根传递闭包：从 index.ts 出发递归解星出/具名转发，收集全部导出符号。
 * internal（相对说明符）递归进目标文件再扫；包说明符（typebox 族）标 forwarded。
 * @returns { name: string, forwarded: boolean }[] （含直导出与转发——值与类型同收）
 */
function collectBarrelSymbols() {
  /** name → forwarded */
  const out = new Map();
  /** 递归防护（环 = 结构错误，fail-loud） */
  const visiting = new Set();
  const visit = (absPath) => {
    if (visiting.has(absPath)) throw new Error(`contracts 再导出成环：${absPath}`);
    visiting.add(absPath);
    const src = readFileSync(absPath, 'utf8');
    const { names, stars } = scanTopLevelExports(src);
    for (const [name, info] of names) {
      out.set(name, { name, forwarded: info.forwarded === true });
    }
    for (const spec of stars) {
      if (!spec.startsWith('.')) continue;
      // internal 星出：递归目标文件（'./x.js' → 同目录 x.ts；目录 → index.ts）
      visit(resolveTsPath(dirname(absPath), spec));
    }
    // 包说明符星出（export * from 'pkg'）：转发记号由具名转发条目承载，星出整体
    // 展开上游面超出豁免面（M4 不展开）——contracts 现役 typebox 走具名转发
    visiting.delete(absPath);
  };
  visit(BARREL_PATH);
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  const barrelSymbols = collectBarrelSymbols();
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
    tier: berryKey.tier,
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

  // —— #2：ctx 服务面目录 ——
  for (const entry of SERVICE_CATALOG) {
    exports.push({
      symbol: entry.name,
      module: 'services',
      tier: entry.tier,
      since: '1.0',
      formFactors: ff(ALL_FF),
    });
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

  // 宿主 apiVersion（package.json 预置号——快照自描述，drift 闸随 release 版本联动）
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

  exports.sort((a, b) =>
    a.module !== b.module ? (a.module < b.module ? -1 : 1) : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0,
  );
  return { apiVersion: pkg.apiVersion, exports, capabilities };
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
      `已落 API 面快照：${SNAPSHOT_PATH}（exports ${surface.exports.length} / capabilities ${surface.capabilities.length}）`,
    );
  } else {
    console.log(serializeSurface(surface));
  }
}
