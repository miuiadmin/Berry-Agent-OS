/**
 * L4 channels — 斜杠命令注册表与解析派发（骨架篇 §9.3 ctx.channels.registerCommand）。
 *
 * 纯注册表模块（无 UI 依赖）：解析 '/name args'、同名后写胜出（与组合树
 * 语义一致）、派发把 handler 错误原样上抛（通道壳负责兜底为通知，不崩界面）。
 */

import type { CommandDefinition } from './types.js';

/** 命令注册表面 */
export interface CommandRegistry {
  /** 注册命令（同名后写胜出；返回注销器——仅当仍是本命令时摘除，幂等） */
  register(cmd: CommandDefinition): () => void;
  /** 解析输入文本为命令（非 '/' 开头返回 null；args 为剩余文本含空格原样） */
  parse(text: string): { name: string; args: string } | null;
  /** 按名查命令（未知名 undefined） */
  lookup(name: string): CommandDefinition | undefined;
  /** 已注册命令清单（按名排序；/help 展示） */
  list(): readonly CommandDefinition[];
  /** 派发结果：'not-command'=非命令输入 / 'ok'=已派发 / 'unknown'=未知名 */
  dispatch(text: string): Promise<'not-command' | 'ok' | 'unknown'>;
  /**
   * 订阅注册面变更（注册胜出/注销摘除即触发；返回退订器）。消费面 = TUI
   * autocomplete 投影重建（M4，2026-08-27 第三十三批：命令名清单是 pi-tui
   * provider 构造参数静态快照，注册面任何变动后须重投影——与 skills 的
   * onProvidersChange 同构：注册表自持通知，宿主不编排时点）。
   */
  onChange(listener: () => void): () => void;
}

/** 组装命令注册表 */
export function createCommandRegistry(): CommandRegistry {
  /** 命令表（name → 定义；同名注册后写胜出） */
  const commands = new Map<string, CommandDefinition>();
  /** 注册面变更监听器（autocomplete 投影重建用；快照迭代防重入） */
  const changeListeners = new Set<() => void>();
  /** 触发注册面变更通知（注册胜出/注销摘除两时点；异常不外溢——通知是辅助面） */
  const notifyChange = (): void => {
    for (const listener of [...changeListeners]) {
      try {
        listener();
      } catch {
        // 监听器自身异常不拖垮注册路径（投影重建失败只是补全面退化）
      }
    }
  };

  const registry: CommandRegistry = {
    register(cmd) {
      commands.set(cmd.name, cmd);
      notifyChange(); // 注册/后写胜出均触发（投影须见最新胜出者）
      let done = false;
      return () => {
        if (done) return;
        done = true;
        // 仅当仍是本定义时移除（防误摘后写者的同名胜出）
        if (commands.get(cmd.name) === cmd) {
          commands.delete(cmd.name);
          notifyChange(); // 摘除即触发（投影不能再列已注销命令）
        }
      };
    },

    parse(text) {
      const trimmed = text.trim();
      if (!trimmed.startsWith('/')) return null;
      // 命令名 = '/' 后到首个空白前的段；其余（含多行）为 args
      const match = /^\/(\S+)[ \t]*([\s\S]*)$/.exec(trimmed);
      if (!match) return { name: trimmed.slice(1), args: '' };
      return { name: match[1]!, args: match[2] ?? '' };
    },

    lookup(name) {
      return commands.get(name);
    },

    list() {
      return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    async dispatch(text) {
      const parsed = registry.parse(text);
      if (!parsed) return 'not-command';
      const cmd = commands.get(parsed.name);
      if (!cmd) return 'unknown';
      // handler 错误向上抛——通道壳 catch 后以通知呈现（命令错误是数据不是崩溃）
      await cmd.handler(parsed.args);
      return 'ok';
    },

    onChange(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
  };
  return registry;
}
