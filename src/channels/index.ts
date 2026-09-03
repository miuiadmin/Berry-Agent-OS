/**
 * L4 channels — 模块公开面（内核篇模块表 #14）。
 *
 * 界面与传输层：订阅 loop 活体事件渲染展示、经 host 面提交用户输入；
 * 不感知 loop/session 内部（拔掉通道对话照完成）。M1 首发 TUI 单通道
 * （技术栈篇 §4.1），Web 通道随后续里程碑接入——UiBackend/聚合器/
 * 命令注册表都是通道无关的。
 */

export type {
  ChannelHost,
  CommandDefinition,
  InputOptions,
  NotifyLevel,
  NotifyOptions,
  RendererDefinition,
  UiBackend,
  UiChoice,
  UiService,
} from './types.js';
export type { ChannelsService } from './types.js';

export { createCommandRegistry, type CommandRegistry } from './commands.js';
export { createUiService, parseBooleanAnswer } from './ui.js';
export { createPromptQueue, type PromptIo, type PromptQueue } from './prompt.js';
export { assistantText, assistantToolLines, joinTextContent, renderAgentMessage, truncate } from './render.js';
export {
  createChannelsService,
  registerChannelServices,
  registerChannelsService,
  registerUiService,
  type ChannelsServiceEntity,
} from './service.js';
// 官方件本体（Ring 1 行树化批，契约篇 §6.8——builtin:channels 行 apply 面）
export { createChannelsApp, type ChannelsAppDeps } from './app.js';
export { createTuiChannel, type TuiChannel, type TuiChannelOptions } from './tui.js';
