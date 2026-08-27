/**
 * L5 app 测试 — /plugin-uninstall 命令面（契约篇 §3.4 第二刀，2026-08-27 刀 2）。
 * 真命令注册表形态（捕获 handler）+ 两段式确认步全链走真壳；plugins 服务与
 * reload 是最小桩（服务面行为已在 plugins.test.ts 全锁，此处只锁壳面：用法
 * 提示 / 裸调=只检视不执行〔SF-5 机制承载〕/ --confirm 才 execute + 链 reload /
 * --purge-data 裁决 / outcome 三态呈现）。
 */

import { describe, expect, it } from 'vitest';
import type { CommandDefinition } from '../channels/types.js';
import type { CommandRegistry } from '../channels/commands.js';
import type { UiService } from '../channels/types.js';
import { registerBuiltinCommands } from './commands.js';
import type { PluginsService, UninstallExecReport, UninstallReport } from './plugins.js';
import type { ReloadResult } from './assembly.js';

/** 捕获型命令注册表（/plugin-uninstall handler 直取直调） */
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

/** uninstall 双相调用记录（断言 inspect 先于 execute、dataAction 裁决） */
interface UninstallCall {
  readonly mode: 'inspect' | 'execute';
  readonly dataAction?: 'keep' | 'purge';
}

/**
 * 装配测试台：uninstall 桩按序回放预设报告；reload 桩记录调用并回成功载荷。
 */
function rig(reports: { inspect: UninstallReport; exec: UninstallExecReport }) {
  const { registry, get } = fakeRegistry();
  const { ui, notes } = fakeUi();
  const calls: UninstallCall[] = [];
  let reloadCount = 0;
  const plugins = {
    list: () => [],
    uninstall: async (_id: string, phase: { mode: 'inspect' } | { mode: 'execute'; dataAction: 'keep' | 'purge' }) => {
      if (phase.mode === 'inspect') {
        calls.push({ mode: 'inspect' });
        return reports.inspect;
      }
      calls.push({ mode: 'execute', dataAction: phase.dataAction });
      return reports.exec;
    },
  } as unknown as PluginsService;
  const reload = async (): Promise<ReloadResult> => {
    reloadCount++;
    return { payload: { activated: ['x'], failed: [], skipped: [] } };
  };
  const dispose = registerBuiltinCommands({
    commands: registry,
    ui,
    skills: { list: () => [], diagnostics: () => [] } as unknown as Parameters<
      typeof registerBuiltinCommands
    >[0]['skills'],
    quit: () => {},
    submit: () => {},
    newSession: () => undefined,
    apps: {
      list: () => ({ active: [], retiredCount: 0 }),
      switchTo: () => false,
      open: () => undefined,
      registered: () => [],
      available: () => [],
      enter: () => ({ ok: false as const, error: '不可用' }),
    },
    plugins,
    reload,
    usage: () => '',
    allowlist: { list: () => [], remove: () => false } as unknown as Parameters<
      typeof registerBuiltinCommands
    >[0]['allowlist'],
  });
  // reloadCount 经 getter 暴露（直接展开会在解构时快照 0，闭包自增不可见）
  return { get, notes, calls, reloadCount: () => reloadCount, dispose };
}

/** 标准检视报告（live 档词 + 受影响会话 + 一条警示——报告面呈现断言用） */
const INSPECT: UninstallReport = {
  id: 'demo',
  status: 'active',
  source: 'npm',
  pluginRef: 'demo-pkg',
  dataDir: '/tmp/x/plugins/demo',
  events: { origin: 'live', names: ['demo/thing'] },
  affectedSessions: { 'demo/thing': 3 },
  sharedRows: [],
  warnings: ['共享词点名：demo/thing ×3 个会话'],
} as unknown as UninstallReport;

/** 标准 execute 回执（无装机物形） */
const EXEC: UninstallExecReport = {
  id: 'demo',
  source: 'npm',
  outcome: 'uninstalled',
  dataAction: 'keep',
  installRemoved: 'none',
  sharedRows: [],
  dataRemoved: false,
} as unknown as UninstallExecReport;

describe('/plugin-uninstall 命令面（第二刀：human-only execute 唯一入口的壳）', () => {
  it('用法面：缺 id 只提示用法，不触服务不重载', async () => {
    const { get, notes, calls, reloadCount } = rig({ inspect: INSPECT, exec: EXEC });
    await get('plugin-uninstall').handler('');
    expect(notes[0]).toContain('用法：/plugin-uninstall');
    expect(calls).toEqual([]); // 服务零调用
    expect(reloadCount()).toBe(0);
  });

  it('裸调 = 只检视不执行（SF-5 机制承载）：报告渲染 + --confirm 指引，execute 零触', async () => {
    const { get, notes, calls, reloadCount } = rig({ inspect: INSPECT, exec: EXEC });
    await get('plugin-uninstall').handler('demo');
    expect(calls).toEqual([{ mode: 'inspect' }]); // execute 零触——确认步是人手打第二条命令
    expect(reloadCount()).toBe(0);
    // 报告呈现：检视头 / 词表与受影响会话点名 / ⚠ 警示 / 确认指引（含 --confirm）
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('卸载检视 demo');
    expect(notes[0]).toContain('demo/thing');
    expect(notes[0]).toContain('⚠');
    expect(notes[0]).toContain('--confirm');
  });

  it('--confirm：execute + 回执 + 链 reload；默认 dataAction = keep（Docker 卷律）', async () => {
    const { get, notes, calls, reloadCount } = rig({ inspect: INSPECT, exec: EXEC });
    await get('plugin-uninstall').handler('demo --confirm');
    expect(calls).toEqual([{ mode: 'execute', dataAction: 'keep' }]); // --confirm 直达 execute（报告上一条已看）
    expect(notes).toHaveLength(2); // 回执 + 重载结果（不再重渲染检视报告）
    expect(notes[0]).toContain('已卸载 demo');
    expect(notes[0]).toContain('保留'); // 数据域保留事实
    expect(reloadCount()).toBe(1); // 壳链 reload（删行热应用）
  });

  it('--confirm --purge-data：dataAction 裁决为 purge，回执呈现已清除', async () => {
    const exec: UninstallExecReport = { ...EXEC, dataAction: 'purge', dataRemoved: true } as UninstallExecReport;
    const { get, notes, calls } = rig({ inspect: INSPECT, exec });
    await get('plugin-uninstall').handler('demo --confirm --purge-data');
    expect(calls).toEqual([{ mode: 'execute', dataAction: 'purge' }]);
    expect(notes[0]).toContain('已清除');
  });

  it('outcome 三态如实呈现：no-op / residual 各自的回执文案', async () => {
    const noOp: UninstallExecReport = { ...EXEC, outcome: 'no-op' } as UninstallExecReport;
    const rigA = rig({ inspect: INSPECT, exec: noOp });
    await rigA.get('plugin-uninstall').handler('gone --confirm');
    expect(rigA.notes[0]).toContain('无动作');
    expect(rigA.notes[0]).toContain('已卸载过或从未安装');

    const residual: UninstallExecReport = { ...EXEC, outcome: 'residual', source: 'git' } as UninstallExecReport;
    const rigB = rig({ inspect: INSPECT, exec: residual });
    await rigB.get('plugin-uninstall').handler('demo --confirm');
    expect(rigB.notes[0]).toContain('残迹收尾');
  });
});
