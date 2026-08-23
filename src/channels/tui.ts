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
import type { AgentMessage } from '../agent/messages.js';
import { isStandardMessage } from '../agent/messages.js';
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
  /** 终端注入（缺省 ProcessTerminal；测试/特殊终端用） */
  readonly terminal?: Terminal;
  /** 标题行文案（缺省不渲染标题） */
  readonly title?: string;
  /** 历史投影拉取（start 时渲染一遍；app 注入 session.deriveMessages 类回调） */
  readonly history?: () => readonly AgentMessage[];
}

/** TUI 通道面（app 组合根持有） */
export interface TuiChannel {
  /** 活体事件入口（组合根把 loop 的 AgentEventSink 直连到这里） */
  handle(event: AgentEvent): void;
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

  /* ---- 输入路由：提问答案 > 斜杠命令 > 普通消息 ---- */
  editor.onSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return; // 空提交忽略（防误触；退出走 Ctrl+D）
    if (prompts.handleSubmit(trimmed)) return;
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
          appendLines(renderAgentMessage(event.message, opts.rendererFor));
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
      const answer = await prompts.ask(`${message} [y/n]`);
      const parsed = /^(y|yes|是)$/i.test(answer.trim());
      return parsed; // 未识别按 false（fail-closed，与技术栈篇 §4.3 精神一致）
    },
    async input(message, ioOpts?: InputOptions) {
      return prompts.ask(ioOpts?.placeholder ? `${message}（${ioOpts.placeholder}）` : message);
    },
    // select/setWidget 不支持——ctx.ui 聚合器按 §4.3 降级规则处理
  };

  return {
    handle,
    renderHistory(history) {
      for (const message of history) appendLines(renderAgentMessage(message, opts.rendererFor));
    },
    ui() {
      return backend;
    },
    start() {
      if (opts.history) {
        const history = opts.history();
        for (const message of history) appendLines(renderAgentMessage(message, opts.rendererFor));
      }
      tui.setFocus(editor);
      tui.start();
    },
    stop() {
      tui.stop();
    },
  };
}
