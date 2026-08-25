/**
 * L5 app 测试 — /allowlist 命令面（第二十四批题1a 接线批 Commit B）。
 * 真命令注册表形态（捕获 handler）+ 真 AllowlistStore（tmpdir 真文件），
 * 其余依赖最小桩——命令壳是纯通知面，无模型层。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandDefinition } from '../channels/types.js';
import type { CommandRegistry } from '../channels/commands.js';
import type { UiService } from '../channels/types.js';
import { registerBuiltinCommands } from './commands.js';
import { AllowlistStore } from './allowlist-store.js';

/** 捕获型命令注册表（/allowlist handler 直取直调） */
function fakeRegistry(): { registry: CommandRegistry; get: (name: string) => CommandDefinition } {
  const map = new Map<string, CommandDefinition>();
  const registry = {
    register: (cmd: CommandDefinition) => {
      map.set(cmd.name, cmd);
      return () => map.delete(cmd.name);
    },
    list: () => [...map.values()],
  } as unknown as CommandRegistry;
  return { registry, get: (name) => map.get(name)! };
}

/** 通知收集型 UI 桩 */
function fakeUi(): { ui: UiService; notes: string[] } {
  const notes: string[] = [];
  return { ui: { notify: (text: string) => notes.push(text) } as unknown as UiService, notes };
}

function rig() {
  const { registry, get } = fakeRegistry();
  const { ui, notes } = fakeUi();
  const allowlist = new AllowlistStore(join(mkdtempSync(join(tmpdir(), 'allowlist-cmd-')), 'allowlist.json'));
  const dispose = registerBuiltinCommands({
    commands: registry,
    ui,
    skills: { list: () => [], diagnostics: () => [] } as unknown as Parameters<
      typeof registerBuiltinCommands
    >[0]['skills'],
    quit: () => {},
    submit: () => {},
    newSession: () => undefined,
    plugins: {} as unknown as Parameters<typeof registerBuiltinCommands>[0]['plugins'],
    reload: (() => undefined) as unknown as Parameters<typeof registerBuiltinCommands>[0]['reload'],
    usage: () => '',
    allowlist,
  });
  return { get, notes, allowlist, dispose };
}

describe('/allowlist 命令面（接线批 Commit B）', () => {
  it('空清单：提示来源与手编路径', async () => {
    const { get, notes } = rig();
    await get('allowlist').handler('');
    expect(notes[0]).toContain('空（0 条）');
    expect(notes[0]).toContain('allowlist.json');
  });

  it('枚举：序号/工具/模式/永久或到期如实呈现；过期条目标注回落问', async () => {
    const { get, notes, allowlist } = rig();
    allowlist.add({ tool: 'bash', pattern: 'git status' });
    allowlist.add({ tool: 'write', pattern: 'docs', expiresAt: 1 }); // 已过期
    await get('allowlist').handler('  ');
    const text = notes.join('\n');
    expect(text).toContain('1. bash  git status');
    expect(text).toContain('永久');
    expect(text).toContain('2. write  docs');
    expect(text).toContain('已过期');
    expect(text).toContain('deny 不在此面');
  });

  it('rm <序号>：撤销成功与越界提示；非法用法给用法行', async () => {
    const { get, notes, allowlist } = rig();
    allowlist.add({ tool: 'bash', pattern: 'ls' });
    allowlist.add({ tool: 'write', pattern: 'src' });
    await get('allowlist').handler('rm 1');
    expect(notes[0]).toBe('已撤销条目 1');
    expect(allowlist.list()).toEqual([{ tool: 'write', pattern: 'src' }]); // 2 变 1
    await get('allowlist').handler('rm 9');
    expect(notes[1]).toBe('无此序号：9');
    await get('allowlist').handler('rm abc');
    expect(notes[2]).toContain('用法：/allowlist rm');
  });

  it('撤销后守门行即见（活数组零重装语义在命令面的兑现）', async () => {
    const { get, allowlist } = rig();
    allowlist.add({ tool: 'write', pattern: 'docs' });
    const live = allowlist.entries;
    await get('allowlist').handler('rm 1');
    expect(live).toHaveLength(0);
  });
});
