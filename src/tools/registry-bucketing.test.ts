/**
 * ToolRegistry builtin / plugin 分桶单测（§5.3.9）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { ToolRegistry, listBuiltinTools, listPluginTools, getToolOrigin, registerBuiltinTool, registerTool } from './index.js';

function makeTool(name: string, description = `test ${name}`): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.object({ input: z.string() }),
    dangerLevel: 'safe',
    execute: async () => ({ content: `${name} result` }),
  };
}

describe('ToolRegistry builtin / plugin bucketing (§5.3.9)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry([
      makeTool('read_file'),
      makeTool('write_file'),
    ]);
  });

  it('构造时注册的工具标记为 builtin', () => {
    expect(registry.getOrigin('read_file')).toBe('builtin');
    expect(registry.getOrigin('write_file')).toBe('builtin');
  });

  it('register() 注册的默认为 plugin', () => {
    registry.register(makeTool('plugin_tool'));
    expect(registry.getOrigin('plugin_tool')).toBe('plugin');
  });

  it('registerWithOrigin 可显式指定 origin', () => {
    registry.registerWithOrigin(makeTool('custom_builtin'), 'builtin');
    expect(registry.getOrigin('custom_builtin')).toBe('builtin');
  });

  it('listBuiltinTools 只返回 builtin', () => {
    registry.register(makeTool('plugin_a'));
    registry.register(makeTool('plugin_b'));
    const builtins = registry.listBuiltinTools().map(t => t.name);
    expect(builtins).toContain('read_file');
    expect(builtins).toContain('write_file');
    expect(builtins).not.toContain('plugin_a');
  });

  it('listPluginTools 只返回 plugin', () => {
    registry.register(makeTool('plugin_a'));
    registry.register(makeTool('plugin_b'));
    const plugins = registry.listPluginTools().map(t => t.name);
    expect(plugins).toContain('plugin_a');
    expect(plugins).toContain('plugin_b');
    expect(plugins).not.toContain('read_file');
  });

  it('重新 register 同名工具会覆盖 origin', () => {
    registry.register(makeTool('read_file'));  // 覆盖 read_file 为 plugin
    expect(registry.getOrigin('read_file')).toBe('plugin');
  });

  it('getAll 返回所有工具（不区分 origin）', () => {
    registry.register(makeTool('plugin_a'));
    expect(registry.getAll().map(t => t.name).sort()).toEqual(['plugin_a', 'read_file', 'write_file']);
  });

  it('clearNames 同时移除 builtin 和 plugin', () => {
    registry.register(makeTool('plugin_a'));
    registry.clearNames(['read_file', 'plugin_a']);
    expect(registry.get('read_file')).toBeUndefined();
    expect(registry.get('plugin_a')).toBeUndefined();
  });
});

describe('defaultRegistry 全局 API', () => {
  it('listBuiltinTools 至少包含 read_file', () => {
    const builtins = listBuiltinTools().map(t => t.name);
    expect(builtins).toContain('read_file');
    expect(builtins).toContain('write_file');
  });

  it('listPluginTools 默认为空（插件按需 register）', () => {
    expect(listPluginTools()).toEqual([]);
  });

  it('getToolOrigin 对 builtin 工具返回 builtin', () => {
    expect(getToolOrigin('read_file')).toBe('builtin');
  });

  it('registerBuiltinTool 把已有工具提升为 builtin', () => {
    // 模拟一个原本是 plugin 的工具
    registerTool(makeTool('promoted_tool'));
    expect(getToolOrigin('promoted_tool')).toBe('plugin');
    registerBuiltinTool(makeTool('promoted_tool'));  // 提升
    expect(getToolOrigin('promoted_tool')).toBe('builtin');
  });
});