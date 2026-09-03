/**
 * L5 app — 桌面壳后端（第八十五批批 C，契约篇 §6.11 换防编舞的壳侧消费面）。
 *
 * 持桌面引擎（src/desktop/ 纯渲染引擎）+ 渲染树，向宿主入口（desktop-main）
 * 呈现 start/dispose 生命周期与换防两动词：
 * - **进应用**（openApp）：先 enterApp（runtime 单源路由）→ 引擎 suspend 三件套
 *   交出 TTY → 宿主 enterAppView（pi-tui 起屏）。起屏失败回滚 resume。
 * - **回桌面**（backToDesktop，即 DesktopFace 真身）：宿主 leaveAppView（pi-tui
 *   stop preserveScreen）→ 引擎 resume 全量首帧重绘。
 * 序的机制单源在引擎（契约 §6.11）；壳只按序调用并管视图状态。
 *
 * 视图三态（栈式替换——单根渲染树整树换装）：desktop（顶栏 + 分组页签 + 应用
 * 清单 + 提示行 + 命令输入框）/ menu（应用菜单：打开/配置/卸载/卸挂载/挂载/详情
 * ——管理四项批 D 接 admin 工具面，本批占位回应不造管理逻辑）/ detail（详情）。
 *
 * 命令前缀（底部 SingleLineInput）：/exit（真退）/shutdown /reboot（批 D 占位）
 * /desktop（回桌面视图）。Ctrl+D = /exit。键位：↑↓ 移动光标、←→/Tab 切分组
 * （全部/官方/第三方）、Enter 打开或提交、m 菜单、Esc 返回。
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
import type { DesktopAppEntry, DesktopFace, DesktopService } from './desktop-service.js';

/** 时序三件注入面（缺省 Date.now/setTimeout/clearTimeout——测试假钟缝合位；与引擎注入面同构） */
export interface ShellTiming {
  /** 时钟（毫秒） */
  readonly now: () => number;
  /** 调度（返回句柄供取消） */
  readonly schedule: (fn: () => void, ms: number) => unknown;
  /** 取消调度（与 schedule 成对） */
  readonly cancelSchedule: (handle: unknown) => void;
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

/** 菜单项（批 C：打开/详情真实现；配置/卸载/卸挂载/挂载占位回应——批 D 接 admin 工具面） */
const MENU_ITEMS = ['打开', '配置', '卸载', '卸挂载', '挂载', '详情'] as const;

/** 顶栏时钟刷新间隔（毫秒——分钟进位粒度，30s 采样足够且省帧） */
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
    ...(deps.io !== undefined ? { io: deps.io } : {}),
    now: timing.now,
    schedule: timing.schedule,
    cancelSchedule: timing.cancelSchedule,
  });

  /* ---------------- 视图状态（单根渲染树整树换装，状态全在壳） ---------------- */
  /** 当前视图（desktop 主面 / menu 应用菜单 / detail 应用详情） */
  let view: 'desktop' | 'menu' | 'detail' = 'desktop';
  /** 分组过滤（desktop 视图） */
  let groupFilter: GroupFilter = 'all';
  /** 清单光标（过滤后投影的下标） */
  let cursor = 0;
  /** 菜单光标（menu 视图） */
  let menuCursor = 0;
  /** 详情目标（detail 视图） */
  let detailApp: DesktopAppEntry | undefined;
  /** 单行提示（命令回执/拒因——单键生命周期：下一次输入即清） */
  let notice: string | undefined;
  /** 命令输入框（跨树重建持状态——单实例嵌入每次新建的树） */
  const input = new SingleLineInput({ prompt: '> ', focused: true });
  /** 起屏旗标（start 后置位；dispose 终退清面） */
  let started = false;
  let disposed = false;
  /** 时钟刷新定时器句柄（null = 未武装） */
  let clockHandle: unknown = null;

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
    const note = entry.note !== undefined ? ` — ${entry.note}` : entry.openable ? '' : ' — 不可进入';
    return `${marker}${entry.label}（${entry.id}）${def}${note}`;
  }

  /** desktop 视图主体：顶栏 + 页签 + 清单（Flex 吸余量）+ 提示行 + 输入框 + 键位行 */
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
    return new Column({
      children: [
        // 顶栏（占位静态文案——批 D 再定信息架构）：品牌 + 时钟
        new Text({ content: ` Berry 桌面${' '.repeat(8)}${formatClock(timing.now())}`, style: { bold: true } }),
        new Text({ content: groupTabLine(groupFilter) }),
        // 清单主体（Flex 吸收全部余量；溢出底部截断——批 D 再上滚动视口）
        new Flex({ child: new Column({ children: rows }) }),
        ...(notice !== undefined ? [new Text({ content: ` ${notice}`, style: { dim: true } })] : []),
        input,
        new Text({ content: ' ↑↓ 选择 · Enter 打开 · m 菜单 · /exit 退出', style: { dim: true } }),
      ],
    });
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
        new Text({ content: app !== undefined ? ` ${app.label}（${app.id}）` : ' （无选中应用）' }),
        new Flex({ child: new Column({ children: items }) }),
        ...(notice !== undefined ? [new Text({ content: ` ${notice}`, style: { dim: true } })] : []),
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
              content: ` 可进入：${app.openable ? '是' : '否'}${app.note !== undefined ? `（${app.note}）` : ''}`,
            }),
            new Text({ content: ` 默认位：${app.isDefault === true ? '是' : '否'}` }),
          ];
    return new Column({
      children: [
        new Text({ content: ' Berry 桌面 — 应用详情', style: { bold: true } }),
        new Flex({ child: new Column({ children: lines }) }),
        ...(notice !== undefined ? [new Text({ content: ` ${notice}`, style: { dim: true } })] : []),
        new Text({ content: ' 管理动作（配置/卸载/挂载族）随批 D 接 admin 工具面 · Esc 返回', style: { dim: true } }),
      ],
    });
  }

  /** 按当前视图建树并请求重绘（挂起态 requestRender 静默短路——回桌面后 resume 补帧） */
  function rerender(): void {
    const tree = view === 'menu' ? buildMenuTree() : view === 'detail' ? buildDetailTree() : buildDesktopTree();
    engine.setRoot(tree);
  }

  /* ---------------- 时钟定时器（顶栏分钟进位；挂起/终退态静默） ---------------- */
  function armClock(): void {
    if (clockHandle !== null || !started) return;
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

  /** 打开应用（换防序：enterApp → 引擎交出 → 宿主起应用视图；失败各自回执） */
  function openApp(app: DesktopAppEntry | undefined): void {
    if (app === undefined) return;
    if (!app.openable) {
      setNotice(app.note ?? '此应用暂不可进入');
      return;
    }
    const result = deps.enterApp(app.id);
    if (!result.ok) {
      setNotice(`进入失败：${result.error}`);
      return;
    }
    // 换防序（契约 §6.11 桌面→应用）：先引擎 suspend 三件套交出 TTY，再 pi-tui
    // 起屏——挂起后残余渲染请求被引擎静默短路，两栈不抢写
    engine.suspend();
    cancelClock();
    try {
      deps.enterAppView();
    } catch (err) {
      // pi-tui 起屏失败：回滚桌面（resume 备屏重进 + 全量首帧）+ 提示行
      engine.resume();
      armClock();
      setNotice(`应用视图起屏失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 提交命令输入（/ 前缀命令面；空提交忽略） */
  function submitInput(): void {
    const text = input.text.trim();
    input.clear();
    input.setPreedit(null);
    if (text === '') return;
    if (!text.startsWith('/')) {
      setNotice('未知输入（桌面只认 / 命令：/exit /shutdown /reboot /desktop）');
      return;
    }
    const head = text.split(/\s+/)[0]!;
    switch (head) {
      case '/exit':
        deps.requestExit();
        return;
      case '/shutdown':
        setNotice('/shutdown 关停编排在批 D 落地（当前用 /exit 优雅退出）');
        return;
      case '/reboot':
        setNotice('/reboot 重启编排在批 D 落地');
        return;
      case '/desktop':
        view = 'desktop';
        setNotice('已在桌面');
        return;
      default:
        setNotice(`未知命令：${head}（认 /exit /shutdown /reboot /desktop）`);
    }
  }

  /** 执行菜单项（打开/详情真实现；管理四项占位回应——批 D 接 admin 工具面） */
  function runMenuItem(item: (typeof MENU_ITEMS)[number]): void {
    const app = currentApp();
    view = 'desktop'; // 菜单是瞬态视图——执行即回桌面（详情另行换装）
    if (app === undefined) return;
    switch (item) {
      case '打开':
        openApp(app);
        return;
      case '详情':
        detailApp = app;
        view = 'detail';
        return;
      case '配置':
        setNotice(`「${app.label}」配置：随批 D 接 admin 工具面（apps configure）`);
        return;
      case '卸载':
        setNotice(`「${app.label}」卸载：随批 D 接 admin 工具面（apps uninstall）`);
        return;
      case '卸挂载':
        setNotice(`「${app.label}」卸挂载：随批 D 接 admin 工具面（apps unmount）`);
        return;
      case '挂载':
        setNotice(`「${app.label}」挂载：随批 D 接 admin 工具面（apps mount）`);
        return;
    }
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

  /** 键事件分派（三视图各认各的键；未认键静默） */
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
        if (input.text.trim() !== '') submitInput();
        else openApp(currentApp());
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
      case 'backspace':
        input.backspace();
        return;
      case 'delete':
        input.deleteForward();
        return;
      case 'home':
        input.moveHome();
        return;
      case 'end':
        input.moveEnd();
        return;
      default:
        // 可打印单字符键（kitty/legacy 双轨差异兜底——部分终端 legacy 轨普通
        // 打字走 key 事件）按文本入框；shift 修饰已并入键名字符
        if (!mods.ctrl && !mods.alt && !mods.meta && key.length === 1) insertText(key);
        return;
    }
  }

  /** 引擎输入事件入口（每次输入先清提示——提示是单键生命周期的闪现面） */
  function onEngineInput(event: InputEvent): void {
    notice = undefined;
    switch (event.kind) {
      case 'key':
        onKey(event);
        break;
      case 'text': {
        // legacy 轨可打印字符走 text 事件（游程合并）——单字符 m 在空输入框时
        // 即菜单热键（命令皆 / 前缀，首字符抢占无碰撞；有文时照常入框）
        if (view === 'desktop' && input.text === '' && event.text === 'm') openMenu();
        else insertText(event.text);
        break;
      }
      case 'ime':
        if (event.composing) {
          input.setPreedit(event.text);
        } else {
          input.setPreedit(null);
          insertText(event.text);
        }
        break;
      case 'paste':
        insertText(event.text);
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
    armClock();
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
      try {
        // 同步首帧探针：渲染树异常在此同步上抛（异步首帧失败不可捕获——熔断
        // 计数需要同步可捕获的启动失败）
        engine.renderNow();
        armClock();
      } catch (err) {
        // 起屏失败内置收口：摘回接面 + 引擎终退复原终端（可能已进屏——dispose
        // 幂等收口）后原样上抛，由宿主记熔断账
        started = false;
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
      cancelClock();
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
