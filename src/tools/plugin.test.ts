/**
 * L2 tools — 官方件 `builtin:tools` 件本体测试（Ring 1 行树化第一刀）。
 *
 * 件 apply 在 fork 作用域执行：provide tools 服务（携带 executor——装饰性行
 * 预防针的正面证据）+ 注册 fs 四件/检索两件 + executor 端到端可执行（read
 * 走真管道：参数校验 → 守门（空链）→ 执行 → 观察态登记）。
 * 装配序/bot 断言在 app/assembly 全栈锁——此处锁件本体的机制面。
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContext } from '../context/index.js';
import type { ContextScope } from '../context/types.js';
import { createToolsPlugin } from './plugin.js';
import type { ToolsService } from './registry.js';

/** 临时工作区（realpath 归一——macOS /var→/private/var 符号链接归一） */
function makeWorkspace(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'tools-plug-')));
}

describe('tools 官方件（Ring 1 行树化件本体，契约篇 §5.1 节奏表）', () => {
  it('apply：fork 作用域上 provide tools 服务（带 executor）+ 注册 fs 四件与检索两件', async () => {
    const workspace = makeWorkspace();
    const root = createContext({ name: 'test' });
    // ring1Anchor 同构装载（宿主装配期专用锚——与插件锚分离的 /reload 语义起点）
    const anchor: ContextScope = root.fork({ name: 'ring1' });
    const plugin = createToolsPlugin({
      gateSink: () => undefined, // 诊断占位（本测试不落 durable 账）
      writableRoots: () => [workspace],
      workspace: () => workspace,
    });

    expect(plugin.name).toBe('tools');
    plugin.apply(anchor);

    // 服务已挂载且带管道执行器（非装饰性行——executor 面可被宿主/替换件消费）
    const tools = anchor.get<ToolsService>('tools');
    expect(typeof tools.executor).toBe('function');
    // 工具族入列：fs 四件（read/write/edit/ls）+ 检索两件（find/grep）——
    // bash 工具件属 exec 席（⑥b 装配），不在本件
    expect(tools.list().map((t) => t.name)).toEqual(['read', 'write', 'edit', 'ls', 'find', 'grep']);
    await anchor.dispose();
  });

  it('executor 端到端：read 经三段管道真执行——内容回传 + 观察态登记（后续 edit/write 依赖的版本基线）', async () => {
    const workspace = makeWorkspace();
    const readme = join(workspace, 'readme.md');
    writeFileSync(readme, 'hello tools-plugin');
    const root = createContext({ name: 'test' });
    const anchor: ContextScope = root.fork({ name: 'ring1' });
    const plugin = createToolsPlugin({
      gateSink: () => undefined,
      writableRoots: () => [workspace],
      workspace: () => workspace,
    });
    plugin.apply(anchor);

    const tools = anchor.get<ToolsService>('tools');
    const def = tools.get('read')!;
    const result = await tools.executor!(def, 'tc-1', { path: readme });
    // 三段管道走通：参数过校验、守门空链放行、执行回传文本
    expect(JSON.stringify(result)).toContain('hello tools-plugin');
    await anchor.dispose();
  });
});
