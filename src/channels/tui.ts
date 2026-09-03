/**
 * L4 channels — TUI 通道（技术栈篇 §4.1 M1 首发通道）。
 *
 * pi-tui 组件库装配的终端全屏对话界面：消息流 + 状态行 + 输入框（Editor）+
 * 快捷键提示行——TuiMainScreen 主屏**线性渲染**（四组件直挂 tui 树），超屏
 * 内容由终端原生 scrollback 承载、视口底部锚定（编辑器/页脚恒可见；第十轮
 * TUI 专项扫雷 TUI-3 收正——原「ScrollView follow-end / 布局根差分」注释描述
 * 的是生产永不命中的 alt-screen 分支，死对象已删）。通道契约（内核篇 #14）：
 * handle() 消费 loop 活体事件（app 组合根把 AgentEventSink 接到这里）、历史
 * 拉投影经 opts.history() 闭包（repaint 重画与 start 起屏共用——本通道不
 * import loop/session 实现，拔掉后对话照跑）。
 *
 * 阻塞式交互（confirm/input）经提问队列占用输入框（prompt 模式）；select
 * 不支持——由 ctx.ui 聚合器降级为 input（§4.3 降级规则）。壳薄逻辑少：
 * 渲染格式在 render.ts、提问排队在 prompt.ts、命令在 commands.ts。
 */

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  KeybindingsManager,
  Loader,
  Markdown,
  ScrollView,
  TUI_KEYBINDINGS,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isKeyRelease,
  matchesKey,
  parseKey,
  setKeybindings,
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type SlashCommand,
  type Terminal,
  type TUI,
  type TuiMainScreenRenderState,
} from '@earendil-works/pi-tui';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import type { AgentEvent } from '../agent/events.js';
import type { AgentMessage } from '../contracts/messages.js';
import { isStandardMessage } from '../contracts/messages.js';
import type { AgentToolResult } from '../contracts/tools.js';
import { chainBackground } from '../context/chain.js';
import { assistantErrorLine, assistantText, assistantToolLines, renderAgentMessage, truncate } from './render.js';
import { accentColorizer } from './theme.js';
import { createPromptQueue } from './prompt.js';
import { createFileSegmentProvider, createMentionProvider, type FilesFace, type SymbolsFace } from './mention.js';
import { fdPathFor } from './fd-path.js';
import type { CommandRegistry } from './commands.js';
import type { ChannelHost, InputOptions, NotifyLevel, RendererDefinition, UiBackend, UiAskOptions } from './types.js';

/** TUI 通道选项 */
export interface TuiChannelOptions {
  /** 宿主面：普通消息提交 / 退出请求 */
  readonly host: ChannelHost;
  /** 斜杠命令注册表（通道本地派发；非命令输入才走 host.submit） */
  readonly commands: CommandRegistry;
  /** 角色渲染器查找（ctx.channels.rendererFor；缺省用内置渲染） */
  readonly rendererFor?: (role: string) => RendererDefinition | undefined;
  /** 渲染器异常诊断回调（隔离案一第一刀 #1——坏渲染器回落内置形态并留痕；app 注入 logger） */
  readonly onRendererError?: (err: unknown, role: string) => void;
  /** 终端注入（缺省 ProcessTerminal；测试/特殊终端用） */
  readonly terminal?: Terminal;
  /**
   * 消息流滚动帽（遗漏大扫 20260903 spec D1-2；02-计划 桌面 TUI 批 C 清单
   * 「休眠 VStack 清理」383f8b25 缺席补刀）：messages 组件树子行上限——桌面
   * 换防停屏期事件仍进组件树 + 长会话正文，零帽零剪枝 = 内存无界累积 + 复起
   * 全量重画成本线性涨。超帽丢最旧（终端 scrollback 同款语义）；缺省 2000。
   * 可注入 = 测试面（生产恒缺省）。
   */
  readonly maxMessageLines?: number;
  /** 标题行文案（缺省不渲染标题） */
  readonly title?: string;
  /** 历史投影拉取（S3 按会话键取：undefined = 当前聚焦〔起屏路，壳闭包解析〕；repaint 重画显式带键——通道不持注册表，宿主注入闭包路由） */
  readonly history?: (sessionId?: string) => readonly AgentMessage[];
  /** 条目运行态查询（S3 切入在飞会话判据——状态行/流式占位槽；退役条目宿主侧按 idle 呈现；通道不持注册表） */
  readonly entryStatus?: (sessionId: string) => 'running' | 'idle' | undefined;
  /**
   * 应用强调色查询（D4 theme 渲染轻件，契约篇 §5.4 theme 条款）：会话键 → 该
   * 应用清单的 accent 字面量（白名单色名八字 / #rrggbb——合法性由清单 schema
   * 执法，通道侧非法值按缺省恒等处理）。undefined = 当前聚焦（起屏路——与
   * history 同款可选参形态）；无 app 域 / 注册表无清单命中 / 无 accent →
   * undefined（零色合法缺省态）。通道不读注册表——宿主注入闭包路由
   * （条目 appId 活视图 → 清单表）。
   */
  readonly themeFor?: (sessionId?: string) => string | undefined;
  /** 退出键提示文案（S6 形态⑦：宿主按起屏时点驱动数分档——多驱动「Ctrl+C 打断 / Ctrl+D·/quit 退出」、单驱动缺省「Ctrl+D·Ctrl+C 退出」） */
  readonly quitHint?: string;
  /**
   * Esc 拦截钩子（批 C 桌面换防，契约篇 §6.11）：应用视图态下 Esc 优先给宿主
   * 路由（桌面态 → 回桌面换防；内核 shell 态 → 出视图回 REPL）。返回 true =
   * 已消费（不进编辑器）；false/未注入 = 维持 Esc 编辑语义（默认不拦截——
   * tui-main 纯对话形态零变化）
   */
  readonly escapeHook?: () => boolean;
  /**
   * 工作区根（M4 命令/文件补全接线，2026-08-27 第三十三批）：传入即武装
   * editor autocomplete（命令名补全 + 参数补全 + `@` 文件补全，经 pi-tui
   * CombinedAutocompleteProvider——basePath 用）；缺省不武装（测试/无终端面）。
   */
  readonly workspace?: string;
  /**
   * fd 可执行路径（fd 接线小刀，契约篇 §6.8）：@ 文件段（第一段）补全的
   * 行走后端注入键。三态：undefined = 未注入走真发现序（APP_FD_PATH 覆盖
   * → PATH 查找 fd/fdfind/fd.exe——resolveFdPath）/ null 或空串 = 显式
   * 禁用（@ 文件段无建议）/ 字符串 = 显式指定。仅在 workspace 武装分支
   * 内被消费（workspace 缺省不武装时是哑键）。
   */
  readonly fdPath?: string | null;
  /**
   * documentSymbol 查询面（channels 批刀 B——@-mention 符号段补全）：传入即
   * 在 autocomplete 武装时包一层组合委托 provider（`@path#sym` token 拦截调
   * 此 face；不匹配与 face 404 档原样委托内层三面）。结构类型注入——通道
   * 不 import lsp/webui（拓扑边零新增）；face 源 = 宿主活取值闭包（lsp 行
   * apply 挂真身、回卷摘除——TUI 面随行回卷自然退化为委托腿）。
   */
  readonly symbolsFor?: SymbolsFace;
  /**
   * 工作区文件查询面（daemon 刀二 filesFor 注入键，契约篇 §6.8 通道契约前
   * 置小改）：传入即在 autocomplete 武装时对单段 token（`@路径片段`——无
   * '#'）外包文件段拦截 provider，@ 文件段补全真源切到注入 face（attach
   * 客户端远程路由）；缺省走本地 fd 发现序不变（fdPath 键另有三态）。结构
   * 类型注入——通道不 import webui/app（拓扑边零新增）；face undefined 结果
   * = 无弹层不回委托（真源在远端，本地行走是错工作区）。
   */
  readonly filesFor?: FilesFace;
  /**
   * todo 折叠查询面（TUI 彻底完善批增强 4，技术栈篇 §4.1）：传入即在输入框上方
   * 渲染紧凑 todo 面板（四态记号 + 帽 6 条 + 溢出行）；刷新触发 = repaint /
   * tool_execution_end(toolName=todo) / agent_end。结构类型注入——通道不 import
   * chat 模块（拓扑边零新增）；undefined/null/空数组 = 面板清空。tui-main 装配
   * 接 builtin-deps 同名面（webui SPA 呈现同源折叠产物）；attach 纯客户端形态
   * 不注入 = 面板缺席零变化。
   */
  readonly todoFor?: (sessionId?: string) => readonly TodoItemFace[] | null | undefined;
  /**
   * 忙态外源（增强 7 终端外显——attach 纯客户端形态注入）：在场 = 进度态由
   * 本闭包派生（attach 侧 = runningBySession 登记簿任一 true 即忙——种子/增量
   * 单源，重连漏 start 的结构性盲区由清单种子自愈，不另设计数器）；缺席 =
   * 本地 TUI 形态走通道内两路净计数（聚焦 handle + 非聚焦 handleActivity——
   * 进程内事件无错过窗）。两形态分源单写点 syncProgress。
   */
  readonly busyFor?: () => boolean;
  /**
   * 当前聚焦会话 id 活取值（增强 7 起屏一次同解析——D4 theme「+起屏一次同
   * 解析」先例同款）：起屏 title 缀短 id 用（boot 路 focus 通知早于订阅，首绘
   * 不走 repaint——聚焦 id 由宿主闭包活取）。缺席 = 起屏 title 纯基线，首次
   * repaint 起（显式带键）自然补短 id。
   */
  readonly focusIdFor?: () => string | undefined;
}

/** TUI 通道面（app 组合根持有） */
export interface TuiChannel {
  /** 活体事件入口（**聚焦者专用**——S3 信封分流后，宿主壳只把聚焦会话的事件路由到这里） */
  handle(event: AgentEvent): void;
  /**
   * 非聚焦活动摘要入口（S3 信封分流的后台腿——宿主壳拆信封后路由到这里：
   * 后台活条目与退役条目统一走摘要行，agent_start/agent_end 落一行，message/tool
   * 事件不进正文——互不绞屏执法；退役条目迟到事件以此保持「审计面可见」）。
   */
  handleActivity(sessionId: string, event: AgentEvent): void;
  /**
   * 清屏重画到目标会话（S3 focus 变化驱动信号）：复位流式槽（防孤儿引用持已摘除
   * 容器）→ 清消息流 → 历史投影重画（按会话键拉）→ 状态行/在飞占位槽按
   * entryStatus 设定。undefined = 无聚焦（防御位：空历史 + 状态行清）。
   */
  repaint(sessionId: string | undefined): void;
  /** 本通道的 UI 后端（接 ctx.ui 聚合器 attach） */
  ui(): UiBackend;
  /** 起屏（装配完再调；接管终端输入）。停屏后复起（批 C 桌面换防）不重拉历史——组件树保连续，强制全量重画 */
  start(): void;
  /**
   * 停屏（恢复终端；不 resolve 在身提问——退出序列由宿主编排）。批 C 换防：
   * preserveScreen:true = 保留屏面不写尾部换行（桌面引擎在其上重绘）——停屏
   * 期间 requestRender 自然短路（pi-tui 原生 stopped 早退），事件仍进组件树
   */
  stop(options?: { readonly preserveScreen?: boolean }): void;
  /**
   * 退出兜底（interrupt 小刀）：收场全部在身/排队提问（prompts.cancelAll）
   * ——quit 后 settle 前调用，覆盖无 run 属主的 ask（服务路）与任何漏网，
   * 队首永不搁浅的最后一道闸。
   */
  cancelAsks(): void;
}

/**
 * 无着色基线主题（恒等函数——多通道实例共享的构造缺省，勿改引用：D4 换装走
 * Editor 实例 borderColor 赋值〔applyTheme〕，不改本常量；selectList 补全面
 * v1 不着色——契约篇 §5.4 theme 条款消费面钉死四处，不含补全面板）
 */
const identity = (text: string): string => text;
const EDITOR_THEME: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

/** 级别 → 通知行前缀（success 档 2026-08-27 第三十三批 P2-1 新增） */
const NOTIFY_PREFIX: Record<NotifyLevel, string> = { info: 'ℹ', success: '✔', warn: '⚠', error: '✖' };

/* ---- TUI 彻底完善批（技术栈篇 §4.1 应用视图四增强，2026-09-04）---- */

/**
 * Markdown 渲染主题（增强 1——assistant 终值正文）：中性 ANSI 配色，暗亮底皆可辨。
 * 刻意不接 highlightCode（语法高亮库零新依赖纪律——规范同条）；accent 着色仍专属
 * 焦点指示面（边框/页脚/转轮/●），内容正文不混用主题色（着色克制律延伸）。
 */
const DIM = (text: string): string => `\x1b[2m${text}\x1b[0m`;
const MD_THEME: MarkdownTheme = {
  heading: (t) => `\x1b[1m${t}\x1b[0m`, // 标题加粗
  link: (t) => `\x1b[4m${t}\x1b[0m`, // 链接下划线
  linkUrl: DIM,
  code: (t) => `\x1b[36m${t}\x1b[0m`, // 行内代码青色
  codeBlock: (t) => `\x1b[36m${t}\x1b[0m`,
  codeBlockBorder: DIM,
  quote: DIM,
  quoteBorder: DIM,
  hr: DIM,
  listBullet: (t) => `\x1b[1m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
  italic: (t) => `\x1b[3m${t}\x1b[0m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[0m`,
  underline: (t) => `\x1b[4m${t}\x1b[0m`,
};

/**
 * todo 条目展示面（增强 4——结构类型：通道不 import chat 模块〔拓扑边零新增〕，
 * 字段 = TodoItem 的呈现子集；宿主注入折叠产物，面板只管呈现）。
 */
export interface TodoItemFace {
  readonly content: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'deferred';
  readonly activeForm?: string;
}

/** todo 面板可见条目帽（超帽折叠为「+ N 更多」一行——紧凑面板纪律） */
const TODO_PANEL_MAX = 6;
/* ---- 终端态复原（TUI-1，第十轮 TUI 专项扫雷 20260904；骨架篇 §1.3 终端态复原条款） ---- */

/** 已武装复原钩子的解除器（模块级单例——一进程一真终端；重复武装先解除旧的） */
let disarmTerminalRestore: (() => void) | null = null;

/** 副屏在场时的退出复原腿（增强 8）：开回看器时武装、收起时卸载。硬退路径
 * 若停留在副屏缓冲，既有复位序列（鼠标/键序/raw）写在副屏里等于没写——本腿
 * 先退副屏（1049l + 鼠标复位 + 自动换行复原）再让既有序列落到主屏缓冲。 */
let viewerExitRestore: (() => void) | null = null;

/**
 * 武装 process exit 终端态复原钩子（仅真 ProcessTerminal 调用——测试注入终端零污染）。
 *
 * 硬退路径（fatal exit(1) / 二次 SIGINT exit(130)）不经优雅退出序列，tui.stop()
 * 的复位写不执行；终端私有模式是写字节开启的设备态，进程退出不自动复原——崩溃
 * 后宿主 shell 键序错乱（Esc/Alt 组合键乱码、Ctrl+C 失去 SIGINT）。raw mode 由
 * Node 出场钩（uv_tty_reset_mode）自行复位，私有模式序列无此待遇——本钩子补位。
 *
 * 复位写幂等镜像 tui.stop() 的全部设备态写：对未激活模式即终端缺省值复位，恒
 * 安全（空 kitty 栈弹栈合法）。生命周期 = channel start() 武装 → stop() 解除，
 * 钩子只活在〔start, stop）崩溃窗内（正常停屏的复位归 tui.stop() 单源）。
 *
 * @param baselineTitle 外显标题基线（增强 7——opts.title；在场时复原写 OSC 0
 *   镜像 stop() 末写「title 复原到基线」；缺席 = 该形态零标题管理，不写）
 */
function armTerminalRestore(baselineTitle: string | undefined): void {
  disarmTerminalRestore?.();
  const restore = (): void => {
    try {
      viewerExitRestore?.(); // 增强 8：副屏退屏先行（在场才写——缺席零污染）
      process.stdout.write('\x1b]9;4;0\x07'); // OSC 9;4 进度态清零（镜像 stop() 首写）
      if (baselineTitle !== undefined) {
        process.stdout.write(`\x1b]0;${baselineTitle}\x07`); // 增强 7：title 复原到基线（镜像 stop() 末写）
      }
      process.stdout.write('\x1b[?2004l'); // 括号粘贴模式关闭
      process.stdout.write('\x1b[<u'); // kitty 键盘协议弹栈（空栈弹栈合法）
      process.stdout.write('\x1b[>4;0m'); // modifyOtherKeys 复位缺省
      process.stdout.write('\x1b[?25h'); // 光标显（A8：pi-tui 起屏/渲染期 hideCursor 藏掉的设备态——镜像 stop() 的 showCursor；已显再显幂等无害）
      process.stdin.setRawMode?.(false); // raw 交还（Node 出场钩亦会做——幂等兜底）
    } catch {
      // 复位尽力而为——退出路径不允许二次异常（crash.log 同款纪律）
    }
  };
  process.on('exit', restore);
  disarmTerminalRestore = () => {
    process.removeListener('exit', restore);
    disarmTerminalRestore = null;
  };
}

/** 组装 TUI 通道 */
export function createTuiChannel(opts: TuiChannelOptions): TuiChannel {
  const terminal = opts.terminal ?? new ProcessTerminal();
  /** 消息流滚动帽（缺省 2000——超帽丢最旧，见 TuiChannelOptions.maxMessageLines） */
  const maxMessageLines = opts.maxMessageLines ?? 2000;
  // 主屏双名（增强 8）：tui = 既有交互面（通道生命周期不变）；mainScreen =
  // TuiMainScreen 静态面（captureRenderState/restoreRenderState——/history 副屏
  // 开合时主屏差分基线的存取，批 C 换防同款「同实例两视图」形态）
  const mainScreen = new TuiMainScreen(terminal);
  const tui: TUI = mainScreen;
  /** 起屏旗标（批 C 桌面换防）：首起拉历史投影，停屏后复起只全量重画不重拉 */
  let screenStarted = false;

  /* ---- 组件树：消息流 / 状态行 / 输入框 / 提示行（四组件直挂 tui 线性树） ---- */
  /** 消息流内容（逐条 append Text；超屏走终端原生 scrollback——TuiMainScreen 主屏无自有滚动面） */
  const messages = new Container();
  /** 状态行（setStatus 更新；空串 = 空） */
  /**
   * 状态行（TUI 彻底完善批增强 3）：静态 Text → Loader 动画组件——agent_start 启
   * 转轮、tool_execution_start 实时显示工具名（状态面消费，正文单源纪律不变）、
   * agent_end 停轮。Loader.render 前置空行天然分隔消息流与状态区。转轮色经
   * 可变槽闭包随主题换装（Loader 构造后 colorFn 私有不可直换）。
   */
  const loaderSpinnerColor: { fn: (text: string) => string } = { fn: identity };
  const statusLoader = new Loader(tui, (s: string) => loaderSpinnerColor.fn(s), identity, '');
  /** todo 面板容器（增强 4）：状态行与输入框之间；todoFor 未注入或空表恒空容器 */
  const todoPanel = new Container();
  /**
   * 活动面板容器（强化批 2 增强 5）：状态行与 todo 面板之间——工具实时进度行
   * （瞬时面：update 建行 / end 摘行 / agent_start·agent_end·repaint 清板，
   * 行集永不入正文——直播路渲染单源纪律不变，状态面消费家族）。
   */
  const activityPanel = new Container();
  /** 最近聚焦会话键（增强 4——todoFor 查询参数；repaint 显式带键时更新，起屏路 undefined = 当前聚焦） */
  let trackedSessionId: string | undefined;
  const editor = new Editor(tui, EDITOR_THEME);
  // M4 补全接线（2026-08-27 第三十三批）：workspace 传入即武装 autocomplete——
  // 命令名补全 + 参数补全 + `@` 文件补全三合一（pi-tui CombinedAutocompleteProvider，
  // basePath = 工作区根）。@ 文件段（第一段）依赖 fd 子进程行走——fd 发现序
  // 见 fd-path.ts（fd 接线小刀：APP_FD_PATH 覆盖 → PATH 查找 fd/fdfind/fd.exe，
  // 诚实缺席不 fail-loud）。命令清单是 provider 构造参数静态快照，注册面任何变动
  // （boot 命令注册 / /reload 重注册 / 技能命令重扫）须重投影——订阅
  // commands.onChange 自动重建（与 skills_change 同构：注册表自持通知，宿主不编
  // 排时点）；参数补全回调闭包内实时 lookup（重装后的命令体即取即用）。
  if (opts.workspace !== undefined) {
    /** 命令注册表 → pi-tui SlashCommand 投影（名字清单快照 + 实时参数回调） */
    const projectCommands = (): SlashCommand[] =>
      opts.commands.list().map((cmd) => ({
        name: cmd.name, // pi-tui 匹配用裸名（不含 '/' 前缀——输入侧已剥离）
        description: cmd.description,
        ...(cmd.argumentHint === undefined ? {} : { argumentHint: cmd.argumentHint }),
        ...(cmd.getArgumentCompletions === undefined
          ? {}
          : {
              // 参数回调实时查注册表（/reload 后重注册的命令体即取即用）；readonly
              // 数组转 mutable（pi-tui 面非 readonly）
              getArgumentCompletions: async (
                prefix: string,
              ): Promise<{ value: string; label: string; description?: string }[] | null> => {
                const current = opts.commands.lookup(cmd.name);
                const items = await current?.getArgumentCompletions?.(prefix);
                return items && items.length > 0 ? items.map((item) => ({ ...item })) : null;
              },
            }),
      }));
    /** 重装 provider（构造时一次 + 每次 onChange；setAutocompleteProvider 为可选 API 防御调用）。
     *  刀 B：symbolsFor 在场时外包组合委托 provider（@-mention 符号段拦截；
     *  非两段 token 与 face 404 档原样委托内层三面）。
     *  刀二：filesFor 在场时再外包文件段 provider（单段 `@路径` 拦截远程路由；
     *  两段判据互斥——文件段排除 '#'、符号段必含 '#'——叠加次序无关）。
     *  fd 接线小刀：第三参 fdPath 每次重建重探（fdPathFor 三态决策——undefined
     *  走真发现序；失败不缓存给中途安装的可发现性，见 fd-path.ts 头注释） */
    const installAutocomplete = (): void => {
      const inner = new CombinedAutocompleteProvider(projectCommands(), opts.workspace!, fdPathFor(opts.fdPath));
      let provider: AutocompleteProvider = inner;
      if (opts.filesFor !== undefined) provider = createFileSegmentProvider(provider, opts.filesFor);
      if (opts.symbolsFor !== undefined) provider = createMentionProvider(provider, opts.symbolsFor);
      editor.setAutocompleteProvider?.(provider);
    };
    installAutocomplete();
    opts.commands.onChange(installAutocomplete);
  }
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  /* ---- 底部提示行（D4 theme 轻件：拆 title 段与尾段——footer 由装配期静态变主题期动态重算，title 文案随聚焦 accent 着色）。S6 形态⑦：quitHint 由构造方按
   * 起屏时点驱动数分档传入（多驱动「Ctrl+C 打断」/ 单驱动「Ctrl+D·Ctrl+C
   * 退出」）——通道不知驱动数，文案判据在宿主侧 */
  /** title 段（缺 title = 空串——着色锚点；着色克制律：只着本段，尾段恒素） */
  const footerTitlePart = opts.title ? ` ${opts.title}` : '';
  /**
   * 尾段现算（发送/命令/退出提示——恒不着色）。TUI-8：「/ 命令」段按注册表
   * 空否省略——空表形态（attach 纯客户端 v1）无命令面，提示行不虚报能力；
   * 每次现算而非构造期快照，注册面变动（boot 注册 / /reload 重注册 / 技能
   * 命令重扫）经 onChange 重算——与下方 installAutocomplete 重装同构。
   */
  const footerRestText = (): string => {
    const commandSeg = opts.commands.list().length > 0 ? ' / / 命令' : '';
    const quit = opts.quitHint ?? 'Ctrl+D·Ctrl+C 退出';
    return opts.title ? ` — Enter 发送${commandSeg} / ${quit}` : ` Enter 发送${commandSeg} / ${quit}`;
  };
  const footerText = new Text(footerTitlePart + footerRestText());

  /* ---- 主题换装（D4 theme 渲染轻件，契约篇 §5.4 theme 条款） ---- */
  /**
   * 聚焦会话当前着色器（跟随聚焦换装三消费点的共享着色面）：repaint / start
   * 起屏两时点重算（起屏路不走 repaint——冷读 B1 裁决补的第四时点）；
   * 缺省恒等零 ANSI。handle(agent_start) 等即时写点读本闭包变量。
   */
  let focusColorize: (text: string) => string = identity;
  /**
   * 重算聚焦着色器并换装三消费点：编辑器边框（Editor 实例 borderColor 公开
   * 可变、render 期求值——赋值即换装，不动模块级共享 EDITOR_THEME 基线）+
   * 页脚 title 段。状态行 ● 由各写点即时用 focusColorize（本函数不触——
   * 它随 run 态翻转，不随主题时点）。
   */
  const applyTheme = (sessionId: string | undefined): void => {
    focusColorize = accentColorizer(opts.themeFor?.(sessionId));
    editor.borderColor = focusColorize;
    // 增强 3：转轮色槽同步换装（Loader colorFn 私有——经可变槽闭包行使）
    loaderSpinnerColor.fn = focusColorize;
    footerText.setText(focusColorize(footerTitlePart) + footerRestText());
    footerText.invalidate();
    // 保底请求重绘：起屏空历史路（renderHistoryInto 零追加行）无其他渲染触发，
    // footer 换装需自带一次 requestRender（幂等调度，repaint 路多一次无害）
    tui.requestRender();
  };

  // 注册面变动重算尾段（TUI-8：与 installAutocomplete 的 onChange 重装同构——
  // 注册表自持通知，宿主不编排时点；多监听器并列，title 段沿用当前聚焦着色）
  opts.commands.onChange(() => {
    footerText.setText(focusColorize(footerTitlePart) + footerRestText());
    footerText.invalidate();
    tui.requestRender();
  });

  // 四组件直挂 tui 线性树（TuiMainScreen 主屏逐行写出、原生 scrollback 底部
  // 锚定——TUI-3 收正：原 VStack 布局根 + setLayoutRoot 条件安装是 alt-screen
  // 分支的死对象〔'setLayoutRoot' in tui 恒 false〕，连同假注释一并删除）
  tui.addChild(messages);
  tui.addChild(statusLoader);
  tui.addChild(activityPanel);
  tui.addChild(todoPanel);
  tui.addChild(editorContainer);
  tui.addChild(footerText);

  /* ---- 展示原语 ---- */

  /** 追加若干展示行（每行一个 Text；请求重绘）。超滚动帽丢最旧（休眠期无界堆积收口） */
  const appendLines = (lines: readonly string[]): void => {
    for (const line of lines) messages.addChild(new Text(line, 1));
    // 滚动帽执法（遗漏大扫 20260903 spec D1-2）：批 C 换防停屏期事件仍进组件
    // 树（requestRender 短路、树照长）——桌面态持续数小时 + 后台长会话即内存
    // 无界累积，复起全量重画成本随树线性涨。children 是 Container 公开数组，
    // 头部整段剪除 = 终端 scrollback 上限同款语义（最新恒保留；流式槽恒在尾
    // 部不受影响）
    const overflow = messages.children.length - maxMessageLines;
    if (overflow > 0) messages.children.splice(0, overflow);
    messages.invalidate();
    tui.requestRender();
  };

  /** 流式 assistant 块（message_start 开、update 原地 setText、end 定稿） */
  let streaming: { container: Container; text: Text } | null = null;

  /** 打开流式块（首帧占位 …；后续 update 覆盖） */
  const openStreaming = (): void => {
    // 单槽自愈守卫（20260901-d #4）：repaint 切入 running 条目已开占位槽后，
    // 下一条 assistant message_start 无条件再进此处——先摘旧槽再开新，防旧
    // 占位容器随 streaming 引用被覆盖而孤儿滞留正文（此前无任何摘除路径）
    if (streaming) messages.removeChild(streaming.container);
    const container = new Container();
    const text = new Text(' …', 1);
    container.addChild(text);
    messages.addChild(container);
    streaming = { container, text };
    messages.invalidate();
    tui.requestRender();
  };

  /** 更新流式块文本（assistant 当前 text 块拼接） */
  const updateStreaming = (content: string): void => {
    if (!streaming) return;
    streaming.text.setText(content.trim() ? ` ${content.trim().split('\n').join('\n ')}` : ' …');
    streaming.text.invalidate();
    tui.requestRender();
  };

  /**
   * 定稿流式块（终值文本 + 工具调用行；无流式块则直接落行——如重放）。
   * 增强 1：终值正文走 Markdown 组件（流式期纯文本直推，定稿换装——性能与观感
   * 兼得）；工具/错误行仍走行形态（appendLines）。
   */
  const closeStreaming = (finalText: string, toolLines: readonly string[]): void => {
    if (streaming) {
      messages.removeChild(streaming.container);
      streaming = null;
    }
    if (finalText.trim() !== '') appendMarkdown(finalText);
    appendLines(toolLines.filter((l) => l !== ''));
  };

  /**
   * 追加 assistant 正文 Markdown 块（增强 1）：一个 Markdown 组件 = 一子行
   * （滚动帽语义随组件化 = 组件数帽——一个代码块再长也是一子行；与 appendLines
   * 同款溢出剪枝，最新恒保留）。
   */
  const appendMarkdown = (text: string): void => {
    messages.addChild(new Markdown(text, 1, 0, MD_THEME));
    const overflow = messages.children.length - maxMessageLines;
    if (overflow > 0) messages.children.splice(0, overflow);
    messages.invalidate();
    tui.requestRender();
  };

  /* ---- 提问队列（prompt 模式占输入框） ---- */
  const prompts = createPromptQueue({
    show(question) {
      appendLines([`? ${question}`]);
    },
    echo(answer) {
      appendLines([`› ${answer}`]);
    },
    // 撤销说明行（刀 A：在身提问被 signal abort 时的收屏行——文案 = abort
    // reason，如「该审批已在网页端应答」；question 参数不显——提问行已在屏）
    dismiss(_question, reason) {
      appendLines([`− ${reason}`]);
    },
  });

  /* ---- 输入路由：斜杠命令 > 提问答案 > 普通消息（S5 序翻转——冷读 F5）----
   * 命令期 prompt 可达：prompt 占屏时 /quit 等逃生命令仍可派发（不被在身
   * 提问吞掉——ask 的取消收场由 prompts.cancelAll 兜底）；prompt 期的非命令
   * 输入才消费为答案。 */
  editor.onSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return; // 空提交忽略（防误触；退出走 Ctrl+D）
    // 增强 2：输入历史（↑/↓ 翻阅、连续去重、百条帽——pi-tui Editor 内建行为，
    // 成功提交路径统一入史：命令/提问答案/普通消息三者皆可翻回
    editor.addToHistory(trimmed);
    // 命令在通道本地派发（命令错误兜底为通知，不崩界面）；命令无时间线事件，本地回显
    if (trimmed.startsWith('/')) {
      appendLines([`❯ ${trimmed}`]);
      opts.commands
        .dispatch(trimmed)
        .then((result) => {
          if (result === 'unknown') {
            // 分档文案（TUI-8 + 增强 8 涟漪勘正）三档：注册表空 = 本形态无命令面
            // （attach 纯客户端 v1——/ 前缀输入按通道统一派发语义本地拦截**不投递**，
            // 诚实告知而非误导性 /help 指引）；/help 在册 = 给 /help 指引；非空但无
            // /help（attach 注入 /history 等通道命令而 help 不在册）= 诚实列未知、
            // 不虚指不存在的命令
            const head = trimmed.split(' ')[0];
            const commands = opts.commands.list();
            appendLines([
              commands.length === 0
                ? `✖ 本形态无斜杠命令面：${head} 未投递（发送普通消息请不以 / 开头）`
                : opts.commands.lookup('help') !== undefined
                  ? `✖ 未知命令：${head}（/help 查看清单）`
                  : `✖ 未知命令：${head}`,
            ]);
          }
        })
        .catch((err: unknown) => {
          appendLines([`✖ 命令执行失败：${err instanceof Error ? err.message : String(err)}`]);
        });
      return;
    }
    if (prompts.handleSubmit(trimmed)) return;
    // 普通消息不本地回显——loop 对 user 消息发 message_start，渲染单一来源是事件流
    opts.host.submit(trimmed);
  };
  // Ctrl+D / Ctrl+C 全局拦截面（pi-tui Editor 无专用回调；经原始输入监听 + 键解析识别）。
  // raw mode 下两键不产生信号而是输入字节——在此拦下分流（S6 形态④）：Ctrl+C 走
  // 宿主 interrupt（多驱动 = 打断聚焦 run 不退 OS，分档单点在 FrontHost）、
  // Ctrl+D 恒 requestQuit（退出命令键位不变）。Esc 拦截在最前（批 C 桌面换防：
  // escapeHook 消费即吞——编辑器 Esc 语义仅在纯对话形态保留）
  const quitKeys = new Set(['ctrl+d', 'ctrl+c']);
  tui.addInputListener((data) => {
    // kitty flag 2 事件类型早滤（E-1，TUI 第十一轮盲区 5）：本监听器跑在 pi-tui
    // 聚焦组件层之前（tui.js inputListeners → focusedComponent 序），而 parseKey
    // 剥掉 CSI u 事件类型字段——release 与 press 解析出同一键 id，不滤则一次按键
    // 双触发 interrupt/requestQuit/escapeHook。只滤 release 不滤 repeat：repeat 是
    // 用户长按的真实重发（pi-tui 聚焦组件层同此分档）；返回 undefined = 不消费，
    // release 事件沿链流至聚焦组件层由 pi-tui 自行丢弃。
    if (isKeyRelease(data)) return undefined;
    if (opts.escapeHook !== undefined && matchesKey(data, 'escape')) {
      if (opts.escapeHook()) return { consume: true };
    }
    const key = parseKey(data);
    if (key !== undefined && quitKeys.has(key)) {
      if (key === 'ctrl+c') opts.host.interrupt();
      else opts.host.requestQuit();
      return { consume: true };
    }
    return undefined;
  });

  /* ---- /history 全屏回看器（增强 8，技术栈篇 §4.1——pi-tui TuiAltScreen 首消费） ---- */
  /**
   * 历史投影 → 组件序列（渲染管线单源）：renderHistoryInto（主屏起屏/repaint）
   * 与 /history 回看器副屏共用同一构建逻辑——零第二渲染器（冷读勘正 #3：
   * assistant 终值走 Markdown 组件 + 工具/错误行尾随，与主屏行集恒一致）。
   * 返回消息条数供回看器提示行披露。
   */
  const buildHistoryComponents = (sessionId: string | undefined): { components: Component[]; count: number } => {
    const history = opts.history ? opts.history(sessionId) : [];
    const components: Component[] = [];
    for (const message of history) {
      if (isStandardMessage(message) && message.role === 'assistant' && opts.rendererFor?.('assistant') === undefined) {
        const body = assistantText(message);
        if (body.trim() !== '') components.push(new Markdown(body, 1, 0, MD_THEME));
        for (const line of [...assistantToolLines(message), ...assistantErrorLine(message)]) {
          components.push(new Text(line, 1));
        }
      } else {
        for (const line of renderAgentMessage(message, opts.rendererFor, opts.onRendererError)) {
          components.push(new Text(line, 1));
        }
      }
    }
    return { components, count: history.length };
  };

  /** 副屏在场态（null = 主屏常驻态）；同刻至多一副屏（/history 重入幂等无操作） */
  let viewer: { alt: TuiAltScreen; detachInput: () => void } | null = null;
  /** 主屏差分基线快照（开副屏前 capture、收副屏后 restore——维持渲染状态连续） */
  let mainScreenState: TuiMainScreenRenderState | null = null;

  /**
   * 收起回看器（幂等；四路共用收口：q/Esc / ask 强制收起 / Ctrl+D 退出 / 换防 stop）。
   * 编舞 = 副屏 stop（preserveScreen 不清屏，回看内容留在终端 scrollback）→ 主屏
   * restore 差分基线 → start → requestRender(true) 强制全帧。不走 repaint（清树
   * 重画投影）——那会抹掉停屏期入树的瞬时行（提问/通知行），冷读勘正 #4。
   */
  const closeViewer = (): void => {
    if (viewer === null) return;
    const { alt, detachInput } = viewer;
    viewer = null;
    viewerExitRestore = null; // 退出复原钩子副屏腿卸载（副屏已优雅收场）
    detachInput();
    alt.stop({ preserveScreen: true });
    // 停屏期事件已进主屏组件树（requestRender 在停屏态短路、树照长）——复起
    // 全帧重画即补显，复起路（channel.start 的 screenStarted 分支）同款
    mainScreen.restoreRenderState(mainScreenState!);
    mainScreenState = null;
    tui.setFocus(editor);
    tui.start();
    tui.requestRender(true);
  };

  /** 开回看器：当前聚焦会话全量 durable 正文（快照档 v1： viewing 期新事件不进回看、返回后可见） */
  const openViewer = (): void => {
    if (viewer !== null || !screenStarted) return;
    const key = trackedSessionId ?? opts.focusIdFor?.();
    const { components, count } = buildHistoryComponents(key);
    const body = new Container();
    for (const component of components) body.addChild(component);
    const scroll = new ScrollView(body, {
      follow: 'end', // 尾随锚定（与 pi 交互模式同款）
      primary: true, // 副屏内建搜索/选区挂 primary 视口
      overscroll: 'chain',
      scrollbar: 'auto', // 缺省 hidden 不显——冷读勘正 #2
    });
    const short = key !== undefined ? key.slice(0, 8) : '—';
    const hint = new Text(
      ` ${short} · ${count} 条 — q/Esc 返回 · Ctrl+Shift+F 搜索 · ↑↓/PgUp/PgDn/滚轮 滚动 · 拖选即复制`,
      0,
    );
    const alt = new TuiAltScreen(terminal, false);
    alt.addChild(body);
    alt.addChild(hint);
    alt.setLayoutRoot(
      // 正文占满弹性区、提示行固定尾行（pi fullscreenLayoutRoot 同款两段栈）
      new VStack([
        { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: hint, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
      ]),
    );
    // 收起监听器：q/Esc。自持让位判据 = 副屏存在聚焦组件（搜索框在场）时不消费
    // ——监听器添加序只保 Esc（内建 searchClose 先消费即止链），裸 q 无内建消费
    // 会落穿到本监听器，无判据则搜索框打不出字母 q（冷读勘正 #1）。kitty release
    // 早滤同 E-1（release 与 press 解析同形，不滤则一次按键双触发开关）。
    const detachClose = alt.addInputListener((data) => {
      if (isKeyRelease(data)) return undefined;
      if (alt.getFocusedComponent() !== null) return undefined;
      if (data === 'q' || matchesKey(data, 'escape')) {
        closeViewer();
        return { consume: true };
      }
      return undefined;
    });
    // 副屏键面补丁（冷读勘正 #7）：主屏 quitKeys 拦截面挂在主 TUI 实例上、副屏期
    // 是死键——副屏侧自建同款：Ctrl+C 打断在飞 run（回看器不关，注意力仍在）/
    // Ctrl+D 退出（先收副屏再走宿主退出路，编舞与换防 stop 同向）
    const detachQuit = alt.addInputListener((data) => {
      if (isKeyRelease(data)) return undefined;
      const keyId = parseKey(data);
      if (keyId === 'ctrl+c') {
        opts.host.interrupt();
        return { consume: true };
      }
      if (keyId === 'ctrl+d') {
        closeViewer();
        opts.host.requestQuit();
        return { consume: true };
      }
      return undefined;
    });
    // 切换编舞（冷读勘正 #5）：恒走 tui 层 stop——channel 外显（增强 7 title/进度
    // 态）与 TUI-1 复原钩子不动（回看窗内钩子恒武装，后台 run 忙态照常外显）
    mainScreenState = mainScreen.captureRenderState();
    tui.stop({ preserveScreen: true });
    viewer = {
      alt,
      detachInput: () => {
        detachClose();
        detachQuit();
      },
    };
    // 退出复原钩子副屏腿（冷读勘正 #6）：硬退路径（fatal/SIGINT）不经优雅收场——
    // 先退副屏缓冲（1049l + 鼠标复位 + 自动换行复原，镜像 tui-alt-screen.js 停屏
    // 写序列）再走既有复位序列
    viewerExitRestore = () => {
      try {
        process.stdout.write('\x1b[?1049l');
        process.stdout.write('\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l');
        process.stdout.write('\x1b[?7h');
      } catch {
        // 复位尽力而为（armTerminalRestore 同款纪律——退出路径不允许二次异常）
      }
    };
    alt.start();
  };

  // 副屏方向键补绑（冷读勘正 #2）：tui.altScreen.lineUp/lineDown 在 pi-tui 缺省
  // 空键（defaultKeys: []）——↑↓ 单行滚动 berry 侧补绑。PgUp/PgDn 页滚缺省在册；
  // 半页不另绑键（页滚已覆盖，且 ctrl+u/ctrl+d 与副屏键面补丁的 Ctrl 键冲突）。
  // 键位表是 pi-tui 模块级单例，重复 set 同值幂等（desktop 双通道形态安全）。
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.altScreen.lineUp': 'up',
      'tui.altScreen.lineDown': 'down',
    }),
  );

  // 命令注册（TUI-8 同律）：history() 注入在场才注册——attach 纯客户端形态持远程
  // 投影闭包同享；注入缺席 = 不注册不虚报
  if (opts.history !== undefined) {
    opts.commands.register({
      name: 'history',
      description: '全屏回看当前会话（q/Esc 返回 · Ctrl+Shift+F 搜索）',
      handler: () => {
        openViewer();
      },
    });
  }

  /* ---- todo 面板（增强 4，技术栈篇 §4.1）---- */
  /** 四态记号（☐ 待办 / ◐ 进行中 / ☑ 已完成 / ⊙ 缓办） */
  const TODO_MARKERS: Record<TodoItemFace['status'], string> = {
    pending: '☐',
    in_progress: '◐',
    completed: '☑',
    deferred: '⊙',
  };
  /**
   * 刷新 todo 面板：todoFor 查询（键 = trackedSessionId；起屏路 undefined = 当前
   * 聚焦，宿主闭包解析）→ 清板重画。进行中条目 accent 着色 + activeForm 优先、
   * 完成/缓办暗淡、超帽折叠「+ N 更多」。null/undefined/空数组 = 清板（注入侧
   * 视同无表，裁决⑧同源）。查询异常吞为清板（面板是呈现面不炸通道）。
   */
  const refreshTodo = (): void => {
    if (opts.todoFor === undefined) return;
    let items: readonly TodoItemFace[] | null | undefined;
    try {
      items = opts.todoFor(trackedSessionId);
    } catch {
      items = undefined;
    }
    todoPanel.clear();
    if (items !== undefined && items !== null && items.length > 0) {
      for (const item of items.slice(0, TODO_PANEL_MAX)) {
        const marker = TODO_MARKERS[item.status] ?? '☐';
        // 进行中条目 activeForm（现在进行时描述）优先于 content；着 accent
        const body = item.status === 'in_progress' && item.activeForm !== undefined ? item.activeForm : item.content;
        const styled =
          item.status === 'in_progress'
            ? focusColorize(`${marker} ${body}`)
            : item.status === 'completed' || item.status === 'deferred'
              ? DIM(`${marker} ${body}`)
              : `${marker} ${body}`;
        todoPanel.addChild(new Text(` ${styled}`, 1));
      }
      if (items.length > TODO_PANEL_MAX) {
        todoPanel.addChild(new Text(` ${DIM(`+ ${items.length - TODO_PANEL_MAX} 更多`)}`, 1));
      }
    }
    todoPanel.invalidate();
    tui.requestRender();
  };

  /* ---- 工具实时进度面板（强化批 2 增强 5，技术栈篇 §4.1——状态面消费家族） ---- */
  /** 进度行登记簿：toolCallId → 展示串（Map 插入序 = 调用序；瞬时面不落正文、不跨 repaint 保存） */
  const activityById = new Map<string, string>();
  /** 面板行帽：并行流 partial 的工具超帽折叠「… + N 更多」（并行工具调用的常见量级） */
  const ACTIVITY_MAX = 4;
  /**
   * partial 输出取尾行：文本块倒扫末条非空行（工具流式输出通常尾部追加——bash
   * 逐行吐出，尾行即最新进度）；截断与正文行同款码点安全 truncate（TUI-5）。
   * 无文本块 = 空串（行退化为 ` ▸ 名 …`）。
   */
  const activityTail = (partial: AgentToolResult): string => {
    for (let i = partial.content.length - 1; i >= 0; i--) {
      const block = partial.content[i]!;
      if (block.type === 'text') {
        const lines = block.text.split('\n').filter((line) => line.trim() !== '');
        if (lines.length > 0) return truncate(lines[lines.length - 1]!, 100);
      }
    }
    return '';
  };
  /**
   * 重建活动面板：登记簿前 ACTIVITY_MAX 行 + 溢出折叠行。整行暗淡——瞬时次级
   * 信息（着色克制律：不与 todo 进行中条目抢 accent）。行集永不入正文。
   */
  const refreshActivity = (): void => {
    activityPanel.clear();
    let shown = 0;
    for (const line of activityById.values()) {
      if (shown >= ACTIVITY_MAX) break;
      activityPanel.addChild(new Text(` ${DIM(line)}`, 1));
      shown++;
    }
    const hidden = activityById.size - shown;
    if (hidden > 0) activityPanel.addChild(new Text(` ${DIM(`… + ${hidden} 更多`)}`, 1));
    activityPanel.invalidate();
    tui.requestRender();
  };
  /** 清板（agent_start / agent_end / repaint 三时点——瞬时态靠事件重建；幂等） */
  const clearActivity = (): void => {
    if (activityById.size === 0) return;
    activityById.clear();
    refreshActivity();
  };

  /* ---- run 级用量累计（强化批 2 增强 6，技术栈篇 §4.1——状态面消费家族） ---- */
  /**
   * 本 run 用量累计（agent_start 归零、turn_end 累加、agent_end 状态行呈现——
   * run 间常驻尾注，repaint / agent_start 清除）。message.usage 必填字段直读
   * （零新管道零新表）；累计值只反映本视图收到的 turn（repaint 切走期间的 turn
   * 归非聚焦摘要——不重复累计，尾注如实覆盖本视角所见轮次）。
   */
  let usageAcc: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal: number;
    costSeen: boolean;
    currency: string | undefined;
  } | null = null;
  /** token 数紧凑格式化（<1000 原样；k/M 档一位小数） */
  const fmtTokens = (n: number): string =>
    n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
  /**
   * agent_end 状态行文案（增强 6）：` ✓ 用量 …`——totalTokens 与入/出直读累计、
   * cost 在场追加货币段（缺省按 USD 符号 $，非 USD 缀三字码）。run 零累计
   * （空转 / 即刻失败）= 空串清行（不虚报零用量）。
   */
  const usageLine = (): string => {
    if (usageAcc === null) return '';
    const costSeg =
      usageAcc.costSeen && usageAcc.costTotal > 0
        ? ` · $${usageAcc.costTotal.toFixed(2)}${usageAcc.currency !== undefined && usageAcc.currency !== 'USD' ? ` ${usageAcc.currency}` : ''}`
        : '';
    return ` ✓ 用量 ${fmtTokens(usageAcc.totalTokens)}（入 ${fmtTokens(usageAcc.input)} · 出 ${fmtTokens(usageAcc.output)}）${costSeg}`;
  };

  /* ---- 终端外显（增强 7：setTitle/setProgress 接线——pi-tui 内建件零自研） ---- */
  /**
   * 外显忙态净计数（本地形态）：聚焦 handle() 与非聚焦 handleActivity() 两路
   * agent_start/end 共用一本账 +1/-1——进度态语义 = 任一会话在飞即忙（终端
   * 标签页注意力模型，非聚焦后台 run 同样占忙态）。进程内事件无错过窗；防御
   * 位 clamp ≥ 0（错序/重复 end 不下探负值——负计数会让后到的单 start 误判
   * 闲）。attach 形态不消费本账（busyFor 外源单源，计数停拨——重连漏 start
   * 的结构性盲区由清单种子自愈，不另设计数器）。
   */
  let busyCount = 0;
  /** 进度态去重镜像（上次写下的态——OSC 重写噪声抑制；stop() 强制清零除外） */
  let progressShown = false;
  /** 标题去重镜像（同串不重写——OSC 重写噪声抑制；stop() 强制回基线除外） */
  let titleShown: string | undefined;
  /**
   * 进度态统一写点（增强 7）：两形态分源——busyFor 在场（attach 纯客户端）=
   * 登记簿派生活取（任一 true 即忙）；缺席（本地 TUI）= 净计数 > 0。经 pi-tui
   * setProgress 写 OSC 9;4（内建件自持 keepalive interval——进程内零自研）。
   * 写点 = handle/handleActivity 的 agent_start/end、repaint、start、stop。
   */
  const syncProgress = (): void => {
    const busy = opts.busyFor !== undefined ? opts.busyFor() : busyCount > 0;
    if (busy === progressShown) return;
    progressShown = busy;
    terminal.setProgress(busy);
  };
  /**
   * 标题统一写点（增强 7）：基线 = opts.title（页脚同源——`Berry <版本>` /
   * attach 形态 `Berry attach <版本>`；缺席 = 零标题管理档，进度态照常）；
   * 聚焦在案 = 基线 + ` · <短id>`（slice(0,8) 非聚焦摘要行同款——会话身份
   * 通道已在案，不引应用身份注入）。写点 = start（focusIdFor 活取——起屏
   * 聚焦在案即缀）与 repaint（显式键）。
   */
  const syncTitle = (sessionId: string | undefined): void => {
    if (opts.title === undefined) return;
    const next = sessionId === undefined ? opts.title : `${opts.title} · ${sessionId.slice(0, 8)}`;
    if (next === titleShown) return;
    titleShown = next;
    terminal.setTitle(next);
  };

  const handle = (event: AgentEvent): void => {
    switch (event.type) {
      case 'agent_start':
        // 增强 7：忙态记账（本地形态净计数 +1；attach 形态账不消费但写点同路
        // ——busyFor 活取单源）+ 进度态外显同步
        busyCount += 1;
        syncProgress();
        // 增强 3：状态行 Loader 化——转轮启转（色经 loaderSpinnerColor 槽随主题）；
        // 「工作中」长文本不着（着色克制律）
        statusLoader.setMessage(' 工作中');
        statusLoader.start();
        // 增强 5：新 run 清板（上一 run 残留行不跨 run）；增强 6：用量归零重计
        clearActivity();
        usageAcc = null;
        break;
      case 'agent_end':
        // 增强 7：忙态记账（clamp ≥ 0——错序/重复 end 不下探负值）+ 进度态外显同步
        busyCount = Math.max(0, busyCount - 1);
        syncProgress();
        // 防漏关（S3）：在飞占位槽开着一轮无 message_end 即结束（abort 中断路）
        // ——空终值关槽（closeStreaming 内 filter 空串，零追加行）
        if (streaming) closeStreaming('', []);
        // 增强 3：停轮；增强 6：用量尾注落状态行（run 间常驻——下一 agent_start
        // / repaint 清除；零累计 = 空串清行）；todo 面板随收场刷新（增强 4 第三
        // 触发时点——廉价）；增强 5：run 收场清板
        statusLoader.stop();
        statusLoader.setMessage(usageLine());
        refreshTodo();
        clearActivity();
        break;
      case 'turn_start':
        break; // 消息级事件已覆盖展示；turn 边界不额外渲染
      case 'turn_end': {
        // 增强 6（状态面消费——正文零渲染不变）：run 级用量累计，agent_end 状态
        // 行呈现；message.usage 契约层必填，防御缺席跳过（不虚报）
        const usage = event.message.usage;
        if (usage !== undefined) {
          const acc = usageAcc ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            costTotal: 0,
            costSeen: false,
            currency: undefined,
          };
          usageAcc = acc;
          acc.input += usage.input;
          acc.output += usage.output;
          acc.cacheRead += usage.cacheRead;
          acc.cacheWrite += usage.cacheWrite;
          acc.totalTokens += usage.totalTokens;
          if (usage.cost?.total !== undefined) {
            acc.costTotal += usage.cost.total;
            acc.costSeen = true;
            acc.currency = usage.cost.currency ?? acc.currency;
          }
        }
        break;
      }
      case 'message_start':
        // assistant 开流式块；user/toolResult/自定义角色按终值即席渲染
        if (isStandardMessage(event.message) && event.message.role === 'assistant') {
          openStreaming();
        } else {
          appendLines(renderAgentMessage(event.message, opts.rendererFor, opts.onRendererError));
        }
        break;
      case 'message_update':
        // 仅 assistant 流式期；text 块原地更新（token 级直推）
        if (isStandardMessage(event.message) && event.message.role === 'assistant') {
          updateStreaming(assistantText(event.message));
        }
        break;
      case 'message_end':
        if (isStandardMessage(event.message) && event.message.role === 'assistant') {
          const custom = opts.rendererFor?.('assistant');
          if (custom === undefined) {
            // Built-in path: final body text goes through Markdown component (enhancement 1) + tool/error lines (failure lines
            // land on screen along with stream wrap-up, #42: failed runs with empty content also have ✖ [error] one line)
            closeStreaming(assistantText(event.message), [
              ...assistantToolLines(event.message),
              ...assistantErrorLine(event.message),
            ]);
          } else {
            // Custom renderer priority (live-path alignment fix——custom assistant also takes line form in live-path, same priority as repaint path;
            // renderer exception isolation same contract as renderAgentMessage: fall back to builtin line form on throw + leave trace)
            let lines: string[];
            try {
              lines = custom.render(event.message);
            } catch (err) {
              opts.onRendererError?.(err, 'assistant');
              lines = renderAgentMessage(event.message, undefined, undefined);
            }
            closeStreaming('', lines);
          }
        }
        // user/toolResult/custom roles already rendered at message_start, no duplication here
        break;
      case 'tool_execution_start':
        // 增强 3（状态面消费——正文零渲染不变）：状态行实时显示正在执行的工具名，
        // 转轮持续（agent_start 已启）。正文 ⚙ 行仍随 assistant message_end 单源落
        statusLoader.setMessage(` ⚙ ${event.toolName} …`);
        break;
      case 'tool_execution_update': {
        // 增强 5（状态面消费——正文零渲染不变）：有 partial 输出的工具占面板行
        // ——首个 update 建行、后续 update 原位换行、end 即摘行（瞬时面；无
        // partial 的工具不占行——状态行工具名 Loader 已覆盖）
        const tail = activityTail(event.partialResult);
        activityById.set(event.toolCallId, `▸ ${event.toolName} ${tail === '' ? '…' : `· ${tail}`}`);
        refreshActivity();
        break;
      }
      case 'tool_execution_end':
        // 增强 4：todo 工具写后即显——面板刷新触发器（非渲染）；↳ 正文行仍随
        // toolResult message_start 的 renderAgentMessage 单源落（历史投影同款）
        if (event.toolName === 'todo') refreshTodo();
        // 增强 5：摘行（无行的工具 end 摘除是幂等 no-op——无 partial 工具不占行）
        if (activityById.delete(event.toolCallId)) refreshActivity();
        break;
    }
  };

  /* ---- UiBackend 实现（attach 进 ctx.ui 聚合器） ---- */
  const backend: UiBackend = {
    id: 'tui',
    notify(message, notifyOpts) {
      const prefix = NOTIFY_PREFIX[notifyOpts?.level ?? 'info']!;
      appendLines([`${prefix} ${message}`]);
    },
    setStatus(status) {
      // 增强 3：经 Loader 静态更新（不启转轮——应用态状态非运行态）
      statusLoader.setMessage(status ? ` ${status}` : '');
    },
    async confirm(message, opts?: UiAskOptions) {
      // 增强 8：ask 强制收起回看器（注意力优先级 ask > 回看）——先收再入队；
      // 收起保树（requestRender 全帧）故提问行照常入屏
      closeViewer();
      // priority 随链取数（S5 后台 run 的确认降级排队——契约篇 §5.4）；取消收场
      // 或 signal abort 的 undefined 按 false（fail-closed：不批准 = 安全缺省）
      const answer = await prompts.ask(`${message} [y/n]`, {
        priority: chainBackground() ? 'background' : 'interactive',
        signal: opts?.signal,
      });
      if (answer === undefined) return false;
      const parsed = /^(y|yes|是)$/i.test(answer.trim());
      return parsed; // 未识别按 false（fail-closed，与技术栈篇 §4.3 精神一致）
    },
    async input(message, ioOpts?: InputOptions) {
      // 增强 8：ask 强制收起回看器（confirm 同律）
      closeViewer();
      // priority 同 confirm；取消收场或 signal abort 的 undefined 归一为 ''
      //（UiService.input 的「无输入」既有语义——消费方零新分支）
      const answer = await prompts.ask(ioOpts?.placeholder ? `${message}（${ioOpts.placeholder}）` : message, {
        priority: chainBackground() ? 'background' : 'interactive',
        signal: ioOpts?.signal,
      });
      return answer ?? '';
    },
    // select/setWidget 不支持——ctx.ui 聚合器按 §4.3 降级规则处理
  };

  /* ---- 非聚焦活动摘要（S3 信封分流后台腿） ---- */
  const handleActivity = (sessionId: string, event: AgentEvent): void => {
    const short = sessionId.slice(0, 8);
    // D4 theme：各归各色——按事件归属会话的 accent 着「符号 + 会话 N」段
    // （⧗/✓ 同函数同族同律）；「后台工作中/完成」长文本不着（着色克制律）
    const colorize = accentColorizer(opts.themeFor?.(sessionId));
    switch (event.type) {
      case 'agent_start':
        // 增强 7：非聚焦腿同账（本地形态净计数 +1——后台 run 同样占忙态）+ 外显同步
        busyCount += 1;
        syncProgress();
        appendLines([`${colorize(`⧗ 会话 ${short}`)} 后台工作中`]);
        break;
      case 'agent_end':
        // 增强 7：非聚焦腿同账（clamp ≥ 0）+ 外显同步
        busyCount = Math.max(0, busyCount - 1);
        syncProgress();
        // 收场三档（#42）：修前恒显「✓ 后台完成」——失败/中止 run 被伪装成
        // 成功，后台炸了用户毫不知情。三档与 RunStatus 一一对应（agent/events）
        appendLines([
          event.status === 'failed'
            ? `${colorize(`✖ 会话 ${short}`)} 后台失败`
            : event.status === 'aborted'
              ? `${colorize(`⏹ 会话 ${short}`)} 后台已中止`
              : `${colorize(`✓ 会话 ${short}`)} 后台完成`,
        ]);
        break;
      default:
        break; // message/tool 事件不进正文（正文只属聚焦者——互不绞屏执法）
    }
  };

  /* ---- 清屏重画（S3 focus 变化驱动信号） ---- */
  /**
   * 按会话键拉历史并渲染（repaint 重画与 start 起屏两路共用——单一历史渲染路径）。
   * 增强 1：内置 assistant 路径正文走 Markdown 组件（自定义渲染器优先——注册了
   * assistant 渲染器的应用回落行形态，优先级纪律不变）；其余角色照旧行形态。
   */
  const renderHistoryInto = (sessionId: string | undefined): void => {
    // 渲染管线单源（增强 8）：主屏起屏/repaint 与 /history 回看器共用
    // buildHistoryComponents——两屏行集恒一致（零第二渲染器）
    const { components } = buildHistoryComponents(sessionId);
    for (const component of components) messages.addChild(component);
    // 滚动帽执法（超帽丢最旧——appendLines/appendMarkdown 逐次剪枝的等价收口；
    // 帽只治主屏树内存，回看器副屏走全量快照不受此帽）
    const overflow = messages.children.length - maxMessageLines;
    if (overflow > 0) messages.children.splice(0, overflow);
    messages.invalidate();
    tui.requestRender();
  };
  const repaint = (sessionId: string | undefined): void => {
    // 增强 4：追踪会话键（todoFor 查询参数——显式键路更新）
    trackedSessionId = sessionId;
    // D4 theme：换装先行（清屏重画时点按目标会话重算聚焦着色器——边框/页脚/
    // 转轮槽随之换装；后续写点读新 focusColorize）
    applyTheme(sessionId);
    // 增强 7：外显随聚焦换装（title 缀目标会话短 id；进度态分源重估——attach
    // 形态重连 repull 时点的清单种子经此写点反映到进度态）
    syncTitle(sessionId);
    syncProgress();
    // 复位顺序先于清空：streaming 槽引用的容器随 messages.clear() 一并摘除，
    // 先置 null 防孤儿引用继续 setText 到已弃容器
    streaming = null;
    // 增强 5：进度面板清板（瞬时面不跨 repaint 保存——切入会话的在飞工具行不
    // 跨会话带）；增强 6：用量尾注清除 + 累计归零（尾注只属本视角所见轮次——
    // 切走期间的 turn 归非聚焦摘要不累计，归零防跨会话混账；聚焦侧状态行由
    // 下方 running 两态分支覆写）
    clearActivity();
    usageAcc = null;
    messages.clear();
    messages.invalidate();
    renderHistoryInto(sessionId);
    // 在飞两态语义（S3 冷读 must-fix）：切入时已完结的消息经历史投影补齐（上面
    // renderHistoryInto）；切入时仍在流式的消息（message_start 已错过、终值在
    // 任何投影里都不存在）——开空流式占位槽，后续 message_update 的 partial 是
    // 全量快照、直推整块替换即自然续流（无需 message_start）
    const running = sessionId !== undefined && opts.entryStatus?.(sessionId) === 'running';
    if (running) {
      openStreaming();
      // 增强 3：切入在飞会话——转轮续转
      statusLoader.setMessage(' 工作中');
      statusLoader.start();
    } else {
      statusLoader.stop();
      statusLoader.setMessage('');
    }
    // 增强 4：面板随聚焦会话重画（第一触发时点）
    refreshTodo();
    tui.requestRender();
  };

  return {
    handle,
    handleActivity,
    repaint,
    ui() {
      return backend;
    },
    start() {
      // 终端态复原钩子武装（TUI-1）：真终端判据（instanceof）防测试注入终端污染
      // exit 钩子清单；复起路同样重挂（arm 幂等——先解除旧钩子再挂新的）；增强 7
      // 起传标题基线（退出钩子镜像 stop() 末写的 title 复原）
      if (terminal instanceof ProcessTerminal) armTerminalRestore(opts.title);
      // 增强 7：外显起屏同步（首起与复起两路同过——title 聚焦在案即缀短 id
      // 〔focusIdFor 活取，D4「起屏一次同解析」先例同款〕；进度态分源重估——
      // attach 形态真握手清单种子先于 start 落簿，busyFor 首写即真值）
      syncTitle(opts.focusIdFor?.());
      syncProgress();
      // 复起路（批 C 桌面换防——stop 后再 start）：组件树跨停屏保连续，不重拉
      // 历史（重拉即重复行）；桌面引擎曾在屏上绘过，差分基线（previousLines）
      // 已失真——force 复位渲染状态强制全帧重画
      if (screenStarted) {
        tui.setFocus(editor);
        tui.start();
        tui.requestRender(true);
        return;
      }
      screenStarted = true;
      // 起屏历史：undefined = 当前聚焦（壳闭包解析——boot 路 focus 通知早于订阅，
      // 初始渲染不走 repaint 而走本路；此后 focus 变化全走 repaint 显式键）
      // D4 theme：起屏换装同路（B1 冷读裁决——起屏聚焦会话的主题不经 repaint，
      // 在此显式应用；undefined = 当前聚焦，与 history 同款语义）
      applyTheme(undefined);
      renderHistoryInto(undefined);
      // 增强 4：起屏拉一次当前聚焦 todo（trackedSessionId 起屏路 undefined——宿主闭包解析聚焦）
      refreshTodo();
      tui.setFocus(editor);
      tui.start();
    },
    stop(options) {
      // 增强 8：换防/停屏先收副屏（幂等——未开即无操作）；编舞 = 副屏 stop →
      // 主屏 restore/start 随即被下方 tui.stop 再停——事件树全程连续不丢行
      closeViewer();
      tui.stop(options);
      // 增强 3：停轮（interval 清理——停屏期转轮空转纯噪声）
      statusLoader.stop();
      // 增强 7：外显复原写点①（stop——换防去系统桌面栈）：进度态清零（pi-tui
      // setProgress(false) 清 OSC 9;4 + keepalive interval）+ 标题回基线（与
      // armTerminalRestore 退出钩子两写点同复原——正常停屏归本写点单源，崩溃
      // 窗归钩子镜像）；强制写位（不去重——跨 stop/start 周期的镜像一致）
      progressShown = false;
      terminal.setProgress(false);
      if (opts.title !== undefined && titleShown !== opts.title) {
        titleShown = opts.title;
        terminal.setTitle(opts.title);
      }
      // 正常停屏解除复原钩子（TUI-1）：tui.stop() 已做全部复位，退出时不再重复写
      disarmTerminalRestore?.();
    },
    /**
     * 退出兜底（interrupt 小刀：cancelAll 生产调用者从无到有）：收场无 run
     * 属主的在身提问（服务路 ask——ctx.exec/ctx.fetch 消费面）与任何漏网——
     * run 属主 ask 已由 per-ask signal 撤销，本面是队首永不搁浅的最后一道闸。
     * 调用时点 = tui-main 退出序列 front.quit 之后、front.settle 之前。
     */
    cancelAsks() {
      prompts.cancelAll();
    },
  };
}
