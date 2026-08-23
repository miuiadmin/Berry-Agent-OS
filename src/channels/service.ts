/**
 * L4 channels — ctx.channels / ctx.ui 服务装配（骨架篇 §9.2/§9.3）。
 *
 * ChannelsService 持有命令与渲染器两个注册表（ctx.channels.registerCommand /
 * registerRenderer 的落点）；UiService 聚合器见 ui.ts。ctx.provide 自带
 * 作用域 LIFO 回卷，无需手动 effect 接线。
 */

import type { Context, Disposer } from '../context/types.js';
import { createCommandRegistry, type CommandRegistry } from './commands.js';
import { createUiService } from './ui.js';
import type { ChannelsService, RendererDefinition, UiService } from './types.js';

/** 通道服务实体（公开面 + 命令注册表直通——通道壳派发用） */
export type ChannelsServiceEntity = ChannelsService & { readonly commands: CommandRegistry };

/** 组装通道服务（命令注册表 + 渲染器注册表二合一；通道壳从这取查找面） */
export function createChannelsService(): ChannelsServiceEntity {
  const commands = createCommandRegistry();
  /** 渲染器表（角色 → 定义；同角色后写胜出） */
  const renderers = new Map<string, RendererDefinition>();

  const service: ChannelsServiceEntity = {
    commands,
    registerCommand(cmd) {
      return commands.register(cmd);
    },
    registerRenderer(renderer) {
      renderers.set(renderer.role, renderer);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        // 仅当仍是本定义时移除（防误摘后写胜出者）
        if (renderers.get(renderer.role) === renderer) renderers.delete(renderer.role);
      };
    },
    listCommands() {
      return commands.list();
    },
    rendererFor(role) {
      return renderers.get(role);
    },
  };
  return service;
}

/** 把通道服务挂进 ctx（ctx.provide('channels')，随作用域 LIFO 回卷） */
export function registerChannelsService(ctx: Context, service: ChannelsService): Disposer {
  return ctx.provide('channels', service);
}

/** 把 UI 聚合器挂进 ctx（ctx.provide('ui')，随作用域 LIFO 回卷） */
export function registerUiService(ctx: Context, service: UiService): Disposer {
  return ctx.provide('ui', service);
}

/** 便捷装配：组两个服务并挂进 ctx（app 组合根单入口用；随作用域自动回卷） */
export function registerChannelServices(ctx: Context): { channels: ChannelsServiceEntity; ui: UiService } {
  const channels = createChannelsService();
  const ui = createUiService();
  registerChannelsService(ctx, channels);
  registerUiService(ctx, ui);
  return { channels, ui };
}
