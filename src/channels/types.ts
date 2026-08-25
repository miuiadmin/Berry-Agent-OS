/**
 * L4 channels — 公共类型（内核篇模块表 #14 + 技术栈篇 §4.3 + 骨架篇 §9.3）。
 *
 * 通道 = 界面与传输：TUI / Web / CLI。通道契约（内核篇 §4 硬约束）：
 * 只订阅活体事件流 + 拉投影（经注入回调），不感知 loop 内部——拔掉任何
 * 通道后端对话照样完成。
 */

import type { AgentMessage } from '../contracts/messages.js';
import type { Disposer } from '../context/types.js';

/** 宿主面：通道把用户输入交回宿主（TUI 入口把它接到对话驱动的 submit——
 * running 时入 steering 队列、闲时开 run；装配与命令面见 app/channels 服务） */
export interface ChannelHost {
  /** 普通用户消息（已排除斜杠命令；宿主接对话驱动 submit） */
  submit(text: string): void;
  /** 请求退出（Ctrl+D / quit 命令等）——宿主执行优雅退出序列（骨架篇 §1.3） */
  requestQuit(): void;
}

/** 通知级别（notify 一次性通知；非交互原语纯活体层不落日志） */
export type NotifyLevel = 'info' | 'warn' | 'error';

/** notify 选项 */
export interface NotifyOptions {
  /** 级别（缺省 info；通道据此选择前缀/着色） */
  readonly level?: NotifyLevel;
}

/** input 选项 */
export interface InputOptions {
  /** 占位提示（通道不识别则忽略） */
  readonly placeholder?: string;
}

/** 单选项（select 用；value 是程序值、label 是展示文案） */
export interface UiChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * 通道 UI 后端能力面（TUI/Web/CLI 各自实现）。可选项缺省 = 通道不支持，
 * 聚合器按降级规则处理（select→input、setWidget→notify、confirm→input），
 * 插件不感知通道能力差异（技术栈篇 §4.3）。
 */
export interface UiBackend {
  /** 通道标识（诊断溯源） */
  readonly id: string;
  /** 一次性通知（所有通道必选支持） */
  notify(message: string, opts?: NotifyOptions): void;
  /** 状态行/标题栏更新（所有通道必选支持；空串 = 清空） */
  setStatus(status: string): void;
  /** 是/否确认（可选；不支持则聚合器经 input 降级） */
  confirm?(message: string): Promise<boolean>;
  /** 自由文本输入（可选；交互面基座——select 降级也落到这里） */
  input?(message: string, opts?: InputOptions): Promise<string>;
  /** 单选（可选；不支持则聚合器经 input 降级） */
  select?(message: string, choices: readonly UiChoice[]): Promise<string>;
  /** 自定义渲染槽（可选；不支持则聚合器降级为 notify） */
  setWidget?(node: unknown): void;
}

/** ctx.ui 聚合面（技术栈篇 §4.3 定稿清单；宿主聚合在线通道应答） */
export interface UiService {
  /** 一次性通知：广播到全部在线通道 */
  notify(message: string, opts?: NotifyOptions): void;
  /** 是/否确认（无交互通道时 fail-closed 返回 false） */
  confirm(message: string): Promise<boolean>;
  /** 单选（通道不支持 select 时降级为 input；无交互通道返回 ''） */
  select(message: string, choices: readonly UiChoice[]): Promise<string>;
  /** 自由文本输入（无交互通道返回 ''） */
  input(message: string, opts?: InputOptions): Promise<string>;
  /** 状态行更新：广播到全部在线通道 */
  setStatus(status: string): void;
  /** 自定义渲染槽（通道不识别则降级为 notify） */
  setWidget(node: unknown | null): void;
  /** 通道后端接入/摘除（通道 start/stop 时调用；返回摘除器） */
  attach(backend: UiBackend): Disposer;
}

/** 斜杠命令定义（骨架篇 §9.3 ctx.channels.registerCommand） */
export interface CommandDefinition {
  /** 命令名（不含 '/'；技能命令用 'skill:<name>' 形态，契约篇 §4.5） */
  readonly name: string;
  /** 一句话说明（/help 清单展示） */
  readonly description: string;
  /** 来源标记（'builtin' | 'skill' | 'plugin'；缺省 'builtin'） */
  readonly source?: string;
  /** 命令体（args 为命令名后的剩余文本；抛错由通道壳兜底为通知） */
  handler(args: string): void | Promise<void>;
}

/**
 * 自定义消息渲染器（骨架篇 §9.3 ctx.channels.registerRenderer）：
 * 按消息角色覆盖内置渲染（返回空数组 = 不展示）。
 */
export interface RendererDefinition {
  /** 匹配的消息角色（自定义角色名；或覆盖 'user'/'assistant'/'toolResult' 内置形态） */
  readonly role: string;
  /** 渲染为展示行（纯文本行；通道负责排版上屏） */
  render(message: AgentMessage): string[];
}

/** ctx.channels 服务面（骨架篇 §9.3） */
export interface ChannelsService {
  /** 注册斜杠命令（同名后写胜出；返回注销器，幂等） */
  registerCommand(cmd: CommandDefinition): Disposer;
  /** 注册消息渲染器（同角色后写胜出；返回注销器，幂等） */
  registerRenderer(renderer: RendererDefinition): Disposer;
  /** 已注册命令清单（/help 展示；按名排序） */
  listCommands(): readonly CommandDefinition[];
  /** 查角色渲染器（无则 undefined——调用方回落内置渲染） */
  rendererFor(role: string): RendererDefinition | undefined;
}
