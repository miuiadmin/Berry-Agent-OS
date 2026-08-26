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
  Container,
  Editor,
  ScrollView,
  Text,
  TuiMainScreen,
  VStack,
  parseKey,
  type Component,
  type EditorTheme,
  type Terminal,
  type TUI,
} from '@earendil-works/pi-tui';
import { ProcessTerminal } from '@earendil-works/pi-tui';
import type { AgentEvent } from '../agent/events.js';
import type { AgentMessage } from '../contracts/messages.js';
import { isStandardMessage } from '../contracts/messages.js';
import { chainBackground } from '../context/chain.js';
import { assistantText, assistantToolLines, formatToolEnd, formatToolStart, renderAgentMessage } from './render.js';
import { createPromptQueue } from './prompt.js';
import type { CommandRegistry } from './commands.js';
import type { ChannelHost, InputOptions, NotifyLevel, RendererDefinition, UiBackend } from './types.js';

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
  /** 标题行文案（缺省不渲染标题） */
  readonly title?: string;
  /** 历史投影拉取（S3 按会话键取：undefined = 当前聚焦〔起屏路，壳闭包解析〕；repaint 重画显式带键——通道不持注册表，宿主注入闭包路由） */
  readonly history?: (sessionId?: string) => readonly AgentMessage[];
  /** 条目运行态查询（S3 切入在飞会话判据——状态行/流式占位槽；退役条目宿主侧按 idle 呈现；通道不持注册表） */
  readonly entryStatus?: (sessionId: string) => 'running' | 'idle' | undefined;
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
  /** 起屏（装配完再调；接管终端输入） */
  start(): void;
  /** 停屏（恢复终端；不 resolve 在身提问——退出序列由宿主编排） */
  stop(): void;
}

/** 无着色主题（恒等函数；着色后续随主题篇定稿） */
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

/** 级别 → 通知行前缀 */
const NOTIFY_PREFIX: Record<NotifyLevel, string> = { info: 'ℹ', warn: '⚠', error: '✖' };

/** 组装 TUI 通道 */
export function createTuiChannel(opts: TuiChannelOptions): TuiChannel {
  const terminal = opts.terminal ?? new ProcessTerminal();
  const tui: TUI = new TuiMainScreen(terminal);

  /* ---- 组件树：消息流（滚动跟随）/ 状态行 / 输入框 / 提示行 ---- */
  /** 消息流内容（逐条 append Text；ScrollView 跟随末端） */
  const messages = new Container();
  const scrollView = new ScrollView(messages, { follow: 'end', primary: true });
  /** 状态行（setStatus 更新；空串 = 空） */
  const statusText = new Text('');
  const editor = new Editor(tui, EDITOR_THEME);
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  /** 底部提示行（快捷键说明，装配期固定） */
  const footerText = new Text(
    opts.title
      ? ` ${opts.title} — Enter 发送 / / 命令 / Ctrl+D·Ctrl+C 退出`
      : ' Enter 发送 / / 命令 / Ctrl+D·Ctrl+C 退出',
  );

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

  /** 追加若干展示行（每行一个 Text；请求重绘） */
  const appendLines = (lines: readonly string[]): void => {
    for (const line of lines) messages.addChild(new Text(line, 1));
    messages.invalidate();
    tui.requestRender();
  };

  /** 流式 assistant 块（message_start 开、update 原地 setText、end 定稿） */
  let streaming: { container: Container; text: Text } | null = null;

  /** 打开流式块（首帧占位 …；后续 update 覆盖） */
  const openStreaming = (): void => {
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
  // raw mode 下 Ctrl+C 不产生 SIGINT 信号而是输入字节——在此拦下与 Ctrl+D 同走优雅退出
  const quitKeys = new Set(['ctrl+d', 'ctrl+c']);
  tui.addInputListener((data) => {
    const key = parseKey(data);
    if (key !== undefined && quitKeys.has(key)) {
      opts.host.requestQuit();
      return { consume: true };
    }
    return undefined;
  });
  /* ---- 活体事件入口（骨架篇 §2.5 十型） ---- */
  const handle = (event: AgentEvent): void => {
    switch (event.type) {
      case 'agent_start':
        statusText.setText(' ● 工作中');
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
          closeStreaming(assistantText(event.message), assistantToolLines(event.message));
        }
        // user/toolResult/自定义角色在 message_start 已渲染，这里不重复
        break;
      case 'tool_execution_start':
        appendLines([`  ${formatToolStart(event.toolName, event.args)}`]);
        break;
      case 'tool_execution_update':
        break; // 工具进度 M1 不展示（进度渲染随 Web 通道形态定稿再补）
      case 'tool_execution_end':
        appendLines([`  ${formatToolEnd(event.result, event.isError)}`]);
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
    async confirm(message) {
      // priority 随链取数（S5 后台 run 的确认降级排队——契约篇 §5.4）；取消收场
      // 的 undefined 按 false（fail-closed：不批准 = 安全缺省）
      const answer = await prompts.ask(`${message} [y/n]`, {
        priority: chainBackground() ? 'background' : 'interactive',
      });
      if (answer === undefined) return false;
      const parsed = /^(y|yes|是)$/i.test(answer.trim());
      return parsed; // 未识别按 false（fail-closed，与技术栈篇 §4.3 精神一致）
    },
    async input(message, ioOpts?: InputOptions) {
      // priority 同 confirm；取消收场的 undefined 归一为 ''（UiService.input 的
      // 「无输入」既有语义——消费方零新分支）
      const answer = await prompts.ask(ioOpts?.placeholder ? `${message}（${ioOpts.placeholder}）` : message, {
        priority: chainBackground() ? 'background' : 'interactive',
      });
      return answer ?? '';
    },
    // select/setWidget 不支持——ctx.ui 聚合器按 §4.3 降级规则处理
  };

  /* ---- 非聚焦活动摘要（S3 信封分流后台腿） ---- */
  const handleActivity = (sessionId: string, event: AgentEvent): void => {
    const short = sessionId.slice(0, 8);
    switch (event.type) {
      case 'agent_start':
        appendLines([`⧗ 会话 ${short} 后台工作中`]);
        break;
      case 'agent_end':
        appendLines([`✓ 会话 ${short} 后台完成`]);
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
    statusText.setText(running ? ' ● 工作中' : '');
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
      // 起屏历史：undefined = 当前聚焦（壳闭包解析——boot 路 focus 通知早于订阅，
      // 初始渲染不走 repaint 而走本路；此后 focus 变化全走 repaint 显式键）
      renderHistoryInto(undefined);
      tui.setFocus(editor);
      tui.start();
    },
    stop() {
      tui.stop();
    },
  };
}
