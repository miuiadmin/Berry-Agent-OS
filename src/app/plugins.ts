/**
 * L5 app — 插件管理服务（ctx.plugins，契约篇 §1.5 表尾落码 2026-08-23 M2 /reload 纵切）。
 *
 * 有状态单例：list/install/toggle/update/uninstall 同一实例，boot 与 /reload 经
 * applyLoad 就地更新装载状态——provide 一次恒定（§1.3 服务集不变式保持）。
 *
 * install 三源分发（§6.1）：
 * - npm（裸 spec）：装 `<数据目录>/plugins/node_modules/` 子树（--legacy-peer-deps
 *   --omit=peer 防 peer 冲突），overlay 行 plugin 写裸包名（resolvePluginEntry 走子树解析）；
 * - git（git@… / https://….git）：clone 到 `<数据目录>/plugins/git/<host>/<首路径段>/<repo 名>`
 *   分层防撞名，ref 经 opts 锁定；源 URL/ref 记入 sources.json（update 重克隆的依据）；
 *   overlay 行 plugin 写 clone 目录绝对路径；
 * - local（./ ../ 绝对路径）：直引不拷贝，overlay 行 plugin 写绝对路径——改动 + /reload 即见。
 *
 * install 只对账写回、不自动热应用——热应用 = 调用方 /reload（对账与组合正交，§1.5 表尾）。
 * 装机子进程失败统一 PLUGIN_INSTALL_FAILED（message 载命令与输出尾行）。
 * dry-run/rollback seam 保留未实现（§1.5 表注记）。
 *
 * uninstall 双相四段（契约篇 §3.4 第二刀，2026-08-27 刀 2）：inspect = 零副作用
 * 只读预检（行现状 + 装机物 + 同包共享行 + 数据域 + 词表三档 + 受影响会话数）；
 * execute = ①删行（文件行 removeOverlayRow / builtin 行禁用落盘 / Ring 1 拒卸）
 * ②装机物必删+同包引用计数（归一路径比对）③数据域 keep|purge（Docker 卷律默认
 * 留）④成功尾 plugin/uninstalled 双落地（总线 + 会话流，经注入回调）。execute
 * 唯一入口 = TUI /plugin uninstall（human-only——服务面不注册模型工具）。
 *
 * 词表账本（同刀）：install/update 时经注入的 loadEntry 一次性 jiti 装载收割
 * name + events 词名，落件数据根 data.json（双键一桥宿主写面首建——第十八批
 * 从挂账转落）；收割抛错记 null（unknown 档）。
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { writeAtomicFile } from '../persist/index.js';
import {
  AppError,
  COMPOSITION_ROW_INVALID,
  PLUGIN_CONFIG_INVALID,
  PLUGIN_FIXED_ROW,
  PLUGIN_INSTALL_FAILED,
} from '../contracts/errors.js';
import { Value as typeboxValue, type TSchema } from '../contracts/typebox.js';
import type { CompositionRow, PluginLoadResult, PluginPlanRow } from '../contracts/plugin.js';
import {
  derivePluginRowSource,
  disableOverlayRow,
  findRowLocation,
  isPathReference,
  loadOverlayRows,
  removeOverlayRow,
  RING1_REQUIRED_ROW_IDS,
  resolvePluginEntry,
  toggleOverlayRow,
  upsertOverlayPluginRef,
  writeOverlayRowConfig,
  type CompositionReport,
  type PluginRowSource,
  type PluginStatusRow,
} from './composition.js';

/** 插件源三分类（§6.1 三源分发） */
export type PluginSource = 'npm' | 'git' | 'local';

/** 装机子进程执行器（可注入——测试替身免真跑 npm/git；真面 spawn 子进程） */
export type InstallRunner = (command: string, args: readonly string[], opts: { cwd: string }) => Promise<void>;

/**
 * 插件管理服务（ctx.plugins）——组合根 provide 'plugins' 的实现。
 * 装配枚举唯一事实源 = 组合树（禁扫 node_modules/命名正则推断已装扩展，§1.5）。
 */
export interface PluginsService {
  /** 装载状态清单（组合树行序；装载前视角的行 = planned 兜底） */
  list(): readonly PluginStatusRow[];
  /**
   * 装机（三源分发按 ref 形态自动判定）+ overlay 对账写回。不自动热应用——
   * 热应用 = 调用方 /reload（TUI 薄壳命令链 install→reload）。
   * @param ref npm spec / git URL / 本地路径三形之一
   * @param opts gitRef 锁定分支或 tag（仅 git 源生效）
   */
  install(ref: string, opts?: { gitRef?: string }): Promise<InstallReport>;
  /** 禁用状态翻转（overlay 行 disabled 置 true / 删键）。@returns 翻转后禁用状态 */
  toggle(id: string): boolean;
  /** 按源分派更新：npm 重装同名 / git 删目录按原 ref 重克隆 / local no-op（改动即见）；三源通尾重收割词表账本 */
  update(id: string): Promise<UpdateReport>;
  /**
   * 双相卸载——inspect 相（契约篇 §3.4 第二刀）：零副作用只读预检（行现状 +
   * 装机物 + 同包共享行 + 数据域体积 + 词表三档 + 受影响会话计数 + 级联强警示）。
   * 人 execute 前已看；模型面消费本相（plugins_uninstall_inspect 随管理刀排期）。
   */
  uninstall(id: string, opts: { readonly mode: 'inspect' }): Promise<UninstallReport>;
  /**
   * 双相卸载——execute 相：四段执行（删行 → 装机物+引用计数 → 数据域处置 →
   * 成功尾事件双落地）。human-only 落法：execute 唯一入口 = TUI /plugin uninstall
   * 命令薄壳（服务面不注册模型工具）；dataAction 省缺不可——keep|purge 由命令
   * 旗标裁决（省缺 = keep 是命令面语义，服务面必须显式）。
   */
  uninstall(
    id: string,
    opts: { readonly mode: 'execute'; readonly dataAction: 'keep' | 'purge' },
  ): Promise<UninstallExecReport>;
  /**
   * 行配置写入（契约篇 §3.4 刀 2 工具族条——configure 服务面导线）：patch 顶层键
   * 整值替换（与 overlay 字段级后写胜出同族语义，不引入深合并），合并后完整 config
   * 经插件声明 schema 校验（复用装载期同 schema）才落 overlay。schema 不可得行
   * （failed/disabled/unresolved/worker 域）拒写并提示先装载——跳过校验降级与
   * 「错配置防 boot 拒启」目标相反。**不自动链 reload**（动词单职责——链式用法
   * 由调用方显式走 requestReload）。
   */
  configure(id: string, patch: Readonly<Record<string, unknown>>): Promise<ConfigureReport>;
  /**
   * 重载请求投递（同条导线——reload 真身住组合根，服务面只投递）：排队语义宿主
   * 侧承载（run 进行中排队、run 结算后自动排水），件不自带重建权。
   */
  requestReload(): Promise<ReloadOutcome>;
  /** boot 与 /reload 后装配方回灌最新装载结果（同实例就地更新——服务集恒定） */
  applyLoad(composition: CompositionReport, load: PluginLoadResult): void;
  /**
   * 运行时单行失败状态面（契约篇 §1.7 死亡结算——worker 域意外退出时行转
   * failed）：装载后的运行期失败路径；boot/reload 装载失败走 applyLoad 三态
   * 清单不经此面（事件广播由调用方/fleet 负责，此处只保 list 状态源不漂移）。
   * 未知行 no-op（行不在最近装载清单 = 非本服务管辖）。
   */
  markFailed(id: string, code: string, message: string): void;
}

/** install 结果（TUI 直显的人读报告） */
export interface InstallReport {
  /** 本次写进 overlay 的行 id（npm=包名 / git=repo 名 / local=目录或文件名） */
  readonly id: string;
  readonly source: PluginSource;
  /** 写进 overlay 行的 plugin 引用（npm 裸包名 / local+git 绝对路径） */
  readonly pluginRef: string;
  /** 一句话结果（人读；TUI 打印后提示 /reload 生效） */
  readonly message: string;
}

/** update 结果（按源分派的不同结局说明） */
export interface UpdateReport {
  readonly id: string;
  readonly source: PluginSource;
  readonly message: string;
}

/* ---------------- uninstall 双相四段（契约篇 §3.4 第二刀，2026-08-27 刀 2） ---------------- */

/**
 * 入口一次性装载面（词表收割用，注入边——assembly 注入 jiti 面与 /reload 装载
 * 同一信任前提同一门禁；测试注入替身。缺省不收割：账本 declaredEvents 记 null）。
 */
export type EntryLoader = (entry: string) => Promise<Record<string, unknown>>;

/** 卸载完成事件信封（plugin/uninstalled 载荷——总线与会话流同词同 data） */
export interface UninstalledEventData {
  /** 组合树行 id */
  readonly id: string;
  /** 行来源四分类 */
  readonly source: PluginRowSource;
  /** 数据域处置事实（keep / purge） */
  readonly dataAction: 'keep' | 'purge';
  /** 受影响会话计数（词 → 会话数；空/无持久层省略） */
  readonly affected?: Readonly<Record<string, number>>;
}

/** 词表三档合一产物（live 活词表 / ledger 账本 / unknown 最坏假设） */
export interface DeclaredEventsInfo {
  /** 三档来源：activated 行读本 boot 活词表优先；其余行唯一来源账本；无账本 unknown */
  readonly origin: 'live' | 'ledger' | 'unknown';
  /** 词名清单（unknown 档恒空——按最坏假设警示，不枚举） */
  readonly names: readonly string[];
  /** unknown 档的原因注记（人读——三种：账本前存量 / 收割失败 / 账本损坏） */
  readonly note?: string;
}

/** 卸载检视报告（inspect 相产物——零副作用只读预检；级联强警示的承载面） */
export interface UninstallReport {
  /** 组合树行 id */
  readonly id: string;
  /** 行来源（builtin/npm/git/local——有效引用 overlay 先出后写胜出） */
  readonly source: PluginRowSource;
  /** 现装载状态（activated/failed/skipped/planned——list 同源） */
  readonly status: PluginStatusRow['status'];
  /** 行 plugin 引用原样（builtin:xxx / 裸包名 / 绝对路径） */
  readonly pluginRef: string;
  /** 装机物路径（npm 子树 / git clone 目录 / local 引用路径〔不删〕；builtin 无） */
  readonly installPath?: string;
  /** 同装机物共享行 id（归一路径命中——execute 将跳删装机物并点名；禁用行也计：禁用≠卸载） */
  readonly sharedRows: readonly string[];
  /** 件数据根路径（<数据目录>/plugins/<行id>/） */
  readonly dataDir: string;
  /** 数据域体积（字节；目录不存在 = undefined——无数据域） */
  readonly dataBytes?: number;
  /** 词表三档 */
  readonly events: DeclaredEventsInfo;
  /** 受影响会话计数（词 → 含该词事件的会话数；无持久层/词表 unknown 省略） */
  readonly affectedSessions?: Readonly<Record<string, number>>;
  /** 级联强警示（人 execute 前已看——inspect 报告是唯一承载面） */
  readonly warnings: readonly string[];
}

/** 卸载执行回执（execute 相产物——四段执行后的事实） */
export interface UninstallExecReport {
  readonly id: string;
  /** 行来源四分类（残迹收尾 = 按残迹推导：npm/git 装机物在推其源，纯数据域推 local） */
  readonly source: PluginRowSource;
  /**
   * 执行结局三态（SF-8 残迹收尾律）：uninstalled = 正常四段走完；residual =
   * 行不在但可推导残迹在（上次卸载段间失败的重入收敛）——只重跑清理段；
   * no-op = 行不在且无残迹（已卸载过 / 从未安装——不造未知行错误，速报事实）。
   */
  readonly outcome: 'uninstalled' | 'residual' | 'no-op';
  /** 数据域处置事实 */
  readonly dataAction: 'keep' | 'purge';
  /** 装机物处置：removed 已删 / shared 跳删（共享）/ none 无装机物可删（local/builtin/缺目录） */
  readonly installRemoved: 'removed' | 'shared' | 'none';
  /** 共享行 id（installRemoved='shared' 时点名） */
  readonly sharedRows: readonly string[];
  /** 数据域是否已删（purge 且目录存在） */
  readonly dataRemoved: boolean;
  /** 受影响会话计数（随事件信封同源；无则省略） */
  readonly affectedSessions?: Readonly<Record<string, number>>;
  /** 卸替换行使官方默认层同 id 行回露出（回出厂态——重装对账即恢复的另一面） */
  readonly restoresDefault?: true;
}

/* ---------------- configure / requestReload 导线（契约篇 §3.4 刀 2 工具族条） ---------------- */

/** configure 结果（TUI/模型面直显的人读报告） */
export interface ConfigureReport {
  /** 组合树行 id */
  readonly id: string;
  /** 合并后的完整行配置（顶层键整值替换的产物——回显确认面） */
  readonly config: Readonly<Record<string, unknown>>;
  /** 本次写入的顶层键集（patch 的键——整值替换语义的显式可见面） */
  readonly appliedKeys: readonly string[];
  /** Ring 1 行提示：行不随 /reload 热装载，写盘后须重启生效（不静默吞——与 /reload 报告同纪律） */
  readonly ring1RestartRequired: boolean;
  /** 一句话结果（人读；提示重载/重启后生效——不自动链） */
  readonly message: string;
}

/**
 * 重载请求回执三态（requestReload 服务面导线形态）：宿主侧 ReloadResult 的
 * 服务面投影——queued（run 进行中已排队，结算后自动执行）/ done（成功，failed
 * 为失败行 id 清单——进程存活逐行报告）/ error（overlay 校验失败等，旧装配未动）。
 */
export type ReloadOutcome =
  | { readonly status: 'queued' }
  | { readonly status: 'done'; readonly failed: readonly string[] }
  | { readonly status: 'error'; readonly message: string };

/**
 * 建插件管理服务实例。
 * @param opts.dataDir 数据目录（overlay 与装机子树的根）
 * @param opts.runner 装机子进程执行器（缺省真 spawn；测试注入替身）
 * @param opts.loadEntry 入口一次性装载面（词表收割；缺省不收割记 null）
 * @param opts.affectedSessionCounts 受影响会话计数取数面（assembly 绑持久层
 *        Store 并内嵌 flush 屏障；缺省 = 无持久层诊断面，检视省略计数）
 * @param opts.emitUninstalled 卸载完成事件投递（assembly 注入：总线 emit +
 *        当前会话流 append 双落地；缺省 = 服务单测不落事件）
 * @param opts.requestReload 重载请求投递面（刀 3 导线：assembly 注入组合根
 *        reload 闭包的适配器——排队语义宿主侧承载；缺省 = 诊断面拒投递）
 */
export function createPluginsService(opts: {
  dataDir: string;
  runner?: InstallRunner;
  loadEntry?: EntryLoader;
  affectedSessionCounts?: (types: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;
  emitUninstalled?: (data: UninstalledEventData) => void;
  requestReload?: () => Promise<ReloadOutcome>;
}): PluginsService {
  const dataDir = opts.dataDir;
  const runner = opts.runner ?? spawnRunner;
  /** 装载状态（applyLoad 回灌；boot 前空表） */
  let byId = new Map<string, PluginStatusRow>();
  let plan: readonly PluginPlanRow[] = [];
  /**
   * per-row 活词表（词表三档 live 档，契约篇 §3.4 第二刀）：applyLoad 从
   * activated 载荷 events 字段收割（undefined = 声明零词，?? [] 归一）；activated
   * 行恒在表（可能空数组）——uninstall 检视据此区分「活词表可枚举（哪怕为空）」
   * 与「须查账本」。整替式更新（applyLoad 同款语义）。
   */
  let liveEventsById = new Map<string, readonly string[]>();

  /**
   * 卸载目标解析（双相共用前置）：行位置双查（overlay 先出后写胜出）→ Ring 1/
   * fixed 拒卸 → 有效引用分类 → 装机物路径。词表与计数在调用侧按相取用。
   * **行不在返 undefined 不抛**（SF-8 残迹收尾律）：inspect 相调用方显式抛未知行错
   * （人检视打错 id 该响亮）；execute 相走残迹收尾/ no-op——段间部分失败后重跑
   * 不被「未知行」卡死，残迹仍可收敛。
   */
  const resolveUninstallTarget = (
    id: string,
  ):
    | {
        source: PluginRowSource;
        ref: string;
        status: PluginStatusRow['status'];
        installPath?: string;
        defaultRowExists: boolean;
      }
    | undefined => {
    const { overlay, defaultRow } = findRowLocation(dataDir, id);
    if (overlay === undefined && defaultRow === undefined) return undefined;
    if (RING1_REQUIRED_ROW_IDS.includes(id) || defaultRow?.fixed === true) {
      // Ring 1 必备行 / fixed 安全栈强制点：卸掉即首启核心循环必破（内核边界篇
      // §5.1 一句话判据）——换实现走 install 同 id 覆盖引用，不是卸载
      throw new AppError(
        PLUGIN_FIXED_ROW,
        `uninstall：行「${id}」是 Ring 1 必备行（或 fixed 安全栈强制点），不可卸载——` +
          `如需换实现请 install 同 id 覆盖引用（契约篇 §5.1 缺省层替换语义）`,
      );
    }
    const ref = overlay?.plugin ?? defaultRow?.plugin;
    if (ref === undefined) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `uninstall：行「${id}」无插件引用（纯禁用行无默认层对应——此形态应在合成期被拒绝，请检查 overlay）`,
      );
    }
    const source = classifyRefSource(ref, dataDir);
    return {
      source,
      ref,
      status: byId.get(id)?.status ?? 'planned',
      installPath: installArtifactPath(dataDir, source, ref),
      defaultRowExists: defaultRow !== undefined,
    };
  };

  /** 词表三档合一（双相共用）：activated 行 live 档优先，其余行唯一来源账本，无账本 unknown */
  const declaredEventsFor = (id: string, status: PluginStatusRow['status']): DeclaredEventsInfo => {
    if (status === 'activated' && liveEventsById.has(id)) {
      return { origin: 'live', names: liveEventsById.get(id)! }; // 活词表可枚举（空数组 = 声明零词）
    }
    const descriptor = readDataDescriptor(dataDir, id);
    if (descriptor === undefined) {
      return {
        origin: 'unknown',
        names: [],
        note: '该行早于词表账本（install 时未收割或 builtin 官方行未落账本）——无法枚举自定义事件词',
      };
    }
    if (descriptor === null) {
      return { origin: 'unknown', names: [], note: '词表账本损坏（data.json 非法 JSON）——无法枚举' };
    }
    if (descriptor.declaredEvents === null) {
      return { origin: 'unknown', names: [], note: '装机时收割失败（装载失败/入口解析失败）——无法枚举' };
    }
    return { origin: 'ledger', names: descriptor.declaredEvents };
  };

  /** 受影响会话计数（双相共用）：词表空 = 恒 {}；unknown / 无持久层 = undefined（警示由 warnings 承载） */
  const affectedCountsFor = async (events: DeclaredEventsInfo): Promise<Record<string, number> | undefined> => {
    if (events.origin === 'unknown' || opts.affectedSessionCounts === undefined) return undefined;
    if (events.names.length === 0) return {};
    return await opts.affectedSessionCounts(events.names);
  };

  /**
   * uninstall 双相服务（契约篇 §3.4 第二刀，2026-08-27 刀 2）——接口 overload 的
   * 实现体（对象字面量直挂双 overload 返回联合不可赋值，故走函数声明形态）。
   * inspect = 零副作用预检（报告给人裁决）；execute = 四段执行序：
   * ①删行（builtin 行 disableOverlayRow 幂等硬禁用，其余 removeOverlayRow）
   * ②装机物必删 + 同包引用计数（归一路径比对；剩余引用 >0 = 跳删+点名；local
   * 不删〔用户自有目录〕/ builtin 无装机物）③数据域处置 = dataAction 裁决
   * （keep = Docker 卷律缺省；purge = 删件数据根整目录含账本）④成功尾
   * plugin/uninstalled 双落地（总线 + 当前会话流，注入闭包承载）。
   */
  async function uninstallImpl(id: string, phase: { readonly mode: 'inspect' }): Promise<UninstallReport>;
  async function uninstallImpl(
    id: string,
    phase: { readonly mode: 'execute'; readonly dataAction: 'keep' | 'purge' },
  ): Promise<UninstallExecReport>;
  async function uninstallImpl(
    id: string,
    phase: { readonly mode: 'inspect' } | { readonly mode: 'execute'; readonly dataAction: 'keep' | 'purge' },
  ): Promise<UninstallReport | UninstallExecReport> {
    const target = resolveUninstallTarget(id);
    // 同包引用计数：删装机物前反查 overlay 剩余行（减去目标行自身；禁用行也计入
    // ——禁用 ≠ 卸载，代码仍在盘上仍可能再启用）
    const sharedRows =
      target?.installPath !== undefined
        ? sharedPackageRows(dataDir, id, target.installPath)
        : { rows: [] as CompositionRow[] };

    if (phase.mode !== 'execute') {
      // ---- inspect 相：零副作用预检——只读不写，报告 = execute 将做的事 ----
      if (target === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `uninstall：未知行 id「${id}」（overlay 与官方默认层皆无此行——清单以组合树为准，勿凭记忆拼 id）`,
        );
      }
      const events = declaredEventsFor(id, target.status);
      const affectedSessions = await affectedCountsFor(events);
      const dataBytes = dirSizeBytes(pluginDataDirOf(dataDir, id));
      return {
        id,
        source: target.source,
        status: target.status,
        pluginRef: target.ref,
        ...(target.installPath !== undefined ? { installPath: target.installPath } : {}),
        sharedRows: sharedRows.rows.map((row) => row.id),
        dataDir: pluginDataDirOf(dataDir, id),
        ...(dataBytes !== undefined ? { dataBytes } : {}),
        events,
        ...(affectedSessions !== undefined ? { affectedSessions } : {}),
        warnings: buildWarnings({
          id,
          source: target.source,
          events,
          affectedSessions,
          sharedRowIds: sharedRows.rows.map((row) => row.id),
        }),
      };
    }

    // ---- execute 相：四段执行序 ----
    const dataAction = phase.dataAction ?? 'keep'; // 类型面必填；运行期兜底 keep（Docker 卷律）
    // SF-8 残迹收尾律：行不在 ≠ 错——上次卸载段间失败的重入收敛面（只重跑清理段）
    // + 已卸/未装的 no-op 速报（不造未知行错误）；inspect 相已在上面显式抛
    if (target === undefined) return await residualCleanup(id, dataAction);
    // 段①：声明死——builtin 行不可删（代码随包），幂等硬禁用落盘；overlay 行删行
    //（默认层同 id 行〔若有〕随行消失重新露出 = 恢复出厂态）
    if (target.source === 'builtin') {
      disableOverlayRow(dataDir, id);
    } else {
      removeOverlayRow(dataDir, id);
    }
    // 段②：装机物必删——同包引用计数裁决（npm/git 才有装机物；local 是用户
    // 自有目录不删；共享则跳删留待最后一个引用行卸载时删）
    let installRemoved: 'removed' | 'shared' | 'none' = 'none';
    if (
      target.installPath !== undefined &&
      (target.source === 'npm' || target.source === 'git') &&
      sharedRows.rows.length === 0 &&
      existsSync(target.installPath)
    ) {
      // 越界防线（与 install 同款纵深第二道）：rmSync 前强制归一校验在装机子树内
      //（npm → plugins/node_modules / git → plugins/git），防 overlay 手改污染
      assertInsideInstallSubtree(dataDir, target.source, target.installPath);
      rmSync(target.installPath, { recursive: true, force: true });
      // git 装机物同批删 sources.json 对应 relDir 记录（N-10：写面有存无删即账实
      // 漂移——update 重克隆按记录找 ref，残记录会让幽灵行复活）
      if (target.source === 'git')
        removeGitSource(dataDir, relative(join(dataDir, 'plugins', 'git'), target.installPath));
      installRemoved = 'removed';
    } else if (sharedRows.rows.length > 0) {
      installRemoved = 'shared';
    }
    // 段③：数据域处置——purge 才删（件数据根整目录含词表账本；keep = Docker 卷律）
    const dataRoot = pluginDataDirOf(dataDir, id);
    let dataRemoved = false;
    if (dataAction === 'purge' && existsSync(dataRoot)) {
      assertSafeDataRootId(id); // 撞保留子树名的数据根拒绝删（rmSync 误吞装机子树）
      assertInsideSubtree(join(dataDir, 'plugins'), dataRoot, 'uninstall：数据根'); // 数据根必在 plugins/ 子树内
      rmSync(dataRoot, { recursive: true, force: true });
      dataRemoved = true;
    }
    // 段④：成功尾双落地——总线广播 + 当前会话流落账（注入闭包承载，无注入则静默）
    const events = declaredEventsFor(id, target.status);
    const affectedSessions = await affectedCountsFor(events);
    opts.emitUninstalled?.({
      id,
      source: target.source,
      dataAction,
      ...(affectedSessions !== undefined && Object.keys(affectedSessions).length > 0
        ? { affected: affectedSessions }
        : {}),
    });
    return {
      id,
      source: target.source,
      outcome: 'uninstalled',
      dataAction,
      installRemoved,
      sharedRows: sharedRows.rows.map((row) => row.id),
      dataRemoved,
      ...(affectedSessions !== undefined ? { affectedSessions } : {}),
      // 卸载后官方默认层同 id 行重新露出 = 恢复出厂态（替换行卸载的显式可见面）
      ...(target.source !== 'builtin' && target.defaultRowExists ? { restoresDefault: true as const } : {}),
    };
  }

  /**
   * 残迹收尾（SF-8：execute 相行不在的收敛路径）：按 id 可推导的残迹 = npm 装机物
   * （install 时行 id = 包名 → node_modules/<id>）+ git 源记录（sources.json 值 URL
   * 重 parse 的 repo 名 == id → relDir 目录与记录）+ 数据域（purge 才构成收尾对象
   * ——keep 留数据域是合法终态）。全无残迹 = no-op 速报。source 按残迹推导
   * （npm/git 装机物在推其源；纯数据域残迹推 local——无装机物无源的最弱假设）。
   */
  const residualCleanup = async (id: string, dataAction: 'keep' | 'purge'): Promise<UninstallExecReport> => {
    const npmPath = installArtifactPath(dataDir, 'npm', id);
    const gitRelDirs = matchGitResidualRelDirs(dataDir, id);
    const dataRoot = pluginDataDirOf(dataDir, id);
    const dataRootExists = existsSync(dataRoot);
    const npmResidual = npmPath !== undefined && existsSync(npmPath);
    if (!npmResidual && gitRelDirs.length === 0 && !(dataAction === 'purge' && dataRootExists)) {
      return {
        id,
        source: 'local',
        outcome: 'no-op',
        dataAction,
        installRemoved: 'none',
        sharedRows: [],
        dataRemoved: false,
      };
    }
    // 段②（残迹版）：推导路径逐个清——防线与正常路径同款（归一子树校验硬拒越界）
    let installRemoved: 'removed' | 'none' = 'none';
    if (npmResidual) {
      assertInsideInstallSubtree(dataDir, 'npm', npmPath!);
      rmSync(npmPath!, { recursive: true, force: true });
      installRemoved = 'removed';
    }
    const gitRoot = join(dataDir, 'plugins', 'git');
    for (const relDir of gitRelDirs) {
      const absDir = join(gitRoot, relDir);
      assertInsideInstallSubtree(dataDir, 'git', absDir);
      if (existsSync(absDir)) rmSync(absDir, { recursive: true, force: true });
      removeGitSource(dataDir, relDir); // 源记录与目录同批清（N-10 同律）
      installRemoved = 'removed';
    }
    // 段③（残迹版）：数据域 purge 裁决同正常路径（防线同款双闸）
    let dataRemoved = false;
    if (dataAction === 'purge' && dataRootExists) {
      assertSafeDataRootId(id);
      assertInsideSubtree(join(dataDir, 'plugins'), dataRoot, 'uninstall：数据根');
      rmSync(dataRoot, { recursive: true, force: true });
      dataRemoved = true;
    }
    // 段④（残迹版）：词表走账本档（行不在 → live 档不可达；账本即数据域 data.json，
    // purge 已删则 unknown——与正常路径「先删后读」行为一致，检视报告已先行承载）
    const events = declaredEventsFor(id, 'planned');
    const affectedSessions = await affectedCountsFor(events);
    const source: PluginRowSource = npmResidual ? 'npm' : gitRelDirs.length > 0 ? 'git' : 'local';
    opts.emitUninstalled?.({
      id,
      source,
      dataAction,
      ...(affectedSessions !== undefined && Object.keys(affectedSessions).length > 0
        ? { affected: affectedSessions }
        : {}),
    });
    return {
      id,
      source,
      outcome: 'residual',
      dataAction,
      installRemoved,
      sharedRows: [],
      dataRemoved,
      ...(affectedSessions !== undefined ? { affectedSessions } : {}),
    };
  };

  return {
    applyLoad(composition, load) {
      const next = new Map<string, PluginStatusRow>();
      // applyMs 打点随 activated 载荷上行（B2 P5：loader 计时 → 诊断面展示；/reload 后行整替）
      for (const item of load.activated)
        next.set(item.id, { id: item.id, status: 'activated', name: item.name, applyMs: item.applyMs });
      for (const item of load.failed)
        next.set(item.id, { id: item.id, status: 'failed', code: item.code, message: item.message });
      for (const item of load.skipped) next.set(item.id, { id: item.id, status: 'skipped', reason: item.reason });
      byId = next; // 原地替换引用——闭包内外一致（provide 一次恒定的实例）
      // 活词表整替：activated 载荷 events 收割（刀 2 live 档——undefined 归一为空表）
      const nextLive = new Map<string, readonly string[]>();
      for (const item of load.activated) nextLive.set(item.id, item.events ?? []);
      liveEventsById = nextLive;
      plan = composition.plan;
    },

    list() {
      // source 在 list 时从组合树 plan 行现推导（契约篇 §3.4 第一刀，2026-08-27）：
      // 计划行的位置事实非装载态——applyLoad 不必存、planned/failed 行同带。
      // planned 兜底行与已装载行统一走 enrichment，面收敛一个形态
      return plan.map((row) => {
        const loaded = byId.get(row.id);
        const source = derivePluginRowSource(row, dataDir);
        return loaded === undefined
          ? { id: row.id, status: 'planned' as const, ...(source !== undefined ? { source } : {}) }
          : { ...loaded, ...(source !== undefined ? { source } : {}) };
      });
    },

    markFailed(id, code, message) {
      // 仅更新已入清单的行（planned/activated/skipped 均可转——域死不挑前态）；
      // 整行替换为 failed 形态（与 applyLoad 失败分支同形——面收敛一个形态）
      if (!byId.has(id)) return;
      byId.set(id, { id, status: 'failed', code, message });
    },

    async install(ref, installOpts) {
      const source = classifyRef(ref);
      if (source === 'npm') {
        const name = npmPackageName(ref);
        await runInstallStep(runner, dataDir, 'npm', [
          'install',
          '--prefix',
          join(dataDir, 'plugins'),
          '--legacy-peer-deps',
          '--omit=peer',
          ref,
        ]);
        upsertOverlayPluginRef(dataDir, name, name);
        // 词表账本收割（刀 2）：三源通尾——jiti 一次性装载读 name/events 落 data.json
        await refreshLedger(opts, name, name);
        return { id: name, source, pluginRef: name, message: `npm 源已装入 plugins/node_modules 子树：${name}` };
      }
      if (source === 'git') {
        const parsed = parseGitUrl(ref);
        const absDir = join(dataDir, 'plugins', 'git', parsed.relDir);
        // 纵深防线（P33 第二道）：段净化之后仍强制校验归一路径在 git 子树内——
        // rmSync 前的最后一道闸，未来 parse 漂移也不可穿越出装机子树
        assertInsideGitRoot(dataDir, absDir);
        // 幂等：先清 clone 目录（重装/半装残骸都不留），父目录补齐（git 只建末级）
        rmSync(absDir, { recursive: true, force: true });
        mkdirSync(dirname(absDir), { recursive: true });
        await runInstallStep(runner, dataDir, 'git', [
          'clone',
          ...(installOpts?.gitRef !== undefined ? ['--branch', installOpts.gitRef] : []),
          '--',
          ref,
          absDir,
        ]);
        saveGitSource(dataDir, parsed.relDir, {
          url: ref,
          ...(installOpts?.gitRef !== undefined ? { ref: installOpts.gitRef } : {}),
        });
        upsertOverlayPluginRef(dataDir, parsed.repo, absDir);
        await refreshLedger(opts, parsed.repo, absDir);
        return {
          id: parsed.repo,
          source,
          pluginRef: absDir,
          message: `git 源已 clone：${ref} → ${absDir}`,
        };
      }
      // local：路径直引不拷贝；绝对化后写 overlay（cwd 无关——跨目录启动解析仍成立）
      const absRef = resolve(process.cwd(), ref);
      if (!existsSync(absRef)) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `install：local 引用路径不存在：${ref}（解析为 ${absRef}）——先确认路径再装`,
        );
      }
      const id = basename(parse(absRef).name); // 目录名 / 文件名去扩展名
      upsertOverlayPluginRef(dataDir, id, absRef);
      await refreshLedger(opts, id, absRef);
      return { id, source, pluginRef: absRef, message: `local 源直引登记：${absRef}（改动 + /reload 即见）` };
    },

    toggle(id) {
      return toggleOverlayRow(dataDir, id); // 持久化半边在组合树模块（翻转语义见其 JSDoc）
    },

    async update(id) {
      const ref = overlayPluginRef(dataDir, id);
      if (ref === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `update：未知行 id「${id}」（overlay 与官方默认层皆无此行——清单以组合树为准）`,
        );
      }
      const gitRoot = join(dataDir, 'plugins', 'git');
      if (ref.startsWith(`${gitRoot}/`)) {
        // 纵深防线（P33 第二道）：overlay 手改/污染的 plugin 引用同受越界校验——
        // `gitRoot/../escape` 形态字面 startsWith 命中但归一后已在子树外
        assertInsideGitRoot(dataDir, ref);
        // git 源：删目录按原 ref 重克隆（sources.json 是 ref 的唯一存放处）
        const relDir = ref.slice(gitRoot.length + 1);
        const record = loadGitSources(dataDir)[relDir];
        if (!record) {
          throw new AppError(
            PLUGIN_INSTALL_FAILED,
            `update：${relDir} 无源记录（sources.json 缺项——手放目录请删除后重新 install）`,
          );
        }
        rmSync(ref, { recursive: true, force: true });
        await runInstallStep(runner, dataDir, 'git', [
          'clone',
          ...(record.ref !== undefined ? ['--branch', record.ref] : []),
          '--',
          record.url,
          ref,
        ]);
        // 重装重收割（刀 2）：声明词汇可能随版本漂移，账本以新装载为准覆写
        await refreshLedger(opts, id, ref);
        return { id, source: 'git', message: `git 源已按原 ref 重克隆：${record.url}` };
      }
      if (isPathReference(ref)) {
        // local 源：直引不拷贝——改动即见，update 天生 no-op；但账本仍刷新
        // （词表随磁盘代码漂移，与 /reload 的活跃词表对齐——no-op ≠ 不对账）
        await refreshLedger(opts, id, ref);
        return { id, source: 'local', message: 'local 源无需 update——改动 + /reload 即见（词表账本已重收割）' };
      }
      // npm 源：重装同名（重新解析版本）
      await runInstallStep(runner, dataDir, 'npm', [
        'install',
        '--prefix',
        join(dataDir, 'plugins'),
        '--legacy-peer-deps',
        '--omit=peer',
        ref,
      ]);
      await refreshLedger(opts, id, ref);
      return { id, source: 'npm', message: `npm 源已重装：${ref}` };
    },

    /** 双相卸载（实现在上方 uninstallImpl 函数声明——overload 返回联合的形态约束） */
    uninstall: uninstallImpl,

    /**
     * 行配置写入（契约篇 §3.4 刀 2 工具族条——configure 服务面导线）。
     * 执行序：行定位（装载计划 = 唯一事实源）→ 状态门（schema 不可得行拒写：
     * disabled 挂载休眠 / unresolved 未装 / worker 域结构不可得 / 非 activated）
     * → 声明 schema 读取（builtin 行 = 官方注册表模块引用零装载；文件行 =
     * loadEntry 一次性 jiti 装载读 named export config——与词表收割同信任前提
     * 同门禁）→ 合并（顶层键整值替换）→ 校验（复用装载期同 schema，错配置
     * 不落盘防 boot 拒启陷阱）→ overlay 整值写回。
     */
    async configure(id, patch) {
      // 空 patch 无语义（整值替换语义下空集不是合法变更）——响亮拒绝防误调造空替换行
      const appliedKeys = Object.keys(patch);
      if (appliedKeys.length === 0) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          'configure：patch 键集为空（顶层键整值替换——要改哪些键就带哪些键，空集不是变更）',
        );
      }
      const row = plan.find((candidate) => candidate.id === id);
      const { overlay, defaultRow } = findRowLocation(dataDir, id);
      if (row === undefined || (overlay === undefined && defaultRow === undefined)) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `configure：未知行 id「${id}」（组合树无此行——清单以 /plugins 或 plugins_list 为准，勿凭记忆拼 id）`,
        );
      }
      // 状态门四拒（spec：schema 不可得行拒写并提示先装载——跳过校验降级与
      // 「错配置防 boot 拒启」目标相反）：
      if (row.skip !== undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `configure：行「${id}」已禁用（${row.skip === 'disabled' ? '静态禁用' : '平台门控'}·挂载休眠）——先启用（/plugin-toggle 或 plugins_toggle）再配置`,
        );
      }
      if (row.unresolved !== undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `configure：行「${id}」入口未解析（${row.unresolved}）——先安装（/plugin-install 或 plugins_install）再配置`,
        );
      }
      if (row.runtime === 'worker') {
        // worker 行的生效 schema 在 worker 域（过界元数据）——宿主侧重装载读到
        // 的是另一实例，配置校验的权威面结构不可得：诚实拒写优于跨域猜测
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `configure：行「${id}」是 worker 域行——其生效 config schema 在 worker 侧结构不可得，请直接编辑 overlay.yaml 后 /reload`,
        );
      }
      const status = byId.get(id)?.status;
      if (status !== 'activated') {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `configure：行「${id}」未激活（当前状态：${status ?? 'planned'}）——先让行装载成功（修失败原因或 /reload）再配置`,
        );
      }
      // 声明 schema 读取：builtin 行 = 官方注册表模块引用（plan 行直挂，零装载）；
      // 文件行 = 注入的 loadEntry 一次性装载（词表收割同款面）
      let schema: TSchema | undefined;
      if (row.builtin !== undefined) {
        schema = row.builtin.config;
      } else {
        if (opts.loadEntry === undefined || row.entry === undefined) {
          throw new AppError(
            COMPOSITION_ROW_INVALID,
            `configure：行「${id}」的配置校验面不可用（无入口装载面——宿主未注入 loadEntry）——拒写`,
          );
        }
        const ns = await opts.loadEntry(row.entry);
        if (Object.hasOwn(ns, 'config')) schema = ns.config as TSchema;
      }
      // 合并（顶层键整值替换）+ 校验（装载期同 schema：typebox Check，抛错与不过同路）。
      // 合并基线 = overlay 行 config 的新鲜读（findRowLocation 每次 loadOverlayRows）：
      // plan 行是 applyLoad 回灌的陈旧快照，连续 configure 不经 reload 时用旧基线整替
      // 会丢前次写入的键；overlay 无 config 键时回退 plan 行 config（= 官方默认层
      // config，代码随包不随运行期变）
      const current = overlay?.config ?? row.config ?? {};
      const merged = { ...current, ...patch };
      if (schema !== undefined) {
        let ok = false;
        try {
          ok = typeboxValue.Check(schema, merged);
        } catch {
          ok = false; // schema 自身非法与校验不过同路（与 loader 装载期口径一致）
        }
        if (!ok) {
          const first = (() => {
            try {
              return [...typeboxValue.Errors(schema, merged)].at(0);
            } catch {
              return undefined;
            }
          })();
          const loc = first ? first.instancePath || first.schemaPath || '(根)' : '(根)';
          const detail = first ? `${loc}：${first.message}` : 'schema 校验失败';
          throw new AppError(
            PLUGIN_CONFIG_INVALID,
            `configure：合并后 config 未通过插件声明 schema——${detail}（本次未写入，现配置不变）`,
          );
        }
      }
      writeOverlayRowConfig(dataDir, id, merged);
      const ring1RestartRequired = RING1_REQUIRED_ROW_IDS.includes(id);
      return {
        id,
        config: merged,
        appliedKeys,
        ring1RestartRequired,
        message:
          `配置已写入 overlay（顶层键整值替换：${appliedKeys.join('、')}）——` +
          (ring1RestartRequired
            ? 'Ring 1 行不随 /reload 热装载，须重启生效'
            : '重载（/reload 或 plugins_reload）后生效'),
      };
    },

    /**
     * 重载请求投递（刀 3 导线——真身在组合根 reload 闭包）：服务面零自有状态，
     * 只经注入闭包转发。排队语义在宿主侧（run 进行中排队、结算后自动排水）。
     */
    async requestReload() {
      if (opts.requestReload === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          'requestReload：宿主未注入重载请求面（诊断装配无 /reload——本面不可用）',
        );
      }
      return await opts.requestReload();
    },
  };
}

/* ---------------- 三源分类与 ref 解析 ---------------- */

/** 三源分类（§6.1）：git@… 或 https://….git = git；./ ../ 绝对路径 = local；其余 = npm */
function classifyRef(ref: string): PluginSource {
  if (ref.startsWith('git@')) return 'git';
  if (/^https?:\/\/.+\/(.+)$/.test(ref) && ref.endsWith('.git')) return 'git';
  if (isPathReference(ref)) return 'local';
  return 'npm';
}

/** npm spec → 包名（`pkg@^2`→pkg / `@scope/pkg@1.2`→@scope/pkg；npm: 别名前缀剥掉） */
function npmPackageName(spec: string): string {
  const bare = spec.startsWith('npm:') ? spec.slice(4) : spec;
  if (bare.startsWith('@')) {
    const parts = bare.split('/'); // ['@scope', 'pkg@1.2', ...]
    return parts.length >= 2 ? `@${parts[0]!.slice(1)}/${parts[1]!.split('@')[0]!}` : bare;
  }
  return bare.split('@')[0]!;
}

/** git URL 拆解产物：clone 目录分层（host/首路径段/repo 名，防撞名） */
interface GitUrlParts {
  /** repo 名（.git 剥离）——overlay 行 id */
  readonly repo: string;
  /** clone 相对目录：`<host>/<首路径段>/<repo>` */
  readonly relDir: string;
}

/** 拆 git URL（git@host:path / https://host/path 两形）→ repo 名 + 分层目录 */
function parseGitUrl(url: string): GitUrlParts {
  let host: string | undefined;
  let path: string | undefined;
  if (url.startsWith('git@')) {
    const at = url.indexOf(':'); // git@github.com:foo/bar.git
    host = at > 0 ? url.slice(0, at).slice('git@'.length) : undefined;
    path = at > 0 ? url.slice(at + 1) : undefined;
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.host;
      path = parsed.pathname.slice(1);
    } catch {
      host = undefined; // 非 URL——留空由下方兜底报错
    }
  }
  const segments = (path ?? '').split('/').filter((seg) => seg.length > 0);
  // 段净化（P33 第一道，隔离案一第一刀 #15）：host 与每个路径段都必须是
  // 「纯文件名形态」——字符集白名单 [A-Za-z0-9._-] 且禁 `.`/`..` 相对段。
  // 修复前 `git@..:../..` 可拼出 relDir `../../..`，install 的幂等 rmSync
  // 会整删数据目录父级（全清单唯一「今日即炸」数据破坏活漏洞）；教训泛化：
  // 防了注入（数组参数 + `--` 分隔）≠ 防了穿越（`..` 段的路径语义面）
  if (!host || !isSafePathSegment(host) || segments.length < 2 || segments.some((seg) => !isSafePathSegment(seg))) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `install：git URL 形态无法拆解或含不安全段：${url}（期望 git@host:owner/repo.git 或 https://host/owner/repo.git；各段仅限字母/数字/._- 且禁 . 与 ..）`,
    );
  }
  const repo = segments[segments.length - 1]!.replace(/\.git$/, '');
  const first = segments[0]!;
  return { repo, relDir: `${host}/${first}/${repo}` };
}

/** git URL 段白名单字符集（防 `..`/路径分隔符/特殊字符构造穿越——B3 §10-4） */
const GIT_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** 单段安全判定：字符集合法且非 `.`/`..`（相对段 join 后会穿越出目标子树） */
function isSafePathSegment(segment: string): boolean {
  return GIT_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..';
}

/**
 * 归一子树防线共用核（P33 第二道同族，2026-08-27 刀 2 抽出共用）：target 经
 * resolve 归一后必须严格落在 root 子树**内**（子树根本身也不许——那是保留物
 * 所在地，如 sources.json）。git 防线（install/update）与装机物/数据根防线
 * （uninstall 段②③）共用——`root/../escape` 形态字面前缀命中但归一后出界的
 * 一切路径来源一律拒绝。
 */
function assertInsideSubtree(root: string, target: string, label: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (!normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `${label}越界（${target} 归一为 ${normalizedTarget}，须在 ${normalizedRoot} 子树内）——路径穿越拒绝`,
    );
  }
}

/**
 * 越界防线（P33 第二道，纵深防御）：clone 目录经 resolve 归一后必须严格落在
 * `<数据目录>/plugins/git/` 子树**内**。段净化（第一道）拦 URL 形态；本防线拦
 * 「归一后越界」的一切路径来源——install 的 parse 产物与 update 的 overlay
 * 引用（手改/污染面）同受校验。
 */
function assertInsideGitRoot(dataDir: string, dir: string): void {
  assertInsideSubtree(join(dataDir, 'plugins', 'git'), dir, 'install/update：clone 目录');
}

/* ---------------- git 源登记（sources.json——update 重克隆的 ref 依据） ---------------- */

/** 一条 git 源记录：URL + 装机时锁定的 ref（可缺省 = 默认分支） */
interface GitSourceRecord {
  url: string;
  ref?: string;
}

/** sources.json 路径（<数据目录>/plugins/git/sources.json；relDir → 源记录） */
function gitSourcesPath(dataDir: string): string {
  return join(dataDir, 'plugins', 'git', 'sources.json');
}

/** 读 git 源登记表（文件缺 = 空表；解析失败响亮抛——对账依据损坏不静默当空表） */
function loadGitSources(dataDir: string): Record<string, GitSourceRecord> {
  const path = gitSourcesPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, GitSourceRecord>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (err) {
    throw new AppError(
      PLUGIN_INSTALL_FAILED,
      `git 源登记表损坏：${path}（${err instanceof Error ? err.message : String(err)}）——手工修复或删除后重装`,
    );
  }
}

/** 写一条 git 源登记（键排序稳定序列化——人对 diff 友好） */
function saveGitSource(dataDir: string, relDir: string, record: GitSourceRecord): void {
  const all = loadGitSources(dataDir);
  all[relDir] = record;
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)));
  mkdirSync(dirname(gitSourcesPath(dataDir)), { recursive: true });
  writeAtomicFile(gitSourcesPath(dataDir), `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * 删一条 git 源登记（uninstall 段② 同批清账——N-10：装机物删了记录留着 =
 * 账实漂移，update 重克隆按记录找 ref 会让幽灵行复活）。键不存在 = no-op
 * （残迹收尾幂等——目录在记录无 = 手放目录，只清目录不造账）。
 */
function removeGitSource(dataDir: string, relDir: string): void {
  const all = loadGitSources(dataDir);
  if (!(relDir in all)) return;
  delete all[relDir];
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)));
  mkdirSync(dirname(gitSourcesPath(dataDir)), { recursive: true });
  writeAtomicFile(gitSourcesPath(dataDir), `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * 残迹反查（SF-8 残迹收尾的 git 半边）：行不在时按 id 匹配 sources.json 记录
 * ——值 URL 重 parse 的 repo 名 == id（install 时行 id = parsed.repo，同一推导
 * 函数往返一致）。同 repo 多次装不同 ref 会分多个 relDir（防撞名分层），全部
 * 返回交调用方逐个清。账本损坏响亮抛（loadGitSources 语义——对账依据不静默）。
 */
function matchGitResidualRelDirs(dataDir: string, id: string): string[] {
  const records = loadGitSources(dataDir);
  const hits: string[] = [];
  for (const [relDir, record] of Object.entries(records)) {
    let repo: string | undefined;
    try {
      repo = parseGitUrl(record.url).repo;
    } catch {
      continue; // 记录里的 URL 已解析不动（手改/污染）——残迹匹配面跳过，正常防线不放宽
    }
    if (repo === id) hits.push(relDir);
  }
  return hits;
}

/* ---------------- 装机子进程执行 ---------------- */

/** 装机子进程硬顶（毫秒）——P32：npm/git 卡死不再永挂（缺省 5 分钟） */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** 单流输出滚动尾窗上限（字符计）——P32：装机输出无界积累的帽，保尾部为诊断 */
const INSTALL_OUTPUT_CAP = 1024 * 1024;

/**
 * 真装机执行器：spawn 子进程，非零退出抛错（含输出尾行——诊断直达）。
 * P32 两道护栏（隔离案一第一刀 #16）：① 超时硬顶——到点 SIGKILL 强杀
 * （'close' 随后到达统一收尾，不再永挂）；② stdout/stderr 各 1MiB 滚动
 * 尾窗——超帽从头部丢弃（失败尾行是诊断要点），截断发生即在错误消息标注。
 * @param opts.timeoutMs 超时覆盖（测试注入用；缺省 5 分钟）
 */
export function spawnRunner(
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // windowsHide 统一纪律（骨架篇 §7.6，P1-3——win32 CREATE_NO_WINDOW）；
    // npm/git/子 berry 输出恒 UTF-8 属编码豁免面，chunk.toString() 缺省不涉决策树
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // 滚动尾窗累加器（truncated 标记截断是否发生过——消息头标注用）
    const stdout = { text: '', truncated: false };
    const stderr = { text: '', truncated: false };
    const appendCapped = (acc: { text: string; truncated: boolean }, chunk: Buffer): void => {
      acc.text += chunk.toString();
      if (acc.text.length > INSTALL_OUTPUT_CAP) {
        acc.text = acc.text.slice(-INSTALL_OUTPUT_CAP);
        acc.truncated = true;
      }
    };
    child.stdout.on('data', (chunk: Buffer) => appendCapped(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendCapped(stderr, chunk));
    // 超时硬顶：SIGKILL 后 'close' 到达走 timedOut 分支（清钟防泄漏）
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? INSTALL_TIMEOUT_MS);
    const clearTimer = (): void => clearTimeout(timer);
    // spawn 级失败（命令不存在等）与退出非零同路归一
    child.on('error', (err) => {
      clearTimer();
      reject(err);
    });
    child.on('close', (code) => {
      clearTimer();
      if (timedOut) {
        reject(new Error(`装机子进程超时（${opts.timeoutMs ?? INSTALL_TIMEOUT_MS}ms）已强杀：${command}`));
        return;
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      const source = stderr.text.trim() || stdout.text.trim();
      const head = source.length > 0 && (stderr.truncated || stdout.truncated) ? '[输出超限已截断，保尾部]\n' : '';
      const tail = source.split('\n').slice(-5).join('\n');
      const body = tail.length > 0 ? `\n${head}${tail}` : '';
      reject(new Error(`退出码 ${code}${body}`));
    });
  });
}

/** 单步装机执行 + 统一失败包装（PLUGIN_INSTALL_FAILED，message 载命令与原因） */
async function runInstallStep(
  runner: InstallRunner,
  cwd: string,
  command: string,
  args: readonly string[],
): Promise<void> {
  try {
    await runner(command, args, { cwd });
  } catch (err) {
    throw new AppError(
      PLUGIN_INSTALL_FAILED,
      `装机子进程失败：${command} ${args.join(' ')}\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 读 overlay 行的 plugin 引用（update 分派用；行不在 overlay 返回 undefined） */
function overlayPluginRef(dataDir: string, id: string): string | undefined {
  // 经装载面同一拒绝式校验读回——只取该行引用字段
  return loadOverlayRows(dataDir).find((row) => row.id === id)?.plugin;
}

/* ---------------- uninstall 辅助（契约篇 §3.4 第二刀，2026-08-27 刀 2） ---------------- */

/**
 * 行引用四分类（uninstall 视角——比 install 的三源分类多一档 builtin）：
 * `builtin:` 前缀 = builtin（代码随包）；归一后落 git 装机子树 = git / 落 npm
 * 装机子树 = npm（overlay 手改写绝对路径也按位置判）；其余路径引用 = local；
 * 裸包名 = npm。与 derivePluginRowSource 同判据不同输入面（本面吃 ref 字符串，
 * 那面吃 plan 行 entry/builtin——uninstall 时手改 overlay 与装载态都可能出现）。
 */
function classifyRefSource(ref: string, dataDir: string): PluginRowSource {
  if (ref.startsWith('builtin:')) return 'builtin';
  const abs = resolve(ref);
  if (abs.startsWith(`${resolve(join(dataDir, 'plugins', 'git'))}${sep}`)) return 'git';
  if (abs.startsWith(`${resolve(join(dataDir, 'plugins', 'node_modules'))}${sep}`)) return 'npm';
  if (isPathReference(ref)) return 'local';
  return 'npm'; // 裸包名（overlay 正常形态）
}

/**
 * 装机物路径（uninstall 段② 的删除对象）：builtin → undefined（代码随包无装机
 * 物）；npm → node_modules 子树内包目录（ref 是裸包名，scoped 名按段拼）；git →
 * ref 本身（overlay 存的就是 clone 目录绝对路径）；local → undefined（用户自有
 * 目录永不删——删用户的工作目录不是 uninstall 的事）。
 */
function installArtifactPath(dataDir: string, source: PluginRowSource, ref: string): string | undefined {
  if (source === 'builtin' || source === 'local') return undefined;
  if (source === 'git') return ref;
  return join(dataDir, 'plugins', 'node_modules', ...ref.split('/'));
}

/**
 * 同包引用计数（段② 裁决依据）：扫 overlay 剩余行（减目标行自身），凡行引用
 * 解析出的装机物与目标**归一路径相同**即共享（resolve 后比对——`dir` 与
 * `dir/../dir` 同物，字面相等不可靠）。禁用行也计入：禁用 ≠ 卸载，代码仍在
 * 盘上仍可能再启用，删了就悬空。
 */
function sharedPackageRows(dataDir: string, targetId: string, targetPath: string): { rows: CompositionRow[] } {
  const want = resolve(targetPath);
  const rows = loadOverlayRows(dataDir).filter((row) => {
    if (row.id === targetId || row.plugin === undefined) return false;
    const source = classifyRefSource(row.plugin, dataDir);
    const path = installArtifactPath(dataDir, source, row.plugin);
    return path !== undefined && resolve(path) === want;
  });
  return { rows };
}

/** 件数据根描述符（data.json——双键一桥宿主写面首建，第十八批）：声明名 + 收割词表 */
interface PluginDataDescriptor {
  /** 插件声明名（收割时读 named export name；失败/未声明回落行 id 由写入方决定） */
  readonly plugin: string;
  /** 自定义事件词名清单（null = 收割失败——装载失败/入口不可解析；检视按最坏假设档） */
  readonly declaredEvents: readonly string[] | null;
  /** 缓存子目录（第十八批布局预留字段——本刀不写） */
  readonly cacheSubdir?: string;
}

/** 件数据根（<数据目录>/plugins/<行id>/——与 ctx.paths.pluginDataDir 同一布局） */
function pluginDataDirOf(dataDir: string, id: string): string {
  return join(dataDir, 'plugins', id);
}

/** 词表账本路径（件数据根内 data.json） */
function dataJsonPath(dataDir: string, id: string): string {
  return join(pluginDataDirOf(dataDir, id), 'data.json');
}

/**
 * 读词表账本（三态判读）：文件不存在 = undefined（账本前存量行——unknown 档
 * 「早于账本」note）；JSON 解析失败或形状非法 = null（账本损坏——unknown 档
 * 「损坏」note）；正常 = descriptor（ledger 档）。只判 presence 与 plugin 字段，
 * declaredEvents 的 null/数组由调用侧分档。
 */
function readDataDescriptor(dataDir: string, id: string): PluginDataDescriptor | null | undefined {
  const path = dataJsonPath(dataDir, id);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PluginDataDescriptor;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.plugin !== 'string' ||
      !('declaredEvents' in parsed) ||
      (parsed.declaredEvents !== null && !Array.isArray(parsed.declaredEvents))
    ) {
      return null; // 形状非法与坏 JSON 同罪——损坏档
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * plugins/ 直下装机子树保留名对（单一来源）：git = git 源克隆子树、
 * node_modules = npm 装机子树。两消费点——assertSafeDataRootId（数据根
 * 写/删双闸防撞名）与 sweepPluginTmpDirs（扫龄跳过装机子树）。布局知识
 * 单源（契约篇 §1.5 tmp 钉位细则④），新增保留名只改此处。
 */
export const RESERVED_SUBTREE_NAMES: readonly string[] = ['git', 'node_modules'];

/**
 * 件数据根保留名防线：行 id 撞装机子树名（git / node_modules）= 件数据根路径
 * 与装机子树同径——写账本会污染 sources.json 邻域、purge 会整删装机子树。
 * install 收割写与 uninstall purge 删两路同拒（rmSync 误吞装机子树 = 数据破坏）。
 */
function assertSafeDataRootId(id: string): void {
  if (RESERVED_SUBTREE_NAMES.includes(id)) {
    throw new AppError(
      COMPOSITION_ROW_INVALID,
      `行 id「${id}」撞装机子树保留名（plugins/${id}）——件数据根与装机子树布局冲突，拒绝操作`,
    );
  }
}

/** tmp 扫龄阈值（毫秒）= 7 天常数，不开旋钮（无 env 无 config——契约篇 §1.5 tmp 钉位细则③） */
const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** ENOENT/ENOTDIR 判定：双进程同扫竞态的「他者已删」形态——视为成功不 warn（契约④ 删除幂等） */
function isVanished(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 件临时空间扫龄（boot 一次；契约篇 §1.5 tmp 钉位细则④⑤）：扫
 * `plugins/<id>/tmp/` 全体件数据根（含已卸载件残留根），删 mtime 过阈值
 * （7 天）的文件并自底向上剪空目录（含 tmp 本体——消费者按需
 * mkdirSync recursive 再造）。安全件：入口 lstat 判真目录（tmp 本身是
 * 链接则不进——防逃逸）；目录内 Dirent 不跟随符号链接（链接本体当文件
 * unlink、永不触目标）；只进 tmp/ 子树——数据根其余内容（data.json/
 * 自管库）永不触碰。best-effort：单件失败 warn 继续、ENOENT/ENOTDIR
 * 静默容忍；plugins/ 目录整体缺失 = 静默 no-op（全新机器首启）。
 * 返回删除文件数（诊断口径，含剪除目录前其内的文件）。
 */
export function sweepPluginTmpDirs(dataDir: string, logger?: { warn: (msg: string) => void }): number {
  let names: string[];
  try {
    names = readdirSync(join(dataDir, 'plugins'));
  } catch {
    return 0; // plugins/ 不存在或不可读——首启常态，静默跳过
  }
  const deadline = Date.now() - TMP_MAX_AGE_MS;
  let removed = 0;

  /**
   * 单目录自底向上扫：过期文件删除、真子目录递归后空则剪。
   * 返回本目录是否「全部子项已消失」——true 则父层可剪本目录。
   */
  const sweepDir = (dir: string): boolean => {
    let allGone = true;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, item.name);
      try {
        if (item.isDirectory()) {
          // Dirent 基于 lstat——符号链接目录此处 isDirectory()=false，走文件分支
          if (sweepDir(child)) {
            try {
              rmdirSync(child);
            } catch (err) {
              if (!isVanished(err)) allGone = false; // ENOTEMPTY（并发写入）= 子目录仍在
            }
          } else allGone = false;
        } else {
          // 文件与符号链接同路：mtime 取 lstat（链接本体），过期即删本体
          if (lstatSync(child).mtimeMs < deadline) {
            unlinkSync(child);
            removed++;
          } else allGone = false;
        }
      } catch (err) {
        if (isVanished(err)) continue; // 他进程同扫已删 = 成功
        logger?.warn(`件 tmp 扫龄单件失败（跳过继续）：${child}：${(err as Error).message}`);
        allGone = false;
      }
    }
    return allGone;
  };

  for (const id of names) {
    if (RESERVED_SUBTREE_NAMES.includes(id)) continue; // 装机子树非数据根——永不触碰
    const tmpDir = join(pluginDataDirOf(dataDir, id), 'tmp');
    let st;
    try {
      st = lstatSync(tmpDir);
    } catch {
      continue; // 无 tmp 子目录的件数据根 = 常态
    }
    if (!st.isDirectory()) continue; // tmp 为链接/文件形态：不进（防符号链接逃逸，契约⑤）
    try {
      if (sweepDir(tmpDir)) {
        try {
          rmdirSync(tmpDir); // 空 tmp 本体剪除——失败容忍（非义务动作）
        } catch {
          /* 非空（并发写入）或已删皆可 */
        }
      }
    } catch (err) {
      if (!isVanished(err)) logger?.warn(`件 tmp 扫龄失败（跳过该数据根）：${tmpDir}：${(err as Error).message}`);
    }
  }
  return removed;
}

/**
 * 词表账本收割写入（install/update 通尾，刀 2）：resolvePluginEntry 解析入口 →
 * 注入的 loadEntry 一次性 jiti 装载（与 /reload 同一信任前提同一 import 门禁）→
 * Object.hasOwn 读 name / events 词名（jiti default-only 命名空间穿透防线——与
 * loader 形状校验同款：命名空间对象上拿到的函数名不冒充 named export）。
 * 任何一步失败**不抛不阻断装机主流程**——declaredEvents 记 null（检视面按
 * unknown 档最坏假设警示）。写入原子（writeAtomicFile）。
 */
async function refreshLedger(
  opts: { dataDir: string; loadEntry?: EntryLoader },
  id: string,
  ref: string,
): Promise<void> {
  let declaredEvents: readonly string[] | null = null;
  let name: string | undefined;
  try {
    const entry = resolvePluginEntry(ref, opts.dataDir);
    if (entry !== undefined && opts.loadEntry !== undefined) {
      const ns = await opts.loadEntry(entry);
      if (Object.hasOwn(ns, 'name') && typeof ns.name === 'string') name = ns.name;
      const raw = Object.hasOwn(ns, 'events') ? ns.events : undefined;
      if (Array.isArray(raw)) {
        const names = raw.map((def) =>
          typeof def === 'object' && def !== null && typeof (def as { name?: unknown }).name === 'string'
            ? (def as { name: string }).name
            : undefined,
        );
        // 任一元素形状非法 = 整次收割失败（不半枚举——账本要么可信要么明记 null）
        if (names.every((n) => n !== undefined)) declaredEvents = names as readonly string[];
      }
    }
  } catch {
    declaredEvents = null; // 收割失败不阻断装机——检视面 unknown 档警示兜底
  }
  assertSafeDataRootId(id);
  mkdirSync(pluginDataDirOf(opts.dataDir, id), { recursive: true });
  writeAtomicFile(
    dataJsonPath(opts.dataDir, id),
    `${JSON.stringify({ plugin: name ?? id, declaredEvents }, null, 2)}\n`,
  );
}

/** 目录体积（字节，递归累加文件 size；目录/符号链接/其他形态跳过——防环且估算够用）；不存在 = undefined */
function dirSizeBytes(dir: string): number | undefined {
  if (!existsSync(dir)) return undefined;
  let total = 0;
  const walk = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, item.name);
      if (item.isDirectory()) walk(child);
      else if (item.isFile()) total += statSync(child).size;
    }
  };
  walk(dir);
  return total;
}

/**
 * 装机物删除前的子树防线（uninstall 段②）：npm 装机物必在 node_modules 子树
 * 内、git 必在 git 子树内——防 overlay 手改/污染引用借 uninstall 的 rmSync 删
 * 任意目录（装机面只删得出装机子树内的东西）。
 */
function assertInsideInstallSubtree(dataDir: string, source: 'npm' | 'git', path: string): void {
  assertInsideSubtree(join(dataDir, 'plugins', source === 'npm' ? 'node_modules' : 'git'), path, 'uninstall：装机物');
}

/**
 * 级联警示集装（inspect 报告承载——人 execute 前已看的强警示，第十八批「非
 * ignorable 词表强警示防会话变砖」的落码面）：unknown 档最坏假设 / 已落会话
 * 的词逐词点名（卸载后词失去注册来源，读侧未知非 ignorable 词整体拒绝）/ 共享
 * 行跳删说明。
 */
function buildWarnings(input: {
  id: string;
  source: PluginRowSource;
  events: DeclaredEventsInfo;
  affectedSessions?: Readonly<Record<string, number>>;
  sharedRowIds: readonly string[];
}): readonly string[] {
  const warnings: string[] = [];
  if (input.events.origin === 'unknown') {
    warnings.push(
      `词表无法枚举（${input.events.note ?? '原因未知'}）——按最坏假设：该插件可能已向历史会话写过自定义事件词，` +
        `卸载后相关会话的恢复/回放将因词失去注册来源而整体拒绝（SESSION_FORMAT_UNSUPPORTED）。确认可接受再 execute。`,
    );
  }
  if (input.affectedSessions !== undefined) {
    for (const [word, n] of Object.entries(input.affectedSessions)) {
      if (n > 0) {
        warnings.push(
          `自定义事件词「${word}」已落在 ${n} 个会话——卸载后这些会话回放时该词失去注册来源` +
            `（非 ignorable 词读侧整体拒绝），存在会话变砖风险（数据仍在，读取面失效）。`,
        );
      }
    }
  }
  if (input.sharedRowIds.length > 0) {
    warnings.push(
      `装机物被行 [${input.sharedRowIds.join(', ')}] 共享——execute 将跳删装机物（点名的共享行继续可用，最后引用行卸载时才真正删）。`,
    );
  }
  return warnings;
}
