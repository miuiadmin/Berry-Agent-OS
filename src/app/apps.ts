/**
 * L5 app — 应用管理服务（ctx.apps，契约篇 §1.5 表尾落码 2026-08-23 M2 /reload 纵切）。
 *
 * 有状态单例：list/install/toggle/update/uninstall 同一实例，boot 与 /reload 经
 * applyLoad 就地更新装载状态——provide 一次恒定（§1.3 服务集不变式保持）。
 *
 * install 三源分发（§6.1）——D2 装机两态（2026-08-27 第三十批）：install = 仓库态
 * （代码进装机子树 + provenance 落账，**不写组合行 = 零生效**——不进装载序、不解析
 * 入口、零注册面；写行生效 = 独立动词 mount）：
 * - npm（裸 spec）：装 `<数据目录>/apps/node_modules/` 子树（--legacy-peer-deps
 *   --omit=peer 防 peer 冲突）——appRef 裸包名（mount 写行时消费，resolveAppEntry 走子树解析）；
 * - git（git@… / https://….git）：clone 到 `<数据目录>/apps/git/<host>/<首路径段>/<repo 名>`
 *   分层防撞名，ref 经 opts 锁定——appRef = clone 目录绝对路径；
 * - local（./ ../ 绝对路径）：直引不拷贝——appRef = 绝对路径，改动 + /reload 即见。
 *
 * provenance 全源账本（`<数据目录>/apps/sources.json`，键 = 装机物定位串）：
 * { source, ref（装机原始引用）, id（装机推导 id）, 精确版本（npm version+integrity /
 * git commit——dist-tag 不算凭证）, 装机时间 }——「组合树 = 装配枚举、账本 = 装机
 * 枚举」双源的物理面（第十四批立项、D2 落码）；update/uninstall 键域迁装机 id
 * （账本反查）、list 差集可见性（installed-unmounted）同源。旧 git 子树
 * sources.json 一次性折叠迁移（loadProvenance 惰性迁移 + 旧文件退役，无双轨）。
 * 装机子进程失败统一 APP_INSTALL_FAILED（message 载命令与输出尾行）。
 * dry-run/rollback seam 保留未实现（§1.5 表注记）。
 *
 * uninstall 双相四段（契约篇 §3.4 第二刀，2026-08-27 刀 2；**D2 键域迁装机 id**
 * ——同批两态修订）：**吃装机 id 非 行 id**（行 id 可任意命名、同包多行——行 id
 * 是行键不是包键）。inspect = 零副作用只读预检（装机物 + 全部挂载行 + 数据域 +
 * 词表三档 + 受影响会话数）；execute = ①删**全部**挂载行（含各 app 键行——归一
 * 路径反查，天然兼容多应用挂载）②装机物必删 + 账本记录同批清（local 不删〔用户
 * 自有目录〕）③数据域 keep|purge（Docker 卷律默认留）④成功尾 app/uninstalled
 * 双落地（总线 + 会话流，经注入回调）。execute 唯一入口 = TUI /apps-uninstall
 * （human-only——服务面不注册模型工具）。
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
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { writeAtomicFile } from '../persist/index.js';
import { AppError, COMPOSITION_ROW_INVALID, APP_CONFIG_INVALID, APP_INSTALL_FAILED } from '../contracts/errors.js';
import { Value as typeboxValue, type TSchema } from '../contracts/typebox.js';
import { resolveRowCarrier, type CompositionRow, type AppLoadResult, type AppPlanRow } from '../contracts/app.js';
import {
  deriveAppRowSource,
  findRowLocation,
  isPathReference,
  loadOverlayRows,
  appDataDirOf,
  removeOverlayRow,
  RESERVED_SUBTREE_NAMES,
  RING1_REQUIRED_ROW_IDS,
  resolveAppEntry,
  toggleOverlayRow,
  insertOverlayRow,
  writeOverlayRowConfig,
  type CompositionReport,
  type AppRowSource,
  type AppStatusRow,
} from './composition.js';

/** 应用源三分类（§6.1 三源分发） */
export type AppSource = 'npm' | 'git' | 'local';

/** 装机子进程执行器（可注入——测试替身免真跑 npm/git；真面 spawn 子进程） */
export type InstallRunner = (command: string, args: readonly string[], opts: { cwd: string }) => Promise<void>;

/**
 * 应用管理服务（ctx.apps）——组合根 provide 'apps' 的实现。
 * 装配枚举唯一事实源 = 组合树（禁扫 node_modules/命名正则推断已装扩展，§1.5）。
 */
export interface AppsService {
  /** 装载状态清单（组合树行序；装载前视角的行 = planned 兜底） */
  list(): readonly AppStatusRow[];
  /**
   * 装机（三源分发按 ref 形态自动判定）——**D2 仓库态**：只进装机子树 + provenance
   * 落账，**不写组合行 = 零生效**（install→reload 旧链废止——零行无物可热应用）。
   * 写行生效 = mount（挂载动词）；热应用 = 调用方 /reload（命令面 mount→reload 链）。
   * @param ref npm spec / git URL / 本地路径三形之一
   * @param opts gitRef 锁定分支或 tag（仅 git 源生效）
   */
  install(ref: string, opts?: { gitRef?: string }): Promise<InstallReport>;
  /** 禁用状态翻转（overlay 行 disabled 置 true / 删键）。@returns 翻转后禁用状态 */
  toggle(id: string): boolean;
  /**
   * 按源分派更新——**键域 = 装机 id**（D2 迁包键：两态后 overlay 无行的仓库态件
   * 也可更新；账本反查装机物与原始 spec）：npm 按装机 spec 重装 / git 删目录按
   * 账本原 ref 重克隆 / local no-op（改动即见）；三源通尾重收割词表账本 +
   * provenance 精确版本刷新。
   */
  update(id: string): Promise<UpdateReport>;
  /**
   * 挂载（D2 写行动词，契约篇 §6.1 两态——「应用独立不生效」的机制化另一半）：
   * 吃**装机推导 id**——账本反查装机物，写一条 overlay 组合行使其生效。行 id
   * 缺省 = 装机推导 id、`rowId` 显式命名位（行 id 是行键不是包键——同包第二应用
   * 挂载必经显式命名，缺省行 id 的全树唯一性不可破）。撞名（overlay ∨ 官方默认
   * 层已有同 id 行）拒绝式 `COMPOSITION_ROW_INVALID`。`apps` v1 必填非空（全局
   * 作用域 v1 官方专属——显式挂系统 = 准入制放开后的预留 seam，v1 不可达；多
   * 应用行 = 共享件，一行投多 app，d36 §3.2）。appRef 按源沿用装机推导（npm
   * 裸包名 / git·local 绝对路径）。`carrier` 三值显式降格位（R1 复盘批
   * 2026-08-29 随解冻收口——契约篇 §6.1 动词族全景）：**缺省不落 sandbox
   * 块** = 闩一装载期缺省推 external（第三方行出生即进程墙，无需也不应显式
   * 声明）；显式 `'main'`/`'worker'` = operator 显式降格（确认面披露降格
   * 语义）；显式 `'external'` = 与缺省等价的显式声明。config 位承载显式
   * 行配置——**对分域行（worker/external/缺省 external）宿主侧校验面拒绝**
   * （分域行 config 校验面在域侧，宿主侧 loadEntry = 主进程执行第三方码
   * 打穿进程墙，禁——R1 P0-3；唯显式 `carrier: 'main'` 走宿主侧应用声明
   * schema 校验，校验面不可得拒写，与 configure 同纪律）。
   * **不自动链 reload**（动词单职责——命令面 mount→reload）。
   */
  mount(
    installId: string,
    opts?: {
      apps?: readonly string[];
      config?: Record<string, unknown>;
      rowId?: string;
      carrier?: 'main' | 'worker' | 'external';
    },
  ): Promise<MountReport>;
  /**
   * 卸挂载（D2 删行动词）：吃**行 id**——删 overlay 行保码（装机物与账本不动、
   * 行 config 随行删；重挂回装机推导 config 缺省——mount 的 config 位承载显式
   * 重配）。受影响会话警示走 uninstall inspect 同款（词表三档 + 受影响会话计数）。
   * **不自动链 reload**（动词单职责——命令面 unmount→reload）。
   */
  unmount(rowId: string): Promise<UnmountReport>;
  /**
   * 双相卸载——inspect 相（契约篇 §3.4 第二刀；D2 键域迁装机 id）：零副作用只读
   * 预检（装机物 + 全部挂载行 + 数据域体积 + 词表三档 + 受影响会话计数 + 级联强
   * 警示）。人 execute 前已看；模型面消费本相（apps_uninstall_inspect 随管理刀排期）。
   * @param id 装机推导 id（非行 id——D2 键域迁移）
   */
  uninstall(id: string, opts: { readonly mode: 'inspect' }): Promise<UninstallReport>;
  /**
   * 双相卸载——execute 相：四段执行（删全部挂载行 → 装机物+账本记录 → 数据域
   * 处置 → 成功尾事件双落地）。human-only 落法：execute 唯一入口 = TUI
   * /apps-uninstall 命令薄壳（服务面不注册模型工具）；dataAction 省缺不可——keep|purge
   * 由命令面旗标裁决（省缺 = keep 是命令面语义，服务面必须显式）。
   * @param id 装机推导 id（非行 id——D2 键域迁移）
   */
  uninstall(
    id: string,
    opts: { readonly mode: 'execute'; readonly dataAction: 'keep' | 'purge' },
  ): Promise<UninstallExecReport>;
  /**
   * 行配置写入（契约篇 §3.4 刀 2 工具族条——configure 服务面导线）：patch 顶层键
   * 整值替换（与 overlay 字段级后写胜出同族语义，不引入深合并），合并后完整 config
   * 经应用声明 schema 校验（复用装载期同 schema）才落 overlay。schema 不可得行
   * （failed/disabled/unresolved/分域行〔worker/external——校验面在域侧，R1
   * 复盘批扩面〕/非 activated）拒写并提示先装载——跳过校验降级与
   * 「错配置防 boot 拒启」目标相反。**不自动链 reload**（动词单职责——链式用法
   * 由调用方显式走 requestReload）。
   */
  configure(id: string, patch: Readonly<Record<string, unknown>>): Promise<ConfigureReport>;
  /**
   * 重载请求投递（同条导线——reload 真身住组合根，服务面只投递）：排队语义宿主
   * 侧承载（run 进行中排队、run 结算后自动排水），件不自带重建权。app 参数 =
   * 单区 reload 目标（D3 per-app reload，契约篇 §1.3）——换该应用第三方挂载行
   * 不动他区运行时；未知/不在册 id 由组合根单点校验（报错面 = error 态）。
   */
  requestReload(opts?: { readonly app?: string }): Promise<ReloadOutcome>;
  /** boot 与 /reload 后装配方回灌最新装载结果（同实例就地更新——服务集恒定） */
  applyLoad(composition: CompositionReport, load: AppLoadResult): void;
  /**
   * 运行时单行失败状态面（契约篇 §1.7 死亡结算——worker 域意外退出时行转
   * failed）：装载后的运行期失败路径；boot/reload 装载失败走 applyLoad 三态
   * 清单不经此面（事件广播由调用方/fleet 负责，此处只保 list 状态源不漂移）。
   * 未知行 no-op（行不在最近装载清单 = 非本服务管辖）。
   */
  markFailed(id: string, code: string, message: string): void;
}

/** install 结果（TUI 直显的人读报告——D2 仓库态：无行写入，报告指引 mount） */
export interface InstallReport {
  /** 装机推导 id（npm=包名 / git=repo 名 / local=目录或文件名——mount 吃此 id） */
  readonly id: string;
  readonly source: AppSource;
  /** 装机引用（npm 裸包名 / local+git 绝对路径——mount 写行时沿用的 appRef） */
  readonly appRef: string;
  /** 一句话结果（人读；TUI 打印后提示挂载动词 + mount→reload 生效链） */
  readonly message: string;
}

/** mount 结果（写行事实 + 热应用提示） */
export interface MountReport {
  /** 写成的组合树行 id（缺省 = 装机推导 id；显式命名 = rowId 实参） */
  readonly id: string;
  /** 挂载目标应用 id 集（v1 恒非空——第三方件必须挂应用；多元素 = 共享件） */
  readonly apps: readonly string[];
  readonly source: AppSource;
  /** 行 pkg 引用（npm 裸包名 / git·local 绝对路径——按源沿用装机推导） */
  readonly appRef: string;
  /** 一句话结果（人读；提示 /reload 或命令面自动链） */
  readonly message: string;
}

/** unmount 结果（删行事实 + 受影响会话警示承载） */
export interface UnmountReport {
  /** 已删的 overlay 行 id */
  readonly id: string;
  /** 被删行的挂载目标应用 id 集（apps 键值——纯禁用/替换行无键 = 空数组；恰一元素 = 命令面链单区 reload 的判据） */
  readonly apps: readonly string[];
  /** 受影响会话警示（uninstall inspect 同款——词表 unknown 档最坏假设 + 逐词点名） */
  readonly warnings: readonly string[];
  /** 一句话结果（人读；装机物与账本保留——重挂走 mount） */
  readonly message: string;
}

/** update 结果（按源分派的不同结局说明） */
export interface UpdateReport {
  readonly id: string;
  readonly source: AppSource;
  readonly message: string;
}

/* ---------------- uninstall 双相四段（契约篇 §3.4 第二刀，2026-08-27 刀 2） ---------------- */

/**
 * 入口一次性装载面（词表收割/config 校验用，注入边——assembly 注入 jiti 面；
 **只在装机类动词（install/update）与 main 行 mount/configure 合法**——装机
 * 动作的显式信任前提（R1 复盘批二 11c 勘正：分域行入口求值在域侧，宿主
 * loadEntry 求值分域行 = 打穿宪章七）；测试注入替身。缺省不收割：账本
 * declaredEvents 记 null）。
 */
export type EntryLoader = (entry: string) => Promise<Record<string, unknown>>;

/** 卸载完成事件信封（app/uninstalled 载荷——总线与会话流同词同 data） */
export interface UninstalledEventData {
  /** 组合树行 id */
  readonly id: string;
  /** 行来源四分类 */
  readonly source: AppRowSource;
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

/** 卸载检视报告（inspect 相产物——零副作用只读预检；级联强警示的承载面；**D2 键域 = 装机 id**） */
export interface UninstallReport {
  /** 装机推导 id（provenance 账本反查的键——非行 id） */
  readonly id: string;
  /** 行来源（npm/git/local——账本记录的 source） */
  readonly source: AppRowSource;
  /** 装机引用（npm 裸包名 / git·local 绝对路径——按源沿用装机推导） */
  readonly appRef: string;
  /** 装机物路径（npm 子树 / git clone 目录 / local 引用路径〔不删〕） */
  readonly installPath: string;
  /** 全部挂载行 id（含各 app 键行——execute 段① 将同批删；禁用行也计：禁用≠卸载） */
  readonly mountedRows: readonly string[];
  /** 件数据根路径全集（装机 id 根 ∪ 各挂载行根——purge 的处置对象） */
  readonly dataRoots: readonly string[];
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
  /** 装机推导 id（非行 id） */
  readonly id: string;
  /** 行来源（npm/git/local；残迹收尾 = 按残迹推导：npm 装机物在推 npm，纯数据域推 local） */
  readonly source: AppRowSource;
  /**
   * 执行结局三态（SF-8 残迹收尾律）：uninstalled = 正常四段走完；residual =
   * 账本无记录但可推导残迹在（pre-D2 遗产装机 / 上次卸载段间失败的重入收敛）
   * ——只重跑清理段；no-op = 账本无记录且无残迹（已卸载过 / 从未安装——不造
   * 未知装机 id 错误，速报事实）。
   */
  readonly outcome: 'uninstalled' | 'residual' | 'no-op';
  /** 数据域处置事实 */
  readonly dataAction: 'keep' | 'purge';
  /** 装机物处置：removed 已删 / none 无装机物可删（local/缺目录——local 账本仍清） */
  readonly installRemoved: 'removed' | 'none';
  /** 已删的全部挂载行 id（含各 app 键行——多应用挂载同批清） */
  readonly mountedRows: readonly string[];
  /** 数据域是否已删（purge 且任一数据根存在） */
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
 * done 腿两可选面（D3 单区 reload）：app = 单区目标（缺席 = 全量）；
 * droppedEvents = 卸词集警示（该区旧词 ∖ 新词，基准 = 运行时真值）。
 */
export type ReloadOutcome =
  | { readonly status: 'queued' }
  | {
      readonly status: 'done';
      readonly failed: readonly string[];
      /** 单区 reload 目标应用（D3——缺席 = 全量） */
      readonly app?: string;
      /** 卸词集警示（D3——该区旧词 ∖ 新词；空/缺省 = 无消失词） */
      readonly droppedEvents?: readonly string[];
    }
  | { readonly status: 'error'; readonly message: string };

/**
 * 建应用管理服务实例。
 * @param opts.dataDir 数据目录（overlay 与装机子树的根）
 * @param opts.runner 装机子进程执行器（缺省真 spawn；测试注入替身）
 * @param opts.loadEntry 入口一次性装载面（词表收割；缺省不收割记 null）
 * @param opts.affectedSessionCounts 受影响会话计数取数面（assembly 绑持久层
 *        Store 并内嵌 flush 屏障；缺省 = 无持久层诊断面，检视省略计数）
 * @param opts.emitUninstalled 卸载完成事件投递（assembly 注入：总线 emit +
 *        当前会话流 append 双落地；缺省 = 服务单测不落事件）
 * @param opts.requestReload 重载请求投递面（刀 3 导线：assembly 注入组合根
 *        reload 闭包的适配器——排队语义宿主侧承载；缺省 = 诊断面拒投递）
 * @param opts.gitCommitOf git 装机物 commit 取数面（provenance 精确版本——
 *        rev-parse HEAD；缺省真 spawn 捕获，测试注入替身；失败容忍记缺省）
 * @param opts.knownAppIds 在册应用清单 id 集活取面（assembly 注入
 *        loadOfficialApps 键集闭包，与 loadComposition 触发①同源）：mount
 *        写行前 apps 值域预校验——坏 id 不落盘（原形态 = 落盘成功后下次
 *        boot/reload 才被 assertRowAppTargets 拒 = boot 拒启陷阱，与 config
 *        「错配置不落盘」目标相反）。缺省不预校验（诊断/测试面——boot 执法
 *        仍兜底）
 */
export function createAppsService(opts: {
  dataDir: string;
  runner?: InstallRunner;
  loadEntry?: EntryLoader;
  affectedSessionCounts?: (types: readonly string[]) => Promise<Record<string, number>> | Record<string, number>;
  emitUninstalled?: (data: UninstalledEventData) => void;
  requestReload?: (opts?: { readonly app?: string }) => Promise<ReloadOutcome>;
  gitCommitOf?: (dir: string) => Promise<string | undefined>;
  knownAppIds?: () => ReadonlySet<string>;
}): AppsService {
  const dataDir = opts.dataDir;
  const runner = opts.runner ?? spawnRunner;
  // git 精确版本采集缺省真身（provenance commit 字段）：可注入替身（测试免真
  // git 仓）；缺省 spawn rev-parse HEAD 捕获 stdout——失败容忍记缺省（ref 锁定
  // 仍是凭证面，commit 缺席只降精度不阻断装机）
  const gitCommitOf = opts.gitCommitOf ?? defaultGitCommitOf;
  /** 装载状态（applyLoad 回灌；boot 前空表） */
  let byId = new Map<string, AppStatusRow>();
  let plan: readonly AppPlanRow[] = [];
  /**
   * 合成行全集（applyLoad 回灌；boot 前空表）：仓库态差集的归一键源。plan 行
   * 不代劳——禁用行在 plan 里只有 {id, skip} 不带 pkg 引用（挂载休眠不解析
   * 入口），差集若按 plan 算会把「挂了但禁用」误报成「装了没挂」。
   */
  let compositionRows: readonly CompositionRow[] = [];
  /**
   * per-row 活词表（词表三档 live 档，契约篇 §3.4 第二刀）：applyLoad 从
   * activated 载荷 events 字段收割（undefined = 声明零词，?? [] 归一）；activated
   * 行恒在表（可能空数组）——uninstall 检视据此区分「活词表可枚举（哪怕为空）」
   * 与「须查账本」。整替式更新（applyLoad 同款语义）。
   */
  let liveEventsById = new Map<string, readonly string[]>();

  /**
   * 卸载目标解析（双相共用前置，D2 键域迁装机 id）：账本反查装机物（装机 id →
   * 唯一 provenance 记录）→ 装机物路径 → **全部挂载行**（归一路径反查——含各
   * app 键行与禁用行，天然兼容多应用挂载；禁用 ≠ 卸载，行在即挂载态）。词表与
   * 计数在调用侧按相取用。
   * **账本无记录返 undefined 不抛**（SF-8 残迹收尾律）：inspect 相调用方显式抛
   * 未知装机 id 错（人检视打错 id 该响亮）；execute 相走残迹收尾 / no-op——段间
   * 部分失败后重跑不被「未知 id」卡死，残迹仍可收敛。同装机 id 多条记录（同
   * repo 名不同 host 等）= 键歧义，响亮点名（卸载面不做「猜一条」）。
   * Ring 1 / fixed 守卫随行锚同灭：装机 id 结构上到不了官方行（provenance 只记
   * 三源装机物，builtin 行不装机）。
   */
  const resolveUninstallTarget = (
    installId: string,
  ):
    | {
        key: string;
        record: ProvenanceRecord;
        source: AppRowSource;
        installPath: string;
        mountedRows: CompositionRow[];
      }
    | undefined => {
    const hits = provenanceById(dataDir, installId);
    if (hits.length === 0) return undefined;
    if (hits.length > 1) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `uninstall：装机 id「${installId}」对应 ${hits.length} 条装机物（${hits.map(([k]) => k).join('、')}）——` +
          `同包多装机物不可凭 id 消歧（行 id 是行键不是包键的同族纪律），请先卸载多余装机物再执行`,
      );
    }
    const [key, record] = hits[0]!;
    const installPath = artifactPathOfKey(dataDir, key, record.source);
    return { key, record, source: record.source, installPath, mountedRows: mountedRowsFor(dataDir, installPath) };
  };

  /** 词表三档合一（双相共用）：activated 行 live 档优先，其余行唯一来源账本，无账本 unknown */
  const declaredEventsFor = (id: string, status: AppStatusRow['status']): DeclaredEventsInfo => {
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
    if (descriptor === 'legacy') {
      // 旧词汇域账本（认领键改名前写入）——非损坏：误报「损坏」会让 operator
      // 去查根本不存在的文件腐坏；真话 = 旧键域 + 重装再生的出路
      return {
        origin: 'unknown',
        names: [],
        note: '旧词汇域账本（认领键 plugin→app 改名前写入）——非损坏，/apps-install 重装收割再生新键域账本',
      };
    }
    if (descriptor === 'corrupt') {
      return { origin: 'unknown', names: [], note: '词表账本损坏（data.json 非法 JSON 或形状非法）——无法枚举' };
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
   * uninstall 双相服务（契约篇 §3.4 第二刀，2026-08-27 刀 2；**D2 键域迁装机
   * id**）——接口 overload 的实现体（对象字面量直挂双 overload 返回联合不可赋值，
   * 故走函数声明形态）。inspect = 零副作用预检（报告给人裁决）；execute = 四段
   * 执行序：①删**全部**挂载行（含各 app 键行——多应用挂载同批清）②装机物必删
   * + 账本记录同批清（local 不删〔用户自有目录〕但记录仍清）③数据域处置 =
   * dataAction 裁决（keep = Docker 卷律缺省；purge = 删各数据根整目录含词表
   * 账本）④成功尾 app/uninstalled 双落地（总线 + 当前会话流，注入闭包承载）。
   * 词表与受影响会话计数在段① 前一次性取数（purge 路径先删后读会丢账本档）。
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
    // 词表与受影响会话先取（段① 前——purge 路径先删后读会丢账本档；装机 id 无行
    // 状态，活档仅在缺省挂载〔行 id === 装机 id〕且已激活时可达，其余走账本档）
    const events = declaredEventsFor(id, byId.get(id)?.status ?? 'planned');
    const affectedSessions = await affectedCountsFor(events);

    if (phase.mode !== 'execute') {
      // ---- inspect 相：零副作用预检——只读不写，报告 = execute 将做的事 ----
      if (target === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `uninstall：未知装机 id「${id}」（provenance 账本无此记录——未装或已卸；清单以 /apps 或 apps_list 为准，勿凭记忆拼 id）`,
        );
      }
      // 数据域全集 = 装机 id 数据根（install 收割账本所在）∪ 各挂载行数据根
      //（自定义行 id 的运行期数据根）；Set 去重（缺省挂载行 id === 装机 id 同径）
      const dataRoots = dataRootsOf(dataDir, id, target.mountedRows);
      let dataBytes: number | undefined;
      for (const root of dataRoots) {
        const bytes = dirSizeBytes(root);
        if (bytes !== undefined) dataBytes = (dataBytes ?? 0) + bytes;
      }
      return {
        id,
        source: target.source,
        appRef: target.record.source === 'npm' ? target.record.id : target.installPath,
        installPath: target.installPath,
        mountedRows: target.mountedRows.map((row) => row.id),
        dataRoots,
        ...(dataBytes === undefined ? {} : { dataBytes }),
        events,
        ...(affectedSessions === undefined ? {} : { affectedSessions }),
        warnings: buildWarnings({
          id,
          source: target.source,
          events,
          affectedSessions,
          // D2：全部挂载行随卸载同删——「共享跳删」形态消灭（空集传参保 buildWarnings 签名）
          sharedRowIds: [],
        }),
      };
    }

    // ---- execute 相：四段执行序 ----
    const dataAction = phase.dataAction ?? 'keep'; // 类型面必填；运行期兜底 keep（Docker 卷律）
    // SF-8 残迹收尾律：账本无记录 ≠ 错——上次卸载段间失败的重入收敛面（只重跑
    // 清理段）+ 已卸/未装的 no-op 速报（不造未知装机 id 错误）；inspect 相已在上面显式抛
    if (target === undefined) return await residualCleanup(id, dataAction, affectedSessions);
    const dataRoots = dataRootsOf(dataDir, id, target.mountedRows);
    // 段①：删全部挂载行（含各 app 键行——多应用挂载同批清）；行 id 撞官方默认层
    // 的替换行删除后默认层同 id 行重新露出 = 恢复出厂态
    let restoresDefault = false;
    for (const row of target.mountedRows) {
      if (findRowLocation(dataDir, row.id).defaultRow !== undefined) restoresDefault = true;
      removeOverlayRow(dataDir, row.id);
    }
    // 段②：装机物必删 + 账本记录同批清（N-10 账实同批律：装机物删了记录留着 =
    // 账实漂移，mount 反查会让幽灵装机物复活；local 是用户自有目录不删——删
    // 用户的工作目录不是 uninstall 的事，但账本记录仍清）
    let installRemoved: 'removed' | 'none' = 'none';
    if ((target.source === 'npm' || target.source === 'git') && existsSync(target.installPath)) {
      // 越界防线（与 install 同款纵深第二道）：rmSync 前强制归一校验在装机子树内
      //（npm → apps/node_modules / git → apps/git），防账本手改污染
      assertInsideInstallSubtree(dataDir, target.source, target.installPath);
      rmSync(target.installPath, { recursive: true, force: true });
      installRemoved = 'removed';
    }
    removeProvenanceRecord(dataDir, target.key);
    // 段③：数据域处置——purge 才删（各数据根整目录含词表账本；keep = Docker 卷律）
    let dataRemoved = false;
    if (dataAction === 'purge') {
      for (const root of dataRoots) {
        if (!existsSync(root)) continue;
        // 保留名闸已在 appDataDirOf 取址时收口（dataRoots 构造行）；子树防线维持
        assertInsideSubtree(join(dataDir, 'apps'), root, 'uninstall：数据根');
        rmSync(root, { recursive: true, force: true });
        dataRemoved = true;
      }
    }
    // 段④：成功尾双落地——总线广播 + 当前会话流落账（注入闭包承载，无注入则静默）
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
      mountedRows: target.mountedRows.map((row) => row.id),
      dataRemoved,
      ...(affectedSessions === undefined ? {} : { affectedSessions }),
      // 卸替换行使官方默认层同 id 行重新露出 = 恢复出厂态（替换行卸载的显式可见面）
      ...(restoresDefault ? { restoresDefault: true as const } : {}),
    };
  }

  /**
   * 残迹收尾（SF-8：execute 相账本无记录的收敛路径）——pre-D2 遗产装机 + 段间
   * 失败重入两类。D2 后可推导残迹收敛为三样：npm 装机物（install id = 包名 →
   * node_modules/<id>；pre-D2 装机无 provenance 记录，账本反查结构性 miss）+
   * 引用它的 overlay 行（pre-D2 install 落的行——归一路径反查同删，悬空行只会
   * 造触发②启动失败）+ 数据域（purge 才构成收尾对象——keep 留数据域是合法
   * 终态）。git 源记录已随全源账本迁移折叠（loadProvenance 一次性收编旧
   * sources.json），账本 miss 即无 git 记录可找——matchGitResidualRelDirs 旧
   * 反查面退役。全无残迹 = no-op 速报；source 按残迹推导（npm 装机物在推
   * npm；纯数据域残迹推 local——无装机物无源的最弱假设）。词表与受影响会话
   * 沿用调用方段① 前取数（本路径行不在活档不可达——与检视报告同源）。
   */
  const residualCleanup = async (
    id: string,
    dataAction: 'keep' | 'purge',
    affectedSessions: Record<string, number> | undefined,
  ): Promise<UninstallExecReport> => {
    const npmPath = installArtifactPath(dataDir, 'npm', id);
    const dataRoot = appDataDirOf(dataDir, id);
    const dataRootExists = existsSync(dataRoot);
    const npmResidual = npmPath !== undefined && existsSync(npmPath);
    // pre-D2 遗产行（含禁用行——禁用 ≠ 卸载）：归一路径反查引用同一 npm 装机物
    // 的 overlay 行，路径比对不问存在性（装机物已手删行悬空 = 同一收敛对象）
    const mountedRows = npmPath === undefined ? [] : mountedRowsFor(dataDir, npmPath);
    if (!npmResidual && mountedRows.length === 0 && !(dataAction === 'purge' && dataRootExists)) {
      return {
        id,
        source: 'local',
        outcome: 'no-op',
        dataAction,
        installRemoved: 'none',
        mountedRows: [],
        dataRemoved: false,
      };
    }
    // 段①（残迹版）：删引用行——替换官方默认行的行删除后默认行重新露出
    let restoresDefault = false;
    for (const row of mountedRows) {
      if (findRowLocation(dataDir, row.id).defaultRow !== undefined) restoresDefault = true;
      removeOverlayRow(dataDir, row.id);
    }
    // 段②（残迹版）：清 npm 装机物——防线与正常路径同款（归一子树校验硬拒越界）
    let installRemoved: 'removed' | 'none' = 'none';
    if (npmResidual) {
      assertInsideInstallSubtree(dataDir, 'npm', npmPath!);
      rmSync(npmPath!, { recursive: true, force: true });
      installRemoved = 'removed';
    }
    // 段③（残迹版）：数据域 purge 裁决同正常路径（防线同款双闸；自定义行 id 数据根
    // 行已删不可反查 = 与正常路径崩溃窗口同界，检视报告已先行承载可删面）
    let dataRemoved = false;
    if (dataAction === 'purge' && dataRootExists) {
      // 保留名闸已在 appDataDirOf 取址时收口；子树防线维持（防线同款双闸）
      assertInsideSubtree(join(dataDir, 'apps'), dataRoot, 'uninstall：数据根');
      rmSync(dataRoot, { recursive: true, force: true });
      dataRemoved = true;
    }
    // 段④（残迹版）：词表走调用方段① 前取数（账本档与检视同源，不在此重读）
    const source: AppRowSource = npmResidual ? 'npm' : 'local';
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
      mountedRows: mountedRows.map((row) => row.id),
      dataRemoved,
      ...(affectedSessions === undefined ? {} : { affectedSessions }),
      ...(restoresDefault ? { restoresDefault: true as const } : {}),
    };
  };

  return {
    applyLoad(composition, load) {
      const next = new Map<string, AppStatusRow>();
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
      compositionRows = composition.rows;
    },

    list() {
      // source 在 list 时从组合树 plan 行现推导（契约篇 §3.4 第一刀，2026-08-27）：
      // 计划行的位置事实非装载态——applyLoad 不必存、planned/failed 行同带。
      // planned 兜底行与已装载行统一走 enrichment，面收敛一个形态
      const rows = plan.map((row) => {
        const loaded = byId.get(row.id);
        const source = deriveAppRowSource(row, dataDir);
        return loaded === undefined
          ? { id: row.id, status: 'planned' as const, ...(source === undefined ? {} : { source }) }
          : { ...loaded, ...(source === undefined ? {} : { source }) };
      });
      // D2 仓库态差集（契约篇 §6.1 可见性）：装机未挂件呈现 installed-unmounted
      // 态——差集按**同包归一键**算非行 id（行 id 可显式命名，包身份是装机物
      // 归一路径）；「装了没挂」不可静默不可见（装机面断头路 = 不可用面）。
      // 归一键源 = 合成行全集（compositionRows）：禁用行 plan 里无 pkg 引用，
      // 按 plan 算会把「挂了但禁用」误报成「装了没挂」（禁用 ≠ 卸载）
      const mountedKeys = new Set<string>();
      for (const row of compositionRows) {
        if (row.pkg === undefined) continue;
        const source = classifyRefSource(row.pkg, dataDir);
        const artifact = installArtifactPath(dataDir, source, row.pkg);
        if (artifact !== undefined) mountedKeys.add(resolve(artifact));
        else if (source === 'local') mountedKeys.add(resolve(row.pkg)); // local 无装机物——归一键 = 直引路径本身
      }
      const ledger = loadProvenance(dataDir);
      for (const [key, record] of ledger) {
        const artifact = artifactPathOfKey(dataDir, key, record.source);
        if (mountedKeys.has(resolve(artifact))) continue;
        rows.push({ id: record.id, status: 'installed-unmounted', source: record.source });
      }
      return rows;
    },

    markFailed(id, code, message) {
      // 仅更新已入清单的行（activated/skipped/failed 均可转——域死不挑前态）；
      // planned 兜底行不在 byId 清单（applyLoad 只收 activated/failed/skipped），
      // 对其 no-op——planned 行从未激活即无域可死，此为语义而非漏网。整行替换
      // 为 failed 形态（与 applyLoad 失败分支同形——面收敛一个形态）
      if (!byId.has(id)) return;
      byId.set(id, { id, status: 'failed', code, message });
    },

    async install(ref, installOpts) {
      // D2 仓库态（契约篇 §6.1 两态块）：install = 代码进装机子树 + provenance
      // 落账，**不写组合行 = 零生效**——写行生效是独立动词 mount；install→reload
      // 链随两态废止。词表账本收割（refreshLedger）仍随 install 走：账本是装机
      // 事实（uninstall 检视的词表档数据源）不是装载态，不依赖行在场。
      const source = classifyRef(ref);
      if (source === 'npm') {
        const name = npmPackageName(ref);
        await runInstallStep(runner, dataDir, 'npm', [
          'install',
          '--prefix',
          join(dataDir, 'apps'),
          '--legacy-peer-deps',
          '--omit=peer',
          ref,
        ]);
        // provenance 落账：精确版本 best-effort 读装机产物（package.json version +
        // .package-lock.json integrity 哈希——dist-tag 不算凭证，解析落盘的才算）
        const pinned = readNpmPin(dataDir, name);
        upsertProvenanceRecord(dataDir, `node_modules/${name}`, {
          source: 'npm',
          ref,
          id: name,
          ...(pinned === undefined ? {} : pinned),
          installedAt: new Date().toISOString(),
        });
        // 词表账本收割（刀 2）：jiti 一次性装载读 name/events 落 data.json
        await refreshLedger(opts, name, name);
        return {
          id: name,
          source,
          appRef: name,
          message: `npm 源已入仓库态（零生效）：${name}——挂载生效走 /apps-mount ${name} --apps <应用id>`,
        };
      }
      if (source === 'git') {
        const parsed = parseGitUrl(ref);
        const absDir = join(dataDir, 'apps', 'git', parsed.relDir);
        // 纵深防线（P33 第二道）：段净化之后仍强制校验归一路径在 git 子树内——
        // rmSync 前的最后一道闸，未来 parse 漂移也不可穿越出装机子树
        assertInsideGitRoot(dataDir, absDir);
        // 幂等：先清 clone 目录（重装/半装残骸都不留），父目录补齐（git 只建末级）
        rmSync(absDir, { recursive: true, force: true });
        mkdirSync(dirname(absDir), { recursive: true });
        await runInstallStep(runner, dataDir, 'git', [
          'clone',
          ...(installOpts?.gitRef === undefined ? [] : ['--branch', installOpts.gitRef]),
          '--',
          ref,
          absDir,
        ]);
        // provenance 落账：精确版本 = rev-parse HEAD（commit 哈希；缺省真 spawn
        // 捕获，失败容忍记缺省——ref 锁定 + commit 双落，update 重克隆按 ref 走）
        const commit = await gitCommitOf(absDir);
        upsertProvenanceRecord(dataDir, `git/${parsed.relDir}`, {
          source: 'git',
          ref,
          ...(installOpts?.gitRef === undefined ? {} : { gitRef: installOpts.gitRef }),
          id: parsed.repo,
          ...(commit === undefined ? {} : { commit }),
          installedAt: new Date().toISOString(),
        });
        await refreshLedger(opts, parsed.repo, absDir);
        return {
          id: parsed.repo,
          source,
          appRef: absDir,
          message: `git 源已 clone 入仓库态（零生效）：${ref} → ${absDir}——挂载生效走 /apps-mount ${parsed.repo} --apps <应用id>`,
        };
      }
      // local：路径直引不拷贝；绝对化后落 provenance（cwd 无关——跨目录启动解析仍成立）
      const absRef = resolve(process.cwd(), ref);
      if (!existsSync(absRef)) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `install：local 引用路径不存在：${ref}（解析为 ${absRef}）——先确认路径再装`,
        );
      }
      const id = basename(parse(absRef).name); // 目录名 / 文件名去扩展名
      upsertProvenanceRecord(dataDir, absRef, {
        source: 'local',
        ref: absRef,
        id,
        installedAt: new Date().toISOString(),
      });
      await refreshLedger(opts, id, absRef);
      return {
        id,
        source,
        appRef: absRef,
        message: `local 源已入仓库态（零生效）：${absRef}——挂载生效走 /apps-mount ${id} --apps <应用id>（改动 + /reload 即见）`,
      };
    },

    toggle(id) {
      return toggleOverlayRow(dataDir, id); // 持久化半边在组合树模块（翻转语义见其 JSDoc）
    },

    async update(id) {
      // D2 键域迁移（契约篇 §6.1 动词族全景）：update 改吃装机推导 id——两态后
      // overlay 无行的仓库态件也可更新；记录缺失/歧义皆响亮（账本是唯一事实源）
      const hits = provenanceById(dataDir, id);
      if (hits.length === 0) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `update：未知装机 id「${id}」（provenance 账本无此记录——未装或已卸；清单以 /apps 或 apps_list 为准）`,
        );
      }
      if (hits.length > 1) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `update：装机 id「${id}」歧义（账本 ${hits.length} 条同 id 记录：${hits
            .map(([key]) => key)
            .join('、')}——请按 /apps 清单核对后用卸载重装收敛）`,
        );
      }
      const [key, record] = hits[0]!;
      const installPath = artifactPathOfKey(dataDir, key, record.source);
      if (record.source === 'git') {
        // 纵深防线（P33 第二道）：账本手改污染的定位串同受越界校验——归一后
        // 必须仍在 git 子树内，字面前缀命中不算数
        assertInsideGitRoot(dataDir, installPath);
        // git 源：删目录按账本原 ref 重克隆（provenance 是 ref 的唯一存放处）
        rmSync(installPath, { recursive: true, force: true });
        await runInstallStep(runner, dataDir, 'git', [
          'clone',
          ...(record.gitRef === undefined ? [] : ['--branch', record.gitRef]),
          '--',
          record.ref,
          installPath,
        ]);
        const commit = await gitCommitOf(installPath);
        upsertProvenanceRecord(dataDir, key, {
          ...record,
          ...(commit === undefined ? {} : { commit }),
          installedAt: new Date().toISOString(),
        });
        // 重装重收割（刀 2）：声明词汇可能随版本漂移，账本以新装载为准覆写
        await refreshLedger(opts, id, installPath);
        return { id, source: 'git', message: `git 源已按原 ref 重克隆：${record.ref}` };
      }
      if (record.source === 'local') {
        // local 源：直引不拷贝——改动即见，update 天生 no-op；但账本仍刷新
        // （词表随磁盘代码漂移，与 /reload 的活跃词表对齐——no-op ≠ 不对账）
        await refreshLedger(opts, id, installPath);
        return { id, source: 'local', message: 'local 源无需 update——改动 + /reload 即见（词表账本已重收割）' };
      }
      // npm 源：按账本原 ref 重装（重新解析版本），provenance 精确版本随之刷新
      await runInstallStep(runner, dataDir, 'npm', [
        'install',
        '--prefix',
        join(dataDir, 'apps'),
        '--legacy-peer-deps',
        '--omit=peer',
        record.ref,
      ]);
      const pinned = readNpmPin(dataDir, record.id);
      upsertProvenanceRecord(dataDir, key, {
        ...record,
        ...(pinned === undefined ? {} : pinned),
        installedAt: new Date().toISOString(),
      });
      await refreshLedger(opts, id, record.id);
      return { id, source: 'npm', message: `npm 源已重装：${record.ref}` };
    },

    /**
     * 挂载（D2 装机两态的生效动词，契约篇 §6.1）：吃装机推导 id，写组合行 =
     * 生效。行 id 缺省 = 装机推导 id（npm 包名 / git repo 名 / local 文件名），
     * 可显式命名（rowId）——同包第二应用挂载必显式（全树行 id 唯一）。撞名
     * （overlay ∨ 官方默认层，findRowLocation 双层查）= `COMPOSITION_ROW_INVALID`
     * 拒绝；系统层官方专属 v1——第三方挂系统走 overlay 手编（专家路径）。config
     * best-effort 校验（行带 config 且应用声明 schema 可得时复用装载期校验面）。
     */
    async mount(id, mountOpts) {
      // 装机解析：账本唯一事实源——缺失/歧义皆响亮（与 update 同档拒绝式）
      const hits = provenanceById(dataDir, id);
      if (hits.length === 0) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `mount：未知装机 id「${id}」（provenance 账本无此记录——先 /apps-install 入仓库态）`,
        );
      }
      if (hits.length > 1) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `mount：装机 id「${id}」歧义（账本 ${hits.length} 条同 id 记录：${hits
            .map(([key]) => key)
            .join('、')}——请按 /apps 清单核对）`,
        );
      }
      const [key, record] = hits[0]!;
      // 挂载目标必填非空 v1（挂载目标两档：缺省全局作用域 = 官方专属、`apps` 键
      // 应用作用域集 = 第三方正路——无 apps 即挂系统，v1 拒绝；多应用行 = 共享件）
      const apps = mountOpts?.apps;
      if (apps === undefined || apps.length === 0) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `mount：挂载目标必填（--apps <应用id>…，可多个 = 共享件）——全局作用域 v1 官方专属，第三方挂载走应用作用域；` +
            `overlay 手编是系统层的专家路径`,
        );
      }
      // apps 值域预校验（R4 行为小刀）：坏应用 id 原形态要落盘后才在下次
      // boot/reload 被 assertRowAppTargets 拒（boot 拒启陷阱）。写行前对在册
      // 清单集执法——与装载期触发①同词同码拒绝；缺省不预校验（诊断/测试面）
      if (opts.knownAppIds !== undefined) {
        const registered = opts.knownAppIds();
        const unknown = apps.filter((appId) => !registered.has(appId));
        if (unknown.length > 0) {
          throw new AppError(
            COMPOSITION_ROW_INVALID,
            `mount：未知应用 id「${unknown.join('、')}」（apps 取值域 = 在册应用清单 id——在册：${
              [...registered].join('、') || '无'
            }；清单以 /app 为准，勿凭记忆拼 id）`,
          );
        }
      }
      // 载体裁决（R1 复盘批 2026-08-29 解冻收口——原「过渡冻结」分支随
      // external carrier 落码批达成解冻前提而删）：三值显式降格位；缺省
      // undefined = 不落 sandbox 块（闩一装载期按行引用形分派——第三方行
      // 缺省推 external 进程墙，装载面 resolveRowCarrier 执法）
      const carrier = mountOpts?.carrier;
      // 行 id 缺省 = 装机推导 id；显式命名走 rowId（行 id 是行键不是包键——全树唯一）
      const rowId = mountOpts?.rowId ?? id;
      // 撞名判域 = overlay ∨ 官方默认层（replace-via-mount 双层皆拒——系统层官方
      // 专属，替换官方行走 overlay 手编的 replace 语义〔专家路径〕）
      const location = findRowLocation(dataDir, rowId);
      if (location.overlay !== undefined || location.defaultRow !== undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `mount：行 id「${rowId}」已被占用（${location.defaultRow === undefined ? 'overlay' : '官方默认层'}同 id 行在场）` +
            `——同包多应用挂载请用 rowId 显式命名（行 id 是行键不是包键）`,
        );
      }
      // appRef 按源沿用装机推导：npm 裸包名 / git·local 绝对路径（与 install
      // 推导同键——装载期 resolveAppEntry 按同一形态解析入口）
      const installPath = artifactPathOfKey(dataDir, key, record.source);
      const appRef = record.source === 'npm' ? record.id : installPath;
      // config 校验（与 configure 同纪律，R1 P0-3 收口）：**唯显式 `carrier:'main'`
      // 走宿主侧校验面**——行带 config 且应用声明 schema 可得时复用装载期校验
      // （typebox Check 同路）——错配置不落盘防 boot 拒启陷阱；**分域行（显式
      // worker/external 或缺省——缺省第三方行经闩一即 external）config 校验面
      // 在域侧**（装载管线权威 schema 过界读，宿主结构不可得）：宿主侧
      // loadEntry 求值分域行入口 = 主进程 jiti 执行第三方码、打穿宪章七进程墙，
      // 禁——带非空 config 即诚实拒写（宁拒不误读；空对象视同未携带）。
      // 行 config 本身可经 overlay 手编携带，装载期域侧校验执法
      if (mountOpts?.config !== undefined && Object.keys(mountOpts.config).length > 0) {
        if (carrier !== 'main') {
          const domain = carrier ?? 'external（缺省——闩一）';
          throw new AppError(
            APP_CONFIG_INVALID,
            `mount：行「${rowId}」是分域行（载体 ${domain}）——config 校验面在域侧，宿主不可代校验（R1 安全收口：拒在宿主主进程装载分域行入口求值 schema）——` +
              `如需行配置请手编 overlay.yaml 后 /reload，或显式降格 --carrier main 后携带 config`,
          );
        }
        let schema: TSchema | undefined;
        const entry = resolveAppEntry(appRef, dataDir);
        if (entry === undefined || opts.loadEntry === undefined) {
          throw new AppError(
            APP_CONFIG_INVALID,
            `mount：行「${rowId}」携带 config 但入口不可解析（resolveAppEntry 无命中——装机物形态异常）——` +
              `先核对 /apps 清单，或去除 config 后挂载再 /apps-configure`,
          );
        }
        try {
          const ns = await opts.loadEntry(entry);
          if (Object.hasOwn(ns, 'config')) schema = ns.config as TSchema;
        } catch {
          schema = undefined; // 装载失败 = 校验面不可得，走下方同款拒绝
        }
        let ok = false;
        try {
          ok = schema !== undefined && typeboxValue.Check(schema, mountOpts.config);
        } catch {
          ok = false; // schema 自身非法与校验不过同路（与 loader 装载期口径一致）
        }
        if (!ok) {
          throw new AppError(
            APP_CONFIG_INVALID,
            schema === undefined
              ? `mount：行「${rowId}」携带 config 但应用未声明 config schema（装载面不可校验）——去除 config 后挂载`
              : `mount：行「${rowId}」config 未通过应用声明 schema——本次未写入，配置面不变`,
          );
        }
      }
      insertOverlayRow(dataDir, {
        id: rowId,
        pkg: appRef,
        apps,
        // 显式载体落盘为 sandbox 块（三值）；缺省不落块——闩一装载期按行引用形
        // 分派（第三方行缺省推 external；块缺席是合法形态非缺授权）
        ...(carrier === undefined ? {} : { sandbox: { carrier } }),
        ...(mountOpts?.config === undefined ? {} : { config: mountOpts.config }),
      });
      // 自定义行 id 的词表账本对齐（R1 复盘批二 11c——按载体分派）：数据根随行
      // id 走（appDataDirOf(rowId)），缺省收割只落了装机 id 根——补档到行数据根
      // 防 uninstall 检视词表档缺角。main 行宿主收割照旧（main 域本就宿主进程
      // 执行，loadEntry 在信任面内）；分域行（worker/external/缺省闩一推
      // external）**复制装机档**——宿主 loadEntry 求值分域行入口 = 主进程 jiti
      // 执行第三方码打穿宪章七进程墙，禁（与上行 config 校验面同一禁令）
      if (rowId !== id) {
        if (carrier === 'main') await refreshLedger(opts, rowId, appRef);
        else await copyLedgerForRow(opts, rowId, id);
      }
      return {
        id: rowId,
        apps,
        source: record.source,
        appRef,
        message: `已挂载生效（apps ${apps.join('、')}；载体 ${carrier ?? 'external（缺省——闩一出生即进程墙）'}）——热应用走 ${
          apps.length === 1
            ? `/reload --app ${apps[0]}（单区——命令面已自动链）`
            : '/reload 全量（跨区共享行——命令面已自动链）'
        }`,
      };
    },

    /**
     * 卸挂载（mount 对偶，契约篇 §6.1）：删行保码——`removeOverlayRow` 既有写面
     * 复用，吃行 id。行删 config 随行删，重挂回装机推导 config 缺省（mount 的
     * config 位承载显式重配）。受影响会话警示走 uninstall inspect 同款词表。
     */
    async unmount(rowId) {
      const location = findRowLocation(dataDir, rowId);
      if (location.overlay === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `unmount：未知行 id「${rowId}」（${location.defaultRow === undefined ? 'overlay 无此行' : '官方默认层行不可卸挂载'}——` +
            `清单以 /apps 为准；临时停用保配置走 /apps-toggle）`,
        );
      }
      const row = location.overlay;
      const source = row.pkg === undefined ? undefined : deriveAppRowSource(row, dataDir);
      // 受影响会话警示：uninstall inspect 同款词表推导（活档可达走活档，否则账本档）
      const events = declaredEventsFor(rowId, byId.get(rowId)?.status ?? 'planned');
      const affectedSessions = await affectedCountsFor(events);
      const warnings = buildWarnings({
        id: rowId,
        source: source ?? 'local',
        events,
        affectedSessions,
        sharedRowIds: [],
      });
      removeOverlayRow(dataDir, rowId);
      return {
        id: rowId,
        // 被删行挂载目标集（R4 行为小刀）：恰一元素 = 命令面链单区 reload 的判据；
        // 纯禁用/替换行无 apps 键 = 空数组（命令面回退全量）
        apps: row.apps ?? [],
        warnings,
        message: `已卸挂载（装机物保留在仓库态——重挂走 /apps-mount；数据域随 dataAction 语义由 uninstall 处置）`,
      };
    },

    /** 双相卸载（实现在上方 uninstallImpl 函数声明——overload 返回联合的形态约束） */
    uninstall: uninstallImpl,

    /**
     * 行配置写入（契约篇 §3.4 刀 2 工具族条——configure 服务面导线）。
     * 执行序：行定位（装载计划 = 唯一事实源）→ 状态门（schema 不可得行拒写：
     * disabled 挂载休眠 / unresolved 未装 / 非 main 载体行结构不可得〔R1 P0-3
     * 扩面：worker/external 同拒——分域行生效 schema 在域内过界不可得，宿主
     * loadEntry 求值分域行入口打穿宪章七〕 / 非 activated）
     * → 声明 schema 读取（builtin 行 = 官方注册表模块引用零装载；main 文件行 =
     * loadEntry 一次性 jiti 装载读 named export config——main 域本就宿主进程
     * 执行，operator 显式写配置动作与装机同族信任前提）→ 合并（顶层键整值
     * 替换）→ 校验（复用装载期同 schema，错配置不落盘防 boot 拒启陷阱）→
     * overlay 整值写回。
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
          `configure：未知行 id「${id}」（组合树无此行——清单以 /apps 或 apps_list 为准，勿凭记忆拼 id）`,
        );
      }
      // 状态门四拒（spec：schema 不可得行拒写并提示先装载——跳过校验降级与
      // 「错配置防 boot 拒启」目标相反）：
      if (row.skip !== undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `configure：行「${id}」已禁用（${row.skip === 'disabled' ? '静态禁用' : '平台门控'}·挂载休眠）——先启用（/apps-toggle 或 apps_toggle）再配置`,
        );
      }
      if (row.unresolved !== undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `configure：行「${id}」入口未解析（${row.unresolved}）——先安装（/apps-install 或 apps_install）再配置`,
        );
      }
      if (resolveRowCarrier(row) !== 'main') {
        // 分域行（worker/external——R1 P0-3 扩面：原门只拒 worker，external 行
        // 落穿到下方 loadEntry = 宿主主进程 jiti 求值第三方码，打穿宪章七进程墙，
        // 且与 worker 拒写自相矛盾）：生效 schema 在域内（过界元数据）——宿主
        // 侧结构不可得：诚实拒写优于跨域猜测。行 config 可经 overlay 手编携带，
        // 装载期域侧校验执法
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `configure：行「${id}」是分域行（载体 ${resolveRowCarrier(row)}）——其生效 config schema 在域侧结构不可得，请直接编辑 overlay.yaml 后 /reload`,
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
      if (row.builtin === undefined) {
        if (opts.loadEntry === undefined || row.entry === undefined) {
          throw new AppError(
            COMPOSITION_ROW_INVALID,
            `configure：行「${id}」的配置校验面不可用（无入口装载面——宿主未注入 loadEntry）——拒写`,
          );
        }
        const ns = await opts.loadEntry(row.entry);
        if (Object.hasOwn(ns, 'config')) schema = ns.config as TSchema;
      } else {
        schema = row.builtin.config;
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
            APP_CONFIG_INVALID,
            `configure：合并后 config 未通过应用声明 schema——${detail}（本次未写入，现配置不变）`,
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
          (ring1RestartRequired ? 'Ring 1 行不随 /reload 热装载，须重启生效' : '重载（/reload 或 apps_reload）后生效'),
      };
    },

    /**
     * 重载请求投递（刀 3 导线——真身在组合根 reload 闭包）：服务面零自有状态，
     * 只经注入闭包转发。排队语义在宿主侧（run 进行中排队、结算后自动排水）。
     * app 参数透传 = 单区 reload 目标（D3 per-app reload）。
     */
    async requestReload(requestOpts) {
      if (opts.requestReload === undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          'requestReload：宿主未注入重载请求面（诊断装配无 /reload——本面不可用）',
        );
      }
      return await opts.requestReload(requestOpts);
    },
  };
}

/* ---------------- 三源分类与 ref 解析 ---------------- */

/** 三源分类（§6.1）：git@… 或 https://….git = git；./ ../ 绝对路径 = local；其余 = npm */
function classifyRef(ref: string): AppSource {
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
 * `<数据目录>/apps/git/` 子树**内**。段净化（第一道）拦 URL 形态；本防线拦
 * 「归一后越界」的一切路径来源——install 的 parse 产物与 update 的 overlay
 * 引用（手改/污染面）同受校验。
 */
function assertInsideGitRoot(dataDir: string, dir: string): void {
  assertInsideSubtree(join(dataDir, 'apps', 'git'), dir, 'install/update：clone 目录');
}

/* ------- provenance 全源账本（<数据目录>/apps/sources.json——D2 两态） ------- */

/**
 * 一条装机出处记录（契约篇 §6.1 装机出处落账 + 两态块）：行说「要什么」，账本
 * 说「装了什么、从哪来」——组合树 = 装配枚举、账本 = 装机枚举的双源物理面。
 * 精确版本 = npm version+integrity 哈希 / git commit——dist-tag 不算凭证，
 * 解析落盘的才算（供应链事件取证面 + 「这个行为是哪个版本的哪个包带来的」）。
 */
export interface ProvenanceRecord {
  /** 源形态（npm/git/local——与行 source 同词汇；无 builtin：官方件随包无装机面） */
  readonly source: AppSource;
  /** 原始装机 spec（npm spec / git URL / local 绝对路径——update 按它重装） */
  readonly ref: string;
  /** 装机推导 id（npm 包名 / git repo 名 / local 文件名——mount/update/uninstall 键域） */
  readonly id: string;
  /** git 装机锁定的分支或 tag（可缺省 = 默认分支；update 重克隆按它走） */
  readonly gitRef?: string;
  /** npm 解析出的精确版本（装机产物 package.json 的 version） */
  readonly version?: string;
  /** npm 装机 integrity 哈希（.package-lock.json——精确版本的凭证面） */
  readonly integrity?: string;
  /** git 装机 commit 哈希（rev-parse HEAD；捕获失败容忍记缺省） */
  readonly commit?: string;
  /** 装机时间（ISO 串） */
  readonly installedAt?: string;
}

/** 全源账本路径（<数据目录>/apps/sources.json；键 = 装机物定位串 → 记录） */
function provenancePath(dataDir: string): string {
  return join(dataDir, 'apps', 'sources.json');
}

/** 旧 git 源登记路径（D2 前形态——只读迁移面，写面已废） */
function gitSourcesPath(dataDir: string): string {
  return join(dataDir, 'apps', 'git', 'sources.json');
}

/**
 * 读全源账本（文件缺 = 空表；解析失败响亮抛——对账依据损坏不静默当空表）。
 * **懒迁移**：旧 git 子树 sources.json 一次性折叠进全源账本（键 `git/<relDir>`、
 * id 按 URL 重 parse 推导——与 install 同一推导函数往返一致；解析不动的记录
 * 跳过不放宽防线）+ 写回 + 删旧文件，无双源期。崩溃窗口收敛：写回后未及删
 * 旧文件 → 下次读重折（幂等 upsert 不覆写新记录）再删；双开竞态 → 原子写 +
 * unlink 容忍 ENOENT。
 */
function loadProvenance(dataDir: string): Map<string, ProvenanceRecord> {
  const path = provenancePath(dataDir);
  const ledger = new Map<string, ProvenanceRecord>();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, ProvenanceRecord>;
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [key, record] of Object.entries(parsed)) ledger.set(key, record);
      }
    } catch (err) {
      throw new AppError(
        APP_INSTALL_FAILED,
        `装机 provenance 账本损坏：${path}（${err instanceof Error ? err.message : String(err)}）——手工修复或删除后重装`,
      );
    }
  }
  // 旧 git 源登记懒折叠（只补缺——D2 新记录不回退覆写）
  const legacyPath = gitSourcesPath(dataDir);
  if (existsSync(legacyPath)) {
    let legacy: Record<string, { url?: unknown; ref?: unknown }> = {};
    try {
      const parsed = JSON.parse(readFileSync(legacyPath, 'utf8')) as typeof legacy;
      if (typeof parsed === 'object' && parsed !== null) legacy = parsed;
    } catch {
      legacy = {}; // 旧账损坏——折叠面跳过（新账不受污染），防线不放宽
    }
    let folded = false;
    for (const [relDir, raw] of Object.entries(legacy)) {
      const key = `git/${relDir}`;
      if (ledger.has(key) || typeof raw?.url !== 'string') continue;
      let id: string;
      try {
        id = parseGitUrl(raw.url).repo;
      } catch {
        continue; // URL 已解析不动（手改/污染）——跳过，正常防线不放宽
      }
      ledger.set(key, {
        source: 'git',
        ref: raw.url,
        ...(typeof raw.ref === 'string' ? { gitRef: raw.ref } : {}),
        id,
      });
      folded = true;
    }
    if (folded) saveProvenanceEntries(dataDir, ledger);
    try {
      rmSync(legacyPath, { force: true }); // 旧账退役（ENOTEMPTY/ENOENT 皆容忍——重读重折收敛）
    } catch {
      /* 双开竞态他者已删——收敛 */
    }
  }
  return ledger;
}

/** 全量落盘（键排序稳定序列化——人对 diff 友好；原子写） */
function saveProvenanceEntries(dataDir: string, ledger: Map<string, ProvenanceRecord>): void {
  const sorted = Object.fromEntries([...ledger.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  mkdirSync(dirname(provenancePath(dataDir)), { recursive: true });
  writeAtomicFile(provenancePath(dataDir), `${JSON.stringify(sorted, null, 2)}\n`);
}

/** 写一条装机记录（同键覆写 = 重装/更新的自然语义） */
function upsertProvenanceRecord(dataDir: string, key: string, record: ProvenanceRecord): void {
  const ledger = loadProvenance(dataDir);
  ledger.set(key, record);
  saveProvenanceEntries(dataDir, ledger);
}

/**
 * 删一条装机记录（uninstall 段② 同批清账——N-10 账实同批律）。键不存在 =
 * no-op（残迹收尾幂等——装机物在记录无 = pre-D2 遗产，残迹路径自理）。
 */
function removeProvenanceRecord(dataDir: string, key: string): void {
  const ledger = loadProvenance(dataDir);
  if (!ledger.delete(key)) return;
  saveProvenanceEntries(dataDir, ledger);
}

/** 按装机推导 id 反查账本（0 条 = 未装/已卸；多条 = 同名异物歧义，调用方响亮） */
function provenanceById(dataDir: string, id: string): [string, ProvenanceRecord][] {
  const hits: [string, ProvenanceRecord][] = [];
  for (const [key, record] of loadProvenance(dataDir)) {
    if (record.id === id) hits.push([key, record]);
  }
  return hits;
}

/**
 * 账本键 → 装机物绝对路径（与 install 三源推导往返一致）：npm/git 键是
 * `apps/` 下相对定位串（node_modules/<pkg>、git/<relDir>）直接拼；local
 * 键就是绝对路径本身。
 */
function artifactPathOfKey(dataDir: string, key: string, source: AppRowSource): string {
  if (source === 'local') return key;
  return join(dataDir, 'apps', key);
}

/**
 * npm 精确版本 best-effort 读取：装机产物 package.json 的 version +
 * .package-lock.json 的 integrity 哈希（dist-tag 不算凭证——落盘的才算）。
 * 任一缺失只记可得字段；全缺 = undefined（记缺省——装机产物形态异常不阻断）。
 */
function readNpmPin(dataDir: string, name: string): { version?: string; integrity?: string } | undefined {
  const pkgDir = installArtifactPath(dataDir, 'npm', name)!;
  let version: string | undefined;
  let integrity: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof pkg.version === 'string') version = pkg.version;
  } catch {
    /* 产物无 package.json——记缺省 */
  }
  try {
    const lock = JSON.parse(readFileSync(join(dataDir, 'apps', '.package-lock.json'), 'utf8')) as {
      packages?: Record<string, { integrity?: unknown }>;
    };
    const entry = lock.packages?.[`node_modules/${name}`];
    if (entry !== undefined && typeof entry.integrity === 'string') integrity = entry.integrity;
  } catch {
    /* lock 不可读——integrity 记缺省 */
  }
  return version !== undefined || integrity !== undefined
    ? { ...(version === undefined ? {} : { version }), ...(integrity === undefined ? {} : { integrity }) }
    : undefined;
}

/* ---------------- 装机子进程执行 ---------------- */

/** 装机子进程硬顶（毫秒）——P32：npm/git 卡死不再永挂（缺省 5 分钟） */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** 单流输出滚动尾窗上限（字符计）——P32：装机输出无界积累的帽，保尾部为诊断 */
const INSTALL_OUTPUT_CAP = 1024 * 1024;

/** npm spawn 计划：归一后的命令 / 前置参数 / 是否需 shell */
export interface NpmSpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

/**
 * npm 命令的平台归一计划（遗漏大扫 20260901 O-7，纯函数可参测）：win32 上
 * 裸 spawn('npm') ENOENT/EINVAL（CVE-2024-27980 后 .cmd 无 shell 直接拒，
 * win32 的 npm 本体是 npm.cmd）——npm 动作（install/update）此前文档化支持
 * 平台上首用即败。归一序：① 优先 `process.execPath` + Node 自带 npm-cli.js
 * （零 shell、零 PATH 依赖、win32 亦免 .cmd 解析；两候选布局 = unix
 * `../lib/node_modules/…`〔官方/Homebrew/nvm〕、win 同目录 `node_modules/…`
 * 〔官方安装器〕，首个在者胜）；② cli 缺席回退：win32 `npm.cmd`+shell
 * （upgrade.ts 自升级同款语义）、unix 裸 `npm`（PATH 解析——既有可跑面不动）。
 * @param platform 平台（测试注入 win32 分支）
 * @param execPath node 解释器路径（缺省真身 process.execPath 的参数位）
 * @param exists cli 候选在判（注入 existsSync——测试可控布局）
 */
export function npmSpawnPlan(
  platform: NodeJS.Platform,
  execPath: string,
  exists: (path: string) => boolean,
): NpmSpawnPlan {
  // 两候选布局（顺序即优先级）：unix lib 布局 → win 同目录布局
  const candidates = [
    join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cli of candidates) {
    if (exists(cli)) return { command: execPath, args: [cli], shell: false };
  }
  if (platform === 'win32') return { command: 'npm.cmd', args: [], shell: true };
  return { command: 'npm', args: [], shell: false };
}

/**
 * 真装机执行器：spawn 子进程，非零退出抛错（含输出尾行——诊断直达）。
 * P32 两道护栏（隔离案一第一刀 #16）：① 超时硬顶——到点 SIGKILL 强杀
 * （'close' 随后到达统一收尾，不再永挂）；② stdout/stderr 各 1MiB 滚动
 * 尾窗——超帽从头部丢弃（失败尾行是诊断要点），截断发生即在错误消息标注。
 * npm 命令过 npmSpawnPlan 平台归一（遗漏大扫 20260901 O-7——单点归一，
 * install/update 两调用面零改动）；非 npm 命令原样透传。
 * @param opts.timeoutMs 超时覆盖（测试注入用；缺省 5 分钟）
 * @param opts.spawnFn spawn 注入面（缺省 node:child_process.spawn——接线测试用）
 */
export function spawnRunner(
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number; spawnFn?: typeof spawn },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // npm 平台归一（O-7）：win32 裸 spawn npm 必败——plan 单点判型
    let runCommand = command;
    let runArgs = args;
    let shell: boolean | undefined;
    if (command === 'npm') {
      const plan = npmSpawnPlan(process.platform, process.execPath, existsSync);
      runCommand = plan.command;
      runArgs = [...plan.args, ...args];
      shell = plan.shell;
    }
    // windowsHide 统一纪律（骨架篇 §7.6，P1-3——win32 CREATE_NO_WINDOW）；
    // npm/git/子 berry 输出恒 UTF-8 属编码豁免面，chunk.toString() 缺省不涉决策树
    const child = (opts.spawnFn ?? spawn)(runCommand, runArgs, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(shell === undefined ? {} : { shell }),
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

/** 单步装机执行 + 统一失败包装（APP_INSTALL_FAILED，message 载命令与原因） */
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
      APP_INSTALL_FAILED,
      `装机子进程失败：${command} ${args.join(' ')}\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * git 装机物 commit 采集缺省真身（provenance 精确版本——rev-parse HEAD，spawn
 * 捕获 stdout 首行；与 spawnRunner 的区别：本面要**读输出**非只等退出码）。
 * 失败容忍（spawn 错/非零/空输出）返回 undefined——ref 锁定仍是凭证面，commit
 * 缺席只降精度不阻断装机（8s 短顶：本地 git 查询亚秒级，卡死即弃）。
 */
async function defaultGitCommitOf(dir: string): Promise<string | undefined> {
  return await new Promise((resolvePromise) => {
    const child = spawn('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000); // 卡死护栏：到点强杀走 error/close 收尾
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 200) child.stdout.destroy(); // commit 哈希 ≤64 字符——超量即异常流，弃
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const head = stdout.trim().split('\n')[0];
      resolvePromise(code === 0 && head !== undefined && /^[0-9a-f]{7,64}$/.test(head) ? head : undefined);
    });
  });
}

/* ---------------- uninstall 辅助（契约篇 §3.4 第二刀，2026-08-27 刀 2） ---------------- */

/**
 * 行引用四分类（uninstall 视角——比 install 的三源分类多一档 builtin）：
 * `builtin:` 前缀 = builtin（代码随包）；归一后落 git 装机子树 = git / 落 npm
 * 装机子树 = npm（overlay 手改写绝对路径也按位置判）；其余路径引用 = local；
 * 裸包名 = npm。与 deriveAppRowSource 同判据不同输入面（本面吃 ref 字符串，
 * 那面吃 plan 行 entry/builtin——uninstall 时手改 overlay 与装载态都可能出现）。
 */
function classifyRefSource(ref: string, dataDir: string): AppRowSource {
  if (ref.startsWith('builtin:')) return 'builtin';
  const abs = resolve(ref);
  if (abs.startsWith(`${resolve(join(dataDir, 'apps', 'git'))}${sep}`)) return 'git';
  if (abs.startsWith(`${resolve(join(dataDir, 'apps', 'node_modules'))}${sep}`)) return 'npm';
  if (isPathReference(ref)) return 'local';
  return 'npm'; // 裸包名（overlay 正常形态）
}

/**
 * 装机物路径（uninstall 段② 的删除对象）：builtin → undefined（代码随包无装机
 * 物）；npm → node_modules 子树内包目录（ref 是裸包名，scoped 名按段拼）；git →
 * ref 本身（overlay 存的就是 clone 目录绝对路径）；local → undefined（用户自有
 * 目录永不删——删用户的工作目录不是 uninstall 的事）。
 */
function installArtifactPath(dataDir: string, source: AppRowSource, ref: string): string | undefined {
  if (source === 'builtin' || source === 'local') return undefined;
  if (source === 'git') return ref;
  return join(dataDir, 'apps', 'node_modules', ...ref.split('/'));
}

/**
 * 挂载行反查（D2 uninstall 段① 的删行全集 + 残迹收尾的遗产行发现）：扫
 * overlay 全部行，凡行引用解析出的装机物与给定装机物**归一路径相同**即同一
 * 包的挂载行（resolve 后比对——`dir` 与 `dir/../dir` 同物，字面相等不可靠）。
 * 禁用行也计入：禁用 ≠ 卸载，代码仍在盘上仍可能再启用；app 键行同计——
 * 多应用挂载同批清（uninstall 语义 = 删码 + 删**全部**挂载行）。
 */
function mountedRowsFor(dataDir: string, installPath: string): CompositionRow[] {
  const want = resolve(installPath);
  return loadOverlayRows(dataDir).filter((row) => {
    if (row.pkg === undefined) return false;
    const source = classifyRefSource(row.pkg, dataDir);
    const path = installArtifactPath(dataDir, source, row.pkg);
    // local 直引无装机物路径（installArtifactPath 恒 undefined）——归一键 = 直引
    // 路径本身（与 list() 差集同款口径，两处同一归一模型）
    const key = path === undefined ? (source === 'local' ? resolve(row.pkg) : undefined) : resolve(path);
    return key !== undefined && key === want;
  });
}

/**
 * 数据根全集（uninstall 段③ 的处置对象）：装机 id 数据根（install 收割账本
 * 所在）∪ 各挂载行数据根（自定义行 id 的运行期数据根）。Set 去重（缺省挂载
 * 行 id === 装机 id 同径）。保留名闸住 appDataDirOf 单点（撞名行取址即抛）。
 */
function dataRootsOf(dataDir: string, installId: string, mountedRows: readonly CompositionRow[]): string[] {
  const roots = new Set<string>([appDataDirOf(dataDir, installId)]);
  for (const row of mountedRows) roots.add(appDataDirOf(dataDir, row.id));
  return [...roots];
}

/** 件数据根描述符（data.json——双键一桥宿主写面首建，第十八批）：声明名 + 收割词表 */
interface AppDataDescriptor {
  /** 应用声明名（收割时读 named export name；失败/未声明回落行 id 由写入方决定） */
  readonly app: string;
  /** 自定义事件词名清单（null = 收割失败——装载失败/入口不可解析；检视按最坏假设档） */
  readonly declaredEvents: readonly string[] | null;
  /** 缓存子目录（第十八批布局预留字段——本刀不写） */
  readonly cacheSubdir?: string;
}

/** 词表账本路径（件数据根内 data.json；appDataDirOf 自 composition 单源取址含保留名闸） */
function dataJsonPath(dataDir: string, id: string): string {
  return join(appDataDirOf(dataDir, id), 'data.json');
}

/**
 * 读词表账本（四态判读）：文件不存在 = undefined（账本前存量行——unknown 档
 * 「早于账本」note）；旧词汇域文件 = 'legacy'（第三十六批认领键 plugin→app 改名前
 * 写入——**非损坏**，重装收割再生即可，critic #2 可诊断处置：读侧不做旧键兼容
 * 〔D36 裁定键随代码笔〕，但误报「损坏」是说谎——区分出来说真话）；坏 JSON /
 * 形状非法 = 'corrupt'（损坏档）；正常 = descriptor（ledger 档）。
 * declaredEvents 的 null/数组由调用侧分档。
 */
function readDataDescriptor(dataDir: string, id: string): AppDataDescriptor | 'legacy' | 'corrupt' | undefined {
  const path = dataJsonPath(dataDir, id);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AppDataDescriptor & { plugin?: unknown };
    // 旧认领键为合法字符串：新键不在 = 改名前文件（legacy 档）；两键同在 =
    // 手改杂交——落 corrupt 诚实（规范 :544 四分支实文：拒绝静默忽略任一键
    // 的读法，宁拒读勿猜测）
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.plugin === 'string') {
      return 'app' in parsed ? 'corrupt' : 'legacy';
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.app !== 'string' ||
      !('declaredEvents' in parsed) ||
      (parsed.declaredEvents !== null && !Array.isArray(parsed.declaredEvents))
    ) {
      return 'corrupt'; // 形状非法与坏 JSON 同罪——损坏档
    }
    return parsed;
  } catch {
    return 'corrupt';
  }
}

/*
 * 数据根布局原语 appDataDirOf 与保留名对 RESERVED_SUBTREE_NAMES 已下沉
 * composition.ts（2026-08-27 复盘批收口——paths 服务同文件、方向不倒）：
 * 保留名闸住 appDataDirOf 单点，本文件 install 收割写 / uninstall purge /
 * 检视取址全走该函数即全闸，不再需要本地副本与显式断言。
 */

/** tmp 扫龄阈值（毫秒）= 7 天常数，不开旋钮（无 env 无 config——契约篇 §1.5 tmp 钉位细则③） */
const TMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** ENOENT/ENOTDIR 判定：双进程同扫竞态的「他者已删」形态——视为成功不 warn（契约④ 删除幂等） */
function isVanished(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 件临时空间扫龄（boot 一次；契约篇 §1.5 tmp 钉位细则④⑤）：扫
 * `apps/<id>/tmp/` 全体件数据根（含已卸载件残留根），删 mtime 过阈值
 * （7 天）的文件并自底向上剪空目录（含 tmp 本体——消费者按需
 * mkdirSync recursive 再造）。安全件：入口 lstat 判真目录（tmp 本身是
 * 链接则不进——防逃逸）；目录内 Dirent 不跟随符号链接（链接本体当文件
 * unlink、永不触目标）；只进 tmp/ 子树——数据根其余内容（data.json/
 * 自管库）永不触碰。best-effort：单件失败 warn 继续、ENOENT/ENOTDIR
 * 静默容忍；apps/ 目录整体缺失 = 静默 no-op（全新机器首启）。
 * 返回删除文件数（诊断口径，含剪除目录前其内的文件）。
 */
export function sweepAppTmpDirs(dataDir: string, logger?: { warn: (msg: string) => void }): number {
  let names: string[];
  try {
    names = readdirSync(join(dataDir, 'apps'));
  } catch {
    return 0; // apps/ 不存在或不可读——首启常态，静默跳过
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
    const tmpDir = join(appDataDirOf(dataDir, id), 'tmp');
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
 * 词表账本收割写入（install/update 通尾，刀 2）：resolveAppEntry 解析入口 →
 * 注入的 loadEntry 一次性 jiti 装载（**装机动作的显式信任前提**——与 npm install
 * scripts 同族语义；「与 /reload 同一信任前提」的原宣称自 R1 复盘批二起勘正：
 * /reload 装载分域行入口在域侧执行，宿主 loadEntry 只在装机/更新/install 类
 * 显式装机动词时合法）→ Object.hasOwn 读 name / events 词名（jiti default-only
 * 命名空间穿透防线——与 loader 形状校验同款：命名空间对象上拿到的函数名不
 * 冒充 named export）。任何一步失败**不抛不阻断装机主流程**——declaredEvents
 * 记 null（检视面按 unknown 档最坏假设警示）。写入原子（writeAtomicFile）。
 */
async function refreshLedger(
  opts: { dataDir: string; loadEntry?: EntryLoader },
  id: string,
  ref: string,
): Promise<void> {
  let declaredEvents: readonly string[] | null = null;
  let name: string | undefined;
  try {
    const entry = resolveAppEntry(ref, opts.dataDir);
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
  // 保留名闸已收口于 appDataDirOf（下行取址即闸——撞名行在 mkdir 前抛）
  mkdirSync(appDataDirOf(opts.dataDir, id), { recursive: true });
  writeAtomicFile(dataJsonPath(opts.dataDir, id), `${JSON.stringify({ app: name ?? id, declaredEvents }, null, 2)}\n`);
}

/**
 * 词表账本按载体分派补档（mount 显式行 id 时的分域行腿，R1 复盘批二 11c——
 * 契约篇 §1.7）：词表是**包属性非行属性**（同包多行同词表）——非 main 行不走
 * 宿主 loadEntry 求值（分域行入口求值 = 主进程 jiti 执行第三方码，打穿宪章七
 * 进程墙，与 mount config 校验面同一禁令），**复制装机 id 根的既有收割档**到
 * 行数据根（install 收割建立在装机显式信任前提上，行补档复用其产物不新增
 * 宿主执行信任面）；装机档缺席（异常形态——install 通尾必落档，缺席即收割
 * 失败/null 档残留）落 null 档，检视面按 unknown 档警示兜底。
 */
function copyLedgerForRow(opts: { dataDir: string }, rowId: string, installId: string): void {
  const source = dataJsonPath(opts.dataDir, installId);
  const payload = existsSync(source)
    ? readFileSync(source, 'utf8')
    : `${JSON.stringify({ app: rowId, declaredEvents: null }, null, 2)}\n`;
  mkdirSync(appDataDirOf(opts.dataDir, rowId), { recursive: true });
  writeAtomicFile(dataJsonPath(opts.dataDir, rowId), payload);
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
  assertInsideSubtree(join(dataDir, 'apps', source === 'npm' ? 'node_modules' : 'git'), path, 'uninstall：装机物');
}

/**
 * 级联警示集装（inspect 报告承载——人 execute 前已看的强警示，第十八批「非
 * ignorable 词表强警示防会话变砖」的落码面）：unknown 档最坏假设 / 已落会话
 * 的词逐词点名（卸载后词失去注册来源，读侧未知非 ignorable 词整体拒绝）/ 共享
 * 行跳删说明。
 */
function buildWarnings(input: {
  id: string;
  source: AppRowSource;
  events: DeclaredEventsInfo;
  affectedSessions?: Readonly<Record<string, number>>;
  sharedRowIds: readonly string[];
}): readonly string[] {
  const warnings: string[] = [];
  if (input.events.origin === 'unknown') {
    warnings.push(
      `词表无法枚举（${input.events.note ?? '原因未知'}）——按最坏假设：该应用可能已向历史会话写过自定义事件词，` +
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
