/**
 * L5 app — 桌面壳后端（第八十五批批 C 起位、批 D 状态面/动词/管理面接线，
 * 契约篇 §6.11 换防编舞的壳侧消费面 + 骨架篇 §1.2/§1.3/§1.4）。
 *
 * 持桌面引擎（src/desktop/ 纯渲染引擎）+ 渲染树，向宿主入口（desktop-main）
 * 呈现 start/dispose 生命周期与换防两动词：
 * - **进应用**（openApp）：先 enterApp（runtime 单源路由）→ 引擎 suspend 三件套
 *   交出 TTY → 宿主 enterAppView（pi-tui 起屏）。起屏失败回滚 resume。
 * - **回桌面**（backToDesktop，即 DesktopFace 真身）：宿主 leaveAppView（pi-tui
 *   stop preserveScreen）→ 引擎 resume 全量首帧重绘。
 * 序的机制单源在引擎（契约 §6.11）；壳只按序调用并管视图状态。
 *
 * 视图族（栈式替换——单根渲染树整树换装）：desktop（顶栏五槽位状态行 +
 * 凭证警示槽 + 分组页签 + 应用清单 + 提示行 + 命令输入框）/ menu（应用菜单：
 * 打开/配置/卸载/卸挂载/挂载/详情——管理四项批 D 起接 admin 服务面薄壳，壳零
 * 管理逻辑）/ detail（详情）/ confirm（二次确认与回执——恒杀全家确认 + 管理
 * 回执/两段式共用原语）/ guide（首启凭证引导——批 E 起助手在场走助手指路面）/
 * prompt（管理补参输入）/ answer（系统助手应答卡——批 E 无前缀文本默认应答）/
 * store（应用商店三市场——批 F：技能/MCP/应用 tab，←→ 切换照桌面分组语义，
 * 动作回执走 applyAdminResult 同一回执链）/ sessions（多会话完整切换器——批 F
 * 骨架篇 §1.2 line 80 五件面：列表分组/预览/搜索/关闭/开新+续接）。
 *
 * 命令前缀（底部 SingleLineInput）：/exit（真退）/shutdown /reboot（恒杀全家
 * ——过 confirm 原语后走宿主 requestPower 单源编舞）/desktop（回桌面视图）
 * /guide（首启引导）/store（进商店视图）/sessions（进会话切换器）。**无 /
 * 前缀文本 = 询问系统助手**（批 E 默认应答者——应答进 answer 卡；助手行缺席
 * 回落帮助文案〔carve-out 第四条〕）。Ctrl+D =
 * /exit。键位：↑↓ 移动光标、←→/Tab 切分组（全部/官方/第三方），Enter 打开
 * 或提交、m 菜单、g 引导（警示在场时）、Esc 返回。
 */

import {
  DesktopEngine,
  Column,
  Flex,
  SingleLineInput,
  Text,
  type InputEvent,
  type KeyEvent,
  type Renderable,
  type TerminalIO,
} from '../desktop/index.js';
import type { DesktopAppEntry, DesktopFace, DesktopService, DesktopStatusService } from './desktop-service.js';
import type { AssistantService } from './assistant-app.js';
import type { StoreService } from './store-app.js';
import {
  parseMonitorTabArg,
  type DesktopMonitorFace,
  type MonitorItem,
  type MonitorPanel,
  type MonitorResult,
  type MonitorTab,
} from './desktop-monitor.js';
import { POWER_KILL_FAMILY_TEXT, type PowerAction, type PowerResult } from './host-power.js';

/** 桌面命令面全集（对等门禁的桌面侧真相源——cli-parity 交叉核对消费） */
export const DESKTOP_COMMANDS: readonly string[] = [
  '/exit',
  '/shutdown',
  '/reboot',
  '/guide',
  '/desktop',
  '/store',
  '/sessions',
  '/monitor',
];

/** 时序三件注入面（缺省 Date.now/setTimeout/clearTimeout——测试假钟缝合位；与引擎注入面同构） */
export interface ShellTiming {
  /** 时钟（毫秒） */
  readonly now: () => number;
  /** 调度（返回句柄供取消） */
  readonly schedule: (fn: () => void, ms: number) => unknown;
  /** 取消调度（与 schedule 成对） */
  readonly cancelSchedule: (handle: unknown) => void;
}

/**
 * 管理面回执（宿主格式化——formatter 与 /apps-* 命令面单源共用，壳零管理逻辑）。
 * string 形 = 单行提示（错误/拒因）；结构形 = 回执视图（标题 + 正文行）。
 */
export type DesktopAdminResult = DesktopAdminReceipt | string;

/** 管理回执结构形（confirm 在场 = 两段式第二段：Enter 触发执行） */
export interface DesktopAdminReceipt {
  readonly title: string;
  readonly lines: readonly string[];
  /** 两段式确认（卸载族——Enter 执行 / Esc 取消；run 返回下一层回执链） */
  readonly confirm?: { readonly label: string; readonly run: () => Promise<DesktopAdminResult> };
}

/**
 * 桌面管理面（宿主实现——AppsService〔admin 工具族同源实现〕的薄壳投影，
 * 禁第二实现）：菜单 配置/卸载/卸挂载/挂载 四项的路由目标。壳只调度与呈现。
 */
export interface DesktopAdminFace {
  /** 配置（JSON patch 整值合并写入） */
  configure(id: string, patchJson: string): Promise<DesktopAdminResult>;
  /** 卸载两段式第一段：检视报告（不执行） */
  uninstallInspect(id: string): Promise<DesktopAdminResult>;
  /** 卸载两段式第二段：执行（dataAction keep/purge——桌面腿恒 keep，purge 走命令面） */
  uninstallExecute(id: string, dataAction: 'keep' | 'purge'): Promise<DesktopAdminResult>;
  /** 卸挂载（rowId = 装机 id） */
  unmount(rowId: string): Promise<DesktopAdminResult>;
  /** 挂载（installId → 目标应用域） */
  mount(installId: string, apps: readonly string[]): Promise<DesktopAdminResult>;
}

/** 桌面壳依赖束（宿主入口注入——壳不 import 组合根/通道，边界单向） */
export interface DesktopShellDeps {
  /** 终端 IO 注入（缺省真 TTY 适配器；组合根全栈测试注 fake——mock 停在终端边界） */
  readonly io?: TerminalIO;
  /** 时序注入（缺省真时钟；测试假钟） */
  readonly timing?: ShellTiming;
  /** 应用清单投影（活取值——每次建树重取，装载面单一真相源的投影，壳不缓存账本） */
  readonly listApps: () => readonly DesktopAppEntry[];
  /**
   * 进入应用（runtime enterApp 单源路由：解析 → 缺场拒 → open({app}) 一条龙）。
   * 返回 ok:false + error = 未知 id / 组件缺场 / 无持久层——壳只转述不判错。
   */
  readonly enterApp: (appId: string) => { ok: true; sessionId: string } | { ok: false; error: string };
  /** 进应用视图（宿主编舞：pi-tui 起屏——在引擎 suspend 之后调用） */
  readonly enterAppView: () => void;
  /** 出应用视图（宿主编舞：pi-tui 停屏 preserveScreen——在引擎 resume 之前调用） */
  readonly leaveAppView: () => void;
  /** 请求退出（/exit、Ctrl+D——宿主接 front.requestQuit 优雅退出序列） */
  readonly requestExit: () => void;
  /** 桌面服务（Ring 1 行 provide 的 holder——起屏后 attach 回接面；缺席 = Esc 回桌面腿降级） */
  readonly service?: DesktopService;
  /** 顶栏状态服务（Ring 1 行 provide 的 holder——批 D；缺席 = 顶栏回落占位时钟） */
  readonly status?: DesktopStatusService;
  /**
   * 关停/重启编舞入口（宿主接 host-power 单源——一实现两入口的桌面腿；UI
   * confirm 原语已过二次确认。缺席 = /shutdown //reboot 诚实拒）
   */
  readonly requestPower?: (action: PowerAction) => Promise<PowerResult>;
  /** 管理面（宿主接 AppsService 薄壳；缺席 = 管理菜单项诚实拒） */
  readonly admin?: DesktopAdminFace;
  /**
   * 系统助手服务面（Ring 2 assistant 行 provide 的 `assistant` 键——批 E
   * 默认应答者）。**getter 活取值**（与 service/status 的直引用不同）：每次
   * 提问/引导现场解析——行被 overlay 禁用 + /apps-toggle 后 tryGet 即时
   * undefined，无前缀文本回落帮助文案（carve-out 第四条），不用重启。
   */
  readonly assistant?: () => AssistantService | undefined;
  /**
   * 应用商店服务面（Ring 2 store 行 provide 的 `store` 键——批 F 三市场动作
   * 单源）。getter 活取值（assistant 同律）：行被 overlay 禁用后即时 undefined
   * ——/store 与商店行 Enter 诚实拒（回落提示行），不用重启。
   */
  readonly store?: () => StoreService | undefined;
  /**
   * 多会话切换器面（宿主 desktop-main 本地闭包实现——骨架篇 §1.2 line 80
   * 五件面：列表/预览/搜索/关闭/开新+续接）。缺席 = /sessions 诚实拒。
   */
  readonly sessions?: DesktopSessionsFace;
  /**
   * 统一管理器面（宿主 desktop-main 闭包构造——OS 三大管理面研究刀四，
   * 骨架篇 §1.2 三页签：proc 进程 / jobs 任务 / mem 内存）。缺席 =
   * /monitor 诚实拒（非桌面形态/宿主未接线）。
   */
  readonly monitor?: DesktopMonitorFace;
}

/**
 * 切换器会话条目（宿主两源合并投影——registry 在册条目 ∪ store 近史，builtin-deps
 * sessionsFor 同款合并律；壳只呈现不持账）。
 */
export interface DesktopSessionEntry {
  /** 会话 id（呈现截短在壳；动作动词吃全串） */
  readonly id: string;
  /** 应用域 id（分组呈现键） */
  readonly appId: string;
  /** 应用人读名（清单 label；缺 = appId） */
  readonly label: string;
  /** 首条用户消息摘要（列表行标题；空会话 = '(空会话)'） */
  readonly title: string;
  /** 末活动时刻人读串（缺 = 无事件） */
  readonly updatedAt: string | undefined;
  /** 活会话（在册未退役）——false = 已闭（可读不可写：预览可见，续接被拒） */
  readonly active: boolean;
  /** 前台聚焦位（★ 标记——续接/开新由 open 切 focus） */
  readonly current: boolean;
}

/**
 * 多会话切换器面（骨架篇 §1.2 line 80 五件面的宿主实现契约——desktop-main
 * 本地闭包真身；动作动词全部单源走既有运行时面：list/preview 两源合并投影、
 * search 走 session-search 窄面（FTS 真跑）、close 走 registry.retire、
 * openNew 走 runtime.enterApp（默认应用）、resume 走 registry.open({resume})）。
 */
export interface DesktopSessionsFace {
  /** 会话清单（两源合并——按末活动降序） */
  list(): readonly DesktopSessionEntry[];
  /** 预览（首末消息投影——deriveMessages 单源；会话不存在 undefined） */
  preview(id: string): { readonly first: string; readonly last: string } | undefined;
  /** 全文搜索（session_fts 命中 → 条目过滤；面缺席诚实拒非静默空集） */
  search(query: string): { ok: true; entries: readonly DesktopSessionEntry[] } | { ok: false; error: string };
  /** 关闭（registry.retire——停摆可读不可写；运行中/已闭/不在册拒） */
  close(id: string): { ok: true } | { ok: false; error: string };
  /** 开新会话（默认应用域——runtime.enterApp 单源路由） */
  openNew(): { ok: true; sessionId: string } | { ok: false; error: string };
  /** 续接（registry.open({resume:id})——活条目幂等切前台；进程内已闭拒） */
  resume(id: string): { ok: true; sessionId: string } | { ok: false; error: string };
}

/** 桌面壳面（宿主入口持有） */
export interface DesktopShell {
  /** 起屏（首帧同步渲染——渲染树异常同步上抛，供两连崩熔断计数；失败内置收口复原终端） */
  start(): void;
  /** 回桌面（换防接收侧——DesktopFace 真身同款；宿主亦可直调） */
  backToDesktop(): { ok: true } | { ok: false; error: string };
  /** 终退（排空 stdin + 摘回接面 + 引擎 dispose；幂等） */
  dispose(): Promise<void>;
  /** 引擎挂起态（宿主退出序列判定两栈收口序用） */
  readonly suspended: boolean;
}

/** 分组过滤三档（←→/Tab 循环切换） */
const GROUP_FILTERS = ['all', 'official', 'thirdparty'] as const;
type GroupFilter = (typeof GROUP_FILTERS)[number];

/** 分组人读名（页签行 + 空清单提示共用单源） */
const GROUP_LABELS: Record<GroupFilter, string> = {
  all: '全部',
  official: '官方',
  thirdparty: '第三方',
};

/** 菜单项（打开/详情壳内直实现；配置/卸载/卸挂载/挂载批 D 起接 admin 服务面薄壳） */
const MENU_ITEMS = ['打开', '配置', '卸载', '卸挂载', '挂载', '详情'] as const;

/** 商店三市场 tab 序与标签（←→ 循环——技能 → MCP → 应用；分组页签切换同语义） */
const STORE_TABS: readonly ('skills' | 'mcp' | 'apps')[] = ['skills', 'mcp', 'apps'];
const STORE_TAB_LABELS: Record<'skills' | 'mcp' | 'apps', string> = {
  skills: '技能',
  mcp: 'MCP',
  apps: '应用',
};

/** 技能装机状态人读词（store 清单行——呈现面） */
const STORE_SKILL_STATE_LABELS: Record<string, string> = {
  none: '未装',
  staged: '已装机·零生效',
  mounted: '已挂载',
  'user-owned': '用户层已有同名',
};

/**
 * 助手缺席回落文案（carve-out 第四条执法面：无前缀文本默认问助手，助手不在场
 * 也不是死路——命令面照常 + 装回指引 + 文档/诊断指路，进 answer 卡呈现）。
 */
const ASSISTANT_ABSENT_HELP: readonly string[] = [
  '桌面输入框的无前缀文本默认由系统助手应答——该行当前不在场（被禁用或未装载）。',
  '',
  '命令面照常可用：/guide 引导 · /shutdown /reboot 关停重启 · /desktop 回桌面 · /exit 退出',
  '装回助手：/apps-toggle assistant（overlay 禁用行翻转即复装；行 id 见 /apps）',
  '更多用法与配置见 docs/使用指南.md；装配诊断：berry dump-config',
];

/** 顶栏时钟回落刷新间隔（毫秒——status 缺席时的占位时钟；聚合器在场则停用） */
const CLOCK_REFRESH_MS = 30_000;

/** 分组页签行（active 组方括号标记） */
function groupTabLine(active: GroupFilter): string {
  return (
    ' ' +
    GROUP_FILTERS.map((g) => (g === active ? `[${GROUP_LABELS[g]}]` : GROUP_LABELS[g])).join(' / ') +
    '（←→/Tab 切换）'
  );
}

/** 毫秒时刻 → HH:MM（顶栏时钟；toTimeString 前 5 位即本地时制时分） */
function formatClock(nowMs: number): string {
  return new Date(nowMs).toTimeString().slice(0, 5);
}

/**
 * 构造桌面壳后端。构造即装引擎输入监听（引擎 idle 态不读终端——start 才进屏）；
 * 起屏前零副作用。start 失败（抛）后壳不可复用（引擎已 dispose 复原终端）——
 * 重试由宿主新建壳（两连崩熔断的 /desktop 动词即如此）。
 */
export function createDesktopShell(deps: DesktopShellDeps): DesktopShell {
  const timing: ShellTiming = deps.timing ?? {
    now: Date.now,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancelSchedule: (h) => clearTimeout(h as NodeJS.Timeout),
  };
  const engine = new DesktopEngine({
    ...(deps.io === undefined ? {} : { io: deps.io }),
    now: timing.now,
    schedule: timing.schedule,
    cancelSchedule: timing.cancelSchedule,
  });

  /* ---------------- 视图状态（单根渲染树整树换装，状态全在壳） ---------------- */
  /** 当前视图（desktop 主面 / menu 应用菜单 / detail 应用详情 / confirm 确认与回执 / guide 引导 / prompt 补参输入 / answer 助手应答卡 / store 应用商店 / sessions 会话切换器 / monitor 统一管理器） */
  let view:
    'desktop' | 'menu' | 'detail' | 'confirm' | 'guide' | 'prompt' | 'answer' | 'store' | 'sessions' | 'monitor' =
    'desktop';
  /** 分组过滤（desktop 视图） */
  let groupFilter: GroupFilter = 'all';
  /** 清单光标（过滤后投影的下标） */
  let cursor = 0;
  /** 菜单光标（menu 视图） */
  let menuCursor = 0;
  /** 详情目标（detail 视图） */
  let detailApp: DesktopAppEntry | undefined;
  /** 商店当前 tab（store 视图——三市场序：技能 → MCP → 应用） */
  let storeTab: 'skills' | 'mcp' | 'apps' = 'skills';
  /** 商店清单光标（store 视图——当前 tab 条目下标） */
  let storeCursor = 0;
  /** 切换器搜索词（sessions 视图——undefined = 全列表；空提交 = 清除搜索） */
  let sessionsQuery: string | undefined;
  /** 切换器光标（sessions 视图——当前清单〔搜索过滤后〕下标） */
  let sessionsCursor = 0;
  /** 管理器当前页签（monitor 视图——spec §1.2 三页签） */
  let monitorTab: MonitorTab = 'proc';
  /** 管理器光标（monitor 视图——items 下标：光标只寻址动作行，仪表行不占位） */
  let monitorCursor = 0;
  /** 管理器面板缓存（monitor 视图——异步活取的最近一帧；undefined = 首帧未达） */
  let monitorPanel: MonitorPanel | undefined;
  /** 管理器取数令牌（递增序——迟到的旧面板不覆盖新页签的取数，answerToken 同律） */
  let monitorToken = 0;
  /** 确认/回执视图载荷（/shutdown 恒杀全家二次确认 + 管理面回执/两段式第二段共用原语） */
  let confirmPane:
    | {
        readonly title: string;
        readonly lines: readonly string[];
        /** 确认动作标签（在场 = Enter 执行 run；缺席 = 只读回执——任意键返回） */
        readonly confirmLabel?: string;
        readonly run?: () => void | Promise<void>;
        /**
         * 回视槽（OS 三大管理面研究刀四——冷读裁决 C2）：confirm 链退出的目标
         * 视图；缺省 = 'desktop'（既有消费面零改动）。monitor 发起的回执链回
         * monitor 视图（管理动作看结果后继续管理，不弹回桌面重走 /monitor）。
         */
        readonly backTo?: 'desktop' | 'monitor';
      }
    | undefined;
  /** 引导视图载荷（首启凭证引导——批 E 起助手在场走助手指路面，真文案与应答同源） */
  let guidePane: { readonly lines: readonly string[] } | undefined;
  /** 应答卡载荷（无前缀文本默认应答——问句标题 + 应答行；异步应答到位即换装） */
  let answerPane: { readonly title: string; readonly lines: readonly string[] } | undefined;
  /** 应答异步令牌（递增序——迟到的旧应答不覆盖新问的占位卡，竞速防串卡） */
  let answerToken = 0;
  /** 补参输入视图载荷（配置 patch / 挂载目标——桌面内嵌输入，非命令行） */
  let promptPane:
    { readonly title: string; readonly hint: string; readonly onSubmit: (text: string) => void } | undefined;
  /** 单行提示（命令回执/拒因——单键生命周期：下一次输入即清） */
  let notice: string | undefined;
  /** 命令输入框（跨树重建持状态——单实例嵌入每次新建的树） */
  const input = new SingleLineInput({ prompt: '> ', focused: true });
  /** 起屏旗标（start 后置位；dispose 终退清面） */
  let started = false;
  let disposed = false;
  /** 时钟刷新定时器句柄（null = 未武装） */
  let clockHandle: unknown = null;
  /** 状态面驱动旗标（status 在场 = 聚合器 1s tick 驱动顶栏，占位时钟停用） */
  const statusDriven = deps.status !== undefined;
  /** 状态值变订阅注销器（start 装 / dispose 摘） */
  let unsubscribeStatus: (() => void) | undefined;

  /* ---------------- 清单投影（活取值——建树时重取，无第二账本） ---------------- */
  /** 当前分组过滤后的清单（装载序即呈现序） */
  function projected(): readonly DesktopAppEntry[] {
    const all = deps.listApps();
    return groupFilter === 'all' ? all : all.filter((entry) => entry.group === groupFilter);
  }

  /** 清单光标所在条目（光标越界钳制后取；空清单 undefined） */
  function currentApp(): DesktopAppEntry | undefined {
    const list = projected();
    if (list.length === 0) return undefined;
    cursor = Math.min(cursor, list.length - 1);
    return list[cursor];
  }

  /* ---------------- 渲染树构建（每次交互整树重建——组件无状态，引擎差分收帧） ---------------- */
  /** 清单行文本（▸ = 光标；〔默认〕= 默认解析位；不可进入附说明） */
  function appRowText(entry: DesktopAppEntry, isCursor: boolean): string {
    const marker = isCursor ? '▸ ' : '  ';
    const def = entry.isDefault === true ? '〔默认〕' : '';
    const note = entry.note === undefined ? (entry.openable ? '' : ' — 不可进入') : ` — ${entry.note}`;
    return `${marker}${entry.label}（${entry.id}）${def}${note}`;
  }

  /** desktop 视图主体：顶栏五槽位 + 警示槽 + 页签 + 清单（Flex 吸余量）+ 提示行 + 输入框 + 键位行 */
  function buildDesktopTree(): Renderable {
    const list = projected();
    if (list.length > 0) cursor = Math.min(cursor, list.length - 1);
    const rows: Renderable[] = list.map((entry, index) =>
      index === cursor
        ? new Text({ content: appRowText(entry, true), style: { reverse: true } })
        : new Text({ content: appRowText(entry, false) }),
    );
    if (list.length === 0) {
      rows.push(
        new Text({
          content: ` （${GROUP_LABELS[groupFilter]}分组无应用——←→ 切换；/apps 装机后重进）`,
          style: { dim: true },
        }),
      );
    }
    // 凭证警示槽（首启引导闭环——恒显红条直至凭证配置；批 E 系统助手接管前真文案在屏）
    const issue = deps.status?.snapshot()?.credentialIssue;
    return new Column({
      children: [
        // 顶栏（骨架篇 §1.2 五槽位）：品牌 + 时间/CPU/内存/后台/应用——聚合器活取值；
        // status 缺席回落占位时钟（批 C 形态——熔断回锁/服务缺场不假死）
        new Text({ content: topBarText(), style: { bold: true } }),
        ...(issue === undefined
          ? []
          : [
              new Text({
                content: ` ⚠ 凭证未配置（${issue.provider}）——/guide 进引导`,
                style: { fg: 1, bold: true },
              }),
            ]),
        new Text({ content: groupTabLine(groupFilter) }),
        // 清单主体（Flex 吸收全部余量；溢出底部截断——批 D 再上滚动视口）
        new Flex({ child: new Column({ children: rows }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        input,
        new Text({ content: ' ↑↓ 选择 · Enter 打开 · m 菜单 · /exit 退出', style: { dim: true } }),
      ],
    });
  }

  /** 顶栏状态行（五槽位单行拼接；status 缺席 = 占位时钟回落——两形态同高度） */
  function topBarText(): string {
    const snap = deps.status?.snapshot();
    if (snap === undefined) {
      return ` Berry 桌面${' '.repeat(8)}${formatClock(timing.now())}`;
    }
    return (
      ` Berry 桌面 · ${snap.time} · CPU ${snap.cpuPercent}% · 内存 ${snap.memoryPercent}%` +
      ` · 后台 ${snap.backgroundJobs} · 应用 ${snap.installedApps}`
    );
  }

  /** menu 视图主体（目标应用 + 菜单项清单——栈式替换整树换装） */
  function buildMenuTree(): Renderable {
    const app = currentApp();
    const items: Renderable[] = MENU_ITEMS.map((item, index) =>
      index === menuCursor
        ? new Text({ content: ` ▸ ${item}`, style: { reverse: true } })
        : new Text({ content: `   ${item}` }),
    );
    return new Column({
      children: [
        new Text({ content: ' Berry 桌面 — 应用菜单', style: { bold: true } }),
        new Text({ content: app === undefined ? ' （无选中应用）' : ` ${app.label}（${app.id}）` }),
        new Flex({ child: new Column({ children: items }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        new Text({ content: ' ↑↓ 选择 · Enter 执行 · Esc 返回', style: { dim: true } }),
      ],
    });
  }

  /** detail 视图主体（清单投影的只读披露——零新管理逻辑） */
  function buildDetailTree(): Renderable {
    const app = detailApp;
    const lines: Renderable[] =
      app === undefined
        ? []
        : [
            new Text({ content: ` id：${app.id}` }),
            new Text({ content: ` 名称：${app.label}` }),
            new Text({ content: ` 分组：${GROUP_LABELS[app.group]}` }),
            new Text({
              content: ` 可进入：${app.openable ? '是' : '否'}${app.note === undefined ? '' : `（${app.note}）`}`,
            }),
            new Text({ content: ` 默认位：${app.isDefault === true ? '是' : '否'}` }),
          ];
    return new Column({
      children: [
        new Text({ content: ' Berry 桌面 — 应用详情', style: { bold: true } }),
        new Flex({ child: new Column({ children: lines }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        new Text({ content: ' 管理动作经菜单（m）：配置/卸载/卸挂载/挂载 · Esc 返回', style: { dim: true } }),
      ],
    });
  }

  /** confirm 视图主体（二次确认与回执共用原语：确认键在场 = Enter 执行/Esc 取消；缺席 = 只读回执任意键返回） */
  function buildConfirmTree(): Renderable {
    const pane = confirmPane;
    const lines: Renderable[] =
      pane === undefined
        ? [new Text({ content: ' （空回执——异常态，Esc 返回）', style: { dim: true } })]
        : [
            new Text({ content: ` ${pane.title}`, style: { bold: true } }),
            ...pane.lines.map((line) => new Text({ content: ` ${line}` })),
          ];
    return new Column({
      children: [
        new Text({ content: ' Berry 桌面', style: { bold: true } }),
        new Flex({ child: new Column({ children: lines }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        new Text({
          content:
            pane?.run !== undefined || pane?.confirmLabel !== undefined
              ? ` Enter ${pane.confirmLabel ?? '确认'} · Esc 取消`
              : ' 任意键返回',
          style: { dim: true },
        }),
      ],
    });
  }

  /** guide 视图主体（首启凭证引导——guidance 真文案 + 指路；批 E 系统助手接手前的真文案面） */
  function buildGuideTree(): Renderable {
    const lines: Renderable[] = (guidePane?.lines ?? [' （无引导内容）']).map(
      (line) => new Text({ content: ` ${line}` }),
    );
    return new Column({
      children: [
        new Text({ content: ' Berry 桌面 — 首启引导', style: { bold: true } }),
        new Flex({ child: new Column({ children: lines }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        new Text({ content: ' Esc 返回桌面（引导不阻塞使用——桌面照常可操作）', style: { dim: true } }),
      ],
    });
  }

  /** prompt 视图主体（管理补参输入：配置 patch / 挂载目标——标题 + 说明 + 内嵌输入框） */
  function buildPromptTree(): Renderable {
    return new Column({
      children: [
        new Text({ content: ` ${promptPane?.title ?? '输入'}`, style: { bold: true } }),
        new Text({ content: ` ${promptPane?.hint ?? ''}`, style: { dim: true } }),
        new Flex({ child: new Column({ children: [] }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        input,
        new Text({ content: ' Enter 提交 · Esc 取消', style: { dim: true } }),
      ],
    });
  }

  /** answer 视图主体（系统助手应答卡：问句标题 + 应答行——占位/缺席帮助同卡呈现） */
  function buildAnswerTree(): Renderable {
    const lines: Renderable[] = (answerPane?.lines ?? [' （无应答内容——异常态，Esc 返回）']).map(
      (line) => new Text({ content: ` ${line}` }),
    );
    return new Column({
      children: [
        new Text({ content: ` ${answerPane?.title ?? '系统助手'}`, style: { bold: true } }),
        new Flex({ child: new Column({ children: lines }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        new Text({ content: ' Esc 返回桌面（继续提问：回桌面再输，无前缀即问）', style: { dim: true } }),
      ],
    });
  }

  /** store 视图主体（三市场 tab + 条目清单——状态活取自 store 服务面 catalog()；包损坏时错误行呈现不炸壳） */
  function buildStoreTree(): Renderable {
    const face = deps.store?.();
    const rows: Renderable[] = [];
    if (face === undefined) {
      rows.push(
        new Text({ content: ' 应用商店行不在场（被禁用或未装载）——/apps-toggle store 装回', style: { dim: true } }),
      );
    } else {
      let catalog: ReturnType<StoreService['catalog']> | undefined;
      try {
        catalog = face.catalog();
      } catch (err) {
        rows.push(
          new Text({ content: ` 精选清单损坏：${err instanceof Error ? err.message : String(err)}`, style: { fg: 1 } }),
        );
      }
      if (catalog !== undefined) {
        const listings = storeListings(catalog);
        if (listings.length > 0) storeCursor = Math.min(storeCursor, listings.length - 1);
        rows.push(
          ...listings.map((row, index) =>
            index === storeCursor
              ? new Text({ content: `▸ ${row}`, style: { reverse: true } })
              : new Text({ content: `  ${row}` }),
          ),
        );
        if (listings.length === 0) {
          rows.push(new Text({ content: ` （${STORE_TAB_LABELS[storeTab]}市场暂无条目）`, style: { dim: true } }));
        }
      }
    }
    return new Column({
      children: [
        new Text({ content: ' Berry 桌面 — 应用商店（内置精选·已审）', style: { bold: true } }),
        new Text({ content: storeTabLine() }),
        new Flex({ child: new Column({ children: rows }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        new Text({ content: ' ←→ 切市场 · ↑↓ 选择 · Enter 动作 · Esc 返回', style: { dim: true } }),
      ],
    });
  }

  /** sessions 视图主体（五件面呈现：清单〔搜索过滤〕+ 光标条目预览 + 动作提示） */
  function buildSessionsTree(): Renderable {
    const face = deps.sessions;
    const rows: Renderable[] = [];
    if (face === undefined) {
      rows.push(new Text({ content: ' 切换器面未接线（宿主未注入 sessions 面）', style: { dim: true } }));
    } else {
      const entries = sessionsEntries(face);
      if (entries.length > 0) sessionsCursor = Math.min(sessionsCursor, entries.length - 1);
      rows.push(
        ...entries.map((entry, index) =>
          index === sessionsCursor
            ? new Text({ content: `▸ ${sessionRowText(entry)}`, style: { reverse: true } })
            : new Text({ content: `  ${sessionRowText(entry)}` }),
        ),
      );
      if (entries.length === 0) {
        rows.push(
          new Text({
            content:
              sessionsQuery === undefined
                ? ' （无会话——n 开新）'
                : ` 「${sessionsQuery}」无命中（s 重搜 / 空提交清除）`,
            style: { dim: true },
          }),
        );
      }
    }
    // 光标条目预览（首末消息——deriveMessages 投影单源，壳只呈现）
    const current = face === undefined ? undefined : sessionsEntries(face)[sessionsCursor];
    const preview =
      current !== undefined && face !== undefined
        ? (() => {
            try {
              return face.preview(current.id);
            } catch {
              return undefined;
            }
          })()
        : undefined;
    const previewLines: Renderable[] =
      current === undefined
        ? []
        : [
            new Text({ content: ` ─ 预览（${current.label}）`, style: { dim: true } }),
            new Text({ content: ` 首：${preview?.first ?? '（无消息）'}` }),
            new Text({ content: ` 末：${preview?.last ?? '（无消息）'}` }),
          ];
    return new Column({
      children: [
        new Text({ content: ' Berry 桌面 — 会话', style: { bold: true } }),
        new Text({
          content: sessionsQuery === undefined ? ' 全部会话（registry 在册 ∪ 近史）' : ` 搜索「${sessionsQuery}」`,
        }),
        new Flex({ child: new Column({ children: rows }) }),
        ...previewLines,
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        new Text({ content: ' ↑↓ 选择 · Enter 续接 · c 关闭 · n 开新 · s 搜索 · Esc 返回', style: { dim: true } }),
      ],
    });
  }

  /** monitor 视图主体（三页签 + 面板行——数据组装全在 desktop-monitor 服务面，壳只呈现与选行） */
  function buildMonitorTree(): Renderable {
    const rows: Renderable[] = [];
    if (deps.monitor === undefined) {
      rows.push(new Text({ content: ' 管理器面未接线（宿主未注入 monitor 面）', style: { dim: true } }));
    } else if (monitorPanel === undefined) {
      rows.push(new Text({ content: ' 取数中…', style: { dim: true } }));
    } else {
      const current = currentMonitorItem();
      rows.push(
        ...monitorPanel.rows.map((row) =>
          current !== undefined &&
          row.item !== undefined &&
          row.item.key === current.key &&
          row.item.kind === current.kind
            ? new Text({ content: `▸ ${row.text}`, style: { reverse: true } })
            : new Text({ content: `  ${row.text}` }),
        ),
      );
    }
    return new Column({
      children: [
        new Text({ content: monitorPanel?.title ?? 'Berry 桌面 — 管理器', style: { bold: true } }),
        new Text({ content: monitorTabLine() }),
        new Flex({ child: new Column({ children: rows }) }),
        ...(notice === undefined ? [] : [new Text({ content: ` ${notice}`, style: { dim: true } })]),
        new Text({ content: monitorHintLine(), style: { dim: true } }),
      ],
    });
  }

  /** 按当前视图建树并请求重绘（挂起态 requestRender 静默短路——回桌面后 resume 补帧） */
  function rerender(): void {
    const tree =
      view === 'menu'
        ? buildMenuTree()
        : view === 'detail'
          ? buildDetailTree()
          : view === 'confirm'
            ? buildConfirmTree()
            : view === 'guide'
              ? buildGuideTree()
              : view === 'prompt'
                ? buildPromptTree()
                : view === 'answer'
                  ? buildAnswerTree()
                  : view === 'store'
                    ? buildStoreTree()
                    : view === 'sessions'
                      ? buildSessionsTree()
                      : view === 'monitor'
                        ? buildMonitorTree()
                        : buildDesktopTree();
    engine.setRoot(tree);
  }

  /* ---------------- 时钟/状态定时器（顶栏活性的两驱动源；挂起/终退态静默） ---------------- */
  /**
   * 状态活性切换（start/resume 装、suspend/dispose 摘——聚合器 1s tick 与占位
   * 时钟互斥：statusDriven 时占位时钟永不武装，聚合器挂起期停表不空转）。
   */
  function startStatusClock(): void {
    if (statusDriven) {
      deps.status?.start();
    } else {
      armClock();
    }
  }

  function stopStatusClock(): void {
    deps.status?.stop();
    cancelClock();
  }

  function armClock(): void {
    if (statusDriven || clockHandle !== null || !started) return; // 聚合器驱动期停用占位时钟
    clockHandle = timing.schedule(() => {
      clockHandle = null;
      // 挂起/终退态不重建（引擎短路也无害，此处省一次建树）；运行态重建续排
      if (engine.lifecycle === 'running') {
        rerender();
        armClock();
      }
    }, CLOCK_REFRESH_MS);
  }

  function cancelClock(): void {
    if (clockHandle !== null) {
      timing.cancelSchedule(clockHandle);
      clockHandle = null;
    }
  }

  /* ---------------- 交互动作 ---------------- */
  /** 设单键提示（下一次输入即清；呈现随 rerender） */
  function setNotice(text: string): void {
    notice = text;
  }

  /** 移动清单光标（空清单无操作；越界循环） */
  function moveCursor(step: -1 | 1): void {
    const list = projected();
    if (list.length === 0) return;
    cursor = (cursor + step + list.length) % list.length;
  }

  /** 循环切分组（← → Tab 共用；光标归零） */
  function cycleGroup(step: -1 | 1): void {
    const index = GROUP_FILTERS.indexOf(groupFilter);
    groupFilter = GROUP_FILTERS[(index + step + GROUP_FILTERS.length) % GROUP_FILTERS.length]!;
    cursor = 0;
  }

  /* ---------------- 商店视图取数与投影（状态活取——每次建树重取 catalog） ---------------- */
  /** 商店 tab 页签行（active 方括号标记——分组页签同形） */
  function storeTabLine(): string {
    return (
      ' ' +
      STORE_TABS.map((tab) => (tab === storeTab ? `[${STORE_TAB_LABELS[tab]}]` : STORE_TAB_LABELS[tab])).join(' / ') +
      '（←→ 切换）'
    );
  }

  /** 当前 tab 的清单行文本（呈现行 = 名（人读名）+ 版本/命令提示 + 状态位） */
  function storeListings(catalog: ReturnType<StoreService['catalog']>): readonly string[] {
    if (storeTab === 'skills') {
      return catalog.skills.map(
        (s) =>
          `${s.name}（${s.title}）v${s.version} — ${
            s.payloadReady ? (STORE_SKILL_STATE_LABELS[s.state] ?? s.state) : '载荷缺失（包损坏）'
          }${s.state === 'staged' ? '〔Enter 挂载〕' : s.state === 'mounted' ? '〔Enter 卸载〕' : ''}`,
      );
    }
    if (storeTab === 'mcp') {
      return catalog.mcp.map((m) => `${m.name}（${m.label}）— ${m.configured ? '已添加' : '未添加〔Enter 添加〕'}`);
    }
    return catalog.apps.map(
      (a) =>
        `${a.id}（${a.label}）— ${a.state === 'none' ? '未装〔Enter 安装〕' : a.state === 'installed' ? '已装未挂〔Enter 挂载〕' : '已挂载〔管理经菜单 m〕'}`,
    );
  }

  /** 循环切商店 tab（光标归零——分组切换同律） */
  function cycleStoreTab(step: -1 | 1): void {
    const index = STORE_TABS.indexOf(storeTab);
    storeTab = STORE_TABS[(index + step + STORE_TABS.length) % STORE_TABS.length]!;
    storeCursor = 0;
  }

  /* ---------------- 会话切换器取数与投影（活取——不持第二账本） ---------------- */
  /** 当前清单（搜索词在场走 FTS 过滤；面错误降级全列表 + 提示行） */
  function sessionsEntries(face: DesktopSessionsFace): readonly DesktopSessionEntry[] {
    if (sessionsQuery === undefined) return face.list();
    const result = face.search(sessionsQuery);
    if (!result.ok) {
      setNotice(`搜索不可用：${result.error}`);
      return face.list();
    }
    return result.entries;
  }

  /** 会话行文本（id 截短 8 位 + 应用域 + 标题摘要 + 末活动 + 状态位） */
  function sessionRowText(entry: DesktopSessionEntry): string {
    const state = entry.current ? '★前台' : entry.active ? '活' : '已闭（只读）';
    return `${entry.id.slice(0, 8)} [${entry.label}] ${entry.title}${entry.updatedAt === undefined ? '' : `（${entry.updatedAt}）`} — ${state}`;
  }

  /**
   * 进应用视图的换防共舞（契约 §6.11 序的壳侧执法——openApp 与切换器续接/开新
   * 三入口共用）：引擎 suspend 三件套交出 TTY → 顶栏活性停 → 宿主 pi-tui 起屏；
   * 起屏失败回滚桌面（resume 备屏重进 + 全量首帧 + 提示行）。
   */
  function handoffToAppView(): void {
    engine.suspend();
    stopStatusClock(); // 顶栏活性停（挂起期零轮询零帧）
    try {
      deps.enterAppView();
    } catch (err) {
      // pi-tui 起屏失败：回滚桌面（resume 备屏重进 + 全量首帧）+ 提示行
      engine.resume();
      startStatusClock();
      setNotice(`应用视图起屏失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 打开应用（换防序：enterApp → 引擎交出 → 宿主起应用视图；失败各自回执） */
  function openApp(app: DesktopAppEntry | undefined): void {
    if (app === undefined) return;
    if (!app.openable) {
      setNotice(app.note ?? '此应用暂不可进入');
      return;
    }
    // 桌面内置视图分流（批 F）：desktopView 行（store）Enter 进桌面内置视图而非
    // enterApp——清单行只是入口皮，真身是行 provide 的服务面
    if (app.desktopView === 'store') {
      openStore();
      return;
    }
    const result = deps.enterApp(app.id);
    if (!result.ok) {
      setNotice(`进入失败：${result.error}`);
      return;
    }
    handoffToAppView();
  }

  /* ---------------- 商店视图动作（回执链走 applyAdminResult——管理面共用原语） ---------------- */
  /** 开商店视图（/store 命令与清单 store 行 Enter 共用入口；行不在场诚实拒） */
  function openStore(): void {
    if (deps.store === undefined || deps.store() === undefined) {
      setNotice('应用商店行不在场（被禁用或未装载）——/apps-toggle store 装回');
      return;
    }
    storeTab = 'skills';
    storeCursor = 0;
    view = 'store';
  }

  /** 商店动作失败收口（回商店视图 + 诚实转述——adminFailure 同律） */
  function storeFailure(err: unknown, what: string): void {
    view = 'store';
    setNotice(`${what}失败：${err instanceof Error ? err.message : String(err)}`);
    rerender();
  }

  /** 执行商店条目动作（Enter——按 tab 与装机状态分派；回执/两段式全走 applyAdminResult） */
  function runStoreAction(): void {
    const face = deps.store?.();
    if (face === undefined) {
      setNotice('应用商店行不在场（被禁用或未装载）');
      return;
    }
    let catalog: ReturnType<StoreService['catalog']>;
    try {
      catalog = face.catalog();
    } catch (err) {
      setNotice(`精选清单损坏：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const listings = storeListings(catalog);
    if (listings.length === 0) return;
    storeCursor = Math.min(storeCursor, listings.length - 1);
    if (storeTab === 'skills') {
      const entry = catalog.skills[storeCursor];
      if (entry === undefined) return;
      // 按状态分派：未装 → 安装检视（两段式）；已装机 → 挂载；已挂载 → 卸载检视
      // （两段式三清）；user-owned → inspect 自拒（服务面单源判）
      const action =
        entry.state === 'staged'
          ? face.mountSkill(entry.name)
          : entry.state === 'mounted'
            ? Promise.resolve(face.skillUninstallInspect(entry.name))
            : Promise.resolve(face.skillInstallInspect(entry.name));
      view = 'confirm';
      confirmPane = { title: '商店动作执行中…', lines: ['执行中…'] };
      void action.then((result) => applyAdminResult(result)).catch((err: unknown) => storeFailure(err, '商店动作'));
      return;
    }
    if (storeTab === 'mcp') {
      const entry = catalog.mcp[storeCursor];
      if (entry === undefined) return;
      if (entry.configured) {
        // 移除是可逆但需重输命令的动作——过 confirm 原语（不静默删）；回执经
        // applyAdminResult 落 confirm 视图（confirm.run 恒 void——结果自管）
        confirmPane = {
          title: `移除 MCP 服务器 ${entry.name}？`,
          lines: [`  ${entry.description}`, '', 'config.servers 键删除（既有其他服务器保留）；/reload 后生效。'],
          confirmLabel: '确认移除',
          run: () => {
            void face
              .removeMcpServer(entry.name)
              .then((result) => applyAdminResult(result))
              .catch((err: unknown) => storeFailure(err, '移除 MCP'));
          },
        };
        view = 'confirm';
        rerender();
        return;
      }
      // 添加需补参（绝对路径启动命令——v1 不认 npx/相对路径）：prompt 视图
      promptPane = {
        title: `添加 MCP 服务器 ${entry.name}（${entry.label}）`,
        hint: `输入启动命令（首个词须可执行文件绝对路径，空格分隔 args）· 参考：${entry.commandHint} · Enter 提交 · Esc 取消`,
        onSubmit: (text) =>
          submitStore(text, (t) => {
            const parts = t.split(/\s+/).filter(Boolean);
            return face.addMcpServer(entry.name, parts[0] ?? '', parts.slice(1));
          }),
      };
      view = 'prompt';
      return;
    }
    // apps tab
    const entry = catalog.apps[storeCursor];
    if (entry === undefined) return;
    if (entry.state === 'none') {
      // 两段式第一段：安装确认披露（provenance + 两态说明）
      applyAdminResult(face.appInstallInspect(entry.id));
      return;
    }
    if (entry.state === 'installed') {
      // 已装未挂 → 挂载补参（目标应用 id——prompt 视图，挂载目标先例同形）
      promptPane = {
        title: `挂载应用 ${entry.label}（${entry.id}）`,
        hint: '输入挂载目标应用 id（逗号分隔多个 = 共享件；缺省建议 chat）· Enter 提交 · Esc 取消',
        onSubmit: (text) => submitStore(text, (t) => face.mountApp(entry.id, t.split(/[,，\s]+/).filter(Boolean))),
      };
      view = 'prompt';
      return;
    }
    // 已挂载：卸载/卸挂载走应用管理面单源（菜单 m——商店不做第二管理入口）
    setNotice('已挂载——卸载/卸挂载经应用菜单（m）管理面（单源）');
  }

  /** 商店补参提交（prompt 视图 onSubmit 落点——空输入拒；回执链 applyAdminResult） */
  function submitStore(text: string, call: (t: string) => Promise<DesktopAdminResult>): void {
    if (text === '') {
      view = 'store';
      setNotice('空输入——未执行');
      rerender();
      return;
    }
    confirmPane = { title: '商店动作执行中…', lines: ['执行中…'] };
    view = 'confirm';
    void Promise.resolve(call(text))
      .then((result) => applyAdminResult(result))
      .catch((err: unknown) => storeFailure(err, '商店动作'));
    rerender();
  }

  /* ---------------- 会话切换器动作（五件面的动词半边——面缺席诚实拒） ---------------- */
  /** 开切换器视图（/sessions 命令入口——桌面级；应用内 chat 的 /sessions 既有面不动） */
  function openSessions(): void {
    if (deps.sessions === undefined) {
      setNotice('会话切换器未接线（宿主未注入 sessions 面）');
      return;
    }
    sessionsQuery = undefined;
    sessionsCursor = 0;
    view = 'sessions';
  }

  /** 切换器光标条目（空清单/越界钳制后取） */
  function currentSession(): DesktopSessionEntry | undefined {
    const face = deps.sessions;
    if (face === undefined) return undefined;
    const entries = sessionsEntries(face);
    if (entries.length === 0) return undefined;
    sessionsCursor = Math.min(sessionsCursor, entries.length - 1);
    return entries[sessionsCursor];
  }

  /** 续接光标会话（Enter——registry.open({resume}) 单源 + 换防共舞进应用视图） */
  function resumeSession(): void {
    const face = deps.sessions;
    const entry = currentSession();
    if (face === undefined || entry === undefined) return;
    const result = face.resume(entry.id);
    if (!result.ok) {
      setNotice(`续接失败：${result.error}`);
      return;
    }
    handoffToAppView();
  }

  /** 关闭光标会话（c——停摆可读不可写；过 confirm 原语不静默关） */
  function closeSession(): void {
    const face = deps.sessions;
    const entry = currentSession();
    if (face === undefined || entry === undefined) return;
    confirmPane = {
      title: `关闭会话 ${entry.id.slice(0, 8)}（${entry.label}）？`,
      lines: [
        `  标题：${entry.title}`,
        '',
        '关闭 = 停摆（本进程内只读不可写；预览仍可见）——不删任何会话数据，',
        '重启后可经近史清单正常续接。',
      ],
      confirmLabel: '确认关闭',
      run: () => {
        // close 是同步面——结果即算即落（confirm.run 恒 void，回执自管）
        const result = face.close(entry.id);
        if (!result.ok) {
          applyAdminResult(`关闭失败：${result.error}`);
          return;
        }
        sessionsCursor = 0;
        applyAdminResult({
          title: `已关闭会话 ${entry.id.slice(0, 8)}`,
          lines: ['  已停摆（只读）——清单即见状态翻已闭'],
        });
      },
    };
    view = 'confirm';
    rerender();
  }

  /** 开新会话（n——默认应用域 enterApp 单源 + 换防共舞） */
  function openNewSession(): void {
    const face = deps.sessions;
    if (face === undefined) return;
    const result = face.openNew();
    if (!result.ok) {
      setNotice(`开新失败：${result.error}`);
      return;
    }
    handoffToAppView();
  }

  /** 搜索会话（s——prompt 视图补参；空提交 = 清除搜索回全列表） */
  function searchSessions(): void {
    promptPane = {
      title: '搜索会话',
      hint: '输入关键词（session_fts 全文检索）· Enter 搜索 · 空提交清除搜索 · Esc 取消',
      onSubmit: (text) => {
        sessionsQuery = text === '' ? undefined : text;
        sessionsCursor = 0;
        view = 'sessions';
        rerender();
      },
    };
    view = 'prompt';
  }

  /* ---------------- 统一管理器动作（刀四三页签的交互半边——面缺席诚实拒） ---------------- */
  /** 页签序与标签（呈现定序——spec §1.2 proc|jobs|mem） */
  const MONITOR_TABS: readonly MonitorTab[] = ['proc', 'jobs', 'mem'];
  const MONITOR_TAB_LABELS: Readonly<Record<MonitorTab, string>> = { proc: '进程', jobs: '任务', mem: '内存' };

  /** 页签行（active 方括号标记——store/sessions 分组页签同形） */
  function monitorTabLine(): string {
    return (
      ' ' +
      MONITOR_TABS.map((tab) => (tab === monitorTab ? `[${MONITOR_TAB_LABELS[tab]}]` : MONITOR_TAB_LABELS[tab])).join(
        ' / ',
      ) +
      '（←→ 切换）'
    );
  }

  /** 键位提示行（页签各有各的动词面——Job 取消只住 proc，tick 动词只住 jobs，记忆动词只住 mem） */
  function monitorHintLine(): string {
    if (monitorTab === 'proc') return ' ↑↓ 选择 · k 取消 Job · r 全量 reload · Esc 返回';
    if (monitorTab === 'jobs') return ' ↑↓ 选择 · e OS 注册 · d 注销 · n 立即运行 · Esc 返回';
    return ' ↑↓ 选择 · f 冻结/解冻 · x 忘掉 · v 恢复 · e 导出 · Esc 返回';
  }

  /** 面板动作行集（item 行——光标只寻址动作行，仪表行不占位） */
  function monitorItemsOf(panel: MonitorPanel): readonly MonitorItem[] {
    return panel.rows.flatMap((row) => (row.item === undefined ? [] : [row.item]));
  }

  /** 光标动作行（空面板/无动作行 undefined；越界钳制后取） */
  function currentMonitorItem(): MonitorItem | undefined {
    if (monitorPanel === undefined) return undefined;
    const items = monitorItemsOf(monitorPanel);
    if (items.length === 0) return undefined;
    monitorCursor = Math.min(monitorCursor, items.length - 1);
    return items[monitorCursor];
  }

  /** 移动管理器光标（空面板无操作；越界循环） */
  function moveMonitorCursor(step: -1 | 1): void {
    if (monitorPanel === undefined) return;
    const items = monitorItemsOf(monitorPanel);
    if (items.length === 0) return;
    monitorCursor = (monitorCursor + step + items.length) % items.length;
  }

  /** 循环切页签（光标归零 + 重取数——分组切换同律） */
  function cycleMonitorTab(step: -1 | 1): void {
    const index = MONITOR_TABS.indexOf(monitorTab);
    monitorTab = MONITOR_TABS[(index + step + MONITOR_TABS.length) % MONITOR_TABS.length]!;
    monitorCursor = 0;
    refreshMonitor();
  }

  /** 开管理器视图（/monitor 命令入口；直达参数已解析成 tab） */
  function openMonitor(tab: MonitorTab = 'proc'): void {
    if (deps.monitor === undefined) {
      setNotice('管理器面未接线（宿主未注入 monitor 面）');
      return;
    }
    monitorTab = tab;
    monitorCursor = 0;
    view = 'monitor';
    refreshMonitor();
  }

  /** 重取面板（建树活取零订阅——spec 冷读裁决 C3；令牌拦迟到旧帧防串页签） */
  function refreshMonitor(): void {
    const face = deps.monitor;
    if (face === undefined) return;
    const token = ++monitorToken;
    monitorPanel = undefined; // 取数中占位（换页签/动作后旧帧不留屏）
    rerender();
    void face
      .panel(monitorTab)
      .then((panel) => {
        if (token !== monitorToken) return; // 迟到旧帧丢弃（页签已切/动作已重取）
        monitorPanel = panel;
        rerender();
      })
      .catch((err: unknown) => {
        if (token !== monitorToken) return;
        monitorPanel = {
          title: 'Berry 桌面 — 管理器',
          rows: [{ text: ` 取数失败：${err instanceof Error ? err.message : String(err)}` }],
        };
        rerender();
      });
  }

  /** 管理器结果落视图（string 单行 = notice 回 monitor；多行/receipt = confirm 只读回执链回 monitor——C2 回视槽） */
  function applyMonitorResult(result: MonitorResult): void {
    if (typeof result === 'string') {
      if (result.includes('\n')) {
        confirmPane = { title: '管理动作回执', lines: result.split('\n'), backTo: 'monitor' };
        view = 'confirm';
      } else {
        view = 'monitor';
        setNotice(result);
      }
    } else {
      confirmPane = { title: result.title, lines: result.lines, backTo: 'monitor' };
      view = 'confirm';
    }
    refreshMonitor(); // 动作后重取面板（计数/清单即时反映新态）
  }

  /** 执行管理器异步动词（busy 占位防双发；回执链 applyMonitorResult——失败回 monitor 转述） */
  function runMonitorAction(call: () => Promise<MonitorResult>): void {
    confirmPane = { title: '管理动作执行中…', lines: ['执行中…'], backTo: 'monitor' };
    view = 'confirm';
    void call()
      .then((result) => applyMonitorResult(result))
      .catch((err: unknown) => {
        view = 'monitor';
        setNotice(`管理动作失败：${err instanceof Error ? err.message : String(err)}`);
        rerender();
      });
  }

  /** 忘掉记忆（x——唯一过 confirm 的管理动词：软删可逆但需显式确认；run 自管回执链） */
  function forgetMemory(item: MonitorItem): void {
    const face = deps.monitor;
    if (face === undefined) return;
    confirmPane = {
      title: `忘掉记忆 ${item.label}？`,
      lines: [`  ${item.label}（${item.key.slice(0, 8)}）`, '', '忘掉 = 软删（v 可恢复）；版本链与访问流水留档。'],
      confirmLabel: '确认忘掉',
      backTo: 'monitor',
      run: () => {
        void face
          .memoryForget(item.key)
          .then((result) => applyMonitorResult(result))
          .catch((err: unknown) => {
            view = 'monitor';
            setNotice(`忘掉失败：${err instanceof Error ? err.message : String(err)}`);
            rerender();
          });
      },
    };
    view = 'confirm';
  }

  /** 提交命令输入（/ 前缀命令面；空提交忽略） */
  function submitInput(): void {
    const text = input.text.trim();
    input.clear();
    input.setPreedit(null);
    if (text === '') return;
    if (!text.startsWith('/')) {
      // 无 / 前缀文本 = 询问系统助手（批 E 默认应答者——取代批 C「未知输入」占位提示）
      askAssistant(text);
      return;
    }
    const head = text.split(/\s+/)[0]!;
    switch (head) {
      case '/exit':
        deps.requestExit();
        return;
      case '/shutdown':
      case '/reboot': {
        // 恒杀全家动词（骨架篇 §1.3）：先过 confirm 原语二次确认（确认语单源
        // host-power），Enter 才走宿主 requestPower 单源编舞——一实现两入口
        const action: PowerAction = head === '/shutdown' ? 'shutdown' : 'reboot';
        if (deps.requestPower === undefined) {
          setNotice(`${head} 编舞未接线（宿主未注入 requestPower）——用 /exit 退出`);
          return;
        }
        confirmPane = {
          title: action === 'shutdown' ? '确认关停？' : '确认重启？',
          lines: [
            POWER_KILL_FAMILY_TEXT,
            '',
            action === 'shutdown'
              ? 'Enter 确认关停：本进程收口自退（会话归档走既有优雅退出序列）'
              : 'Enter 确认重启：退出前 spawn 新实例接力',
          ],
          confirmLabel: action === 'shutdown' ? '确认关停' : '确认重启',
          run: () => {
            // UI 确认已过——单源编舞放行（宿主 confirmed 恒 true 语义在此成立）
            void deps.requestPower!(action)
              .then((result) => {
                // 仍在跑 = 编舞拒/接力失败（进程未退）——回桌面 + 转述消息
                if (result.outcome === 'refused' || result.outcome === 'spawn-failed') {
                  view = 'desktop';
                  setNotice(result.message);
                  rerender();
                }
              })
              .catch((err: unknown) => {
                view = 'desktop';
                setNotice(`关停编舞异常：${err instanceof Error ? err.message : String(err)}`);
                rerender();
              });
          },
        };
        view = 'confirm';
        return;
      }
      case '/guide':
        openGuide();
        return;
      case '/desktop':
        view = 'desktop';
        setNotice('已在桌面');
        return;
      case '/store':
        // 商店视图入口（批 F）——命令与清单 store 行 Enter 同一动作函数
        openStore();
        return;
      case '/sessions':
        // 会话切换器入口（批 F 桌面级五件面——应用内 chat 的 /sessions 既有面不动）
        openSessions();
        return;
      case '/monitor': {
        // 统一管理器入口（刀四三页签）：直达参数 /monitor proc|jobs|mem——非法值诚实拒
        const arg = text.slice(head.length).trim();
        if (arg === '') openMonitor();
        else {
          const tab = parseMonitorTabArg(arg);
          if (tab === undefined) setNotice(`未知页签：${arg}（认 proc / jobs / mem）`);
          else openMonitor(tab);
        }
        return;
      }
      default:
        setNotice(`未知命令：${head}（认 ${DESKTOP_COMMANDS.join(' ')}）`);
    }
  }

  /**
   * 无前缀文本默认应答（carve-out 第四条「默认应答者」的壳侧执法点）：
   * - 助手在场：进 answer 卡（占位「询问中…」→ 异步应答到位换装；迟到旧应答
   *   被令牌拦下不串卡，用户已离开则提示行告知不打断）。
   * - 助手缺席（行被 overlay 禁用 / 未装载）：回落帮助文案——命令面照常可用 +
   *   装回指引（无前缀文本不是死路，桌面也不是）。
   */
  function askAssistant(question: string): void {
    const face = deps.assistant?.();
    if (face === undefined) {
      answerPane = { title: '系统助手不在场（行已禁用或未装载）', lines: ASSISTANT_ABSENT_HELP };
      view = 'answer';
      return;
    }
    const token = ++answerToken;
    answerPane = { title: `问：${question}`, lines: ['询问系统助手中…'] };
    view = 'answer';
    void Promise.resolve(face.answer(question)).then(
      (res) => {
        // 令牌匹配 + 仍在本问的应答卡 → 换上应答行；否则提示行告知（不抢当前视图）
        if (token === answerToken && view === 'answer') {
          answerPane = { title: `问：${question}`, lines: res.lines };
        } else if (token === answerToken) {
          setNotice('系统助手已应答（重发问题即可再看）');
        }
        rerender();
      },
      (err: unknown) => {
        // 服务面自身异常（三路判定之外的意外）——诚实转述回桌面
        if (token === answerToken && view === 'answer') {
          answerPane = undefined;
          view = 'desktop';
        }
        setNotice(`系统助手异常：${err instanceof Error ? err.message : String(err)}`);
        rerender();
      },
    );
  }

  /** 开引导视图（首启凭证引导——批 E 起助手在场走助手 guide 面〔与应答同源的
   * 知识面〕；助手缺席回落批 D 形态：文案取状态快照 guidance 同源，禁抄第二份） */
  function openGuide(): void {
    const face = deps.assistant?.();
    if (face !== undefined) {
      guidePane = { lines: [...face.guide()] };
      view = 'guide';
      return;
    }
    const issue = deps.status?.snapshot()?.credentialIssue;
    guidePane =
      issue === undefined
        ? {
            lines: [
              '模型凭证已配置（当前无警示）。',
              '',
              '配置新 provider 的途径见 docs/使用指南.md §2「模型与凭证」。',
            ],
          }
        : {
            lines: [
              '首启引导——模型凭证未配置，对话应用无法发起模型调用。',
              '',
              ...issue.guidance.split('\n'),
              '',
              '配置后重启进程生效（凭证链在 boot 期读取）；引导不阻塞桌面其他使用。',
            ],
          };
    view = 'guide';
  }

  /**
   * 管理面结果落视图（string = 单行提示回桌面；receipt = confirm 视图回执；
   * receipt.confirm 在场 = 两段式第二段——confirm 原语复用，Enter 执行）。
   */
  function applyAdminResult(result: DesktopAdminResult): void {
    if (typeof result === 'string') {
      view = 'desktop';
      setNotice(result);
      rerender();
      return;
    }
    confirmPane = {
      title: result.title,
      lines: result.lines,
      ...(result.confirm === undefined
        ? {}
        : {
            confirmLabel: result.confirm.label,
            run: () => {
              void Promise.resolve(result.confirm!.run())
                .then((next) => applyAdminResult(next))
                .catch((err: unknown) => {
                  view = 'desktop';
                  setNotice(`管理动作失败：${err instanceof Error ? err.message : String(err)}`);
                  rerender();
                });
            },
          }),
    };
    view = 'confirm';
    rerender();
  }

  /** 管理动作失败收口（回桌面 + 诚实转述） */
  function adminFailure(err: unknown, what: string): void {
    view = 'desktop';
    setNotice(`${what}失败：${err instanceof Error ? err.message : String(err)}`);
    rerender();
  }

  /** 管理面在场护栏（缺席 = 诚实拒——宿主未接线不假执行） */
  function requireAdmin(): DesktopAdminFace | undefined {
    if (deps.admin === undefined) {
      setNotice('管理面未接线（宿主未注入 admin 服务）');
      return undefined;
    }
    return deps.admin;
  }

  /** 执行菜单项（打开/详情壳内直实现；管理四项批 D 起接 admin 服务面薄壳——壳零管理逻辑） */
  function runMenuItem(item: (typeof MENU_ITEMS)[number]): void {
    const app = currentApp();
    view = 'desktop'; // 菜单是瞬态视图——执行即回桌面（详情/确认/回执另行换装）
    if (app === undefined) return;
    switch (item) {
      case '打开':
        openApp(app);
        return;
      case '详情':
        detailApp = app;
        view = 'detail';
        return;
      case '配置': {
        const admin = requireAdmin();
        if (admin === undefined) return;
        promptPane = {
          title: `配置「${app.label}（${app.id}）」`,
          hint: '输入 JSON patch（顶层键整值替换，如 {"key":"value"}）· Enter 提交 · Esc 取消',
          onSubmit: (text) => submitAdmin(text, (t) => admin.configure(app.id, t)),
        };
        view = 'prompt';
        return;
      }
      case '卸载': {
        const admin = requireAdmin();
        if (admin === undefined) return;
        // 两段式第一段：检视（inspect 不执行）→ 回执带确认段（Enter 才执行）
        confirmPane = { title: `卸载检视「${app.label}」`, lines: ['检视中…'] };
        view = 'confirm';
        void Promise.resolve(admin.uninstallInspect(app.id))
          .then((result) => applyAdminResult(result))
          .catch((err: unknown) => adminFailure(err, '卸载检视'));
        return;
      }
      case '卸挂载': {
        const admin = requireAdmin();
        if (admin === undefined) return;
        confirmPane = { title: `卸挂载「${app.label}」`, lines: ['执行中…'] };
        view = 'confirm';
        void Promise.resolve(admin.unmount(app.id))
          .then((result) => applyAdminResult(result))
          .catch((err: unknown) => adminFailure(err, '卸挂载'));
        return;
      }
      case '挂载': {
        const admin = requireAdmin();
        if (admin === undefined) return;
        promptPane = {
          title: `挂载「${app.label}（${app.id}）」`,
          hint: '输入挂载目标应用 id（逗号分隔多个 = 共享件）· Enter 提交 · Esc 取消',
          onSubmit: (text) => submitAdmin(text, (t) => admin.mount(app.id, t.split(/[,，\s]+/).filter(Boolean))),
        };
        view = 'prompt';
        return;
      }
    }
  }

  /** 管理补参提交（空输入拒；执行期 confirm 视图占位，回执链走 applyAdminResult） */
  function submitAdmin(text: string, call: (t: string) => Promise<DesktopAdminResult>): void {
    if (text === '') {
      setNotice('空输入——未执行');
      rerender();
      return;
    }
    confirmPane = { title: '管理动作执行中…', lines: ['执行中…'] };
    view = 'confirm';
    void Promise.resolve(call(text))
      .then((result) => applyAdminResult(result))
      .catch((err: unknown) => adminFailure(err, '管理动作'));
    rerender();
  }

  /* ---------------- 输入路由（引擎事件面 → 视图状态机） ---------------- */
  /** 开应用菜单（目标 = 光标条目；空清单提示不换装） */
  function openMenu(): void {
    if (projected().length > 0) {
      menuCursor = 0;
      view = 'menu';
    } else {
      setNotice('清单为空——无菜单目标');
    }
  }

  /** 普通文本入输入框（text/paste/ime 提交/可打印键共用路——仅 desktop 视图收） */
  function insertText(text: string): void {
    if (text.length === 0) return;
    input.insertText(text);
  }

  /** 输入编辑键族（desktop 与 prompt 视图共用：退格/删/行首行尾/可打印单字符） */
  function editKey(event: KeyEvent): boolean {
    const { key, mods } = event;
    switch (key) {
      case 'backspace':
        input.backspace();
        return true;
      case 'delete':
        input.deleteForward();
        return true;
      case 'home':
        input.moveHome();
        return true;
      case 'end':
        input.moveEnd();
        return true;
    }
    // 可打印单字符键（kitty/legacy 双轨差异兜底——部分终端 legacy 轨普通
    // 打字走 key 事件）按文本入框；shift 修饰已并入键名字符
    if (!mods.ctrl && !mods.alt && !mods.meta && key.length === 1) {
      insertText(key);
      return true;
    }
    return false;
  }

  /** 键事件分派（视图族各认各的键；未认键静默） */
  function onKey(event: KeyEvent): void {
    const { key, mods } = event;
    // Ctrl+D = /exit（全视图恒可退——桌面不是牢笼）
    if (mods.ctrl && key === 'd') {
      deps.requestExit();
      return;
    }
    if (view === 'menu') {
      if (key === 'escape') view = 'desktop';
      else if (key === 'up') menuCursor = (menuCursor - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
      else if (key === 'down') menuCursor = (menuCursor + 1) % MENU_ITEMS.length;
      else if (key === 'enter') runMenuItem(MENU_ITEMS[menuCursor]!);
      return; // 菜单期其余键不达输入框
    }
    if (view === 'detail') {
      if (key === 'escape' || key === 'enter' || key === 'm') view = 'desktop';
      return;
    }
    if (view === 'confirm') {
      const pane = confirmPane;
      // 回视槽（刀四冷读裁决 C2）：monitor 发起的链退出回 monitor，缺省回 desktop
      const back = pane?.backTo ?? 'desktop';
      if (key === 'escape') {
        // 取消：不执行（两段式第二段不触达——Esc 是唯一取消面）
        confirmPane = undefined;
        view = back;
        return;
      }
      if (key === 'enter') {
        confirmPane = undefined;
        view = back;
        // 确认执行（run 自管后续视图转换——回执链/失败转述都在其内）
        if (pane?.run !== undefined) {
          void Promise.resolve(pane.run()).catch((err: unknown) => {
            setNotice(`执行失败：${err instanceof Error ? err.message : String(err)}`);
            rerender();
          });
        }
        return;
      }
      if (pane?.run === undefined && pane?.confirmLabel === undefined) {
        // 只读回执：任意键返回
        confirmPane = undefined;
        view = back;
      }
      return; // 有确认动作时非 Enter/Esc 键静默（防误触）
    }
    if (view === 'guide') {
      if (key === 'escape' || key === 'enter' || key === 'g') {
        guidePane = undefined;
        view = 'desktop';
      }
      return;
    }
    if (view === 'answer') {
      // 应答卡是只读呈现面：Esc/Enter 回桌面继续提问（打字不落框——视图无框）
      if (key === 'escape' || key === 'enter') {
        answerPane = undefined;
        view = 'desktop';
      }
      return;
    }
    if (view === 'prompt') {
      if (key === 'escape') {
        promptPane = undefined;
        view = 'desktop';
        input.clear();
        input.setPreedit(null);
        return;
      }
      if (key === 'enter') {
        const pane = promptPane;
        const text = input.text.trim();
        promptPane = undefined;
        view = 'desktop';
        input.clear();
        input.setPreedit(null);
        pane?.onSubmit(text); // onSubmit 自管后续视图（占位/回执/提示）
        return;
      }
      editKey(event); // 补参输入框编辑（可打印/退格/删/行首行尾）
      return;
    }
    if (view === 'store') {
      // 商店视图键位面（批 F）：←→/Tab 切市场照桌面分组切换语义；Enter 按条目
      // 装机状态分派动作（安装/挂载/卸载检视/补参）；Esc 回桌面
      if (key === 'escape') view = 'desktop';
      else if (key === 'left' || key === 'tab') cycleStoreTab(-1);
      else if (key === 'right') cycleStoreTab(1);
      else if (key === 'up' || key === 'down') {
        const face = deps.store?.();
        if (face !== undefined) {
          const count = storeListings(face.catalog()).length;
          if (count > 0) {
            const step = key === 'up' ? -1 : 1;
            storeCursor = (storeCursor + step + count) % count;
          }
        }
      } else if (key === 'enter') runStoreAction();
      return; // 商店期其余键不达输入框
    }
    if (view === 'sessions') {
      // 切换器键位面（批 F 五件面的交互半边）：↑↓ 选 · Enter 续接 · c 关闭 ·
      // n 开新 · s 搜索（FTS）· Esc 回桌面
      if (key === 'escape') view = 'desktop';
      else if (key === 'up' || key === 'down') {
        const face = deps.sessions;
        if (face !== undefined) {
          const count = sessionsEntries(face).length;
          if (count > 0) {
            const step = key === 'up' ? -1 : 1;
            sessionsCursor = (sessionsCursor + step + count) % count;
          }
        }
      } else if (key === 'enter') resumeSession();
      else if (key === 'c' && !mods.ctrl && !mods.alt && !mods.meta) closeSession();
      else if (key === 'n' && !mods.ctrl && !mods.alt && !mods.meta) openNewSession();
      else if (key === 's' && !mods.ctrl && !mods.alt && !mods.meta) searchSessions();
      return; // 切换器期其余键不达输入框
    }
    if (view === 'monitor') {
      // 管理器键位面（刀四三页签）：←→/Tab 切页签（重取数）· ↑↓ 光标（items）·
      // 页签动词各住各页签（Job 取消只住 proc——宾语唯一，冷读裁决 B5；tick
      // 动词只住 jobs；记忆动词只住 mem）· Esc 回桌面。视图无输入框——
      // 全键拦截不落 desktop 命令框
      const plain = !mods.ctrl && !mods.alt && !mods.meta;
      if (key === 'escape') view = 'desktop';
      else if (key === 'left' || key === 'tab') cycleMonitorTab(-1);
      else if (key === 'right') cycleMonitorTab(1);
      else if (key === 'up') moveMonitorCursor(-1);
      else if (key === 'down') moveMonitorCursor(1);
      else if (key === 'r' && plain && monitorTab === 'proc') {
        if (deps.monitor !== undefined) runMonitorAction(() => deps.monitor!.reloadAll());
      } else if (key === 'k' && plain && monitorTab === 'proc') {
        const item = currentMonitorItem();
        if (item !== undefined && deps.monitor !== undefined) runMonitorAction(() => deps.monitor!.cancelJob(item.key));
      } else if (monitorTab === 'jobs') {
        const item = currentMonitorItem();
        if (item !== undefined && deps.monitor !== undefined) {
          if (key === 'e' && plain) runMonitorAction(() => deps.monitor!.tick('enable', item.key));
          else if (key === 'd' && plain) runMonitorAction(() => deps.monitor!.tick('disable', item.key));
          else if (key === 'n' && plain) runMonitorAction(() => deps.monitor!.tick('run', item.key));
        }
      } else if (monitorTab === 'mem') {
        const face = deps.monitor;
        if (face !== undefined) {
          if (key === 'e' && plain) runMonitorAction(() => face.memoryExport());
          else {
            const item = currentMonitorItem();
            if (item !== undefined) {
              if (key === 'f' && plain) runMonitorAction(() => face.memoryToggleFrozen(item.key));
              else if (key === 'v' && plain) runMonitorAction(() => face.memoryRestore(item.key));
              else if (key === 'x' && plain) forgetMemory(item);
            }
          }
        }
      }
      return; // 管理器期其余键不达输入框
    }
    // desktop 视图键位面
    switch (key) {
      case 'up':
        moveCursor(-1);
        return;
      case 'down':
        moveCursor(1);
        return;
      case 'left':
      case 'tab':
        cycleGroup(-1);
        return;
      case 'right':
        cycleGroup(1);
        return;
      case 'enter': {
        // Enter 双语义：输入框有文 → 提交命令；空 → 打开光标应用（桌面主动词——
        // 空回车不是「什么都没提交」而是「打开我选中的」）
        if (input.text.trim() === '') openApp(currentApp());
        else submitInput();
        return;
      }
      case 'escape':
        return; // 提示已在事件入口清——桌面态 Esc 无操作
      case 'm':
        if (!mods.ctrl && !mods.alt && !mods.meta) {
          // 空输入框才当热键（kitty 轨单字符键形态）；输入中有文则当打字入框
          if (input.text === '') openMenu();
          else insertText('m');
        }
        return;
      case 'g':
        if (!mods.ctrl && !mods.alt && !mods.meta) {
          // 引导热键：警示槽在场 + 空输入才触发（首启引导闭环的键盘捷径；
          // 无警示时 g 照常打字——不挡正常输入）
          if (input.text === '' && deps.status?.snapshot()?.credentialIssue !== undefined) openGuide();
          else insertText('g');
        }
        return;
      default:
        editKey(event);
        return;
    }
  }

  /** 引擎输入事件入口（每次输入先清提示——提示是单键生命周期的闪现面） */
  function onEngineInput(event: InputEvent): void {
    notice = undefined;
    // 文本类事件只入两输入视图（desktop 命令框 / prompt 补参框）——confirm/guide
    // 期打字不落框（视图无框，防隐藏输入累积）
    const inputView = view === 'desktop' || view === 'prompt';
    switch (event.kind) {
      case 'key':
        onKey(event);
        break;
      case 'text': {
        // legacy 轨可打印字符走 text 事件（游程合并）——单字符 m 在空输入框时
        // 即菜单热键（命令皆 / 前缀，首字符抢占无碰撞；有文时照常入框）；g 同律
        // 但仅警示在场时抢占（首启引导捷径——判据与 kitty 轨 onKey 'g' 同源）
        if (view === 'desktop' && input.text === '') {
          if (event.text === 'm') {
            openMenu();
            break;
          }
          if (event.text === 'g' && deps.status?.snapshot()?.credentialIssue !== undefined) {
            openGuide();
            break;
          }
        }
        // 管理器视图无输入框：单字符 text 即动词键。两轨的普通可打印字符恒
        // text 事件（kitty CSI-u 文本一致→text；legacy 游程→text）——onKey
        // 的 k/r/e/d/n/f/v/x 分支若无此桥在真终端永不可达（m/g 热键同因走
        // text 分支先例）。多字符游程（快速连打合并）不触发——单字符闸防误触
        if (view === 'monitor' && event.text.length === 1) {
          onKey({ kind: 'key', key: event.text, mods: { ctrl: false, alt: false, shift: false, meta: false } });
          break;
        }
        if (inputView) insertText(event.text);
        break;
      }
      case 'ime':
        if (inputView) {
          if (event.composing) {
            input.setPreedit(event.text);
          } else {
            input.setPreedit(null);
            insertText(event.text);
          }
        }
        break;
      case 'paste':
        if (inputView) insertText(event.text);
        break;
    }
    rerender();
  }

  const detachEngineInput = engine.on('input', onEngineInput);

  /* ---------------- 换防接收侧（DesktopFace 真身） ---------------- */
  /** 回桌面：宿主先还屏（pi-tui 停屏 preserveScreen）再引擎复位（全量首帧） */
  function backToDesktop(): { ok: true } | { ok: false; error: string } {
    if (!started || disposed) return { ok: false, error: '桌面未起屏' };
    // 已在桌面（引擎未挂起）= 幂等空回执：不再触 leaveAppView（pi-tui 未在屏，
    // 停屏无对象）——/desktop 双触发、Esc 与命令竞速共用了这条护栏
    if (!engine.suspended) return { ok: true };
    try {
      deps.leaveAppView();
    } catch (err) {
      return { ok: false, error: `停应用视图失败：${err instanceof Error ? err.message : String(err)}` };
    }
    engine.resume();
    startStatusClock(); // 顶栏活性复起（聚合器续表 / 占位时钟续排）
    rerender();
    return { ok: true };
  }

  const face: DesktopFace = { backToDesktop };

  return {
    get suspended(): boolean {
      return engine.suspended;
    },
    start(): void {
      if (started || disposed) return;
      const tree = buildDesktopTree();
      engine.start(tree);
      started = true;
      deps.service?.attach(face);
      // 状态订阅先装再起表（起表首拍值变即通知——顺序保证首拍不漏）
      if (deps.status !== undefined) {
        unsubscribeStatus = deps.status.onChange(() => rerender());
      }
      try {
        // 同步首帧探针：渲染树异常在此同步上抛（异步首帧失败不可捕获——熔断
        // 计数需要同步可捕获的启动失败）
        engine.renderNow();
        startStatusClock(); // 顶栏活性起（聚合器 1s tick / 占位时钟 30s 二选一）
      } catch (err) {
        // 起屏失败内置收口：摘回接面 + 引擎终退复原终端（可能已进屏——dispose
        // 幂等收口）后原样上抛，由宿主记熔断账
        started = false;
        unsubscribeStatus?.();
        unsubscribeStatus = undefined;
        deps.service?.detach();
        engine.dispose();
        detachEngineInput();
        throw err;
      }
    },
    backToDesktop,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      stopStatusClock(); // 顶栏活性停（聚合器停表 + 占位时钟摘）
      unsubscribeStatus?.(); // 值变订阅摘（壳终退不再吃通知）
      unsubscribeStatus = undefined;
      deps.service?.detach();
      detachEngineInput();
      // 排空 stdin 残留（契约 §6.11 退回 shell 前）——挂起态调用同合法（吞缓冲
      // + pause）；失败不阻塞退出序列
      try {
        await engine.drainInput();
      } catch {
        // 排空尽力而为
      }
      engine.dispose();
    },
  };
}
