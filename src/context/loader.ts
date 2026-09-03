/**
 * L1 context — 应用加载器本体（应用契约篇 §1：jiti 直载 + 虚拟注入 + 轮次激活）。
 *
 * 职责单子（「怎么装」；「装什么/在哪」归 app 组合树模块）：
 * 1. **jiti 免编译直载 .ts/.js**（§1.2【pi】），宿主核心包与 typebox 以虚拟模块
 *    注入防双实例（应用 peerDependencies 声明、禁自装 typebox）；
 * 2. **形状校验**（§1.1 单形状钉死 + §1.2 named export 三件——APP_SHAPE_INVALID）；
 * 3. **行 config 启动一次性校验**（应用声明 schema，APP_CONFIG_INVALID）；
 * 4. **inject 依赖驱动轮次激活（Kahn 式，§1.2 落码注记②）**：逐轮扫描、全就绪即激活
 *    （激活完成即可 provide 服务供后续轮取用）；整轮零进展仍有 pending = 缺提供方或
 *    依赖环，即刻响亮失败列 pending 清单（无墙上钟超时）；
 * 5. **per-plugin fork 作用域**：独立 effect 栈（卸载/LIFO 回卷基底）、config 冻结视图、
 *    logger 前缀（`app:<行id>`——失败归因）；apply 抛错或挂起超时（§1.6 时钟族
 *    缺省 10s）即回卷本作用域再进失败清单（§1.6 不留残骸、不静默跳过）；
 * 6. **生命周期事件逐行必发**（§2.2 增补 1：app/activated / failed / skipped——
 *    「扩展没生效」从 pull 诊断升级为 push 事件面）；
 * 7. **自定义事件词汇装载期登记**（§1.1 逃生口）：行 named export events 在一切
 *    apply 之前经 registerLiveEvent 入注册表（挂 root/锚作用域 effect——卸载即注销）。
 * 8. **worker 行两半装载**（契约篇 §1.7，2026-08-26 第二十七批刀二）：runtime:
 *    'worker' 行经注入的 WorkerRowLoader（bridge 模块实现，拓扑 seam——本模块
 *    只定义结构不引 bridge）在 worker 域完成 import/校验，元数据过界后与 main 行
 *    同管线混排（事件登记/Kahn 轮次/config 校验/生命周期事件不分域）。
 *
 * jiti `moduleCache: false` 是 /reload 两条缓存纪律（§1.3 补钉②）的 v1 基底：
 * 每次 import 全依赖图重新求值——毒化模块与「模块图半坏」结构上不可能跨加载存活。
 */

import { createJiti, type TransformOptions, type TransformResult } from 'jiti';
import { createRequire, isBuiltin, Module } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import * as typeboxRoot from 'typebox';
import * as typeboxCompile from 'typebox/compile';
import * as typeboxValue from 'typebox/value';
import * as contractsFace from '../contracts/index.js';
import {
  AppError,
  APP_APPLY_FAILED,
  APP_APPLY_TIMEOUT,
  APP_CONFIG_INVALID,
  APP_ENTRY_UNRESOLVED,
  APP_IMPORT_FORBIDDEN,
  APP_INJECT_UNRESOLVED,
  APP_LOAD_FAILED,
  APP_SHAPE_INVALID,
  describeError,
} from '../contracts/errors.js';
import { appZoneId, registerLiveEvent, tryResolveService } from './context.js';
import { runInCallerChain } from './chain.js';
import type {
  AppActivatedPayload,
  AppFailedPayload,
  AppLoadResult,
  AppModule,
  AppPlanRow,
  AppSkippedPayload,
} from '../contracts/app.js';
import { resolveRowCarrier } from '../contracts/app.js';
import { VIRTUAL_API_KEYS, assertExperimentalDeclared } from '../contracts/api.js';
import type { LiveEventDefinition } from '../contracts/events.js';
import type { Context, ContextScope } from './types.js';

/**
 * 形状校验后的模块视图：default 已确认是函数，ctx 参数在此收窄为真实 Context
 * （contracts 侧 AppApply 的 ctx 是结构占位——零依赖层不引 context 类型）。
 * 导出（第二十七批刀二 K3-b2）：worker 半 bootstrap 复用同一校验与类型
 * （worker 域自有 loader 模块实例——本类型两侧各持一份，结构同源）。
 */
export type ValidatedModule = Omit<AppModule, 'default'> & {
  default: (ctx: Context, config?: Readonly<Record<string, unknown>>) => unknown;
};

/**
 * 创建应用装载用 jiti 实例。导出（第二十七批刀二 K3-b2）：worker 半 bootstrap
 * 在 worker realm 建同构实例（虚拟注入映射两 realm 各持一份——函数不可过界，
 * 注入物必须 realm 本地构造；v1 worker 域虚拟面第五/六键为空对象面，与
 * loadApps 缺省行为同构，后续按需开面）。
 *
 * 虚拟注入映射（契约篇 §1.2 落码注记①）：`berryagent`（宿主公共面 = contracts
 * 公共导出——AppError/错误码/事件常量与目录/typebox 再导出；名即宿主 npm 包名）
 * + typebox 三入口（宿主实例注入——双实例防线，pi 生态 Static 双实例实证反例）。
 */
/**
 * 虚拟模块面键集（单一来源 = contracts/api.ts VIRTUAL_API_KEYS 键表——API 治理
 * §6.13.1 真相源 #1，第八十七批派生收编）：装载期 jiti 注入的宿主实例模块名。
 * 用途有三——virtualModules 构造 + import 失败错误的可用面提示（探针 #12：
 * 第三方按 npm 子路径直觉写 `berryagent/typebox` 撞错时，错误必须自带合法路）
 * + experimental import 门禁判据（§6.13.4——键表 tier 列单源，本模块不再另持）。
 * 2026-08-26 挖矿批 P0-2 扩六键：+`berryagent/llm`（pi-ai provider 工厂族背书，
 * llm 模块 provider-face 注入）+`berryagent/sqlite`（宿主同实例 better-sqlite3
 * 包装，persist 模块 app-sqlite 注入——主库路径 fail-loud 拒开）。注入物由
 * 组合根参数传入（本模块不 import llm/persist——拓扑边 context→contracts 不变）。
 */
const VIRTUAL_MODULE_KEYS: readonly string[] = VIRTUAL_API_KEYS.map((entry) => entry.key);

/**
 * import 失败错误的虚拟面提示：消息形如「Cannot find module …」时附可用面清单。
 * 虚拟模块只在 jiti 装载期存在——第三方 IDE/文档看不到它，猜错是常态而非例外。
 */
function virtualModuleHint(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (!/Cannot find module|ERR_MODULE_NOT_FOUND|PACKAGE_PATH_NOT_EXPORTED/.test(text)) return '';
  const faces = VIRTUAL_MODULE_KEYS.map((k) => `'${k}'`).join('、');
  return `（可用虚拟模块面：${faces}——宿主公共面与 typebox 经装载期虚拟注入，子路径不解析；契约篇 §1.2）`;
}

/* ---------------- import 来源门禁（契约篇 §1.2 执法面②，2026-08-26 挖矿批 P0-2） ---------------- */

/**
 * 当前装载行的应用目录树根（realpath 归一）：装载排队链串行设置/清理（见
 * importAppEntry 的 loadChain——一切装载入口串行是机制事实），transform 全图
 * 扫描据此裁决树内外。builtin 行不经 jiti，期间恒 undefined（不拦）。
 */
let currentTreeRoot: string | undefined;

/**
 * 当前装载窗的 API 装载门上下文（API 治理 §6.13.4 执法点①，第八十七批）：
 * 与 currentTreeRoot 同生命周期（装载排队链窗内设置/finally 清空）——装载行的
 * 清单 api 块裁决产物（应用 id + 已声明实验键集）。undefined = 无声明可达
 * （builtin 行/防御路径）——实验键 import 恒拒（fail-closed；现役六键全 stable，
 * 空集与缺席同效）。模块实例级（worker realm 自持实例同律）。
 */
let gateWindow: ImportGateContext | undefined;

/**
 * API 装载门上下文（装载门裁决结果在装载窗内的形态）：loadApps 经
 * experimentalByRow seam 自组合根取得（组合根闭包读 app-registry 裁决产物）。
 */
export interface ImportGateContext {
  /** 行属应用 id（错误消息归因用） */
  readonly appId: string;
  /** 清单 api.experimental 声明集（空集 = 未声明任何实验键） */
  readonly experimental: ReadonlySet<string>;
}

/**
 * 活动树根集（**行寿命**，2026-09-02 勘正〔遗漏大扫 20260902-c #3〕）：镜像
 * 当前组合树——装载即入（importAppEntry 窗内 add），loadApps 每轮开始按本轮
 * 将 import 的行剪枝（卸载/禁用/换载体行的树根即逐出）。Module._load 常驻补丁
 * （ensureNodeLoadGate）据此集合裁决纯 CJS 迟发 require——集合空纯透传。与
 * currentTreeRoot 的分工：后者是**装载窗**事实（transform 扫描裁决用），前者是
 * **行存活期**事实（apply 期/定时器期迟发 require 裁决用）。模块实例级（同
 * currentTreeRoot 律）：worker realm 自持实例，其行寿命 = realm 寿命，无需剪枝。
 */
const activeTreeRoots = new Set<string>();

/** Module._load 常驻补丁安装旗标（模块实例级，幂等） */
let nodeLoadGateInstalled = false;

/**
 * 装载排队链尾（20260901-d #13，契约篇 §1.2 注记⑤勘正）：一切 importAppEntry
 * 调用串行。原「boot 与 /reload 不并发是装配序前提」的注释假设在 admin 装载
 * 词表收割（configure / mount-config 预校验 / install·update）第三消费方落地
 * 后失真——含顶层 await 的应用求值跨异步边界，TLA 恢复时懒件（动态 import
 * 目标）的 transform 会见他载树根（本树合法导入误拒）或已清空值（门禁静默
 * 放行）。排队把 TLA 求值持链至完成，懒件 transform 恒见己根。模块实例级
 * （与 currentTreeRoot 同律）：worker realm 自持 loader 模块实例，链按 realm
 * 隔离不与主域互扰。
 */
let loadChain: Promise<unknown> = Promise.resolve();

/** 默认转译实例：只借公开 `.transform` 方法链默认 TS 转译（guard 通过后照常转译——零内部路径依赖） */
const plainJiti = createJiti(import.meta.url);

/**
 * 静态说明符提取正则：import 声明 / export-from / 动态 import 字面量 / require
 * 字面量 / 裸 import。type-only import 同样被抓（源码面统一纪律——解析对账不等
 * 使用）；注释中的示例 import 也会被抓（过度拦截面——注释里写越界 import 本就
 * 该清理，消息自带合法路指路，接受）。
 */
const SPECIFIER_RE =
  /(?:import|export)\s+[^'";]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

/** 提取源码中全部静态说明符（matchAll 四捕获组按序取首个命中） */
function extractSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPECIFIER_RE)) {
    const s = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (s !== undefined) out.push(s);
  }
  return out;
}

/** realpath 容错：目标不存在（尚未创建的新库/新文件）或不可达时回退字面绝对路径 */
function realpathIfPossible(absolutePath: string): string {
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/** 判定路径是否落在应用目录树内（等值 = 树根本身，罕见但等价于树内） */
function insideTree(p: string, treeRoot: string): boolean {
  return p === treeRoot || p.startsWith(treeRoot + sep);
}

/**
 * 白名单三道裁决（契约篇 §1.2 注记⑤）：虚拟面六键 → `node:`/裸内建 → 应用
 * 目录树内。返回 undefined = 放行；string = 拒载原因（进错误消息）。
 * 相对/绝对路径按导入文件位置解析；裸包名经 createRequire 从导入文件位置解析
 * （node 真实解析语义）——realpath 归一后验落树：自捆 node_modules 即树内放行，
 * 解析上逃到宿主侧/全局或不可解析即拒（symlink 归一同规，别名逃逸同拦）。
 */
function adjudicateImport(specifier: string, fromDir: string, treeRoot: string): string | undefined {
  // 第一道：虚拟面六键（防御式——虚拟模块 import 通常由 jiti 短路不经 transform）
  if ((VIRTUAL_MODULE_KEYS as readonly string[]).includes(specifier)) return undefined;
  // 第二道：显式 node: 前缀与裸 Node 内建（fs/path/crypto…——isBuiltin 视同 node: 放行）
  if (specifier.startsWith('node:') || isBuiltin(specifier)) return undefined;
  // 第三道：应用目录树内
  if (specifier.startsWith('./') || specifier.startsWith('../') || isAbsolute(specifier)) {
    const target = realpathIfPossible(resolve(fromDir, specifier));
    return insideTree(target, treeRoot) ? undefined : `相对路径解析逃逸出应用目录树（${specifier} → ${target}）`;
  }
  try {
    const resolved = createRequire(join(fromDir, 'noop.js')).resolve(specifier);
    const target = realpathIfPossible(resolved);
    return insideTree(target, treeRoot) ? undefined : `包解析逃逸出应用目录树（${specifier} → ${target}）`;
  } catch {
    return `不可解析（${specifier}——拼写错或未自捆：应用自身依赖须随 node_modules 自捆分发，契约篇 §6.1）`;
  }
}

/**
 * import 越界拒载错误构造器（字面量早拦与运行期兜底同码同出口——差异只在
 * originNote 标注拦截层，消息可分辨）。白名单指路尾文本两层共享（探针 #12：
 * 第三方撞墙时错误必须自带合法路）。
 */
function importForbiddenError(specifier: string, violation: string, originNote: string): AppError {
  return new AppError(
    APP_IMPORT_FORBIDDEN,
    `import 越界：${specifier}——${violation}（${originNote}）。` +
      `白名单三道：虚拟面六键（${VIRTUAL_MODULE_KEYS.map((k) => `'${k}'`).join('、')}）/ node: 内建 / 应用目录树内；` +
      `宿主类型与工厂经虚拟面取（契约篇 §1.2 注记⑤）`,
  );
}

/**
 * 执法 transform（§1.2 执法面②，spike 实证形态）：jiti 全依赖图每文件过检
 * （moduleCache:false 保证无缓存旁路）——先扫说明符，违规即抛
 * APP_IMPORT_FORBIDDEN（transform 抛错先于 eval——模块永不求值，副作用零触达）；
 * 合法后链 plainJiti 默认转译。currentTreeRoot undefined（builtin 行/防御路径）
 * 时不拦照转——真实文件装载路径必设。
 *
 * 运行期兜底第一腿（全面复盘 20260902 S-1，契约篇 §1.2 注记⑤勘正）：字面量
 * 扫描只认引号字面量，**计算说明符**（拼串变量求值出的绝对路径/裸包名）结构性
 * 失明——转译产物指令序后注入 require/jitiImport 求值入口包裹（见
 * injectRuntimeGuardPrelude），每次调用运行期复跑同一三道裁决。
 */
function guardTransform(opts: TransformOptions): TransformResult {
  const treeRoot = currentTreeRoot;
  if (treeRoot !== undefined && opts.filename !== undefined) {
    for (const specifier of extractSpecifiers(opts.source ?? '')) {
      // 实验键门禁（API 治理 §6.13.4 执法点①，第八十七批）：说明符属虚拟键且
      // 键表 tier = experimental 而装载行未声明 → API_EXPERIMENTAL_UNDECLARED
      // 拒载（契约即知情）。现役六键全 stable 故恒放行——门禁先行、键随后到。
      if (gateWindow !== undefined && (VIRTUAL_MODULE_KEYS as readonly string[]).includes(specifier)) {
        assertExperimentalDeclared(specifier, gateWindow.experimental, gateWindow.appId);
      }
      const violation = adjudicateImport(specifier, dirname(opts.filename), treeRoot);
      if (violation !== undefined) {
        throw importForbiddenError(specifier, violation, `文件 ${opts.filename}`);
      }
    }
  }
  const code = plainJiti.transform(opts);
  // 树根缺席（builtin 行/防御路径）时守卫无锚可烙——与字面量层「不拦照转」同律
  return { code: treeRoot === undefined ? code : injectRuntimeGuardPrelude(code, treeRoot) };
}

/* ---------------- 运行期 import 门禁兜底（全面复盘 20260902 S-1，契约篇 §1.2 注记⑤勘正） ---------------- */

/**
 * 运行期门禁检查面键（globalThis）：transform 注入的前置守卫闭包与宿主裁决间
 * 唯一稳定通道——jiti 以 vm.runInThisContext 求值（同域 globalThis），守卫产码
 * 与宿主模块不能共享闭包，全局键是两界最短桥。命名去品牌化（通用领域语义）。
 * 键值形态 = (specifier, fromDir, treeRoot) => AppError | undefined——undefined
 * 放行；AppError 由守卫原样 throw（同码 APP_IMPORT_FORBIDDEN，与字面量早拦
 * 同出口）。worker realm 自持 loader 模块实例——两域各装各的（globalThis 按
 * realm 隔离，键不跨域互扰）。
 */
const RUNTIME_GATE_KEY = '__appLoaderImportGate';

/** 运行期门禁检查面安装（createAppJiti 每次幂等覆装——函数无状态，重复装零副作用） */
function installRuntimeGate(): void {
  (globalThis as Record<string, unknown>)[RUNTIME_GATE_KEY] = (
    specifier: string,
    fromDir: string,
    treeRoot: string,
  ): AppError | undefined => {
    const violation = adjudicateImport(specifier, fromDir, treeRoot);
    return violation === undefined
      ? undefined
      : importForbiddenError(specifier, violation, `运行期兜底：求值文件目录 ${fromDir}`);
  };
}

/**
 * 指令序正则：函数体开头的连续字符串指令（"use strict" 等）。守卫必须插在指令
 * 序之后——插在前面会使其后的 "use strict" 降级为普通表达式（指令只有位居函数
 * 体首才生效），模块严格性语义漂移。指令字符串不含转义（含转义的字面量本就不
 * 构成指令），正则按此收紧。
 */
const DIRECTIVE_PROLOGUE_RE = /^(?:\s*(?:'[^'\\\n]*'|"[^"\\\n]*")\s*;)+/;

/**
 * 运行期兜底第一腿注入体：在转译产物指令序后、一切语句前插入 require/jitiImport
 * 包裹。要点：
 * - jiti 求值包裹签名为 (exports, require, module, __filename, __dirname,
 *   jitiImport, jitiESMResolve)——本段以 var 声明遮蔽 require/jitiImport 两参，
 *   原值先经 typeof 捕获（var 与参数同名合并绑定，赋值前读到的就是原参数值）；
 * - 包裹形态 = **Proxy apply 陷阱**（2026-09-02 勘正〔遗漏大扫 20260902-c #2〕）：
 *   属性面自动透传（无 get 陷阱即转发目标函数），require.resolve / require.cache
 *   等合法 CJS 惯用面照常可用；裸函数遮蔽会整体丢失属性面（干净环境实测
 *   require.resolve is not a function——合法第三方应用结构性不可装载，修 A 破
 *   B），调用面经 apply 陷阱受辖。
 * - 树根随 transform 时点烙成字面量进模块闭包——apply 期迟发动态 import 同受辖
 *   （不依赖装载窗在场，绕开 currentTreeRoot 生命周期）；
 * - __dirname（求值包裹参数）即裁决 fromDir；守卫经 globalThis 键回查宿主
 *   adjudicateImport（产码不能持有宿主闭包引用）；
 * - 虚拟面六键 / node: 内建由三道裁决放行——合法路径零行为变化。
 */
function injectRuntimeGuardPrelude(code: string, treeRoot: string): string {
  const prologue = DIRECTIVE_PROLOGUE_RE.exec(code);
  const insertAt = prologue ? prologue[0].length : 0;
  const prelude =
    `var __igGate = globalThis[${JSON.stringify(RUNTIME_GATE_KEY)}];` +
    `var __igRoot = ${JSON.stringify(treeRoot)};` +
    `var __igOrigRequire = typeof require === "function" ? require : null;` +
    `var __igOrigImport = typeof jitiImport === "function" ? jitiImport : null;` +
    `var __igCheck = function (id) {` +
    `  var e = __igGate && __igGate(String(id), __dirname, __igRoot);` +
    `  if (e) throw e;` +
    `};` +
    // Proxy apply 陷阱包裹：属性读取无陷阱即透传目标（resolve/cache 惯用面保全），
    // 仅调用面过 __igCheck；目标非函数（无 require 面的求值环境）原样返回
    `var __igWrap = function (orig) {` +
    `  if (typeof orig !== "function") return orig;` +
    `  return new Proxy(orig, {` +
    `    apply: function (target, thisArg, args) { __igCheck(args[0]); return target.apply(thisArg, args); }` +
    `  });` +
    `};` +
    `var require = __igWrap(__igOrigRequire);` +
    `var jitiImport = __igWrap(__igOrigImport);`;
  return code.slice(0, insertAt) + prelude + code.slice(insertAt);
}

/** node Module._load 结构签名（内部 API，@types 未声明——结构收窄自用） */
type NodeModuleLoadFn = (request: string, parent: { filename?: string | null } | null, isMain: boolean) => unknown;

/**
 * 运行期兜底第二腿：纯 CJS 面（.cjs / 无 ESM 语法的 .js）jiti 不调自定义
 * transform（evalModule 的转译判定：非 TS、无 ESM 语法即 native require 直载，
 * 探针实证 transform 零调用）——字面量早拦与前置守卫注入双双缺席。
 *
 * **行寿命执法**（2026-09-02 勘正〔遗漏大扫 20260902-c #3〕）：原窗式装拆
 * （importAppEntry 窗内包 Module._load、finally 还原）对 apply 期迟发 require
 * 全裸——装载器在 importAppEntry 返回**之后**才调 apply，纯 CJS 中间模块体内
 * 的 require（定时器/事件回调里发起同理）落在窗外即逃逸（实验复现 ESCAPED:
 * host-secret）。改为**首个活动树根安装后按 realm Module 实例寿命常驻**：
 * 补丁按 activeTreeRoots 集合裁决——**请求父模块（require 发起文件）落在任一
 * 活动树内**才过三道裁决（树根互斥：各自行目录，首个包含即裁决树）；父在树外
 * （宿主自身/测试框架的 require）恒放行；集合空（无活动行）纯透传，零行为面。
 * 集合镜像当前组合树：装载即入、loadApps 每轮剪枝——「常驻」不等于「无界」。
 * worker realm 自持 Module 实例与 loader 模块实例——补丁按 realm 天然隔离，
 * 其行寿命 = realm 寿命，无需剪枝。
 */
function ensureNodeLoadGate(): void {
  if (nodeLoadGateInstalled) return;
  const ModuleInternals = Module as unknown as { _load?: NodeModuleLoadFn };
  const origLoad = ModuleInternals._load;
  if (typeof origLoad !== 'function') return; // 防御：形态漂移时只缺兜底不炸装载
  const gated: NodeModuleLoadFn = (request, parent, isMain) => {
    if (activeTreeRoots.size > 0) {
      const parentFile = parent?.filename;
      if (parentFile !== undefined && parentFile !== null) {
        const realParent = realpathIfPossible(parentFile);
        for (const treeRoot of activeTreeRoots) {
          if (insideTree(realParent, treeRoot)) {
            const violation = adjudicateImport(request, dirname(parentFile), treeRoot);
            if (violation !== undefined) {
              throw importForbiddenError(request, violation, `运行期兜底：require 发起文件 ${parentFile}`);
            }
            break; // 树根互斥（各自行目录）——首个包含即裁决树，免继续扫
          }
        }
      }
    }
    return origLoad.call(Module, request, parent, isMain);
  };
  ModuleInternals._load = gated;
  nodeLoadGateInstalled = true;
}

export function createAppJiti(faces?: LoadAppsOptions['virtualFaces']) {
  // 运行期门禁检查面安装（S-1 兜底第一腿的宿主侧——前置守卫闭包经 globalThis
  // 键回查；幂等覆装，worker realm 各自实例化时各自装）
  installRuntimeGate();
  return createJiti(import.meta.url, {
    moduleCache: false,
    // 应用代码统一走 jiti 转译一条路径（native import 无法解析虚拟模块——防行为分叉）
    tryNative: false,
    // import 来源门禁：全图扫描执法（违规即拒载，合法链默认转译）
    transform: guardTransform,
    virtualModules: Object.fromEntries(
      VIRTUAL_MODULE_KEYS.map((key) => [
        key,
        key === 'berryagent'
          ? contractsFace
          : key === 'typebox'
            ? typeboxRoot
            : key === 'typebox/value'
              ? typeboxValue
              : key === 'typebox/compile'
                ? typeboxCompile
                : key === 'berryagent/llm'
                  ? (faces?.llm ?? {})
                  : (faces?.sqlite ?? {}),
      ]),
    ),
  });
}

/**
 * 单行入口 import（两半共用，第二十七批刀二 K3-b2）：设置 import 门禁树根 →
 * jiti import → finally 清空（防跨行串染）。一切调用经 loadChain 排队串行
 * （20260901-d #13：串行前提从注释假设变机制事实——TLA 求值持链至完成，
 * 懒件 transform 恒见己根；链尾吞错防前载失败卡死后续装载，错误仍由各调用
 * 自身的 promise 抛给调用方）。导出供 worker 半复用：currentTreeRoot 与
 * loadChain 均是**模块实例级**——worker realm 自持 loader 模块实例，状态按
 * realm 隔离不与主域互扰。
 */
export async function importAppEntry(
  jiti: ReturnType<typeof createAppJiti>,
  entry: string,
  gate?: ImportGateContext,
): Promise<Record<string, unknown>> {
  const run = loadChain.then(async () => {
    const treeRoot = realpathIfPossible(dirname(entry));
    currentTreeRoot = treeRoot;
    // API 装载门上下文随窗设置（与 currentTreeRoot 同窗——guardTransform 实验键
    // 门禁读此面；finally 同清防跨行串染）
    gateWindow = gate;
    // 运行期兜底第二腿（S-1 + 20260902-c #3 行寿命）：CJS 面 native require
    // 直载不经 transform——Module._load 补丁首个活动树根安装后常驻
    // （ensureNodeLoadGate），树根入活动集（装载窗后不还原；集合由 loadApps
    // 每轮剪枝镜像组合树，worker realm 行寿命 = realm 寿命无需剪枝）
    ensureNodeLoadGate();
    activeTreeRoots.add(treeRoot);
    try {
      return (await jiti.import(entry)) as Record<string, unknown>;
    } finally {
      currentTreeRoot = undefined;
      gateWindow = undefined;
    }
  });
  // 链尾推进吞错（两向）——run 自身照常把装载错误抛给调用方
  loadChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 模块形状校验（§1.1/§1.2 单形状纪律）：default 函数 / name 非空字符串 /
 * inject 与 optionalInject string[] / config 为对象形 schema / events 为
 * LiveEventDefinition 数组——违例即 APP_SHAPE_INVALID（dsh postmortem 0001：
 * 混形状丢元数据，一条代码路径不分派）。
 *
 * named export 判定一律走自有属性（Object.hasOwn）：jiti 对 default-only 模块
 * 的命名空间会让任意属性读取穿透到 default 函数本身（其 name 位是函数名）——
 * 不设防时「缺 name export」会被函数名顶替蒙混过关（回归锁：形状校验用例）。
 *
 * 导出（K3-b2）：worker 半在 worker realm 复用同一校验（形状纪律单实现，
 * 两 realm 各跑一份——声明面校验过界即此）。
 */
export function validateModuleShape(mod: Record<string, unknown>, _id: string): ValidatedModule {
  if (typeof mod['default'] !== 'function') {
    throw new AppError(
      APP_SHAPE_INVALID,
      `default export 非函数——应用唯一形状 export default async function apply(ctx, config)（契约篇 §1.1）`,
    );
  }
  const name = Object.hasOwn(mod, 'name') ? mod['name'] : undefined;
  if (typeof name !== 'string' || name.length === 0) {
    throw new AppError(APP_SHAPE_INVALID, `named export name 缺失或非非空字符串（行 id/日志归因标识，契约篇 §1.2）`);
  }
  for (const key of ['inject', 'optionalInject'] as const) {
    if (!Object.hasOwn(mod, key)) continue;
    const value = mod[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new AppError(APP_SHAPE_INVALID, `named export ${key} 必须是 string[]（服务名清单，契约篇 §1.2）`);
    }
  }
  const config = Object.hasOwn(mod, 'config') ? mod['config'] : undefined;
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new AppError(
      APP_SHAPE_INVALID,
      `named export config 必须是 JSON Schema 对象（TypeBox 生成或手写，契约篇 §1.2）`,
    );
  }
  const events = Object.hasOwn(mod, 'events') ? mod['events'] : undefined;
  if (
    events !== undefined &&
    (!Array.isArray(events) || events.some((item) => typeof item !== 'object' || item === null))
  ) {
    throw new AppError(
      APP_SHAPE_INVALID,
      `named export events 必须是 LiveEventDefinition[]（自定义事件声明清单，契约篇 §1.2 第四件）`,
    );
  }
  // skills 第六件（§1.2，2026-08-26 技能包应用纵切）：相对包根的目录路径清单，
  // 与 inject 同形 string[]（不用 glob——清单短、显式优于模式匹配）
  const skills = Object.hasOwn(mod, 'skills') ? mod['skills'] : undefined;
  if (skills !== undefined && (!Array.isArray(skills) || skills.some((item) => typeof item !== 'string'))) {
    throw new AppError(
      APP_SHAPE_INVALID,
      `named export skills 必须是 string[]（自带技能目录清单，相对应用包根，契约篇 §1.2 第六件）`,
    );
  }
  // SAFETY: 上方形状校验已逐成员确认运行时形状（default 函数/name/inject/optionalInject/
  // config/events/skills），Record<string, unknown> → ValidatedModule 的成员级收窄 TS 无法
  // 静态验证——校验与转换同居同一函数单点兑现，违例在上方已抛 APP_SHAPE_INVALID
  return mod as unknown as ValidatedModule;
}

/** 自定义事件名格式：小写段 + 至少一个 `/`（防撞宿主词汇域——session_shutdown 类无斜线名是宿主目录自留地） */
const CUSTOM_EVENT_NAME_FORMAT = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/;

/**
 * 逐条校验自定义事件声明（§1.1 逃生口的装载期门槛）：name/mode/note 三必填、
 * name 小写含 `/`——违例即 APP_SHAPE_INVALID（与模块形状同码族：声明面非法）。
 * 撞名检查不在此做（registerLiveEvent 运行时 EVENT_DUPLICATE——两行声明同名在
 * 逐行登记时才暴露）。
 *
 * 导出（K3-b2）：worker 半在 worker realm 复用同一校验——声明面纪律单实现。
 */
export function validateEventDefs(defs: readonly LiveEventDefinition[] | undefined, _id: string): void {
  if (!defs) return;
  for (const def of defs) {
    if (typeof def.name !== 'string' || !CUSTOM_EVENT_NAME_FORMAT.test(def.name)) {
      throw new AppError(
        APP_SHAPE_INVALID,
        `events 声明「${String(def.name)}」名字非法——须小写且含 /（如 my-app/done；防撞宿主词汇域，契约篇 §1.1）`,
      );
    }
    if (def.mode !== 'emit' && def.mode !== 'waterfall' && def.mode !== 'parallel' && def.mode !== 'serial') {
      throw new AppError(
        APP_SHAPE_INVALID,
        `events 声明「${def.name}」mode 非法（${String(def.mode)}）——四模式 emit/waterfall/parallel/serial 之一（mode 是事件公开契约）`,
      );
    }
    if (typeof def.note !== 'string' || def.note.length === 0) {
      throw new AppError(
        APP_SHAPE_INVALID,
        `events 声明「${def.name}」缺 note（一句话语义——目录生成与应用作者查阅用）`,
      );
    }
  }
}

/**
 * 行级技能注册信息（loadApps 桥接回调入参——技能包应用，契约篇 §1.2 第六件）。
 *
 * 拓扑 seam（2026-08-26 冷读裁决）：context 不引 skills 模块（拓扑边只有
 * skills→context）——context 只定义本结构，组合根注入回调在此结构上桥接
 * skills 服务（createPackageSkillsProvider + registerProvider）。
 */
export interface AppSkillsInfo {
  /** 组合树行 id（诊断归因） */
  readonly id: string;
  /** 应用声明 name（provider id 溯源） */
  readonly name: string;
  /**
   * 应用包根（skills 相对路径解析锚点），两来源同一字段（契约篇 §3.4 第一刀
   * 细化段，2026-08-27 刀 1）：文件应用 = 入口文件所在目录（推导）；builtin 行
   * = 件模块自述 packageRoot（import.meta.url 求值的位置事实，仅 builtin 行
   * 生效——文件应用模块带此键被忽略）。undefined = 无锚可判（builtin 件未
   * 自述）——回调侧跳过注册并告警
   */
  readonly packageRoot?: string;
  /** skills named export 声明的目录清单（相对 packageRoot，原样透传） */
  readonly dirs: readonly string[];
  /** 行作用域（回调应把注册挂此 effect——行失败//reload 回卷即注销，技能是行资产） */
  readonly scope: ContextScope;
}

/**
 * worker 行装载元数据（第二十七批刀二 K3-b2）：worker 半在 worker realm 完成
 * jiti import + 形状/事件声明校验后，**过界回宿主**的纯数据面（JSON 可编码——
 * 函数/config schema 例外：schema 是声明数据可克隆，default 不可过界故不回传）。
 * 宿主半据此走与 main 行同轨的管线：事件词汇登记（registerLiveEvent 防跨域
 * EVENT_UNKNOWN）/ Kahn 轮次（inject 名单照读）/ config Value.Check / 生命周期
 * 事件——「装载管线两半拆分」的契约面。
 */
export interface WorkerModuleMeta {
  /** 应用声明 name（worker 半形状校验后转抄——宿主侧 activated 载荷与 warn 用） */
  readonly name: string;
  /** 硬依赖服务清单（与 AppModule.inject 同义——Kahn 轮次照此排布） */
  readonly inject?: readonly string[];
  /** 软依赖服务清单（同 AppModule.optionalInject） */
  readonly optionalInject?: readonly string[];
  /** 配置 JSON Schema（结构化克隆无损过界——typebox schema 无函数/symbol 键，PoC 证） */
  readonly config?: object;
  /** 自定义事件声明（宿主侧统一登记——跨应用订阅无顺序洞与 main 行同一纪律） */
  readonly events?: readonly LiveEventDefinition[];
  /** 技能目录清单（宿主侧技能注册回调照走——技能是行资产与执行域无关） */
  readonly skills?: readonly string[];
}

/**
 * worker 行装载器（拓扑 seam，第二十七批刀二 K3-b2）：bridge 模块实现、组合根
 * 注入——context 不 import bridge（拓扑边 context→contracts 不变，与
 * registerSkills 回调同构的「context 只定义结构、组合根桥接」先例）。
 *
 * load = worker 半（spawn worker → jiti import → 形状/事件校验 → 元数据过界）；
 * apply = 宿主半（fork 行作用域后把 apply 委托进 worker 域执行——opts.signal
 * 是 loadApps 竞速时钟的取消通道，worker 侧桩 ctx 收到 abort 即停止等待）。
 */
export interface WorkerRowLoader {
  /**
   * worker 半装载：对单行完成 import + 校验，返回过界元数据。失败抛 AppError
   * （APP_ 族码照携——过界保码），loadApps 按与 main 行同路进失败清单。
   */
  load(row: AppPlanRow): Promise<WorkerModuleMeta>;
  /**
   * 宿主半激活委托：在行作用域 fork 后调用（与 main 行 module.default(scope,…)
   * 同位——同一竞速时钟罩着）。resolve = worker 侧 apply 返还；抛错/超时由
   * loadApps 统一收尾（回卷作用域 + 进失败清单）。
   */
  apply(row: AppPlanRow, scope: ContextScope, opts?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * 装载管线 pending 项（第二十七批刀二）：main 行持校验后模块（同进程 apply）、
 * worker 行持过界元数据（apply 委托 worker 域）——判别联合，轮次/激活按 kind 分派。
 * external carrier 落码批加 external kind：与 worker 同构的过界元数据（apply
 * 委托 externalLoader 进 fork 进程域执行——两分域行同管线混排，执行域差异
 * 对轮次/服务消费方零暴露）。
 */
type PendingItem =
  | { row: AppPlanRow; kind: 'main'; module: ValidatedModule }
  | { row: AppPlanRow; kind: 'worker'; meta: WorkerModuleMeta }
  | { row: AppPlanRow; kind: 'external'; meta: WorkerModuleMeta };

/** loadApps 可选参数（技能注册回调 + 虚拟面注入物——后续跨模块桥接需求同形扩展） */
export interface LoadAppsOptions {
  /**
   * 行级技能注册回调：加载器在**行作用域 fork 后、apply 之前**逐声明行调用
   * （登记位冷读裁决——与 events 的装载阶段①早登记不同位：skills 无跨应用
   * 订阅顺序洞，无早登记收益只有失败残留风险）。回调契约：**不得抛错**（内部
   * 问题应记日志/走诊断面）；抛错将按 apply 失败同路回卷杀行。
   */
  registerSkills?: (info: AppSkillsInfo) => void;
  /**
   * apply 挂起时钟（毫秒，缺省 10_000——契约篇 §1.6 时钟族之一，2026-08-27
   * 刀〇a）：apply 永不 resolve 且已返还控制 = 与抛错同族的故障语义，超时按
   * APP_APPLY_TIMEOUT 收尾（先回卷本作用域再进失败清单）。只罩 apply 段——
   * import/形状校验/轮次激活不在此钟内（inject 零进展即刻判，无墙上钟）。
   * 测试面注小值验证超时路径；生产面用缺省。
   */
  applyTimeoutMs?: number;
  /**
   * 第五/六键虚拟面注入物（P0-2，契约篇 §1.2 注记①）：组合根参数注入——
   * context 模块不 import llm/persist（拓扑护栏），类型面在此收窄为结构最小形。
   * 缺省注入空对象（键恒在虚拟面，import 不炸 Cannot find；面为空应用自查）；
   * 生产组合根必传真面（assembly 装配序 ⑨）。
   */
  virtualFaces?: {
    /** 第五键注入物（llm 模块 providerApiFace——pi-ai provider 工厂族背书导出） */
    readonly llm?: object;
    /** 第六键注入物（persist 模块 createAppSqliteFace 产物——同实例 + 主库拒开包装） */
    readonly sqlite?: { openDatabase(path: string, options?: { readonly?: boolean }): object };
  };
  /**
   * worker 行装载器（第二十七批刀二 K3-b2，拓扑 seam）：bridge 模块注入。缺省
   * 未注入时 sandbox.carrier 'worker' 行按 APP_LOAD_FAILED 进失败清单（worker 域能力
   * 未装配——如未来某裁剪面）；注入后 worker 行与 main 行同管线混排（Kahn 轮次
   * 不分域——服务消费方对执行域无感知）。
   *
   * external carrier 落码批：external 行同走本注入口（WorkerRowLoader 是
   * 「分域行装载器」接口——名字词汇中性化挂步⑤ docs 批；注入物 = 舰队，舰队
   * 内部按行 carrier 分派 worker 线程域 / external 进程域两种 spawn 形态，
   * 装载管线对载体差异零感知）。缺注入时 external 行 fail-closed 拒载同语义。
   */
  workerLoader?: WorkerRowLoader;
  /**
   * 行级 API 装载门上下文 seam（API 治理 §6.13.4 执法点①，第八十七批）：
   * 组合根闭包回查（装载门裁决产物按行 id 取——官方件随包无 api 块声明，现役
   * 恒 undefined；第三方 npm 应用装机态经 install 管线绑定行后填）。undefined =
   * 无声明可达——实验键 import 恒拒（fail-closed；现役六键全 stable 空档零差）。
   * 回调契约与 registerSkills 同律：不得抛错（查无行返回 undefined 即可）。
   */
  importGateByRow?: (rowId: string) => ImportGateContext | undefined;
}

/**
 * 装载应用（组合根装配期与 /reload 调用；输入 = 组合树合成的装载计划行）。
 *
 * root 参数应传**应用锚作用域**（组合根 `ctx.fork('apps')` 产物）：全体应用
 * 作用域自锚派生、自定义事件词汇挂锚 effect——锚 dispose 即 LIFO 级联回卷一切
 * 应用注册（/reload 的卸载基底，契约篇 §1.3 落码形态①）。
 *
 * 返回三态清单；failed 非空时由调用方决定语义——boot 启动断言拒绝启动，/reload
 * 逐行响亮报告不杀进程（本函数自身不抛：逐行失败收集进清单，单行失败不阻断
 * 其余行装载诊断）。
 */
export async function loadApps(
  root: ContextScope,
  rows: readonly AppPlanRow[],
  opts?: LoadAppsOptions,
): Promise<AppLoadResult> {
  const activated: AppActivatedPayload[] = [];
  const failed: AppFailedPayload[] = [];
  const skipped: AppSkippedPayload[] = [];
  // 行读链区身份（D3 装载分面分区，契约篇 §5.1）：装载行自锚 fork 级联同值——
  // Kahn 探测按行读链解析（app 区行 inject 只能命中 本区表→系统区表→根表；
  // 跨区行 zone='system' 只命中 根表∪系统区表，装载律③——区际依赖同拒）
  const zone = root.zone;

  // 活动树根集剪枝（行寿命执法的镜像维护，20260902-c #3）：本轮将 import 的
  // 行 = 非跳过 / 已解析 / 非 builtin（宿主函数引用无树）/ carrier main——
  // 其余行（卸载/禁用/解析失败/换载体 worker·external——分域 realm 自持集
  // 合）的旧树根即逐出，常驻 Module._load 补丁对已逐出树的迟发 require 回归
  // 纯透传。import 失败行的树根留到下轮剪枝收（fail-closed：半载模块比活行
  // 更不该外读，宁可多辖一拍）。
  const keepRoots = new Set<string>();
  for (const row of rows) {
    if (row.skip || row.unresolved !== undefined || row.builtin !== undefined) continue;
    if (resolveRowCarrier(row) !== 'main') continue;
    keepRoots.add(realpathIfPossible(dirname(row.entry!)));
  }
  for (const treeRoot of activeTreeRoots) {
    if (!keepRoots.has(treeRoot)) activeTreeRoots.delete(treeRoot);
  }

  /* ---- ① 跳过行 / 解析失败行：不 import（禁用行不要求已装——挂载休眠精神） ---- */
  // 两域混排的 pending（第二十七批刀二）：main 行持校验后模块（同进程 apply）；
  // worker 行持过界元数据（apply 委托 workerLoader 进 worker 域执行）。Kahn 轮次
  // 与激活按 kind 分派——服务消费方对提供方执行域无感知（provide 面经桥接同构）
  const pending: PendingItem[] = [];
  const jiti = createAppJiti(opts?.virtualFaces);
  for (const row of rows) {
    if (row.skip) {
      skipped.push({ id: row.id, reason: row.skip });
      root.emit('app/skipped', { id: row.id, reason: row.skip });
      continue;
    }
    if (row.unresolved !== undefined) {
      failed.push({ id: row.id, code: APP_ENTRY_UNRESOLVED, message: row.unresolved });
      root.emit('app/failed', { id: row.id, code: APP_ENTRY_UNRESOLVED, message: row.unresolved });
      continue;
    }
    // 载体分派（契约篇 §1.7 第三十七批）：resolveRowCarrier 闩一缺省两分派——
    // sandbox 块在场以块 carrier 为准；缺块 builtin 行 = main（官方豁免）、缺块
    // 第三方行 = external（出生即进程墙）。worker/external 行（external carrier
    // 落码批解冻——原第三十七批增补 2b 过渡冻结已解除）：装载校验在域半完成、
    // 元数据过界，宿主侧照走同一管线——事件词汇登记（防跨域 EVENT_UNKNOWN）+
    // pending 混排；两者同走注入的 workerLoader（分域行装载器——舰队内部按
    // carrier 分派 spawn 形态，本管线零感知）。builtin 行携块（任何 carrier）
    // 组合树已机器执法，此处第二执法点防御性兜底同语义拒载。缺注入 = 该载体
    // 能力未装配（裁剪/测试面）fail-closed 拒载
    const carrier = resolveRowCarrier(row);
    if (row.builtin !== undefined && row.sandbox !== undefined) {
      const payload = {
        id: row.id,
        code: APP_LOAD_FAILED,
        message:
          'builtin 官方件不可声明 sandbox 块（官方随包件恒 main 域执行，任何 carrier 皆拒——契约篇 §1.7 第三十七批）',
      };
      failed.push(payload);
      root.emit('app/failed', payload);
      continue;
    }
    if (carrier === 'worker' || carrier === 'external') {
      const carrierLoader = opts?.workerLoader;
      if (carrierLoader === undefined) {
        const payload = {
          id: row.id,
          code: APP_LOAD_FAILED,
          message:
            carrier === 'worker'
              ? 'sandbox.carrier worker 行装载失败：worker 装载器未注入（本装配面未启用 worker 域能力，契约篇 §1.7）'
              : 'sandbox.carrier external 行装载失败：分域装载器未注入（本装配面未启用 external 载体能力，契约篇 §1.7 第三十七批——fail-closed 拒载）',
        };
        failed.push(payload);
        root.emit('app/failed', payload);
        continue;
      }
      try {
        const meta = await carrierLoader.load(row);
        validateEventDefs(meta.events, row.id);
        for (const def of meta.events ?? []) {
          root.effect(() => registerLiveEvent(root, def));
        }
        pending.push({ row, kind: carrier, meta });
      } catch (err) {
        const payload = {
          id: row.id,
          code: err instanceof AppError ? err.code : APP_LOAD_FAILED,
          message: err instanceof AppError ? err.message : `${carrier} 域装载失败：${describeError(err)}`,
        };
        failed.push(payload);
        root.emit('app/failed', payload);
      }
      continue;
    }
    // import + 形状校验 + 自定义事件词汇登记（失败进清单不阻断——其余行仍要出全量诊断）
    try {
      let mod: Record<string, unknown>;
      if (row.builtin === undefined) {
        // import 门禁树根 = 入口所在目录（realpath 归一）——设置/求值/清空三步
        // 收口在 importAppEntry（第二十七批刀二：worker 半同用此件）；API 装载门
        // 上下文（实验键声明集）随第三参同窗传入
        mod = await importAppEntry(jiti, row.entry!, opts?.importGateByRow?.(row.id));
      } else {
        // 官方件（契约篇 §6.1 `builtin:` 前缀）：宿主随包函数引用，不经 jiti、
        // 不受应用零 import 约束——包成模块记录后与文件应用走**完全同轨**的形状
        // 校验/事件登记/轮次激活/生命周期事件管线（apply 替位 default，字段同名转抄）
        mod = { default: row.builtin.apply };
        for (const key of ['name', 'inject', 'optionalInject', 'config', 'events', 'skills'] as const) {
          if (row.builtin[key] !== undefined) mod[key] = row.builtin[key];
        }
      }
      const module = validateModuleShape(mod, row.id);
      // 自定义事件词汇登记（§1.1 逃生口）：装载阶段①（一切 apply 之前）统一入册——
      // 跨应用订阅无顺序洞（晚激活提供方的词汇此刻已在注册表）；登记经 effect 挂
      // 锚作用域（/reload 卸载锚即 LIFO 注销词汇，撞名 EVENT_DUPLICATE 在此暴露）
      validateEventDefs(module.events, row.id);
      for (const def of module.events ?? []) {
        root.effect(() => registerLiveEvent(root, def));
      }
      pending.push({ row, kind: 'main', module });
    } catch (err) {
      const payload = {
        id: row.id,
        code: err instanceof AppError ? err.code : APP_LOAD_FAILED,
        message:
          err instanceof AppError ? err.message : `入口 import 失败：${describeError(err)}${virtualModuleHint(err)}`,
      };
      failed.push(payload);
      root.emit('app/failed', payload);
    }
  }

  /* ---- ② 轮次激活（Kahn 式）：inject 全就绪即激活，激活即可供后续轮 ---- */
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < pending.length;) {
      const item = pending[i]!;
      const inject = item.kind === 'main' ? item.module.inject : item.meta.inject;
      // 按行读链探测（D3）：root.tryGet 是宿主面读链（根表∪系统区表），会误放
      // 行——app 区行经本区表→系统区表→根表解析，跨区依赖在此即视同缺失
      const missing = (inject ?? []).filter((name) => tryResolveService(root, zone, name) === undefined);
      if (missing.length > 0) {
        i += 1; // 依赖未就绪——留待后续轮（由更晚激活的行 provide）
        continue;
      }
      pending.splice(i, 1);
      await activateOne(root, item, activated, failed, opts);
      progress = true;
    }
  }

  /* ---- ③ 零进展即无解：缺提供方或依赖环，逐行响亮（不做墙上钟等待） ----
   * 缺失清单与 pending 清单并列——两成因不预判（未激活模块将提供什么无从得知），
   * 人看两份清单即可分辨：缺失名全在 pending 的 inject 里 = 环；否则 = 缺提供方。 */
  for (const item of pending) {
    const inject = item.kind === 'main' ? item.module.inject : item.meta.inject;
    const missing = (inject ?? []).filter((name) => tryResolveService(root, zone, name) === undefined);
    const payload = {
      id: item.row.id,
      code: APP_INJECT_UNRESOLVED,
      message:
        `inject 依赖无法满足（缺失：${missing.length > 0 ? missing.join('、') : '（无）'}；` +
        `pending 行：${pending.map((p) => p.row.id).join('、')}——缺提供方或依赖环，即刻响亮失败）`,
    };
    failed.push(payload);
    root.emit('app/failed', payload);
  }

  return { activated, failed, skipped };
}

/**
 * 激活单行：config 校验 → fork 作用域 → （技能注册回调）→ apply → 生命周期事件。
 * apply 抛错或挂起超时（§1.6 时钟族，2026-08-27 刀〇a：缺省 10s）都即回卷——
 * 失败行不留残骸；applyMs 打点（fork→apply 返回墙钟差）随 activated 载荷上行。
 *
 * 两域分派（第二十七批刀二）：main 行 = module.default(scope, config) 同进程调
 * 用；worker 行 = workerLoader.apply(row, scope, {signal}) 委托 worker 域执行
 * （宿主半只等结算——声明的 config schema/技能清单从过界元数据取，同名同义）。
 * 竞速时钟同罩两域：worker 侧超时 abort 经 signal 传给桥接层（本地结算不等
 * worker 迟到回执——与 PoC cancel 语义同族）。
 */
async function activateOne(
  root: ContextScope,
  item: PendingItem,
  activated: AppActivatedPayload[],
  failed: AppFailedPayload[],
  opts?: LoadAppsOptions,
): Promise<void> {
  const row = item.row;
  // 声明面来源按域分派（结构同源——worker 侧元数据是同一 named export 的转抄）
  const schema = item.kind === 'main' ? item.module.config : (item.meta.config as typeboxRoot.TSchema | undefined);
  const skills = item.kind === 'main' ? item.module.skills : item.meta.skills;
  const declaredName = item.kind === 'main' ? item.module.name : item.meta.name;
  const applyTimeoutMs = opts?.applyTimeoutMs ?? 10_000;
  const fail = (code: string, message: string, stack?: string): void => {
    // 栈键仅在场时携带（G1 诊断文件取材面——undefined 不进载荷，JSON 面零噪音）
    const payload: AppFailedPayload =
      stack === undefined ? { id: row.id, code, message } : { id: row.id, code, message, stack };
    failed.push(payload);
    root.emit('app/failed', payload);
  };

  // 行 config 启动一次性校验（§1.2：schema 声明 + 校验 + 注入唯一样本）
  if (schema) {
    const value = row.config ?? {};
    let ok = false;
    try {
      ok = typeboxValue.Value.Check(schema, value);
    } catch {
      ok = false; // schema 自身非法（Value 抛错）与校验不过同路——启动即响
    }
    if (!ok) {
      // typebox 1.x 错误载荷字段是 instancePath（JSON 指针）——首错位置进诊断
      const first = [...typeboxValue.Value.Errors(schema, value)].at(0);
      const loc = first ? first.instancePath || first.schemaPath || '(根)' : '(根)';
      const detail = first ? `${loc}：${first.message}` : 'schema 校验失败';
      fail(APP_CONFIG_INVALID, `行 config 未通过应用声明的 schema——${detail}`);
      return;
    }
  }

  // 行籍旗标（契约篇 §1.5 provide 两段式分级 + §2.2 增补 9 保留词执法）：
  // 行引用形为官方形（row.builtin 在场——合并 pkg 保持 builtin: 形）= 官方名位
  // （provide 单段名自留地 + 宿主保留词可用面）。籍随行引用形不随行 id 承袭
  // （§5.1 执法形态全集同一法条）——自带第三方引用的替换官方 id 行不承袭名位
  //（原「id 承袭官方默认层」第二支 2026-08-30 G1 小刀勘正摘除：同一行清单内
  // 与 row.builtin 在场判定恒等值 = 死条款，且措辞与 D2 引用形法条相抵）
  const builtinRow = row.builtin !== undefined;
  const scope = root.fork({
    name: row.id,
    rowId: row.id,
    builtinRow,
    ...(row.config === undefined ? {} : { config: row.config }),
    // 跨区行 provide 扇出（D3 装载分面分区，契约篇 §5.1 装载律①）：apps 枚举
    // 多应用的行挂系统相位装载恰一次（zone 随锚级联 'system'——读链收窄由装载
    // 律③承载），provide 同键写进枚举各区表（应用区表——不回流系统区表）；独占
    // 行/系统行免显式（zone 级联即 [zone] 缺省扇出）
    ...(row.apps !== undefined && row.apps.length > 1 ? { provideZones: row.apps.map(appZoneId) } : {}),
  });
  try {
    // 技能目录注册（契约篇 §1.2 第六件；登记位 = 冷读裁决的「行作用域 fork 后
    // apply 之前」）：技能是行资产——apply 抛错走下方 catch 的 scope.dispose()
    // 连带回卷回调挂上的注册 effect，/reload 锚级联回卷同理，失败行不留技能残骸。
    // 空清单/未注入回调（老调用方）不调——纯技能包（default 空实现）照常走完激活
    if (skills !== undefined && skills.length > 0 && opts?.registerSkills !== undefined) {
      // 包根两来源（契约篇 §3.4 第一刀细化段）：builtin 行优先取件模块自述
      // packageRoot（import.meta.url 求值的位置事实）；文件应用恒走入口路径
      // 推导——jiti 模块对象上即使带 packageRoot 键也在此被忽略（暗道不存在，
      // 自述键只挂 BuiltinAppModule 类型面、不入 validateModuleShape）
      const packageRoot =
        row.builtin === undefined
          ? row.entry === undefined
            ? undefined
            : dirname(row.entry)
          : row.builtin.packageRoot;
      opts.registerSkills({
        id: row.id,
        name: declaredName,
        packageRoot,
        dirs: skills,
        scope,
      });
    }
    // apply 挂起时钟（§1.6 时钟族之一，2026-08-27 刀〇a）：永不 resolve 且已
    // 返还控制 = 故障语义，竞速超时按 APP_APPLY_TIMEOUT 收尾。迟到结算
    // 兜底：竞速败方的 apply promise 挂 catch 吞掉——超时后它才 reject 不进
    // unhandledRejection（正常路径的 reject 在此之前已赢出竞速进下方 catch）。
    // cancelCtl（刀二）：超时同刻 abort——worker 行经 workerLoader.apply 的
    // opts.signal 下沉到桥接层，宿主侧本地结算不等 worker 迟到回执（main 行
    // 不消费此信号，纯本地竞速同前）
    const startedAt = Date.now();
    const cancelCtl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelCtl.abort();
        reject(
          new AppError(APP_APPLY_TIMEOUT, `apply 挂起超 ${applyTimeoutMs}ms 未返还（挂起与抛错同族，按故障收尾）`),
        );
      }, applyTimeoutMs);
    });
    let applyPromise: Promise<unknown>;
    // caller 链写点之一（会话篇 §5.1 导入者归因，P1-1）：apply 段内的一切共享服务面
    // 调用（如 createSession 的 importer 落账）归本应用。只罩 apply 调用——装载器
    // 自身的注册回调/词表收割/生命周期 emit 是宿主行为，不落应用账。worker 行只罩
    // 宿主半（RPC 不跨 ALS——worker 桥帧带身份随该批挂账，与 sessionId 锚同款）
    if (item.kind === 'main') {
      applyPromise = runInCallerChain(row.id, () => Promise.resolve(item.module.default(scope, scope.config)));
    } else {
      // 阶段①保证分域行必配装载器（worker/external 同一注入口）——此兜底
      // 不可达，防御式响亮不静默
      const carrierLoader = opts?.workerLoader;
      if (carrierLoader === undefined) {
        throw new AppError(APP_LOAD_FAILED, `${item.kind} 行激活时装载器缺席（装载管线不变量被破坏——不可达防御路径）`);
      }
      applyPromise = runInCallerChain(row.id, () => carrierLoader.apply(row, scope, { signal: cancelCtl.signal }));
    }
    applyPromise.catch(() => {}); // 竞速败方迟到 reject 兜底（多订阅不影响 race 正常传播）
    try {
      await Promise.race([applyPromise, clock]);
    } finally {
      clearTimeout(timer);
    }
    // name 与行 id 不一致：不拒绝（两者本就不同物），warn 留痕防归因混淆
    if (declaredName !== row.id) {
      root.logger.warn('应用声明 name 与组合树行 id 不一致', { rowId: row.id, name: declaredName });
    }
    // 词表收割（契约篇 §3.4 第二刀 live 档）：装载阶段①已 validateEventDefs——
    // 此处只取名字清单随 activated 载荷上行（applyMs 同刻单点取值，push 与 emit
    // 同一对象）；uninstall 检视据此对 activated 行优先读本 boot 活词表
    const applyMs = Date.now() - startedAt;
    const eventNames = (item.kind === 'main' ? item.module.events : item.meta.events)?.map((def) => def.name) ?? [];
    const payload: AppActivatedPayload = {
      id: row.id,
      name: declaredName,
      applyMs,
      ...(eventNames.length > 0 ? { events: eventNames } : {}), // 空清单不带键（undefined = 未声明，消费面 ?? [] 归一）
    };
    activated.push(payload);
    root.emit('app/activated', payload);
  } catch (err) {
    // apply 抛错/挂起超时即响（§1.6）：先回卷本作用域半途注册（LIFO——失败行不
    // 留残骸；回卷自身的挂起由 dispose 竞速时钟兜），再进失败清单。码面两分：
    // 挂起超时 = APP_APPLY_TIMEOUT（专用码）；执行抛错一律 APP_APPLY_FAILED
    // （注册表钉死语义——不透传内部码，原始错误进 message，两类失败一眼可分）
    await scope.dispose();
    const isTimeout = err instanceof AppError && err.code === APP_APPLY_TIMEOUT;
    fail(
      isTimeout ? APP_APPLY_TIMEOUT : APP_APPLY_FAILED,
      `${isTimeout ? 'apply 挂起超时' : 'apply 执行抛错'}（本作用域注册已回卷）：${describeError(err)}`,
      // 栈仅 apply 抛错族随载荷上行（G1 诊断文件取材面）——超时族无原始 Error
      // 栈可带（AppError 自造），缺席即诚实现状
      isTimeout ? undefined : err instanceof Error ? err.stack : undefined,
    );
  }
}
