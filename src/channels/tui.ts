/**
 * L4 channels — TUI 通道（技术栈篇 §4.1 M1 首发通道）。
 *
 * pi-tui 差分渲染组件库装配的终端全屏对话界面：消息流（ScrollView
 * follow-end）+ 状态行 + 输入框（Editor）+ 快捷键提示行。通道契约
 * （内核篇 #14）：handle() 消费 loop 活体事件（app 组合根把 AgentEventSink
 * 接到这里）、renderHistory() 拉投影（app 注入回调）——本通道不 import
 * loop/session 实现，拔掉后对话照跑。
 *
 * 阻塞式交互（confirm/input）经提问队列占用输入框（prompt 模式）；select
 * 不支持——由 ctx.ui 聚合器降级为 input（§4.3 降级规则）。壳薄逻辑少：
 * 渲染格式在 render.ts、提问排队在 prompt.ts、命令在 commands.ts。
 */

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  ScrollView,
  Text,
  TuiMainScreen,
  VStack,
  matchesKey,
  parseKey,
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
  type SlashCommand,
  type Terminal,
  type TUI,
} from '@earendil-works/pi-tui';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import type { AgentEvent } from '../agent/events.js';
import type { AgentMessage } from '../contracts/messages.js';
import { isStandardMessage } from '../contracts/messages.js';
import { chainBackground } from '../context/chain.js';
import { assistantErrorLine, assistantText, assistantToolLines, renderAgentMessage } from './render.js';
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
  /** 启动时渲染历史投影（拉投影经注入回调——通道不依赖 session） */
  renderHistory(messages: readonly AgentMessage[]): void;
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

/* ---- 终端态复原（TUI-1，第十轮 TUI 专项扫雷 20260904；骨架篇 §1.3 终端态复原条款） ---- */

/** 已武装复原钩子的解除器（模块级单例——一进程一真终端；重复武装先解除旧的） */
let disarmTerminalRestore: (() => void) | null = null;

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
 */
function armTerminalRestore(): void {
  disarmTerminalRestore?.();
  const restore = (): void => {
    try {
      process.stdout.write('\x1b]9;4;0\x07'); // OSC 9;4 进度态清零（镜像 stop() 首写）
      process.stdout.write('\x1b[?2004l'); // 括号粘贴模式关闭
      process.stdout.write('\x1b[<u'); // kitty 键盘协议弹栈（空栈弹栈合法）
      process.stdout.write('\x1b[>4;0m'); // modifyOtherKeys 复位缺省
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
  const tui: TUI = new TuiMainScreen(terminal);
  /** 起屏旗标（批 C 桌面换防）：首起拉历史投影，停屏后复起只全量重画不重拉 */
  let screenStarted = false;

  /* ---- 组件树：消息流（滚动跟随）/ 状态行 / 输入框 / 提示行 ---- */
  /** 消息流内容（逐条 append Text；ScrollView 跟随末端） */
  const messages = new Container();
  const scrollView = new ScrollView(messages, { follow: 'end', primary: true });
  /** 状态行（setStatus 更新；空串 = 空） */
  const statusText = new Text('');
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
        ...(cmd.argumentHint !== undefined ? { argumentHint: cmd.argumentHint } : {}),
        ...(cmd.getArgumentCompletions !== undefined
          ? {
              // 参数回调实时查注册表（/reload 后重注册的命令体即取即用）；readonly
              // 数组转 mutable（pi-tui 面非 readonly）
              getArgumentCompletions: async (
                prefix: string,
              ): Promise<{ value: string; label: string; description?: string }[] | null> => {
                const current = opts.commands.lookup(cmd.name);
                const items = await current?.getArgumentCompletions?.(prefix);
                return items && items.length > 0 ? items.map((item) => ({ ...item })) : null;
              },
            }
          : {}),
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
  /** 尾段（发送/命令/退出提示——恒不着色） */
  const footerRest = opts.title
    ? ` — Enter 发送 / / 命令 / ${opts.quitHint ?? 'Ctrl+D·Ctrl+C 退出'}`
    : ` Enter 发送 / / 命令 / ${opts.quitHint ?? 'Ctrl+D·Ctrl+C 退出'}`;
  const footerText = new Text(footerTitlePart + footerRest);

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
    footerText.setText(focusColorize(footerTitlePart) + footerRest);
    footerText.invalidate();
    // 保底请求重绘：起屏空历史路（renderHistoryInto 零追加行）无其他渲染触发，
    // footer 换装需自带一次 requestRender（幂等调度，repaint 路多一次无害）
    tui.requestRender();
  };

  const layoutRoot = new VStack([
    { component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: statusText, basis: 'auto', grow: 0, shrink: 1, minSize: 0 },
    { component: editorContainer, basis: 'auto', grow: 0, shrink: 1, minSize: 3 },
    { component: footerText, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
  ]);
  tui.addChild(messages);
  tui.addChild(statusText);
  tui.addChild(editorContainer);
  tui.addChild(footerText);
  // 布局根接管排布（组件仍挂 tui 树上；差分渲染走 ScrollView）
  if ('setLayoutRoot' in tui) {
    (tui as { setLayoutRoot(component: Component | undefined): void }).setLayoutRoot(layoutRoot);
  }

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

  /** 定稿流式块（终值文本 + 工具调用行；无流式块则直接落行——如重放） */
  const closeStreaming = (finalText: string, toolLines: readonly string[]): void => {
    if (streaming) {
      messages.removeChild(streaming.container);
      streaming = null;
    }
    appendLines([...finalText.split('\n').filter((l) => l !== ''), ...toolLines]);
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
    // 命令在通道本地派发（命令错误兜底为通知，不崩界面）；命令无时间线事件，本地回显
    if (trimmed.startsWith('/')) {
      appendLines([`❯ ${trimmed}`]);
      opts.commands
        .dispatch(trimmed)
        .then((result) => {
          if (result === 'unknown') appendLines([`✖ 未知命令：${trimmed.split(' ')[0]}（/help 查看清单）`]);
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
  /* ---- 活体事件入口（骨架篇 §2.5 十型） ---- */
  const handle = (event: AgentEvent): void => {
    switch (event.type) {
      case 'agent_start':
        // D4 theme：● 指示符着聚焦 accent（focusColorize——repaint/起屏时点已重算）；
        // 「工作中」长文本不着（着色克制律）
        statusText.setText(`${focusColorize(' ●')} 工作中`);
        statusText.invalidate();
        tui.requestRender();
        break;
      case 'agent_end':
        // 防漏关（S3）：在飞占位槽开着一轮无 message_end 即结束（abort 中断路）
        // ——空终值关槽（closeStreaming 内 filter 空串，零追加行）
        if (streaming) closeStreaming('', []);
        statusText.setText('');
        statusText.invalidate();
        tui.requestRender();
        break;
      case 'turn_start':
      case 'turn_end':
        break; // 消息级事件已覆盖展示；turn 边界不额外渲染
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
          // 失败行随流式收尾一并落屏（#42）：content 空的失败 run 也有 ✖ [错误] 一行
          closeStreaming(assistantText(event.message), [
            ...assistantToolLines(event.message),
            ...assistantErrorLine(event.message),
          ]);
        }
        // user/toolResult/自定义角色在 message_start 已渲染，这里不重复
        break;
      case 'tool_execution_start':
        // 不渲染（直播路单源，20260901-d #5）：⚙ 行随 assistant message_end 的
        // assistantToolLines 落（时点更早——message_end 先于执行发出）；本事件
        // 是执行层锚点（webui 直播卡等消费面照用事件扇出），TUI 不双源双帧
        break;
      case 'tool_execution_update':
        break; // 工具进度 M1 不展示（进度渲染随 Web 通道形态定稿再补）
      case 'tool_execution_end':
        // 不渲染（#5 同批）：↳ 行随 toolResult message_start 的 renderAgentMessage
        // 落——与历史投影（repaint）同一渲染器，直播/重画行集恒一致
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
      statusText.setText(status ? ` ${status}` : '');
      statusText.invalidate();
      tui.requestRender();
    },
    async confirm(message, opts?: UiAskOptions) {
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
        appendLines([`${colorize(`⧗ 会话 ${short}`)} 后台工作中`]);
        break;
      case 'agent_end':
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
  /** 按会话键拉历史并渲染（repaint 重画与 start 起屏两路共用——单一历史渲染路径） */
  const renderHistoryInto = (sessionId: string | undefined): void => {
    const history = opts.history ? opts.history(sessionId) : [];
    for (const message of history) appendLines(renderAgentMessage(message, opts.rendererFor, opts.onRendererError));
  };
  const repaint = (sessionId: string | undefined): void => {
    // D4 theme：换装先行（清屏重画时点按目标会话重算聚焦着色器——边框/页脚
    // 随之换装；后续 statusText 写点读新 focusColorize）
    applyTheme(sessionId);
    // 复位顺序先于清空：streaming 槽引用的容器随 messages.clear() 一并摘除，
    // 先置 null 防孤儿引用继续 setText 到已弃容器
    streaming = null;
    messages.clear();
    messages.invalidate();
    renderHistoryInto(sessionId);
    // 在飞两态语义（S3 冷读 must-fix）：切入时已完结的消息经历史投影补齐（上面
    // renderHistoryInto）；切入时仍在流式的消息（message_start 已错过、终值在
    // 任何投影里都不存在）——开空流式占位槽，后续 message_update 的 partial 是
    // 全量快照、直推整块替换即自然续流（无需 message_start）
    const running = sessionId !== undefined && opts.entryStatus?.(sessionId) === 'running';
    if (running) openStreaming();
    // D4 theme：● 指示符随本会话 accent（applyTheme 已在 repaint 开头重算）
    statusText.setText(running ? `${focusColorize(' ●')} 工作中` : '');
    statusText.invalidate();
    tui.requestRender();
  };

  return {
    handle,
    handleActivity,
    repaint,
    renderHistory(history) {
      for (const message of history) appendLines(renderAgentMessage(message, opts.rendererFor, opts.onRendererError));
    },
    ui() {
      return backend;
    },
    start() {
      // 终端态复原钩子武装（TUI-1）：真终端判据（instanceof）防测试注入终端污染
      // exit 钩子清单；复起路同样重挂（arm 幂等——先解除旧钩子再挂新的）
      if (terminal instanceof ProcessTerminal) armTerminalRestore();
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
      tui.setFocus(editor);
      tui.start();
    },
    stop(options) {
      tui.stop(options);
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
