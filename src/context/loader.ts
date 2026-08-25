/**
 * L1 context — 插件加载器本体（插件契约篇 §1：jiti 直载 + 虚拟注入 + 轮次激活）。
 *
 * 职责单子（「怎么装」；「装什么/在哪」归 app 组合树模块）：
 * 1. **jiti 免编译直载 .ts/.js**（§1.2【pi】），宿主核心包与 typebox 以虚拟模块
 *    注入防双实例（插件 peerDependencies 声明、禁自装 typebox）；
 * 2. **形状校验**（§1.1 单形状钉死 + §1.2 named export 三件——PLUGIN_SHAPE_INVALID）；
 * 3. **行 config 启动一次性校验**（插件声明 schema，PLUGIN_CONFIG_INVALID）；
 * 4. **inject 依赖驱动轮次激活（Kahn 式，§1.2 落码注记②）**：逐轮扫描、全就绪即激活
 *    （激活完成即可 provide 服务供后续轮取用）；整轮零进展仍有 pending = 缺提供方或
 *    依赖环，即刻响亮失败列 pending 清单（无墙上钟超时）；
 * 5. **per-plugin fork 作用域**：独立 effect 栈（卸载/LIFO 回卷基底）、config 冻结视图、
 *    logger 前缀（`app:<行id>`——失败归因）；apply 抛错即回卷本作用域再进失败清单
 *    （§1.6 不留残骸、不静默跳过）；
 * 6. **生命周期事件逐行必发**（§2.2 增补 1：plugin/activated / failed / skipped——
 *    「扩展没生效」从 pull 诊断升级为 push 事件面）；
 * 7. **自定义事件词汇装载期登记**（§1.1 逃生口）：行 named export events 在一切
 *    apply 之前经 registerLiveEvent 入注册表（挂 root/锚作用域 effect——卸载即注销）。
 *
 * jiti `moduleCache: false` 是 /reload 两条缓存纪律（§1.3 补钉②）的 v1 基底：
 * 每次 import 全依赖图重新求值——毒化模块与「模块图半坏」结构上不可能跨加载存活。
 */

import { createJiti } from 'jiti';
import { dirname } from 'node:path';
import * as typeboxRoot from 'typebox';
import * as typeboxCompile from 'typebox/compile';
import * as typeboxValue from 'typebox/value';
import * as contractsFace from '../contracts/index.js';
import {
  AppError,
  PLUGIN_APPLY_FAILED,
  PLUGIN_CONFIG_INVALID,
  PLUGIN_ENTRY_UNRESOLVED,
  PLUGIN_INJECT_UNRESOLVED,
  PLUGIN_LOAD_FAILED,
  PLUGIN_SHAPE_INVALID,
  describeError,
} from '../contracts/errors.js';
import { registerLiveEvent } from './context.js';
import type {
  PluginActivatedPayload,
  PluginFailedPayload,
  PluginLoadResult,
  PluginModule,
  PluginPlanRow,
  PluginSkippedPayload,
} from '../contracts/plugin.js';
import type { LiveEventDefinition } from '../contracts/events.js';
import type { Context, ContextScope } from './types.js';

/**
 * 形状校验后的模块视图：default 已确认是函数，ctx 参数在此收窄为真实 Context
 * （contracts 侧 PluginApply 的 ctx 是结构占位——零依赖层不引 context 类型）。
 */
type ValidatedModule = Omit<PluginModule, 'default'> & {
  default: (ctx: Context, config?: Readonly<Record<string, unknown>>) => unknown;
};

/**
 * 创建插件装载用 jiti 实例。
 *
 * 虚拟注入映射（契约篇 §1.2 落码注记①）：`berryagent`（宿主公共面 = contracts
 * 公共导出——AppError/错误码/事件常量与目录/typebox 再导出；名即宿主 npm 包名）
 * + typebox 三入口（宿主实例注入——双实例防线，pi 生态 Static 双实例实证反例）。
 */
/**
 * 虚拟模块面键集（单一来源）：装载期 jiti 注入的宿主实例模块名。
 * 用途有二——virtualModules 构造 + import 失败错误的可用面提示（探针 #12：
 * 第三方按 npm 子路径直觉写 `berryagent/typebox` 撞错时，错误必须自带合法路）。
 */
const VIRTUAL_MODULE_KEYS = ['berryagent', 'typebox', 'typebox/value', 'typebox/compile'] as const;

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

function createPluginJiti() {
  return createJiti(import.meta.url, {
    moduleCache: false,
    // 插件代码统一走 jiti 转译一条路径（native import 无法解析虚拟模块——防行为分叉）
    tryNative: false,
    virtualModules: Object.fromEntries(
      VIRTUAL_MODULE_KEYS.map((key) => [
        key,
        key === 'berryagent'
          ? contractsFace
          : key === 'typebox'
            ? typeboxRoot
            : key === 'typebox/value'
              ? typeboxValue
              : typeboxCompile,
      ]),
    ),
  });
}

/**
 * 模块形状校验（§1.1/§1.2 单形状纪律）：default 函数 / name 非空字符串 /
 * inject 与 optionalInject string[] / config 为对象形 schema / events 为
 * LiveEventDefinition 数组——违例即 PLUGIN_SHAPE_INVALID（dsh postmortem 0001：
 * 混形状丢元数据，一条代码路径不分派）。
 *
 * named export 判定一律走自有属性（Object.hasOwn）：jiti 对 default-only 模块
 * 的命名空间会让任意属性读取穿透到 default 函数本身（其 name 位是函数名）——
 * 不设防时「缺 name export」会被函数名顶替蒙混过关（回归锁：形状校验用例）。
 */
function validateModuleShape(mod: Record<string, unknown>, id: string): ValidatedModule {
  if (typeof mod['default'] !== 'function') {
    throw new AppError(
      PLUGIN_SHAPE_INVALID,
      `default export 非函数——插件唯一形状 export default async function apply(ctx, config)（契约篇 §1.1）`,
    );
  }
  const name = Object.hasOwn(mod, 'name') ? mod['name'] : undefined;
  if (typeof name !== 'string' || name.length === 0) {
    throw new AppError(PLUGIN_SHAPE_INVALID, `named export name 缺失或非非空字符串（行 id/日志归因标识，契约篇 §1.2）`);
  }
  for (const key of ['inject', 'optionalInject'] as const) {
    if (!Object.hasOwn(mod, key)) continue;
    const value = mod[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new AppError(PLUGIN_SHAPE_INVALID, `named export ${key} 必须是 string[]（服务名清单，契约篇 §1.2）`);
    }
  }
  const config = Object.hasOwn(mod, 'config') ? mod['config'] : undefined;
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    throw new AppError(
      PLUGIN_SHAPE_INVALID,
      `named export config 必须是 JSON Schema 对象（TypeBox 生成或手写，契约篇 §1.2）`,
    );
  }
  const events = Object.hasOwn(mod, 'events') ? mod['events'] : undefined;
  if (
    events !== undefined &&
    (!Array.isArray(events) || events.some((item) => typeof item !== 'object' || item === null))
  ) {
    throw new AppError(
      PLUGIN_SHAPE_INVALID,
      `named export events 必须是 LiveEventDefinition[]（自定义事件声明清单，契约篇 §1.2 第四件）`,
    );
  }
  // skills 第六件（§1.2，2026-08-26 技能包插件纵切）：相对包根的目录路径清单，
  // 与 inject 同形 string[]（不用 glob——清单短、显式优于模式匹配）
  const skills = Object.hasOwn(mod, 'skills') ? mod['skills'] : undefined;
  if (skills !== undefined && (!Array.isArray(skills) || skills.some((item) => typeof item !== 'string'))) {
    throw new AppError(
      PLUGIN_SHAPE_INVALID,
      `named export skills 必须是 string[]（自带技能目录清单，相对插件包根，契约篇 §1.2 第六件）`,
    );
  }
  // 形状已验：default 收窄为真实签名（Record<string,unknown> → 契约形，单点转换）
  return mod as unknown as ValidatedModule;
}

/** 自定义事件名格式：小写段 + 至少一个 `/`（防撞宿主词汇域——session_shutdown 类无斜线名是宿主目录自留地） */
const CUSTOM_EVENT_NAME_FORMAT = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/;

/**
 * 逐条校验自定义事件声明（§1.1 逃生口的装载期门槛）：name/mode/note 三必填、
 * name 小写含 `/`——违例即 PLUGIN_SHAPE_INVALID（与模块形状同码族：声明面非法）。
 * 撞名检查不在此做（registerLiveEvent 运行时 EVENT_DUPLICATE——两行声明同名在
 * 逐行登记时才暴露）。
 */
function validateEventDefs(defs: readonly LiveEventDefinition[] | undefined, id: string): void {
  if (!defs) return;
  for (const def of defs) {
    if (typeof def.name !== 'string' || !CUSTOM_EVENT_NAME_FORMAT.test(def.name)) {
      throw new AppError(
        PLUGIN_SHAPE_INVALID,
        `events 声明「${String(def.name)}」名字非法——须小写且含 /（如 my-plugin/done；防撞宿主词汇域，契约篇 §1.1）`,
      );
    }
    if (def.mode !== 'emit' && def.mode !== 'waterfall' && def.mode !== 'parallel' && def.mode !== 'serial') {
      throw new AppError(
        PLUGIN_SHAPE_INVALID,
        `events 声明「${def.name}」mode 非法（${String(def.mode)}）——四模式 emit/waterfall/parallel/serial 之一（mode 是事件公开契约）`,
      );
    }
    if (typeof def.note !== 'string' || def.note.length === 0) {
      throw new AppError(
        PLUGIN_SHAPE_INVALID,
        `events 声明「${def.name}」缺 note（一句话语义——目录生成与插件作者查阅用）`,
      );
    }
  }
}

/**
 * 行级技能注册信息（loadPlugins 桥接回调入参——技能包插件，契约篇 §1.2 第六件）。
 *
 * 拓扑 seam（2026-08-26 冷读裁决）：context 不引 skills 模块（拓扑边只有
 * skills→context）——context 只定义本结构，组合根注入回调在此结构上桥接
 * skills 服务（createPackageSkillsProvider + registerProvider）。
 */
export interface PluginSkillsInfo {
  /** 组合树行 id（诊断归因） */
  readonly id: string;
  /** 插件声明 name（provider id 溯源） */
  readonly name: string;
  /**
   * 插件包根（skills 相对路径解析锚点）= 入口文件所在目录；builtin 行（宿主
   * 随包函数件）无磁盘锚点 = undefined——回调侧跳过注册（官方纯技能包件真
   * 出现时随其纵切开）
   */
  readonly packageRoot?: string;
  /** skills named export 声明的目录清单（相对 packageRoot，原样透传） */
  readonly dirs: readonly string[];
  /** 行作用域（回调应把注册挂此 effect——行失败//reload 回卷即注销，技能是行资产） */
  readonly scope: ContextScope;
}

/** loadPlugins 可选参数（v1 仅技能注册回调——后续跨模块桥接需求同形扩展） */
export interface LoadPluginsOptions {
  /**
   * 行级技能注册回调：加载器在**行作用域 fork 后、apply 之前**逐声明行调用
   * （登记位冷读裁决——与 events 的装载阶段①早登记不同位：skills 无跨插件
   * 订阅顺序洞，无早登记收益只有失败残留风险）。回调契约：**不得抛错**（内部
   * 问题应记日志/走诊断面）；抛错将按 apply 失败同路回卷杀行。
   */
  registerSkills?: (info: PluginSkillsInfo) => void;
}

/**
 * 装载插件（组合根装配期与 /reload 调用；输入 = 组合树合成的装载计划行）。
 *
 * root 参数应传**插件锚作用域**（组合根 `ctx.fork('plugins')` 产物）：全体插件
 * 作用域自锚派生、自定义事件词汇挂锚 effect——锚 dispose 即 LIFO 级联回卷一切
 * 插件注册（/reload 的卸载基底，契约篇 §1.3 落码形态①）。
 *
 * 返回三态清单；failed 非空时由调用方决定语义——boot 启动断言拒绝启动，/reload
 * 逐行响亮报告不杀进程（本函数自身不抛：逐行失败收集进清单，单行失败不阻断
 * 其余行装载诊断）。
 */
export async function loadPlugins(
  root: ContextScope,
  rows: readonly PluginPlanRow[],
  opts?: LoadPluginsOptions,
): Promise<PluginLoadResult> {
  const activated: PluginActivatedPayload[] = [];
  const failed: PluginFailedPayload[] = [];
  const skipped: PluginSkippedPayload[] = [];

  /* ---- ① 跳过行 / 解析失败行：不 import（禁用行不要求已装——挂载休眠精神） ---- */
  const pending: Array<{ row: PluginPlanRow; module: ValidatedModule }> = [];
  const jiti = createPluginJiti();
  for (const row of rows) {
    if (row.skip) {
      skipped.push({ id: row.id, reason: row.skip });
      root.emit('plugin/skipped', { id: row.id, reason: row.skip });
      continue;
    }
    if (row.unresolved !== undefined) {
      failed.push({ id: row.id, code: PLUGIN_ENTRY_UNRESOLVED, message: row.unresolved });
      root.emit('plugin/failed', { id: row.id, code: PLUGIN_ENTRY_UNRESOLVED, message: row.unresolved });
      continue;
    }
    // import + 形状校验 + 自定义事件词汇登记（失败进清单不阻断——其余行仍要出全量诊断）
    try {
      let mod: Record<string, unknown>;
      if (row.builtin !== undefined) {
        // 官方件（契约篇 §6.1 `builtin:` 前缀）：宿主随包函数引用，不经 jiti、
        // 不受插件零 import 约束——包成模块记录后与文件插件走**完全同轨**的形状
        // 校验/事件登记/轮次激活/生命周期事件管线（apply 替位 default，字段同名转抄）
        mod = { default: row.builtin.apply };
        for (const key of ['name', 'inject', 'optionalInject', 'config', 'events', 'skills'] as const) {
          if (row.builtin[key] !== undefined) mod[key] = row.builtin[key];
        }
      } else {
        mod = (await jiti.import(row.entry!)) as Record<string, unknown>;
      }
      const module = validateModuleShape(mod, row.id);
      // 自定义事件词汇登记（§1.1 逃生口）：装载阶段①（一切 apply 之前）统一入册——
      // 跨插件订阅无顺序洞（晚激活提供方的词汇此刻已在注册表）；登记经 effect 挂
      // 锚作用域（/reload 卸载锚即 LIFO 注销词汇，撞名 EVENT_DUPLICATE 在此暴露）
      validateEventDefs(module.events, row.id);
      for (const def of module.events ?? []) {
        root.effect(() => registerLiveEvent(root, def));
      }
      pending.push({ row, module });
    } catch (err) {
      const payload = {
        id: row.id,
        code: err instanceof AppError ? err.code : PLUGIN_LOAD_FAILED,
        message:
          err instanceof AppError ? err.message : `入口 import 失败：${describeError(err)}${virtualModuleHint(err)}`,
      };
      failed.push(payload);
      root.emit('plugin/failed', payload);
    }
  }

  /* ---- ② 轮次激活（Kahn 式）：inject 全就绪即激活，激活即可供后续轮 ---- */
  let progress = true;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < pending.length;) {
      const item = pending[i]!;
      const missing = (item.module.inject ?? []).filter((name) => root.tryGet(name) === undefined);
      if (missing.length > 0) {
        i += 1; // 依赖未就绪——留待后续轮（由更晚激活的行 provide）
        continue;
      }
      pending.splice(i, 1);
      await activateOne(root, item.row, item.module, activated, failed, opts);
      progress = true;
    }
  }

  /* ---- ③ 零进展即无解：缺提供方或依赖环，逐行响亮（不做墙上钟等待） ----
   * 缺失清单与 pending 清单并列——两成因不预判（未激活模块将提供什么无从得知），
   * 人看两份清单即可分辨：缺失名全在 pending 的 inject 里 = 环；否则 = 缺提供方。 */
  for (const item of pending) {
    const missing = (item.module.inject ?? []).filter((name) => root.tryGet(name) === undefined);
    const payload = {
      id: item.row.id,
      code: PLUGIN_INJECT_UNRESOLVED,
      message:
        `inject 依赖无法满足（缺失：${missing.length > 0 ? missing.join('、') : '（无）'}；` +
        `pending 行：${pending.map((p) => p.row.id).join('、')}——缺提供方或依赖环，即刻响亮失败）`,
    };
    failed.push(payload);
    root.emit('plugin/failed', payload);
  }

  return { activated, failed, skipped };
}

/** 激活单行：config 校验 → fork 作用域 → （技能注册回调）→ apply → 生命周期事件；apply 抛错即回卷 */
async function activateOne(
  root: ContextScope,
  row: PluginPlanRow,
  module: ValidatedModule,
  activated: PluginActivatedPayload[],
  failed: PluginFailedPayload[],
  opts?: LoadPluginsOptions,
): Promise<void> {
  const fail = (code: string, message: string): void => {
    failed.push({ id: row.id, code, message });
    root.emit('plugin/failed', { id: row.id, code, message });
  };

  // 行 config 启动一次性校验（§1.2：schema 声明 + 校验 + 注入唯一样本）
  if (module.config) {
    const value = row.config ?? {};
    let ok = false;
    try {
      ok = typeboxValue.Value.Check(module.config, value);
    } catch {
      ok = false; // schema 自身非法（Value 抛错）与校验不过同路——启动即响
    }
    if (!ok) {
      // typebox 1.x 错误载荷字段是 instancePath（JSON 指针）——首错位置进诊断
      const first = [...typeboxValue.Value.Errors(module.config, value)].at(0);
      const loc = first ? first.instancePath || first.schemaPath || '(根)' : '(根)';
      const detail = first ? `${loc}：${first.message}` : 'schema 校验失败';
      fail(PLUGIN_CONFIG_INVALID, `行 config 未通过插件声明的 schema——${detail}`);
      return;
    }
  }

  const scope = root.fork({ name: row.id, ...(row.config !== undefined ? { config: row.config } : {}) });
  try {
    // 技能目录注册（契约篇 §1.2 第六件；登记位 = 冷读裁决的「行作用域 fork 后
    // apply 之前」）：技能是行资产——apply 抛错走下方 catch 的 scope.dispose()
    // 连带回卷回调挂上的注册 effect，/reload 锚级联回卷同理，失败行不留技能残骸。
    // 空清单/未注入回调（老调用方）不调——纯技能包（default 空实现）照常走完激活
    if (module.skills !== undefined && module.skills.length > 0 && opts?.registerSkills !== undefined) {
      opts.registerSkills({
        id: row.id,
        name: module.name,
        packageRoot: row.entry !== undefined ? dirname(row.entry) : undefined,
        dirs: module.skills,
        scope,
      });
    }
    await module.default(scope, scope.config);
    // name 与行 id 不一致：不拒绝（两者本就不同物），warn 留痕防归因混淆
    if (module.name !== row.id) {
      root.logger.warn('插件声明 name 与组合树行 id 不一致', { rowId: row.id, name: module.name });
    }
    activated.push({ id: row.id, name: module.name });
    root.emit('plugin/activated', { id: row.id, name: module.name });
  } catch (err) {
    // apply 抛错即响（§1.6）：先回卷本作用域半途注册（LIFO——失败行不留残骸），再进失败清单
    await scope.dispose();
    fail(PLUGIN_APPLY_FAILED, `apply 执行抛错（本作用域注册已回卷）：${describeError(err)}`);
  }
}
