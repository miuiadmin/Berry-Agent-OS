#!/usr/bin/env node
/**
 * CI 拓扑门禁（技术栈篇 §2.3 四件之一；内核篇 §4：27 模块单向 DAG——各批随落码
 * 入册，席清单与入册史见内核篇 §4.1 模块表；27 席全有码）。
 *
 * 两条规则 + 一条公开面数字锚（2026-09-01 复盘 G-3 根治——「模块增行不滚计数」
 * 第五起漂移后，模块计数宣称面收进本器机器对照）：
 * 1. 相对导入只允许走显式白名单边（模块 → 可依赖模块集合）；同模块内部互引自由。
 * 2. 裸导入（包名）按模块白名单放行；node:* 全模块放行。
 * 3. 公开文档的模块计数宣称（README 四语头部统计行 + 「N 模块/N 个模块单向」
 *    句式）必须等于边表实数——数字漂移即红。
 * 测试文件（*.test.ts）豁免模块 DAG——harness 全真组合（mock 只停模型层）跨模块
 * 合法，产码白名单只描产码 DAG、两账分离（2026-08-31 复盘批 #38；原「只许本模块
 * 白名单边内目标」让测试需求反向给白名单续命，烂出七条死边）。
 *
 * 边表对齐[内核与应用边界]篇 §4 模块表；模块落地时如与规范出入，以规范为准修本表。
 * 未落地的模块保留占位行——目录不存在即零检查，表先钉住方向。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 模块 → 允许 import 的其他模块（单向 DAG 白名单；同层仅 context 作为运行时基座可被引用）
 * 2026-08-31 复盘批 #38 边表复核：七条死边（声明未用）收册——session/persist/llm/web/
 * compaction 的 context 边、safety/memory 的 session 边；收后白名单与实际 import 全对齐
 * （未声明边 = 零），规范侧边表（内核与应用边界篇 §4.1）同批同步 */
const MODULE_EDGES = {
  contracts: [],
  context: ['contracts'],
  session: ['contracts'],
  agent: ['contracts'],
  persist: ['contracts', 'session'],
  llm: ['contracts'],
  tools: ['contracts', 'context'],
  safety: ['contracts', 'context', 'tools'],
  skills: ['contracts', 'context'],
  subagent: ['contracts', 'context', 'agent', 'session'],
  // chat = 对话应用官方件聚落（铭牌批入册；不 import llm——StreamFn 经 contracts 注入；
  // exec 边 = S5 bash 迁域——createBashTool def 随 open() 会话域注册）
  chat: ['contracts', 'context', 'agent', 'session', 'persist', 'tools', 'safety', 'exec'],
  memory: ['contracts', 'context', 'persist'],
  goal: ['contracts', 'context', 'persist'],
  // exec = 工具族件聚落（第 18 模块，2026-08-25 exec 纵切；tools 不 import exec——
  // bash def 随 chat 件 open() 会话域注册（S5 迁域），检索族双装配点先例）
  exec: ['contracts', 'context', 'safety', 'tools'],
  scheduler: ['contracts', 'context', 'persist'],
  // mcp = stdio-only 客户端桥（2026-08-26 第一刀，契约篇 §6.6）：spawn/kill 经
  // 组合根闭包注入（app/mcp-spawn.ts）——结构上不见 exec/tools（冷读 #1）
  mcp: ['contracts', 'context'],
  lsp: ['contracts', 'context'],
  // web = 官方 web 件聚落（2026-08-26 web 刀，契约篇 §1.5.2）：fetch 工具 +
  // ctx.fetch 原语 + SSRF 五卫生件——工具注册经 ctx.get('tools') 服务面、管道
  // 经 ToolsService.executor（类型住 contracts）、schema 经 contracts typebox
  // 再导出面——零 tools/exec import（mcp 最窄边同款）
  web: ['contracts'],
  // bridge = 桥接协议 v0 + worker 分域装载两半（2026-08-26 第二十七批刀二
  // K3-a/K3-b2，契约篇 §1.7）：端点纯机制（BridgeEndpoint 两侧同构）+ worker
  // 半复用 context 装载器私有件（jiti/形状校验——WorkerRowLoader seam 反向：
  // context 不 import bridge，bridge 引 context 单向）。生命周期监督住组合根
  bridge: ['contracts', 'context'],
  // compaction = 长会话压缩官方件（2026-08-26 纵切，会话篇 §2 增补七条）：策略
  // 纯函数 + durable 四词宿主注册 + 件本体。服务全经 ctx 取（sessions/llm/
  // agent——运行时零跨模块 import）；session 边是 ProjectedMessage/SessionEvent
  // 类型面（2026-08-31 复盘批 #38 边表复核：context 死边删——与「服务全经 ctx
  // 取」注释一致；memory 的同名类型边同批已死删，此处勿再互引）
  compaction: ['contracts', 'session'],
  // checkpoint = 工作区快照·回退官方件（2026-08-30 纵切，会话篇 §5.3，默认层
  // 第十一行）：件本体 + blob 仓/捕获引擎纯函数 + /rewind 命令。服务全经 ctx
  // 取（sessions/paths/agent/channels/ui——运行时零跨模块 import）；fork 边界
  // 探针走 sessions.lastClosedBoundary() 宿主面单源（件不触 session 内部——
  // 修前件内自算曾以词级过滤数组喂 lastClosedTurnBoundary 恒错位，收敛宿主
  // 后 session 边退役）
  checkpoint: ['contracts', 'context'],
  // admin = 平台管理面官方件（2026-08-27 契约篇 §3.4 第一刀，默认层第十行）：
  // apps_list/events_query 两只读工具 + 管理 Skill 随件携带。工具/服务全经
  // ctx.get 运行时取（结构子集类型本地收窄）——零跨模块 import，contracts
  // 单边（mcp/web 最窄边再窄一档：连 context 类型都不引用）
  admin: ['contracts'],
  // 历史投影经注入回调拉取（不依赖 session）；活体事件类型来自 agent 公开事件面
  channels: ['contracts', 'context', 'agent'],
  // webui = Web 通道官方件（2026-08-30 Web 通道刀一，契约篇 §6.8，默认层第十四
  // 行 = Ring 2 真·可卸）：node:http 微路由 + SSE 活体流 + SPA 静态分发。display
  // 信封结构子集（WebuiDisplayEnvelope）本地定义不 import agent；UiBackend/
  // UiService 形状走 channels 类型面；typebox Type/Value 全走 contracts 再导出
  //（无裸导入、无 context 依赖——ctx 窄面类型来自 contracts AppContext）
  webui: ['contracts', 'channels'],
  // obs = 观测面官方件（契约篇 §6.9，2026-08-31 观测复盘批）：web/admin 单边
  // 形态 + persist 自管库边（createAppSqliteFace 直连开库——零跨模块 import）
  obs: ['contracts', 'persist'],
  // browser = 浏览器自动化官方件（契约篇 §6.10，2026-08-31 第四十九批）：
  // contracts 类型边 + web 卫生件边（刀二 navigate SSRF 前置真用入册——
  // assertPublicHost/requireHttpUrl 复用同码第三消费面）。spawn/kill/桥核/
  // 登记簿全经组合根闭包注入（app/browser-spawn.ts）——结构上不见 exec/mcp/context
  browser: ['contracts', 'web'],
  app: [
    'contracts',
    'context',
    'session',
    'agent',
    'persist',
    'llm',
    'tools',
    'safety',
    'skills',
    'subagent',
    'memory',
    'goal',
    'exec',
    'scheduler',
    'mcp',
    'web',
    'compaction',
    // admin = 平台管理面官方件（2026-08-27 契约篇 §3.4 第一刀）：只读两工具
    // 全走 ctx.get 运行时服务面（tools/sessions/plugins），零跨模块 import——
    // contracts 单边即足（比 mcp/web 窄边更窄：无 context 依赖）
    'admin',
    // checkpoint = 快照·回退官方件（会话篇 §5.3 第十一行）：builtins 注册 +
    // checkpointDeps 闭包（registry 在册会话集）+ sessions provide 两针
    //（adopt/isBusy）接线
    'checkpoint',
    // bridge = worker 域舰队（K3-c 组合根接线——app/bridge-fleet.ts 收编
    // spawnWorkerDomain 为 WorkerRowLoader + 监督/关停编舞，契约篇 §1.7）
    'bridge',
    'channels',
    'chat',
    // lsp = 语言服务器官方件（契约篇 §6.7 第十二行）：builtins 注册 + lspDeps
    // 闭包（confined spawner 的 lsp 实例/登记簿/桥核工厂——assembly 同构）
    'lsp',
    // webui = Web 通道官方件（契约篇 §6.8 第十四行）：builtins 注册 + webuiDeps
    // 闭包（addDisplay/submitTo/historyFor/sessionsFor/ui/themeFor/version——
    // 组合根晚绑闭包；VERSION 亦组合根注入防 app 边回流）
    'webui',
    // obs = 观测面官方件（契约篇 §6.9 第十五行）：builtins 注册（零 deps——
    // BuiltinRegistryOptions 零新字段，组合根零改动纪律首次兑现）
    'obs',
    // browser = 浏览器自动化官方件（契约篇 §6.10 第十六行，2026-08-31 第四十
    // 九批刀一）：builtins 注册 + browserDeps 闭包（browser-spawn/登记簿/桥核
    // 工厂——assembly 同构）
    'browser',
  ],
};

/** 裸导入白名单：包名 → 允许引用它的模块（node:* 与测试专用包单独放行）
 * 2026-08-31 第四十三批死项复核（同 R6 边表收册精神；本表不进死边断言——口径②，
 * 虚拟键/测试面合法项混载，产码死项靠周期人工复核）：收册四死项——typebox→skills/
 * safety（两模块产码测试零引用）、@earendil-works/pi-tui→app、jiti→app（src/app
 * 仅注释残留）。typebox→app 保留：狗粮件 fixture（dogfood.test.ts）真引用虚拟面键 */
const BARE_IMPORTS = {
  // context = 应用加载器（虚拟注入映射构造 + 行 config schema 校验 Value 面——契约篇 §1.2 落码注记③）
  typebox: ['contracts', 'context', 'tools', 'app', 'exec'],
  // berryagent = 加载器注入的虚拟模块名（非 npm 包；loader.test fixture 源码内的合法引用面）
  berryagent: ['context'],
  '@earendil-works/pi-ai': ['llm'],
  '@earendil-works/pi-tui': ['channels'],
  'better-sqlite3': ['persist'],
  yaml: ['app', 'skills'],
  ignore: ['skills', 'tools', 'checkpoint', 'webui'], // tools = 检索族 gitignore 遍历（2026-08-25 检索族纵切）；checkpoint = 工作区快照 DFS 遍历（2026-08-30 会话篇 §5.3——CR-10 语义同源不共享，第四消费者仍再议）；webui = @-mention 文件补全行走（2026-08-30 契约篇 §6.8 刀三）
  jiti: ['context'],
};
const TEST_ONLY_BARE = new Set(['vitest']);

/** 递归收集 src 下全部 ts 文件（webui/client 排除——vite 打包域：bundler 解析 + JSX，不进 Node 模块 DAG，刀二冷读 CR-7/9 同族排除） */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full === join(srcRoot, 'webui', 'client')) continue;
      out.push(...collect(full));
    } else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 提取文件中全部静态/动态 import 与 export-from 的说明符 */
function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // 副作用导入（import 'x.css'）——行首语句位锚定：真副作用导入是语句，必在行首
    //（允缩进）。两轮误报教训：字符串字面量里的 import 词面会被吞——'import'/
    // origin='import'（引号前置，2026-08-27 P1-1 撞上 16 处）、argv 数组 '--import'
    //（连字符前置同样放过了旧 lookbehind，同日 e1 落码撞上）——行锚定一并根治
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

/** 文件所属模块（src 下第一级目录名；src 根不挂散文件——出现即报违规） */
function moduleOf(file) {
  const relativePath = file.slice(srcRoot.length + 1);
  const firstSegment = relativePath.split('/').at(0) ?? '';
  return firstSegment.endsWith('.ts') ? '(root-files)' : firstSegment;
}

const violations = [];
const seenModules = new Set();
// 产码跨模块相对导入记录（"module target"）——死边断言的用例证据。
// 只计产码（.test.ts 不计）：测试 import 给边续命正是复盘批 #38 七死边的烂出机制，
// 证据口径必须与测试豁免（下文 isTest 分支）同源两账分离（契约篇 §6.3#2）。
const usedEdges = new Set();

for (const file of collect(srcRoot)) {
  const module = moduleOf(file);
  seenModules.add(module);
  const isTest = file.endsWith('.test.ts');
  const allowed = MODULE_EDGES[module];
  if (!allowed) {
    violations.push(`${relative(file)}：未知模块（不在 ${Object.keys(MODULE_EDGES).length} 模块白名单）`);
    continue;
  }

  for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('node:')) continue;

    if (spec.startsWith('.')) {
      // 相对导入：解析目标（NodeNext 源码以 .js 后缀指 .ts 文件——candidates 里做 .js→.ts 回替）
      const base = resolve(dirname(file), spec);
      const baseTs = base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : base;
      const candidates = [base, baseTs, `${base}.ts`, `${baseTs}.ts`, join(base, 'index.ts'), join(base, 'index.js')];
      const target = candidates.find((c) => {
        try {
          return statSync(c).isFile();
        } catch {
          return false;
        }
      });
      if (!target) {
        violations.push(`${relative(file)}：相对导入无法解析 ${spec}`);
        continue;
      }
      const targetModule = moduleOf(target);
      if (targetModule === module) continue; // 同模块自由
      if (isTest) {
        // 测试文件豁免模块 DAG：harness 全真组合（mock 只停模型层）跨模块合法。
        // 2026-08-31 复盘批 #38：原「只许本模块白名单边内目标」让测试需求反向给
        // 白名单续命——七条死边即此机制烂出来的；产码白名单只描产码 DAG，两账分离
        // （规范 = 契约篇 §6.3#2）
        continue;
      }
      usedEdges.add(`${module} ${targetModule}`);
      if (module !== '(root-files)' && !allowed.includes(targetModule)) {
        violations.push(
          `${relative(file)}：${module} → ${targetModule} 不在白名单边 ${allowed.join(', ') || '（无）'}`,
        );
      }
      continue;
    }

    // 裸导入：scoped 包归一到 @scope/name（子路径导入按包级白名单放行——同包 subpath 不算新依赖）
    const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/').at(0);
    if (TEST_ONLY_BARE.has(spec)) {
      if (!isTest) violations.push(`${relative(file)}：vitest 只许出现在测试文件`);
      continue;
    }
    const bareAllowed = BARE_IMPORTS[bare];
    if (!bareAllowed || !(bareAllowed.includes(module) || module === 'app')) {
      violations.push(`${relative(file)}：模块 ${module} 不允许裸导入 ${bare}`);
    }
  }
}

function relative(file) {
  return file.slice(srcRoot.length + 1);
}

/* ---------------- 组合根零改动纪律（内核与应用边界篇 §2.1，2026-08-31 技术债批） ----------------
 * 官方件 deps 装配下沉 builtin-deps.ts 的机器执法两道：
 * ① assembly.ts 内 createBuiltinRegistry( 的实参必须是 assembleBuiltinDeps( 产物——
 *    组合根只构造 BuiltinHostResources 资源束，不内联拼 BuiltinRegistryOptions；
 * ② assembly.ts 不得出现「XxxDeps:」字面键（官方件闭包依赖字段一律 *Deps 后缀——
 *    命名规约使间接构造〔先拼对象再传入〕同样被字面键扫描拦下）。
 * 新官方件落码全链住 builtin-deps.ts + builtins.ts，assembly 零行增长由此可机检。 */
{
  const assemblySource = readFileSync(join(srcRoot, 'app', 'assembly.ts'), 'utf8');
  if (/createBuiltinRegistry\s*\(\s*(?!\s*assembleBuiltinDeps)/.test(assemblySource)) {
    violations.push(
      'app/assembly.ts：createBuiltinRegistry 实参非 assembleBuiltinDeps 产物（组合根零改动纪律——官方件 deps 派生住 builtin-deps.ts，内核与应用边界篇 §2.1）',
    );
  }
  for (const match of assemblySource.matchAll(/\b\w+Deps\s*:/g)) {
    violations.push(
      `app/assembly.ts：出现官方件 deps 字面键「${match[0]}」（派生住 builtin-deps.ts——组合根零改动纪律，内核与应用边界篇 §2.1）`,
    );
  }
}

/* ---------------- 死边断言（内核篇 §4.3#4 边表双向执法，2026-08-31 第四十三批） ----------------
 * 声明未用边（MODULE_EDGES 有、产码 import 零证据）= 违规——「边随真用入册」的机器执法。
 * 三口径（冷读 #1/#2/#3 钉死）：
 * ①用例证据只计产码（.test.ts 豁免，与主循环 isTest 分支同源）；
 * ②断言只及模块 DAG 边表 MODULE_EDGES——BARE_IMPORTS 裸导入白名单不参与（其内含
 *   berryagent 虚拟键等测试面合法项，死边断言管它必致不可修误报）；裸导入白名单的
 *   产码死项靠周期人工复核；
 * ③边表键 ⊆ 在场模块 ∪ 占位清单——防模块删除后残键/键名手滑被「占位零检查」豁免
 *   （死键对门禁不可见 = 死边盲区的同构复刻）。 */
{
  // 显式占位清单：边表键已入册但目录未落地的席（今日为空；占位键须在此登记并注释声明）
  const PLACEHOLDER_MODULES = new Set();
  for (const [mod, edges] of Object.entries(MODULE_EDGES)) {
    if (!seenModules.has(mod)) {
      if (!PLACEHOLDER_MODULES.has(mod)) {
        violations.push(
          `边表键「${mod}」无对应模块目录且非占位清单成员——模块已删残留键或键名手滑（死键对门禁不可见，内核篇 §4.3#4 口径③）`,
        );
      }
      continue; // 占位键的边零检查——表先钉住方向
    }
    for (const target of edges) {
      if (!usedEdges.has(`${mod} ${target}`)) {
        violations.push(
          `死边：${mod} → ${target} 声明未用（产码零 import 证据）——边随真用入册，未用的边删掉（内核篇 §4.3#4 边表双向执法）`,
        );
      }
    }
  }
}

/* ---- 规则 3：公开面模块计数锚（2026-09-01 复盘 G-3 根治） ----
 * 「模块增行不滚计数」五起漂移的机器面：公开文档的模块数宣称必须等于边表实数。
 * 断言面（每文件逐处对照，非只头部）：
 * - README 四语头部统计行「**N** 模块 / **N** modules / **N** módulos」；
 * - 「N 模块单向 DAG」（含 README 正文/架构图与 AGENTS/CONTRIBUTING/开发指南）、
 *   「N 个模块单向依赖」（架构总览）、README 三外语的「N-module one-way DAG /
 *   de N módulos / de N modules」同义句式。
 * 收词前提 = 零误报：只锚「模块总量」计数口径的既有句式；行数/件数/环数/Ring 0
 * 子集数等他口径不收（各有语义，不属本器真相）。文件缺失静默跳过（本仓恒在）。 */
{
  const count = Object.keys(MODULE_EDGES).length;
  /** 文件 → 提取正则（g 标志逐处对照；语言各自适配） */
  const CLAIMS = [
    ['README.md', /\*\*(\d+)\*\*\s*模块/g],
    ['README.md', /(\d+)\s*模块单向 DAG/g],
    ['README.en.md', /\*\*(\d+)\*\*\s*modules/g],
    ['README.en.md', /(\d+)-module one-way DAG/g],
    ['README.es.md', /\*\*(\d+)\*\*\s*módulos/g],
    ['README.es.md', /de\s+(\d+)\s*módulos/g],
    ['README.fr.md', /\*\*(\d+)\*\*\s*modules/g],
    ['README.fr.md', /de\s+(\d+)\s*modules/g],
    ['AGENTS.md', /(\d+)\s*模块单向 DAG/g],
    ['CONTRIBUTING.md', /(\d+)\s*模块单向 DAG/g],
    ['docs/开发指南.md', /(\d+)\s*模块单向 DAG/g],
    ['docs/架构总览.md', /(\d+)\s*个模块单向依赖/g],
  ];
  for (const [file, re] of CLAIMS) {
    const full = resolve(dirname(fileURLToPath(import.meta.url)), '..', file);
    if (!existsSync(full)) continue;
    for (const m of readFileSync(full, 'utf8').matchAll(re)) {
      if (Number(m[1]) !== count) {
        violations.push(
          `${file}：模块计数宣称 ${m[1]} ≠ 边表实数 ${count}（模块增行须同笔滚计数——复盘 G-3 第五起漂移根治锚）`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`拓扑检查未通过（${violations.length} 处违规）：`);
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(
  `拓扑检查通过：${seenModules.size} 个模块（${[...seenModules].sort().join(', ')}），边表 ${Object.keys(MODULE_EDGES).length} 行（死边零，双向执法，公开面模块计数锚对照绿）`,
);
