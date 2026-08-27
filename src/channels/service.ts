/**
 * L4 channels — ctx.channels / ctx.ui 服务装配（骨架篇 §9.2/§9.3）。
 *
 * ChannelsService 持有命令与渲染器两个注册表（ctx.channels.registerCommand /
 * registerRenderer 的落点）；UiService 聚合器见 ui.ts。ctx.provide 自带
 * 作用域 LIFO 回卷，无需手动 effect 接线。
 */

import type { Context, Disposer } from '../context/types.js';
import { chainCaller } from '../context/chain.js';
import { AppError, COMPOSITION_ROW_INVALID } from '../contracts/errors.js';
import type { RowAppProbe } from '../contracts/plugin.js';
import { createCommandRegistry, type CommandRegistry } from './commands.js';
import { createUiService } from './ui.js';
import type { ChannelsService, RendererDefinition, UiService } from './types.js';

/** 通道服务实体（公开面 + 命令注册表直通——通道壳派发用） */
export type ChannelsServiceEntity = ChannelsService & { readonly commands: CommandRegistry };

/**
 * 组装通道服务（命令注册表 + 渲染器注册表二合一；通道壳从这取查找面）。
 * @param opts.rowApp 行挂载目标投影（D1 注册面路由裁死，契约篇 §5.1）：挂应用
 *   组合的行注册 TUI 命令 = 装载期拒绝——命令单表无域层（全局命令面），app 行
 *   注册即跨应用漏命令。渲染器 registerRenderer v1 维持全局（规范未裁，同族
 *   域层挂账随首个真实第三方需求）。缺省不接 = 不执法（纯测试/诊断面）。
 */
export function createChannelsService(opts?: { rowApp?: RowAppProbe }): ChannelsServiceEntity {
  const commands = createCommandRegistry();
  /** 渲染器表（角色 → 定义；同角色后写胜出） */
  const renderers = new Map<string, RendererDefinition>();

  const service: ChannelsServiceEntity = {
    commands,
    registerCommand(cmd) {
      // D1 app 行拒载（契约篇 §5.1 注册面路由裁死，2026-08-27）：caller 链带行
      // id（装载器 apply 帧）且该行挂应用组合 → 拒绝——命令单表无域层，app 行
      // 注册 = 跨应用漏命令破坏隔离。抛错即行失败（装载期拒绝）
      const rowId = chainCaller();
      const appId = rowId !== undefined ? opts?.rowApp?.get(rowId) : undefined;
      if (appId !== undefined) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `TUI 命令注册被拒：行 ${rowId} 挂应用组合（app: ${appId}）——应用行的命令注册 v1 裁死拒载` +
            `（命令单表无域层，防跨应用漏命令破坏隔离；契约篇 §5.1 D1 注册面路由）`,
        );
      }
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

/**
 * 便捷装配：组两个服务并挂进 ctx（app 组合根单入口用；随作用域自动回卷）。
 * @param opts.onUiError UI 广播异常诊断回调（隔离案一第一刀 #3——组合根接
 *   ctx.logger，坏后端异常「有信号」不静默吞）
 * @param opts.rowApp 行挂载目标投影（透传 createChannelsService——D1 注册面
 *   路由，契约篇 §5.1；组合根维护的活闭包，构造时点先于组合树合成无碍）
 */
export function registerChannelServices(
  ctx: Context,
  opts?: { onUiError?: (err: unknown, op: 'notify' | 'setStatus') => void; rowApp?: RowAppProbe },
): { channels: ChannelsServiceEntity; ui: UiService } {
  const channels = createChannelsService({ ...(opts?.rowApp !== undefined ? { rowApp: opts.rowApp } : {}) });
  const ui = createUiService({ onError: opts?.onUiError });
  registerChannelsService(ctx, channels);
  registerUiService(ctx, ui);
  return { channels, ui };
}
