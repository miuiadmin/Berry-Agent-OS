/**
 * app — 分域舰队（契约篇 §1.7 K3-c 编舞件，2026-08-26 第二十七批刀二；
 * external carrier 落码批扩 fork 腿——2026-08-29）。
 *
 * 「每分域行一域」的装配形态落码：把 spawnWorkerDomain / spawnExternalDomain
 * 两种域 spawn 收编成 loadApps 可注入的分域行装载器（workerLoader——词汇
 * 中性化挂步⑤）——分域行 load 时即 spawn 专属域（boot 解析即 spawn），并给
 * 组合根三件编舞出口：
 *
 * - reapUnapplied：清割「装载成功但从未 apply」的域（Kahn 零进展残留行——行
 *   已按 APP_INJECT_UNRESOLVED 进失败清单，域是孤儿，即刻刻意收尾防漏）；
 * - terminateAll：域级刻意收尾（/reload 随应用锚重装载、进程关停两时点）；
 * - terminateZone：单区 reload 的选择性收编（D3 per-app reload，契约篇 §5.1
 *   ——「该区行」谓词 = 独占该区〔apps 恰为 [该 app]〕，跨区行/系统相位行
 *   不动；行→区登记列在 load() 单点落，worker/external 两腿同舰队同谓词）；
 * - stats：观测打点（观测锚⑨心跳超时/⑩装机计数——打点先行，事件面随预算
 *   内存维度〔刀三〕另批；先例：tools stats() counters）。
 *
 * 死亡结算（契约篇 §1.7）：域意外死亡（自崩溃/watchdog kill/resourceLimits
 * 超限）→ 域 spawn 件 exit 监听已完成域死回卷（行作用域 LIFO）→ 本舰队逐行
 * 广播 app/failed（复用装载失败同一观测词汇，code = BRIDGE_WORKER_EXITED——
 * external 腿同码复用，词汇中性化挂步⑤）——不自动重启，「宁可死得响亮」，
 * operator 裁量重开。
 *
 * external 腿三层执法组装（契约篇 §1.7 第三十七批增补 2/4/8，本件单点）：
 * 进程墙（fork per-行域）+ PM 中层（derivePmFlags 旗面）+ OS 层尽力
 * （sandbox.confine 包裹 + 装载期 probe 醒 fail-closed）。闩二拒绝式执法
 * （声明根越基线即 COMPOSITION_ROW_INVALID）与有效白名单组装（基线 ∩ 行
 * 声明）在此落位——装载管线消费面（spawn 前）有 workspace 输入，组合树
 * 解析面没有（冷读闸拆明的执法点依据）。grants.writableRoots 收窄源挂账
 * 首个真实第三方应用清单（v1 导线未接——contracts/app.ts §5.4 注记）。
 *
 * env 白名单（K3-c 决定）：worker 腿 v1 不过滤——缺省继承宿主 env 全量。
 * 理由：main 域应用本可直读 process.env，给 worker 过滤无安全增益（worker
 * 分域是故障域分域非安全边界）。external 腿不同——进程墙是**信任边界**
 * （宪章七）：env 经 buildChildEnv 白名单（deny-by-default）+ TMPDIR 指向
 * per-域 tmp 子目录（基线内零新增根，痕迹随行清算——宪章八）。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppError,
  BRIDGE_WORKER_EXITED,
  APP_LOAD_FAILED,
  COMPOSITION_ROW_INVALID,
  SANDBOX_UNAVAILABLE,
} from '../contracts/errors.js';
import { resolveRowCarrier, exclusiveAppOf, type AppPlanRow } from '../contracts/app.js';
import type { HostFaceData } from '../contracts/api.js';
import type { ToolsService } from '../contracts/tools.js';
import type { ContextScope } from '../context/types.js';
import { appZoneId } from '../context/context.js';
import type { WorkerModuleMeta, WorkerRowLoader } from '../context/loader.js';
import { spawnWorkerDomain, bridgeWorkerUrl, type WorkerDomain } from '../bridge/bootstrap.js';
import { spawnExternalDomain, type ExternalDomain } from '../bridge/external-domain.js';
import {
  canonicalPath,
  externalEffectiveRoots,
  externalWritableRoots,
  derivePmFlags,
  type SandboxService,
} from '../safety/index.js';
import { buildChildEnv } from '../exec/env.js';
import { appDataDirOf } from './composition.js';

/** 舰队参数（组合根注入——编舞值〔心跳节律/资源上限〕由装配层定，本件只收编） */
export interface BridgeFleetOptions {
  /** 服务解析根（spawnWorkerDomain 的 root——ctx 真根，服务表根共享全树可见） */
  readonly root: ContextScope;
  /** 装载锚 accessor（app/failed 死亡结算的落点；/reload 会重 fork，恒取活锚） */
  readonly anchor: () => ContextScope;
  /** worker 同伴入口（缺省 bridge 模块自描述位置） */
  readonly workerUrl?: URL;
  /** 子进程 Node 参数（测试面注入 tsx 预载；生产面缺省继承父进程参数） */
  readonly execArgv?: readonly string[];
  /** 工具服务（缺省由 bootstrap 懒解析 root 的 'tools'——装载序晚期行友好） */
  readonly tools?: ToolsService;
  /**
   * 宿主面过河数据（§6.13.5 桥接档——两载体域内 ctx.host 的物化源）：随
   * svc.apply 帧第 4 位过河；未注入 = 域内 ctx.host 成员缺席。条件展开同款
   * 纪律（undefined 恒挂会被 external 腿 JSON 序列化丢尾）。
   */
  readonly hostFaceData?: HostFaceData;
  /** svc.load 在途超时毫秒（缺省 bootstrap 的 60s） */
  readonly loadTimeoutMs?: number;
  /** 心跳节律毫秒（undefined = 不起监督探针——监督编舞由装配层启用） */
  readonly heartbeatMs?: number;
  /** 连续丢拍阈值（缺省端点 3） */
  readonly heartbeatMissLimit?: number;
  /** resourceLimits 宿主全局缺省（预算内存维度——只限 JS 堆，非安全墙） */
  readonly resourceLimits?: Readonly<Record<string, number>>;
  /**
   * 按行资源限覆盖（第三纵切 budget.memoryMb 落码形态，契约篇 §5.4 第 5 条）：
   * worker 行装载时先问此钩子——键 = 行 pkg 装载身份串（与组件在场断言同键），
   * 返回值优先于全局缺省；undefined = 回落 opts.resourceLimits。应用内存预算的
   * per-row 映射位（多应用共享组件由装配层先行取严 min，本件不重复裁决）。
   * external 腿同钩子取 maxOldGenerationSizeMb 映射 --max-old-space-size
   * （fork 无 resourceLimits——增补 8 旗形替代）。
   */
  readonly rowResourceLimits?: (row: {
    readonly id: string;
    readonly pkg?: string;
  }) => Readonly<Record<string, number>> | undefined;
  /**
   * external 腿装配参数（external carrier 落码批）。缺省不启用 = external 行
   * 按未注入装载器 fail-closed 拒载（loadApps 载体分派面语义）；启用后
   * 本舰队按行 carrier 分派两腿 spawn（装载管线零感知）。
   */
  readonly external?: {
    /** 工作区根（执法基线左源——externalWritableRoots(workspace, 件数据根)） */
    readonly workspace: string;
    /** 数据目录（per-行件数据根推导源：appDataDirOf(dataDir, 行 id)） */
    readonly dataDir: string;
    /** 沙箱服务（OS 层 confine 包装 + 装载期 probe 醒 fail-closed） */
    readonly sandbox: SandboxService;
    /**
     * OS 层开关（缺省 true——probe 醒 + confine 包裹）。显式 false =
     * PM-only 逃生门：operator 显式降格档（跳过 OS 层，进程墙 + PM 中层
     * 两层执法仍全——宪章九「安全可控」的 operator 裁量面）。
     */
    readonly osLayer?: boolean;
    /** 域入口 URL（缺省 bridge 模块自描述位置；测试可显式指） */
    readonly externalUrl?: URL;
  };
  /**
   * 运行时行失败回写面（ctx.apps.markFailed 注入物——契约篇 §1.7 死亡
   * 结算：app/failed 事件广播 + list 状态源同步转 failed，两件同一时点）。
   * 事件归本舰队、状态归应用管理服务——分工不重不漏。
   */
  readonly markFailed?: (id: string, code: string, message: string) => void;
  /** 域死追加上报钩子（死亡结算内建 app/failed 广播之后；装配层观测面） */
  readonly onDomainExit?: (info: {
    readonly workerId: string;
    readonly code: number;
    readonly rows: readonly string[];
    readonly reason?: string;
    readonly diagnostic?: string;
  }) => void;
}

/** 舰队单域登记项（一行一域——行 id 即键；两腿域句柄操作面同构〔load/applyRow/terminate/kill〕） */
interface FleetEntry {
  readonly domain: WorkerDomain | ExternalDomain;
  /** apply 是否已成功返还（reapUnapplied 的判别面） */
  applied: boolean;
  /**
   * 行归属应用区（D3 per-app reload 行→区登记列，契约篇 §5.1）：apps 恰一
   * 元素 = appZoneId(该 app)；缺席/多元素 = undefined（系统相位/跨区行——
   * 单区 reload 不动）。load() 单点登记，两腿（worker/external）同列同谓词。
   */
  readonly zone?: string;
}

/** 舰队操作面（组合根三件编舞出口 + 装载器注入物） */
export interface BridgeFleet {
  /** loadApps opts.workerLoader 注入物（worker 行装载管线入口） */
  readonly loader: WorkerRowLoader;
  /** 清割未应用域（loadApps 返回后调用——Kahn 残留行防漏）；返回清割数 */
  reapUnapplied(reason: string): number;
  /** 全域刻意收尾（/reload/关停编舞——不走死亡结算）；返回收编数 */
  terminateAll(reason: string): number;
  /**
   * 单区选择性收编（D3 per-app reload，契约篇 §5.1「该区行」谓词 = 独占该区）：
   * 只 terminate 行→区列恰等于该区的域——跨区行/系统相位行不动（他区运行时
   * 不动是 per-app reload 的存在理由）。zone 形 = appZoneId(appId)（'app:<id>'）。
   * 返回收编数（含 0 = 该区无分域行，空区路径合法）。
   */
  terminateZone(zone: string, reason: string): number;
  /** 观测打点：spawned/ooms/crashed/heartbeatFreezes/terminated 累计、live 现存（ooms = crashed 的内存超限归因子集） */
  stats(): {
    spawned: number;
    live: number;
    crashed: number;
    ooms: number;
    heartbeatFreezes: number;
    terminated: number;
  };
}

/**
 * 观测锚⑤ 内存超限归因判据（两腿签名并集，契约篇 §1.7 预算旗形定形——R2 测试
 * 补课批 2026-08-29 立法）：域死 diagnostic 携带内存超限签名即归因 ooms（exit
 * code 两腿都与普通崩溃同码——签名是唯一判据，probe-oom 实证）。两腿不同形：
 * - worker 线程腿：resourceLimits 超限 → 'error' 事件签名
 *   `Worker terminated due to reaching memory limit`（tools/poc-worker/probe-oom.mjs 实证）；
 * - external fork 腿：`--max-old-space-size` 超限 → V8 堆 OOM abort，stderr
 *   结论行在头部 `FATAL ERROR: Reached heap limit Allocation failed - JavaScript
 *   heap out of memory`（Node 24 实证）——域内真栈 ~10KiB 会把头部结论行挤出
 *   8KiB 尾缓存（R2 实测），故 stderr 缓存改两头制（external-domain 头 2KiB
 *   判据 + 尾 8KiB 最深帧）。`heap out of memory` 是跨 V8 变体的稳定子串
 *   （CALL_AND_RETRY_LAST 老形亦含）、`Reached heap limit` 兜 Invalid-marked-
 *   size 变体——修复前单串 'reaching memory limit' 匹配漏判 fork 腿：
 *   external OOM 记 crashed 不记 ooms。
 */
const isOomDiagnostic = (diagnostic: string | undefined): boolean =>
  diagnostic !== undefined &&
  (diagnostic.includes('reaching memory limit') ||
    diagnostic.includes('heap out of memory') ||
    diagnostic.includes('Reached heap limit'));

/**
 * 建 worker 域舰队。装载失败/apply 失败的域即刻刻意收尾（行已进失败清单，
 * 域不留孤儿——防漏是本件的存在理由之一）；意外死亡走域 spawn 件域死回卷 +
 * 本件 app/failed 死亡结算。两腿（worker 线程 / external fork 进程）同编舞
 * 共用，spawn 形态差异封在各分支的 spawn 参数组装里。
 */
export function createBridgeFleet(opts: BridgeFleetOptions): BridgeFleet {
  /** 行 id → 域登记项（一行一域） */
  const entries = new Map<string, FleetEntry>();
  /** 观测打点计数器（观测锚⑨⑩——装机计数 spawned、心跳超时 heartbeatFreezes；⑤ ooms = crashed 的内存超限归因子集） */
  let spawned = 0;
  let crashed = 0;
  let ooms = 0;
  let heartbeatFreezes = 0;
  let terminated = 0;

  /** OS 层 probe 是否已过（fleet 生命周期一次——装载期首 external 行前醒probe） */
  let osLayerProbed = false;

  /**
   * OS 层 probe 醒（契约篇 §1.7 第三十七批增补 2a）：external 腿装载期显式
   * 探测后端链——与 confine 单候选不预探测的日常路径不同，进程墙批次「宣示
   * OS 层尽力」必须在装载时点验真（坏了再发现 = 域起不来，失败形态是运行
   * 事故不是装载拒绝）。任一 probe 失败 = SANDBOX_UNAVAILABLE fail-closed
   * （抛给 loader.load 的 catch → 行进失败清单 → boot 启动断言拒启）。
   */
  const ensureOsLayer = (sandbox: SandboxService): void => {
    if (osLayerProbed) return;
    const backends = sandbox.listBackends();
    // 空后端链 fail-closed（R4 行为小刀）：本平台零 OS 沙箱后端——「OS 层尽力」
    // 宣示无层可验，原形态零迭代静默放行 = PM-only 悄悄降格（三层执法缺一层
    // 而无人知）。与 probe 失败同档拒装；降 PM-only 必须显式 osLayer:false 逃生门
    if (backends.length === 0) {
      throw new AppError(
        SANDBOX_UNAVAILABLE,
        'external 域 OS 沙箱层不可用（本平台零 OS 沙箱后端）——fail-closed 拒装（契约篇 §1.7 增补 2a；可显式降 PM-only 逃生门）',
      );
    }
    for (const backend of backends) {
      if (backend.probe !== undefined && !backend.probe(5_000)) {
        throw new AppError(
          SANDBOX_UNAVAILABLE,
          `external 域 OS 沙箱层探测失败（后端 ${backend.id}）——fail-closed 拒装（契约篇 §1.7 增补 2a；可显式降 PM-only 逃生门）`,
        );
      }
    }
    // 旗后置：探测全过后才缓存「已验真」（mcp-spawn.ts 同款修法——遗漏大扫
    // 20260903 runtime D2-1 修死）。修前旗在 probe 前置位：首行 probe 失败抛出
    // 后旗已立，第二行 external 装载即被「已验真」短路静默放行——fail-closed
    // 只对首行生效，后续行带着未验真的 OS 层起域。
    osLayerProbed = true;
  };

  /**
   * 闩二执法 + 有效白名单组装（external 腿单点，契约篇 §1.7 第三十七批
   * 增补 2/4）：基线 = workspace ∪ 件数据根；行声明根越基线即
   * COMPOSITION_ROW_INVALID 拒（拒绝式——宁响亮不静默钳）；有效白名单 =
   * 基线 ∩ 行声明（声明缺席 = 全基线；交集可空 = 只读域）。
   * 两道验：词法归一验（声明形）+ 实化后复验（R1 P0-5 立法，见内注）。
   * 单源统一（R1 复盘批二 11e）：交集滤除与缺省全基线**全走
   * externalEffectiveRoots 同函数**（与 assembly rowConfinementLookup 运行期
   * 消费面同一 containment 语义——本件只做「差集命名 + 拒绝式抛错 + 实化」，
   * 不复刻包含判定）；缺省档（声明缺席）基线同样实化返回（mkdir+realpath
   * 归一——与声明档同形，PM 旗/OS bind/TMPDIR 均绑实形无 symlink 漂移窗）。
   */
  const resolveEffectiveRoots = (ext: NonNullable<BridgeFleetOptions['external']>, row: AppPlanRow): string[] => {
    const appDataDir = appDataDirOf(ext.dataDir, row.id);
    const baseline = externalWritableRoots(ext.workspace, appDataDir);
    const declared = row.sandbox?.fs?.writableRoots;
    /** 实化（mkdir 预建 + realpath 归一）——两档同形（坑三序：先预建再归一） */
    const realize = (roots: readonly string[]): string[] =>
      roots.map((root) => {
        mkdirSync(root, { recursive: true });
        return canonicalPath(root);
      });
    if (declared === undefined) {
      // 缺省档 = 全基线实化返回（R1 复盘批二 11e——与声明档同形）
      return realize(baseline);
    }
    // 第一道·词法归一验（单源：externalEffectiveRoots 同函数滤，差集即越界
    // 命名——/ws-evil 撞 /ws 前缀不合法〔isInsideRoot 分隔符特判〕）
    const lexical = externalEffectiveRoots(ext.workspace, appDataDir, declared);
    const outside = declared.map(canonicalPath).filter((d) => !lexical.includes(d));
    if (outside.length > 0) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `行 ${row.id} 的 sandbox.fs.writableRoots 声明越界（${outside.join('、')} 不在执法基线 ${baseline.join('、')} 内）——` +
          `闩二「只收窄不放大」拒绝式拒载（契约篇 §1.7 第三十七批；宁响亮不静默钳）`,
      );
    }
    // 第二道·实化后复验（R1 P0-5，契约篇 §1.7 增补 2 R1 复盘批立法 2026-08-29）：
    // 词法归一只挡词法层越界声明——修前末段组件不存在时 realpath 整体 ENOENT
    // 原样返回、**中间 symlink 组件不被解析**，mkdirSync 预建会跟随 symlink
    // 实化出越基线真身。〔2026-09-02 运行时探针 F-1 修法注记：canonicalPath
    // 缺失路径已改「最近存在祖先解析」——已存在的 symlink 祖先组件在第一道
    // 词法验即被解析拒载，此攻击形态提前死于第一道；本复验的必要性收窄至
    // 「词法验与预建之间换 symlink 的竞态窗」，保留为防御深度〕预建（幂等
    // ——derivePmFlags 推导内还会再建，recursive
    // 无害）后全链存在、realpath 解析真身，逐一复验在基线内、越界同码拒。
    // 诚实边界：预建本身可能已落越基线空目录（痕迹残留，域死随行清扫覆盖
    // 不到基线外）+ 复验与预建间换 symlink 的竞态窗（堵死需 openat 级原语，
    // 非本批）——拒绝式执法拦的是域起 spawn 与 PM/OS 两层旗授权，装载拒绝
    // 后行不生效、旗不会落地。
    const realized = realize(declared.map(canonicalPath));
    const realizedLexical = externalEffectiveRoots(ext.workspace, appDataDir, realized);
    const realizedOutside = realized.filter((r) => !realizedLexical.includes(r));
    if (realizedOutside.length > 0) {
      throw new AppError(
        COMPOSITION_ROW_INVALID,
        `行 ${row.id} 的 sandbox.fs.writableRoots 实化越界（${realizedOutside.join('、')}——预建跟随 symlink 解析出的真身不在执法基线 ${baseline.join('、')} 内）——` +
          `闩二实化后复验拒绝式拒载（契约篇 §1.7 增补 2 R1 复盘批立法）`,
      );
    }
    // 返回实化形根：PM 旗与 OS 层 confine 绑真身路径（rw bind 即真身，无
    // symlink 漂移窗）
    return realized;
  };

  /**
   * external 腿 spawn 参数组装（三层执法的参数面——头注）：PM 旗 + 预算旗
   * （execArgv）、OS 层 confine 包裹器（argvWrapper）、白名单 env + per-域
   * TMPDIR。per-域 tmp 子目录建在件数据根内（基线内零新增根；痕迹随行清算）。
   * TS 源形态 PM 伴随参数（刀四载体去 tsx 化后勘正）：`--allow-worker` 保留
   * ——理由从「tsx→esbuild 转译线程」换为「载体引导器 module.register 的
   * loader 钩子线程（AsyncLoaderHookWorker）」；`TSX_DISABLE_CACHE` 退役
   * （载体零 tsx 无磁盘缓存面）。编译产物形态参数都不带——PM 保持最紧
   * （dist 直载不经引导器）。入口形态判据 = 域入口 URL 尾缀：显式
   * externalUrl 看自身；缺省入口（external-domain.ts 内部定位）与本
   * 模块同树同形（src/bridge 同编译单元——dev 同 .ts、dist 同 .js）。
   */
  const assembleExternalSpawn = (
    ext: NonNullable<BridgeFleetOptions['external']>,
    row: AppPlanRow,
  ): { execArgv: string[]; argvWrapper?: (argv: string[]) => string[]; env: Record<string, string> } => {
    const effective = resolveEffectiveRoots(ext, row);
    const isTs = (ext.externalUrl?.pathname ?? import.meta.url).endsWith('.ts');
    // 预算旗（增补 8 旗形）：fork 无 resourceLimits，memoryMb → V8 堆上限旗
    const rowLimits = opts.rowResourceLimits === undefined ? undefined : opts.rowResourceLimits(row);
    const memoryMb = (rowLimits ?? opts.resourceLimits ?? {}).maxOldGenerationSizeMb;
    const execArgv = [
      ...derivePmFlags(effective, { tsTransform: isTs }), // PM 中层（写根预建在推导内——坑三执法）
      ...(memoryMb === undefined ? [] : [`--max-old-space-size=${memoryMb}`]),
    ];
    const osLayer = ext.osLayer ?? true;
    if (osLayer) ensureOsLayer(ext.sandbox);
    const argvWrapper = osLayer
      ? (argv: string[]) =>
          // OS 层尽力（mode=workspace-write + 显式 writableRoots=有效白名单——
          // confine 策略面现成的收窄通道；seatbelt/bwrap 按它出 rw bind）
          ext.sandbox.confine(argv, {
            mode: 'workspace-write',
            workspaceRoot: ext.workspace,
            writableRoots: effective,
          }).argv
      : undefined; // PM-only 逃生门（显式降格——两层执法仍全）
    const appDataDir = appDataDirOf(ext.dataDir, row.id);
    // per-域 tmp：件数据根内 tmp/（契约篇 §1.5 tmp 钉位细则——boot 扫龄 7 天
    // 罩残留；消费者按需 mkdirSync recursive 再造即本行；一行一域，行 id 即
    // 域键，tmp/ 本体即该域专属）。derivePmFlags 已预建根（坑三序），域死留痕
    const tmpDir = join(appDataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const env = {
      ...buildChildEnv(process.env),
      TMPDIR: tmpDir,
    };
    return { execArgv, ...(argvWrapper === undefined ? {} : { argvWrapper }), env };
  };

  const loader: WorkerRowLoader = {
    /* 域半装载 = spawn 专属域 + 委托 domain.load（boot 解析即 spawn）——按行载体分派两腿 */
    load(row) {
      // onFreeze 闭包需引用域自身（spawn 后才存在）——先声明后接线的同款两步
      let self!: WorkerDomain | ExternalDomain;
      // 域死结算共用体（两腿同码——观测词汇 worker/spawned|froze|oom 复用，
      // 词汇中性化挂步⑤ docs 批）
      const onExit = (info: {
        readonly workerId: string;
        readonly code: number;
        readonly rows: readonly string[];
        readonly reason?: string;
        readonly diagnostic?: string;
      }): void => {
        entries.delete(row.id);
        if (info.reason === undefined) crashed += 1; // 无执法归因 = 自崩溃（kill 路径已计 heartbeatFreezes）
        // 观测锚⑤ 内存超限归因：error 事件/stderr 签名命中（probe-oom 实证——
        // exit code 与普通崩溃同码，签名是唯一判据）→ ooms 计数 + worker/oom 事件。
        // 两腿签名并集（isOomDiagnostic——fork 腿 V8 堆 OOM 签名不同形）
        if (isOomDiagnostic(info.diagnostic)) {
          ooms += 1; // crashed 的归因子集（维度正交——既计 crashed 又计 ooms）
          opts.anchor().emit('worker/oom', { rowId: row.id, workerId: info.workerId, diagnostic: info.diagnostic });
        }
        for (const id of info.rows) {
          const detail = info.reason === undefined ? '' : `，归因：${info.reason}`;
          // 诊断面终点（契约篇 §1.7 结算消息携带 diagnostic）：第一手错误缀入
          // 结算消息——app/failed 广播与 markFailed 回写同一字符串，operator
          // 看 appsService.list() 行状态即见原始异常/内存超限签名，不只知 code 1
          const diag = info.diagnostic === undefined ? '' : `，diagnostic：${info.diagnostic}`;
          const message = `worker 域意外退出（code ${info.code}${detail}${diag}）——域死回卷已完成，不自动重启（宁可死得响亮，契约篇 §1.7）`;
          // 事件广播（观测面）+ 状态回写（list 状态源不漂移）同一时点落定
          opts.anchor().emit('app/failed', { id, code: BRIDGE_WORKER_EXITED, message });
          opts.markFailed?.(id, BRIDGE_WORKER_EXITED, message);
        }
        // 进程日志半边（基建大扫 #23，契约篇 §1.7 死亡结算「响亮的两半」）：
        // 运行期域死 warn 落进程日志——daemon 常驻形态唯一跨重启痕迹（进程内
        // 事件表/状态面重启即灭，daemon.log 是唯一持久位）；与 durable 事件/
        // 状态回写双保险，单路失明不致断链。一次死亡一行（多行域同死因同结算，
        // 不逐行刷屏）；code 织进文本（grep/日志检索面按码直达）
        opts.root.logger.warn(
          `worker 域意外退出（${BRIDGE_WORKER_EXITED}）：行 [${info.rows.join('、')}]（code ${info.code}` +
            `${info.reason === undefined ? '' : `，归因：${info.reason}`}` +
            `${info.diagnostic === undefined ? '' : `，diagnostic：${info.diagnostic}`}）——死亡结算已广播`,
          { workerId: info.workerId },
        );
        opts.onDomainExit?.(info);
      };
      // 心跳监督编舞共用体：冻结 → watchdog 杀域（kill 走意外死亡全流程）
      const freezeOpts =
        opts.heartbeatMs === undefined
          ? {}
          : {
              heartbeatMs: opts.heartbeatMs,
              ...(opts.heartbeatMissLimit === undefined ? {} : { heartbeatMissLimit: opts.heartbeatMissLimit }),
              onFreeze: (info: { missed: number }) => {
                heartbeatFreezes += 1; // 观测锚⑨ 打点（kill 后 exit 通知带 reason 不再计 crashed——防双计）
                // 观测锚⑨ 事件面：kill 前派发（订阅方先见冻结归因再见死亡结算）；
                // 域 id 经 self 引用（冻结时点域必已 spawn——w:/e: 前缀随腿）
                opts.anchor().emit('worker/froze', { rowId: row.id, workerId: self.workerId, missed: info.missed });
                self.kill(`心跳缺失（连续 ${info.missed} 拍无应答）——同步死循环或事件循环冻结，watchdog 杀域`);
              },
            };
      const common = {
        root: opts.root,
        ...(opts.tools === undefined ? {} : { tools: opts.tools }),
        ...(opts.loadTimeoutMs === undefined ? {} : { loadTimeoutMs: opts.loadTimeoutMs }),
        ...(opts.hostFaceData === undefined ? {} : { hostFaceData: opts.hostFaceData }),
        ...freezeOpts,
        onExit,
      };

      const carrier = resolveRowCarrier(row);
      let domain: WorkerDomain | ExternalDomain;
      if (carrier === 'external' && opts.external !== undefined) {
        // external 腿（fork 进程域——三层执法参数在 assembleExternalSpawn 组装）。
        // 缺省入口不在此定位——externalEntryUrl 的位置知识归 external-domain.ts
        //（本模块在 src/app/，自解析会指向不存在的 src/app/external-entry.ts）
        const ext = opts.external;
        const spawnOpts = assembleExternalSpawn(ext, row);
        domain = spawnExternalDomain({
          ...common,
          workerId: `e:${row.id}`, // 域 id 用行 id 归因（w:/e: 前缀分腿——诊断面直查组合树行）
          ...(ext.externalUrl === undefined ? {} : { externalUrl: ext.externalUrl }),
          ...spawnOpts,
        });
      } else if (carrier === 'external') {
        // external 行 + external 装配参数缺席 = 响亮拒载（R1 复盘批二 11e——契约篇
        // §1.7）。修复前此处静默落 worker 线程域：「external 声明被降格执行」比拒绝
        // 更糟——进程墙承诺（宪章七）在线程域不存在，操作者从行状态看不出降格。
        // 裁剪装配面（测试/诊断形态）同拒——与加载器「分域装载器未注入」分支同
        // 语义，不因场景放水
        throw new AppError(
          APP_LOAD_FAILED,
          `external 行 ${row.id} 装载失败：舰队未注入 external 装配参数（本装配面未启用 external 载体能力——契约篇 §1.7 第 11e 条，fail-closed 拒载不降格 worker 线程域）`,
        );
      } else {
        // worker 腿（worker 线程域——resourceLimits 预算执法）
        const rowLimits = opts.rowResourceLimits === undefined ? undefined : opts.rowResourceLimits(row);
        const resourceLimits = rowLimits ?? opts.resourceLimits;
        domain = spawnWorkerDomain({
          ...common,
          workerUrl: opts.workerUrl ?? bridgeWorkerUrl(),
          workerId: `w:${row.id}`,
          ...(opts.execArgv === undefined ? {} : { execArgv: opts.execArgv }),
          ...(resourceLimits === undefined ? {} : { resourceLimits }),
        });
      }
      self = domain;
      // 行→区登记（D3 单区 reload 过滤列）：apps 恰一元素才归属该应用区——
      // 跨区行（多元素）与系统相位行（缺席）zone 列 undefined，单区 terminate 不动
      // （谓词单源 = contracts exclusiveAppOf，与 partitionPlan 同源防两处漂移）
      const zoneApp = exclusiveAppOf(row);
      entries.set(row.id, {
        domain,
        applied: false,
        ...(zoneApp === undefined ? {} : { zone: appZoneId(zoneApp) }),
      });
      spawned += 1; // 观测锚⑩ 装机计数
      // 观测锚⑩ 事件面：spawn 即派发（订阅方计量装机——boot//reload 各分域行一发）
      opts.anchor().emit('worker/spawned', { rowId: row.id, workerId: domain.workerId });
      return domain.load(row).catch((err: unknown) => {
        // 装载失败防漏：行已进失败清单，域即刻刻意收尾（无死亡结算——编舞既知终点）
        entries.delete(row.id);
        domain.terminate(`行 ${row.id} 装载失败防漏收尾`);
        terminated += 1;
        throw err;
      }) as Promise<WorkerModuleMeta>;
    },
    /* 宿主半激活 = 委托 domain.applyRow（行作用域由 loadApps fork 后传入） */
    apply(row, scope, callOpts) {
      const entry = entries.get(row.id);
      if (entry === undefined) {
        // 装载后域已死（意外死亡已结算）/已收编——行按失败收尾，响亮不静默
        return Promise.reject(
          new AppError(APP_LOAD_FAILED, `分域行 ${row.id} 的域不在舰队（装载后死亡或已收编——装载管线不变量）`),
        );
      }
      return entry.domain.applyRow(row, scope, callOpts).then(
        () => {
          entry.applied = true;
        },
        (err: unknown) => {
          // apply 失败防漏：loadApps 已回卷行作用域 + 行进失败清单，域即刻收尾
          entries.delete(row.id);
          entry.domain.terminate(`行 ${row.id} apply 失败防漏收尾`);
          terminated += 1;
          throw err;
        },
      );
    },
  };

  return {
    loader,
    /** 清割未应用域：Kahn 零进展残留行（loadApps 已判 APP_INJECT_UNRESOLVED）的孤儿域 */
    reapUnapplied(reason) {
      let reaped = 0;
      for (const [rowId, entry] of [...entries]) {
        if (entry.applied) continue;
        entries.delete(rowId);
        entry.domain.terminate(reason);
        terminated += 1;
        reaped += 1;
      }
      return reaped;
    },
    /** 全域刻意收尾（/reload 随应用锚重装载、进程关停——jobs drain 后 persistence.close 前） */
    terminateAll(reason) {
      let count = 0;
      for (const [rowId, entry] of [...entries]) {
        entries.delete(rowId);
        entry.domain.terminate(reason);
        terminated += 1;
        count += 1;
      }
      return count;
    },
    /** 单区选择性收编（interface 注记——谓词 = 行→区列恰等，跨区/系统相位行不动） */
    terminateZone(zone, reason) {
      let count = 0;
      for (const [rowId, entry] of [...entries]) {
        if (entry.zone !== zone) continue; // 独占该区才收编（跨区行/系统相位行 zone 列不等）
        entries.delete(rowId);
        entry.domain.terminate(reason);
        terminated += 1;
        count += 1;
      }
      return count;
    },
    stats() {
      return { spawned, live: entries.size, crashed, ooms, heartbeatFreezes, terminated };
    },
  };
}
