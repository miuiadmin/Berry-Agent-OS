#!/usr/bin/env node
/**
 * 事件目录双向校验器（契约篇 §6.3 第 4 条——必须在应用加载器上线前就位）。
 *
 * 五族断言，方向都是双向（族 1-4 = 目录 ↔ src 派发/写点；族 5 = 目录 ↔ 公开文档镜像）：
 *
 * 1. 总线活体事件（词汇面 = LIVE_EVENT_CATALOG ∪ 应用声明层，契约篇 §6.3#4
 *    第四十六批——官方件自有总线词经轻量 events.ts named export 声明，装载器
 *    装载阶段① 同一 const 登记运行时注册表）：
 *    - 非 reserved 词汇项 ≥1 个宿主派发点（emit/waterfall/parallel/serial 调用；
 *      on() 是订阅不是派发，不算证据）；
 *    - src 每个派发/订阅点事件名必在词汇面——opencode permission.ask 型
 *      「声明无 trigger / 派发无声明」两个方向的谎都在此变红；
 *    - 派发方法与词汇项 mode 一致（mode 是事件公开契约的一部分）。
 * 2. AgentEvent 流式族（loop 直推，非总线——故单独成族）：
 *    - 每个派发点 type 必在 union 词汇；union 每型 ≥1 派发点。
 * 3. SessionEvent durable 写点（session 模块运行时注册表）：
 *    - 非 reserved 目录项 ≥1 写点；每个写点类型必在目录。
 * 4. EventName 联合字面量 ↔ 总线目录（契约篇 §1.1 收口的类型面）：
 *    - 联合字面量成员 ⊆ 目录名集（类型面不承认目录外词汇）；
 *    - 目录名集 ⊆ 联合字面量成员（目录新增名忘进联合 CI 即红）。
 *    （(string & {}) 逃生口不参与——它保住「自定义事件显式注册」的字符串面。）
 * 6. 错误码注册表对账（基建大扫 #46，2026-09-02 第五十七批）：errors.ts 头注
 *    「错误码与事件类型同纪律的 CI 校验」兑现——AppError 字面量码 ⊆ 注册表
 *    （手拼/typo 码红）；注册表零使用即死码红（registerErrorCode 自防御抛码
 *    经字面量构造算使用）。
 * 7. 迁移链版本锚（全面复盘 20260902 G-1/G-3①）：全仓非测试 src 的
 *    MigrationSpec 声明面最大 version ≡ docs 两表末行 + 运维手册标题
 *    「user_version = N」——新增迁移不滚表即红（v15 落码两表止于 v14
 *    静默绿是首个已发实证）。
 * 5. 公开面镜像对照（契约篇 §6.3#4 第五族，2026-08-31 第四十三批）：
 *    - docs/应用开发指南「活体总线词汇速览」表：词集 ≡ 总线目录名集 +
 *      标题计数/层括号计数和对照（提取锚 = 以 | 起头的表格行内反引号词）；
 *    - docs/架构总览「事件系统」表三行计数（项/型/类）≡ 三目录真值；
 *    - 锚标题缺失或不唯一 = 违规（fail-loud，禁静默跳过——锚失效的假绿
 *      比无门禁更危险；两张表是对应用作者的词汇承诺面，改版须同 commit 同步锚）。
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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative, resolve } from 'node:path';
import { createJiti } from 'jiti';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 公开面镜像读根缝（遗漏大扫 20260901 O-4②）：缺省读真仓（缺文件 readFileSync
 * 抛错即红——docs 改名漂移不得静默跳过）；CHECK_ROOT 指向夹具树时镜像面随缝
 * 随移且缺席文件静默跳过（夹具树只造目标锚面，不复制整册 docs）——锚规则可被
 * 负例锁钉（第五族③整块删除后测试照绿的「锁的锁」缺位补齐）。src 扫描面与
 * jiti 目录真源恒读真仓（事件目录真相不随夹具变）。返回 undefined = 跳过本文件。
 */
const MIRROR_ROOT = process.env.CHECK_ROOT ? resolve(process.env.CHECK_ROOT) : ROOT;
function readMirrorFile(relPath) {
  const full = join(MIRROR_ROOT, relPath);
  if (process.env.CHECK_ROOT && !existsSync(full)) return undefined;
  return readFileSync(full, 'utf8');
}

/* ------------------------------------------------------------------ */
/* 源码收集（src 下全部 .ts，排除测试与产物）                           */
/* ------------------------------------------------------------------ */

/** 递归收集 src 下全部 .ts 源文件（排除 .test.ts / dist / node_modules；webui/client 是 vite 打包域——bundler 解析与 JSX 不走本门禁，CR-9 同族排除） */
function collectSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      if (full === join(ROOT, 'src', 'webui', 'client')) continue;
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
// checkpoint 两词同款（src/checkpoint/events.ts——快照/回退审计词，轻依赖）
await jiti.import(fileURLToPath(new URL('../src/checkpoint/events.ts', import.meta.url)));
// goal 轮结算账本词同款（src/goal/events.ts——goal/evidence 轮结算写点在
// goal/tools.ts，第三十九批 T4-A；goal/summary 随第四刀沉淀④步同笔注册）
await jiti.import(fileURLToPath(new URL('../src/goal/events.ts', import.meta.url)));
// 错误码注册表（族 6 数据源——基建大扫 #46：errors.ts 头注「CI 可校验」兑现，
// 与事件词汇面同纪律的机器执法）
const errorsMod = await jiti.import(fileURLToPath(new URL('../src/contracts/errors.ts', import.meta.url)));

// 应用声明层总线词（契约篇 §6.3#4 族 1 词汇面 = 目录 ∪ 应用声明层，第四十六批）：
// 官方件自有总线词的宿主面声明——轻量 events.ts named export（件 manifest 引同
// 一 const 单源），零运行时依赖 jiti 可载（compaction 等 SessionEvent 宿主面同形；
// 差异：它们加载即副作用注册，本层是惰性数据 const、生产注册在装载阶段①）。
// 新增官方件总线词时：件内抽 events.ts + manifest 引用 + 此处追加导入。
// 第三方装载面登记是运行时态、CI 静态不可见（与族 3 双入口边界注记同款）。
const obsEventsMod = await jiti.import(fileURLToPath(new URL('../src/obs/events.ts', import.meta.url)));
/** @type {Array<{ name: string; mode: string; reserved?: boolean }>} */
const appDeclared = obsEventsMod.OBS_EVENTS ?? [];

/** @type {Array<{ name: string; mode: string; reserved?: boolean }>} */
const liveCatalog = events.LIVE_EVENT_CATALOG;
/** @type {Array<{ type: string; reserved?: boolean }>} */
const sessionCatalog = sessionTypes.listSessionEventTypes();

/* ------------------------------------------------------------------ */
/* 断言与报告                                                           */
/* ------------------------------------------------------------------ */

const violations = [];
const v = (message) => violations.push(message);

// ---- 族 1：总线词汇面（目录 ∪ 应用声明层）↔ 站点 ----
const liveByName = new Map(liveCatalog.map((e) => [e.name, e]));
// 声明层三向断言之③先行（构造期执法）：格式非法直接红（不套 EVENT_NAME_FORMAT
// 预滤——预滤会静默滤出、让非法名绕过死词断言②把 fail-loud 后移到装载期）；
// 撞名（目录或他件声明，双撞向）即红——EVENT_DUPLICATE 拒静默覆盖的语义整体
// 前移到静态。并集 map 目录先入写死顺序（撞名已红，取哪个 def 无所谓）。
const declaredByName = new Map();
for (const def of appDeclared) {
  if (!EVENT_NAME_FORMAT.test(def.name)) {
    v(
      `[总线-声明层] 声明词「${def.name}」名非法——须小写且含 /（防撞宿主词汇域；装载期 APP_SHAPE_INVALID 同款，此处前移）`,
    );
    continue;
  }
  if (liveByName.has(def.name) || declaredByName.has(def.name)) {
    v(
      `[总线-声明层] 声明词「${def.name}」撞名（目录或他件声明已占用）——运行时 EVENT_DUPLICATE 拒静默覆盖，此处前移到静态`,
    );
    continue;
  }
  declaredByName.set(def.name, def);
}
const busVocab = new Map([...liveByName, ...declaredByName]);
const dispatchesByName = new Map();
for (const site of busSites) {
  if (!site.resolvable) {
    v(`[总线] ${site.file}：事件常量无法解析为字面量（${site.name}）`);
    continue;
  }
  if (!busVocab.has(site.name)) {
    v(
      `[总线] ${site.file}：派发/订阅了词汇外事件「${site.name}」——词汇面 = LIVE_EVENT_CATALOG ∪ 应用 events 声明（官方件抽轻量 events.ts + manifest 引用）`,
    );
    continue;
  }
  // mode 一致性只对派发点断言（on() 订阅不区分模式）
  if (site.kind === 'dispatch') {
    if (site.method !== busVocab.get(site.name).mode) {
      v(
        `[总线] ${site.file}：「${site.name}」以 ${site.method} 派发，词汇项声明 mode=${busVocab.get(site.name).mode}——mode 是事件的公开契约`,
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
// 声明层死词断言（与目录词同罪；reserved 豁免同目录侧对称）
for (const entry of declaredByName.values()) {
  if (entry.reserved) continue;
  if (!dispatchesByName.has(entry.name)) {
    v(`[总线-声明层] 声明词「${entry.name}」全 src 无派发点——声明无 trigger 与目录词同罪；确属预留请加 reserved: true`);
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

// ---- 族 5：公开面镜像对照（契约篇 §6.3#4 第五族，2026-08-31 第四十三批） ----
// 代码目录 ↔ 公开文档两张镜像表。提取锚 fail-loud：锚标题缺失/不唯一即违规——
// 锚失效的假绿比无门禁更危险；两张表是对应用作者的词汇承诺面，改版须同
// commit 同步锚。防漂路线 = 对照执法而非生成展示性工件（生成丢手写语义注）。
{
  /** 截取文档中锚标题到下一个同级标题的区域；锚缺失/不唯一 = 违规并返回 null */
  const docSection = (source, relPath, heading) => {
    const first = source.indexOf(heading);
    if (first === -1) {
      v(
        `[镜像] ${relPath}：锚标题「${heading}」缺失——对照锚 fail-loud（文档改版须同 commit 同步门禁锚，契约篇 §6.3#4 第五族）`,
      );
      return null;
    }
    if (source.indexOf(heading, first + heading.length) !== -1) {
      v(`[镜像] ${relPath}：锚标题「${heading}」不唯一——对照锚须全文档唯一命中`);
      return null;
    }
    // 从锚标题之后找下一个行首标题（##/###），截到那里；文件尾则截到末尾
    const rest = source.slice(first + heading.length);
    const next = rest.search(/^#{2,3} /m);
    return next === -1 ? source.slice(first) : source.slice(first, first + heading.length + next);
  };

  // ① 应用开发指南「活体总线词汇速览」表：词集双向 + 标题计数 + 层括号计数和
  {
    const relPath = join('docs', '应用开发指南.md');
    const source = readMirrorFile(relPath); // O-4② 镜像根缝：夹具模式缺席跳过
    const section = source === undefined ? null : docSection(source, relPath, '### 活体总线词汇速览');
    if (section) {
      // 词集提取锚 = 以 | 起头的表格行内反引号词（过词汇格式正则滤掉 `next()`/
      // `ctx.on` 型非词汇）——钉死表格行识别防注行 `on/emit` 型杂质混入（冷读 #6）
      const docWords = new Set();
      let layerSum = 0;
      for (const line of section.split('\n')) {
        if (!line.startsWith('|')) continue;
        for (const m of line.matchAll(/`([^`]+)`/g)) {
          if (EVENT_NAME_FORMAT.test(m[1])) docWords.add(m[1]);
        }
        // 层括号计数在首列（如「| 会话（3） |」全角括号）——层分组是编辑视角非
        // 契约，和数断言只防「加词忘改层括号」主事故形态（冷读 #7）
        const firstCell = line.split('|')[1] ?? '';
        const layerCount = firstCell.match(/（(\d+)）/);
        if (layerCount) layerSum += Number(layerCount[1]);
      }
      const catalogNames = new Set(liveCatalog.map((e) => e.name));
      for (const word of docWords) {
        if (!catalogNames.has(word)) {
          v(`[镜像] ${relPath} 速览表收录目录外词汇「${word}」——幽灵词（R5 事故型），目录是真源`);
        }
      }
      for (const entry of liveCatalog) {
        if (!docWords.has(entry.name)) {
          v(`[镜像] 总线目录事件「${entry.name}」未进 ${relPath} 速览表——漏项（全目录承诺，reserved 词同在集内）`);
        }
      }
      // 标题计数「N 词全目录」≡ 名集大小；层括号计数和 ≡ 标题计数
      const titleMatch = section.match(/(\d+)\s*词全目录/);
      if (!titleMatch) {
        v(`[镜像] ${relPath} 速览表标题计数「N 词全目录」锚缺失——fail-loud`);
      } else {
        const titleCount = Number(titleMatch[1]);
        if (titleCount !== catalogNames.size) {
          v(`[镜像] ${relPath} 速览表标题计数 ${titleCount} ≠ 总线目录 ${catalogNames.size} 词——计数漂移`);
        }
        if (layerSum !== titleCount) {
          v(`[镜像] ${relPath} 速览表层括号计数和 ${layerSum} ≠ 标题计数 ${titleCount}——层间分组漂移`);
        }
      }
    }
  }

  // ② 架构总览「事件系统」表：三行计数（项/型/类）≡ 三目录真值，各恰一次命中
  {
    const relPath = join('docs', '架构总览.md');
    const source = readMirrorFile(relPath); // O-4② 镜像根缝：夹具模式缺席跳过
    const section = source === undefined ? null : docSection(source, relPath, '## 4. 事件系统');
    if (section) {
      const countChecks = [
        ['总线词汇量（项）', /(\d+)\s*项/g, liveCatalog.length],
        ['AgentEvent（型）', /(\d+)\s*型/g, agentUnion.size],
        ['SessionEvent（类）', /(\d+)\s*类/g, sessionCatalog.length],
      ];
      for (const [label, pattern, truth] of countChecks) {
        const hits = [...section.matchAll(pattern)];
        if (hits.length !== 1) {
          v(`[镜像] ${relPath} 事件表「${label}」计数锚命中 ${hits.length} 次（须恰一次）——表结构漂移 fail-loud`);
          continue;
        }
        const stated = Number(hits[0][1]);
        if (stated !== truth) {
          v(`[镜像] ${relPath} 事件表「${label}」写 ${stated}，代码真值 ${truth}——计数漂移（R5 事故型）`);
        }
      }
    }
  }

  // ③ README 四语头部统计行：钩子数 ≡ 总线目录、durable 事件类数 ≡ SessionEvent 目录
  //（2026-09-01 复盘 G-6 根治——正文「35 钩子」对目录 27 的漂移即此型；模块数锚在
  // check-topology 规则 3，两器各管自家真相）。每锚须恰一次命中：0 次或多次都是
  // 表结构漂移，fail-loud 同 ②。
  {
    /** 文件 → [(标签, 提取正则, 真值)]；真值 = 本器目录（事件真相住 check-events） */
    const README_ANCHORS = [
      [
        'README.md',
        [
          ['生命周期钩子', /\*\*(\d+)\*\*\s*生命周期钩子/g, liveCatalog.length],
          ['durable 事件类', /\*\*(\d+)\*\*\s*类 durable 事件/g, sessionCatalog.length],
        ],
      ],
      [
        'README.en.md',
        [
          ['lifecycle hooks', /\*\*(\d+)\*\*\s*lifecycle hooks/g, liveCatalog.length],
          ['durable event types', /\*\*(\d+)\*\*\s*durable event types/g, sessionCatalog.length],
        ],
      ],
      [
        'README.es.md',
        [
          ['ganchos de ciclo de vida', /\*\*(\d+)\*\*\s*ganchos de ciclo de vida/g, liveCatalog.length],
          ['tipos de eventos durables', /\*\*(\d+)\*\*\s*tipos de eventos durables/g, sessionCatalog.length],
        ],
      ],
      [
        'README.fr.md',
        [
          ['crochets de cycle de vie', /\*\*(\d+)\*\*\s*crochets de cycle de vie/g, liveCatalog.length],
          ["types d'événements durables", /\*\*(\d+)\*\*\s*types d'événements durables/g, sessionCatalog.length],
        ],
      ],
    ];
    for (const [relPath, anchors] of README_ANCHORS) {
      // O-4② 镜像根缝：面随 CHECK_ROOT 随移。缺席跳过语义两态同构（既有
      // existsSync 先行——README 四语任一缺席不炸器，不属 fail-loud 面）
      const full = join(MIRROR_ROOT, relPath);
      if (!existsSync(full)) continue;
      const source = readFileSync(full, 'utf8');
      for (const [label, pattern, truth] of anchors) {
        const hits = [...source.matchAll(pattern)];
        if (hits.length !== 1) {
          v(`[镜像] ${relPath} 头部统计「${label}」锚命中 ${hits.length} 次（须恰一次）——表结构漂移 fail-loud`);
          continue;
        }
        const stated = Number(hits[0][1]);
        if (stated !== truth) {
          v(`[镜像] ${relPath} 头部统计「${label}」写 ${stated}，代码真值 ${truth}——计数漂移（复盘 G-6 根治锚）`);
        }
      }
    }
  }

  // ④ README 四语全家桶计数锚（遗漏大扫 20260901 L-1/O-2 根治面——契约篇 §6.3#4
  // 族 5③）：头部统计行「N 件官方全家桶」≡ 同文档全家桶表行数 + 四语横向一致。
  // 真值取同文档表行数（件数 = 注册表 14 行 + 默认应用 berrycode 的跨轴和，无代码单点
  // 目录——表即公开承诺面）；批3 曾同 commit 内统计行换基、表沿用旧基（14 vs 15
  // 互斥躺了整批），此锚防同型再漂。
  {
    /** 文件 → (统计行件数提取正则〔恰一次〕, 全家桶表节头正则)——四语同面 */
    const FAMILY_ANCHORS = [
      ['README.md', /\*\*(\d+)\*\* 件官方全家桶/g, /^### 官方全家桶（Ring 2，件件可卸）$/m],
      ['README.en.md', /\*\*(\d+)\*\* official bundle pieces/g, /^### Official Bundle \(Ring 2, each unloadable\)$/m],
      [
        'README.es.md',
        /\*\*(\d+)\*\* piezas oficiales/g,
        /^### Paquete oficial \(Ring 2, cada pieza desinstalable\)$/m,
      ],
      [
        'README.fr.md',
        /\*\*(\d+)\*\* pièces officielles/g,
        /^### Ensemble officiel \(Ring 2, chaque pièce déchargeable\)$/m,
      ],
    ];
    const statedByFile = [];
    for (const [relPath, headRe, sectionRe] of FAMILY_ANCHORS) {
      const full = join(MIRROR_ROOT, relPath);
      if (!existsSync(full)) continue; // 缺席跳过同 ③（夹具树不炸器）
      const source = readFileSync(full, 'utf8');
      const head = [...source.matchAll(headRe)];
      if (head.length !== 1) {
        v(`[镜像] ${relPath} 全家桶计数锚命中 ${head.length} 次（须恰一次）——表结构漂移 fail-loud`);
        continue;
      }
      const sec = sectionRe.exec(source);
      if (sec === null) {
        v(`[镜像] ${relPath} 全家桶表节头锚缺席——表结构漂移 fail-loud`);
        continue;
      }
      const stated = Number(head[0][1]);
      // 表行 = 节内以「| `」起头的数据行（表头/分隔行不携反引号件名）
      const after = source.slice(sec.index + sec[0].length);
      const nextSec = after.search(/^#{2,3} /m);
      const section = nextSec === -1 ? after : after.slice(0, nextSec);
      const rows = [...section.matchAll(/^\| `/gm)].length;
      if (stated !== rows) {
        v(`[镜像] ${relPath} 头部全家桶计数 ${stated} ≠ 表行数 ${rows}——同文档两基互斥（遗漏大扫 O-2 事故型）`);
      }
      statedByFile.push([relPath, stated]);
    }
    if (new Set(statedByFile.map(([, n]) => n)).size > 1) {
      v(`[镜像] 四语全家桶计数不一致：${statedByFile.map(([f, n]) => `${f}=${n}`).join(' ')}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 族 6：错误码注册表对账（基建大扫 #46——手拼/typo 码与注册死码两向红）    */
/* ------------------------------------------------------------------ */

{
  const registered = new Set(errorsMod.listErrorCodes());
  // 字面量形态对账：new AppError('CODE', ...) 手拼码必在注册表——标识符形态
  // 天然安全（具名常量只能从 registerErrorCode 产物定义），字面量是唯一逃逸面
  const literalRe = /new AppError\(\s*'([A-Z][A-Z0-9_]*)'/g;
  for (const file of files) {
    for (const m of file.code.matchAll(literalRe)) {
      if (!registered.has(m[1])) {
        v(`${file.rel}：AppError 字面量码 ${m[1]} 未注册（registerErrorCode 注册即词汇表）`);
      }
    }
  }
  // 注册未用对账（死码口径，对齐事件面死词断言）：具名常量在 errors.ts 之外
  // 零引用、且 errors.ts 内无字面量构造（registerErrorCode 自防御抛码经
  // 字面量构造即使用）= 注册即死码
  const errorsTs = files.find((f) => f.rel === 'src/contracts/errors.ts');
  const literalInErrors = new Set([...(errorsTs?.code.matchAll(literalRe) ?? [])].map((m) => m[1]));
  for (const code of registered) {
    if (literalInErrors.has(code)) continue;
    const wordRe = new RegExp(`\\b${code}\\b`);
    const used = files.some((f) => f.rel !== 'src/contracts/errors.ts' && wordRe.test(f.code));
    if (!used) v(`错误码 ${code} 注册未用（死码——词汇表不收尸体）`);
  }
}

/* ------------------------------------------------------------------ */
/* 族 7：迁移链版本锚（全面复盘 20260902 G-1/G-3①——新增迁移不滚表即红） */
/* ------------------------------------------------------------------ */

/** 代码真值：全仓 MigrationSpec 声明面最大 version（汇总行同引——let 供族块内赋值） */
let migrationMax = 0;
{
  // 代码真值：全仓非测试 src 的 MigrationSpec 声明面（声明形态恒 `: MigrationSpec = {`
  // 且 version 恒首字段——窗口 400 字符内取不到即表结构漂移 fail-loud）。不 import
  // 聚合链（collectBuiltinMigrations 拖全 app 依赖面）也不 import 四散 schema 模块
  // （登记清单会漏新文件）——源扫描对「新增迁移文件」结构性可见。
  const versions = [];
  for (const file of files) {
    const declRe = /:\s*MigrationSpec\s*=\s*\{/g;
    for (const m of file.code.matchAll(declRe)) {
      const win = file.code.slice(m.index, m.index + 400);
      const vm = /version:\s*(\d+)/.exec(win);
      if (vm === null) {
        v(`${file.rel}：MigrationSpec 声明 400 字符内无 version 字段——声明面结构漂移 fail-loud`);
        continue;
      }
      versions.push(Number(vm[1]));
    }
  }
  migrationMax = Math.max(0, ...versions);
  // 公开面两表 + 运维手册标题：末行版本 ≡ 代码真值（G-1 事故型 = v15 落码两表
  // 止于 v14、四门禁静默绿）。镜像面随 CHECK_ROOT 随移（readMirrorFile 两态同构）。
  // 表行版本取节内首列 `| N` 形（运维手册 v4/v9 折进他行内容不设独立行——
  // 完整性不是两表不变量，末行对齐才是）。
  const docTables = [
    ['docs/架构总览.md', /^## 8\. 存储布局[^\n]*/m],
    ['docs/运维手册.md', /^## 2\. 库内表清单[^\n]*/m],
  ];
  for (const [relPath, headRe] of docTables) {
    const source = readMirrorFile(relPath);
    if (source === undefined) continue;
    const head = headRe.exec(source);
    if (head === null) {
      v(`[镜像] ${relPath} 迁移表节头锚缺席——表结构漂移 fail-loud`);
      continue;
    }
    const after = source.slice(head.index + head[0].length);
    const nextSec = after.search(/^#{2,3} /m);
    const section = nextSec === -1 ? after : after.slice(0, nextSec);
    const rows = [...section.matchAll(/^\|\s*(\d+)(?!\d)/gm)].map((m) => Number(m[1]));
    if (rows.length === 0) {
      v(`[镜像] ${relPath} 迁移表零版本行——表结构漂移 fail-loud`);
      continue;
    }
    const docMax = Math.max(...rows);
    if (docMax !== migrationMax) {
      v(
        `[镜像] ${relPath} 迁移表末行 v${docMax} ≠ 代码真值 v${migrationMax}——新增迁移未滚表（全面复盘 20260902 G-1 事故型）`,
      );
    }
  }
  // 运维手册标题版本号（「user_version = N」）单独对照——标题与表末行双面同锚
  const ops = readMirrorFile('docs/运维手册.md');
  if (ops !== undefined) {
    const hm = /user_version\s*=\s*(\d+)/.exec(ops);
    if (hm === null) {
      v('[镜像] docs/运维手册.md 标题 user_version 锚缺席——表结构漂移 fail-loud');
    } else if (Number(hm[1]) !== migrationMax) {
      v(
        `[镜像] docs/运维手册.md 标题 user_version = ${hm[1]} ≠ 代码真值 v${migrationMax}——版本号漂移（全面复盘 20260902 G-1 事故型）`,
      );
    }
  }
}

// ---- 汇总 ----
if (violations.length > 0) {
  console.error(`check-events：${violations.length} 处目录/派发点漂移`);
  for (const message of violations) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `check-events ✓ 总线 ${liveCatalog.length} 项（另应用声明 ${declaredByName.size} 词）/ AgentEvent ${agentUnion.size} 型 / SessionEvent ${sessionCatalog.length} 类 / EventName 联合 ${eventUnion.size} 字面量 / 错误码 ${errorsMod.listErrorCodes().length} 册，七族双向一致（含公开面镜像 + 迁移末行 v${migrationMax} 锚）`,
);
