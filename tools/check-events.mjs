#!/usr/bin/env node
/**
 * 事件目录双向校验器（契约篇 §6.3 第 4 条——必须在应用加载器上线前就位）。
 *
 * 三族断言，方向都是双向（目录 ↔ src 派发/写点）：
 *
 * 1. 总线活体事件（LIVE_EVENT_CATALOG，contracts 运行时目录）：
 *    - 非 reserved 目录项 ≥1 个宿主派发点（emit/waterfall/parallel/serial 调用；
 *      on() 是订阅不是派发，不算证据）；
 *    - src 每个派发/订阅点事件名必在目录——opencode permission.ask 型
 *      「声明无 trigger / 派发无声明」两个方向的谎都在此变红；
 *    - 派发方法与目录 mode 一致（mode 是事件公开契约的一部分）。
 * 2. AgentEvent 流式族（loop 直推，非总线——故单独成族）：
 *    - 每个派发点 type 必在 union 词汇；union 每型 ≥1 派发点。
 * 3. SessionEvent durable 写点（session 模块运行时注册表）：
 *    - 非 reserved 目录项 ≥1 写点；每个写点类型必在目录。
 * 4. EventName 联合字面量 ↔ 总线目录（契约篇 §1.1 收口的类型面）：
 *    - 联合字面量成员 ⊆ 目录名集（类型面不承认目录外词汇）；
 *    - 目录名集 ⊆ 联合字面量成员（目录新增名忘进联合 CI 即红）。
 *    （(string & {}) 逃生口不参与——它保住「自定义事件显式注册」的字符串面。）
 *
 * 已知豁免（显式，不静默）：
 * - 动态 append（recoverFromInterruption 的 closer.type——静态不可解析）：
 *   turn/end、tool/result 均另有直接写点兜底，类型本身仍在目录断言内；
 * - reserved 词汇（已拍板但当前无宿主写点）目录项显式标记豁免——2026-08-30
 *   todo 纵切落码后 todo/write 写点已现、reserved 翻转，核心 16 类暂无
 *   reserved 项（机制保留给未来拍板词）。
 *
 * 目录数据源用 jiti 直接导入模块运行时面（不解析 JSDoc——「运行时可枚举」
 * 优于「解析注释」，JSDoc 生成目录留作文档站未来形态，契约篇 §6.3 落码注记）。
 *
 * 用法：node tools/check-events.mjs（挂 npm run lint:topology 链尾）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';
import { createJiti } from 'jiti';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* 源码收集（src 下全部 .ts，排除测试与产物）                           */
/* ------------------------------------------------------------------ */

/** 递归收集 src 下全部 .ts 源文件（排除 .test.ts / dist / node_modules） */
function collectSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...collectSources(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 去注释：块注释整体删；行注释从 // 起删到行尾——但 // 前是 ':'（URL 协议段
 * https://）或引号字符时不删，防误伤字符串字面量。注释不是派发证据。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`A-Za-z])\/\/[^\n]*/g, '$1');
}

const files = collectSources(join(ROOT, 'src')).map((full) => {
  const rel = relative(ROOT, full);
  return { rel, path: full, code: stripComments(readFileSync(full, 'utf8')) };
});

/* ------------------------------------------------------------------ */
/* 常量解析：X_EVENT → 字面量值（全 src 收集，供派发点常量引用解引用）    */
/* ------------------------------------------------------------------ */

const constMap = new Map();
for (const file of files) {
  for (const m of file.code.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_EVENT)\s*=\s*'([^']+)'/g)) {
    constMap.set(m[1], m[2]);
  }
}

/* ------------------------------------------------------------------ */
/* 族 1：总线活体事件站点（on/emit/waterfall/parallel/serial）           */
/* ------------------------------------------------------------------ */

/**
 * 事件词汇名格式：小写段 + 至少一个分隔符（斜线 = 域/动作应用域、下划线 = 宿主
 * 自留地）——单词名（data/error/close 等裸 EventEmitter 回调、SIGINT 等信号名）
 * 不在词汇域，天然排除（契约篇 §1.1 命名纪律的机械面）。
 */
const EVENT_NAME_FORMAT = /^[a-z][a-z0-9_-]*(?:[/_][a-z][a-z0-9_-]*)+$/;

/**
 * @typedef {{ file: string; method: string; name: string; kind: 'dispatch' | 'subscribe'; resolvable: boolean }} BusSite
 */
/** @type {BusSite[]} */
const busSites = [];
for (const file of files) {
  // 泛型参数可夹在方法名与 ( 之间（ctx.waterfall<T>(...)）；事件名可换行
  const re = /\.(on|emit|waterfall|parallel|serial)(?:<[^()<>]*>)?\(\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*))/g;
  for (const m of file.code.matchAll(re)) {
    const method = m[1];
    let name;
    let resolvable = true;
    if (m[2] !== undefined) {
      name = m[2];
    } else {
      const ident = m[3];
      if (!ident.endsWith('_EVENT')) continue; // 非事件常量（如数字/配置常量）不参与
      name = constMap.get(ident);
      if (name === undefined) {
        // 形似事件常量但解析不出值——记录为待报告违规
        name = `⟨未解析:${ident}⟩`;
        resolvable = false;
      }
    }
    if (!EVENT_NAME_FORMAT.test(name)) continue; // 信号名等非事件词汇域
    busSites.push({
      file: file.rel,
      method,
      name,
      kind: method === 'on' ? 'subscribe' : 'dispatch',
      resolvable,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 族 2：AgentEvent 流式派发点（emit({ type: '...' })——排除声明文件）    */
/* ------------------------------------------------------------------ */

/** 声明文件（union 词汇提取源，本身不算派发点） */
const AGENT_EVENTS_DECL = 'src/agent/events.ts';
const agentUnion = new Set();
{
  const decl = files.find((f) => f.rel === AGENT_EVENTS_DECL);
  if (!decl) throw new Error(`声明文件缺失：${AGENT_EVENTS_DECL}`);
  for (const m of decl.code.matchAll(/type:\s*'([a-z][a-z0-9_]*)'/g)) agentUnion.add(m[1]);
}
/** @type {Array<{ file: string; name: string }>} */
const agentSites = [];
for (const file of files) {
  if (file.rel === AGENT_EVENTS_DECL) continue;
  // type 字段可经换行/其他字段后置（多行 emit 字面量），故 [^{}] 有界惰性跨行
  for (const m of file.code.matchAll(/\bemit\s*\(\s*\{[^{}]{0,400}?type:\s*'([a-z][a-z0-9_]*)'/g)) {
    agentSites.push({ file: file.rel, name: m[1] });
  }
}

/* ------------------------------------------------------------------ */
/* 族 3：SessionEvent durable 写点                                      */
/* ------------------------------------------------------------------ */

/** @type {Array<{ file: string; name: string }>} */
const durableSites = [];
for (const file of files) {
  // 族 3a：显式类型字面量 append / appendEvent（session.append = 宿主写面，
  // ctx.sessions.appendEvent = 应用写面——同一注册表的两个入口都算写点证据）
  for (const m of file.code.matchAll(/\.\s*append(?:Event)?\s*\(\s*'([a-z][a-z0-9/-]+)'/g)) {
    durableSites.push({ file: file.rel, name: m[1] });
  }
  // 族 3b：信封对象构造（限定 session 模块非声明文件——fork 的 end-seed、恢复 closer）
  if (file.rel.startsWith('src/session/') && file.rel !== 'src/session/event-types.ts') {
    for (const m of file.code.matchAll(/type:\s*'([a-z][a-z0-9-]*\/[a-z0-9-]+)'/g)) {
      durableSites.push({ file: file.rel, name: m[1] });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 族 4：EventName 联合字面量（类型面——源码文本提取，含注释剔除）        */
/* ------------------------------------------------------------------ */

/** @type {Set<string>} */
const eventUnion = new Set();
{
  const EVENTS_DECL = 'src/contracts/events.ts';
  const decl = files.find((f) => f.rel === EVENTS_DECL);
  if (!decl) throw new Error(`声明文件缺失：${EVENTS_DECL}`);
  // 从 `export type EventName =` 起截到首个 `;` 收集 `| '字面量'` 成员；
  // (string & {}) 逃生口无字面量形态，天然不参与
  const head = decl.code.slice(decl.code.indexOf('export type EventName'));
  const body = head.slice(0, head.indexOf(';'));
  for (const m of body.matchAll(/\|\s*'([^']+)'/g)) eventUnion.add(m[1]);
  if (eventUnion.size === 0) throw new Error(`EventName 联合解析为空——检查 ${EVENTS_DECL} 定义形态`);
}

/* ------------------------------------------------------------------ */
/* 目录导入（jiti 直接加载模块运行时面）                                */
/* ------------------------------------------------------------------ */

const jiti = createJiti(import.meta.url);
const events = await jiti.import(fileURLToPath(new URL('../src/contracts/events.ts', import.meta.url)));
const sessionTypes = await jiti.import(fileURLToPath(new URL('../src/session/event-types.ts', import.meta.url)));
// 应用注册的 SessionEvent 词汇随其宿主模块导入生效（v1 首例：memory/diff 在
// src/memory/diff.ts 顶层注册——该文件运行时依赖保持轻量，导入不连锁 SQLite）。
// 新增应用侧注册模块时在此追加导入，否则族 3 会把其写点误报为注册表外类型。
// 双入口纪律（2026-08-25 #19 收口）：此机制只覆盖宿主面（模块级 registerSessionEventType
// 直调）——装载面 ctx.registerSessionEventType 注册发生在 apply 运行时、CI 静态不可
// 见。官方件词汇一律走宿主面模块注册（会话篇 §2.1 注记），改走装载面会在族 3 撞
// 误报且无模块可导入——那不是闸坏了，是纪律破了。
await jiti.import(fileURLToPath(new URL('../src/memory/diff.ts', import.meta.url)));
// compaction 四词同款（src/compaction/events.ts——宿主面顶层注册，轻依赖）
await jiti.import(fileURLToPath(new URL('../src/compaction/events.ts', import.meta.url)));

/** @type {Array<{ name: string; mode: string; reserved?: boolean }>} */
const liveCatalog = events.LIVE_EVENT_CATALOG;
/** @type {Array<{ type: string; reserved?: boolean }>} */
const sessionCatalog = sessionTypes.listSessionEventTypes();

/* ------------------------------------------------------------------ */
/* 断言与报告                                                           */
/* ------------------------------------------------------------------ */

const violations = [];
const v = (message) => violations.push(message);

// ---- 族 1：总线目录 ↔ 站点 ----
const liveByName = new Map(liveCatalog.map((e) => [e.name, e]));
const dispatchesByName = new Map();
for (const site of busSites) {
  if (!site.resolvable) {
    v(`[总线] ${site.file}：事件常量无法解析为字面量（${site.name}）`);
    continue;
  }
  if (!liveByName.has(site.name)) {
    v(`[总线] ${site.file}：派发/订阅了目录外事件「${site.name}」——先在 LIVE_EVENT_CATALOG 登记（含 mode/note）`);
    continue;
  }
  // mode 一致性只对派发点断言（on() 订阅不区分模式）
  if (site.kind === 'dispatch') {
    if (site.method !== liveByName.get(site.name).mode) {
      v(
        `[总线] ${site.file}：「${site.name}」以 ${site.method} 派发，目录声明 mode=${liveByName.get(site.name).mode}——mode 是事件的公开契约`,
      );
    }
    if (!dispatchesByName.has(site.name)) dispatchesByName.set(site.name, []);
    dispatchesByName.get(site.name).push(site);
  }
}
for (const entry of liveCatalog) {
  if (entry.reserved) continue;
  if (!dispatchesByName.has(entry.name)) {
    v(
      `[总线] 目录事件「${entry.name}」全 src 无宿主派发点——声明无 trigger 即对应用作者撒谎（opencode permission.ask 型）；确属预留请加 reserved: true`,
    );
  }
}

// ---- 族 2：AgentEvent union ↔ 派发点 ----
const agentDispatched = new Set(agentSites.map((s) => s.name));
for (const site of agentSites) {
  if (!agentUnion.has(site.name)) {
    v(`[AgentEvent] ${site.file}：派发了 union 外事件「${site.name}」——先在 src/agent/events.ts 扩充词汇`);
  }
}
for (const name of agentUnion) {
  if (!agentDispatched.has(name)) {
    v(`[AgentEvent] union 词汇「${name}」无任何派发点——死词汇应删，或标注预留依据`);
  }
}

// ---- 族 3：session 目录 ↔ durable 写点 ----
const sessionByName = new Map(sessionCatalog.map((t) => [t.type, t]));
const durableByName = new Map();
for (const site of durableSites) {
  if (!sessionByName.has(site.name)) {
    v(`[SessionEvent] ${site.file}：写入了注册表外类型「${site.name}」——先经 registerSessionEventType 显式注册`);
    continue;
  }
  if (!durableByName.has(site.name)) durableByName.set(site.name, []);
  durableByName.get(site.name).push(site);
}
for (const def of sessionCatalog) {
  if (def.reserved) continue;
  if (!durableByName.has(def.type)) {
    v(`[SessionEvent] 注册类型「${def.type}」无任何写点——预留词汇请加 reserved: true 显式豁免`);
  }
}

// ---- 族 4：EventName 联合字面量 ↔ 总线目录（§1.1 类型面/运行时面同源） ----
for (const name of eventUnion) {
  if (!liveByName.has(name)) {
    v(`[EventName] 联合字面量「${name}」不在 LIVE_EVENT_CATALOG——目录是唯一事实源，类型面不得承认目录外词汇`);
  }
}
for (const entry of liveCatalog) {
  if (!eventUnion.has(entry.name)) {
    v(`[EventName] 目录事件「${entry.name}」未进 EventName 联合——目录新增名须同步联合（补全/拼写校验面才可用）`);
  }
}

// ---- 汇总 ----
if (violations.length > 0) {
  console.error(`check-events：${violations.length} 处目录/派发点漂移`);
  for (const message of violations) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `check-events ✓ 总线 ${liveCatalog.length} 项 / AgentEvent ${agentUnion.size} 型 / SessionEvent ${sessionCatalog.length} 类 / EventName 联合 ${eventUnion.size} 字面量，四族双向一致`,
);
