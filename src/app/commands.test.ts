/**
 * L5 app 测试 — /apps-uninstall 命令面（契约篇 §3.4 第二刀，2026-08-27 刀 2）。
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
import type { AppsService, UninstallExecReport, UninstallReport, MountReport, UnmountReport } from './apps.js';
import type { ReloadResult } from './assembly.js';

/** 捕获型命令注册表（/apps-uninstall handler 直取直调） */
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
  const appsService = {
    list: () => [],
    uninstall: async (_id: string, phase: { mode: 'inspect' } | { mode: 'execute'; dataAction: 'keep' | 'purge' }) => {
      if (phase.mode === 'inspect') {
        calls.push({ mode: 'inspect' });
        return reports.inspect;
      }
      calls.push({ mode: 'execute', dataAction: phase.dataAction });
      return reports.exec;
    },
  } as unknown as AppsService;
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
    appsService,
    reload,
    usage: () => '',
    allowlist: { list: () => [], remove: () => false } as unknown as Parameters<
      typeof registerBuiltinCommands
    >[0]['allowlist'],
  });
  // reloadCount 经 getter 暴露（直接展开会在解构时快照 0，闭包自增不可见）
  return { get, notes, calls, reloadCount: () => reloadCount, dispose };
}

/** 标准检视报告（live 档词 + 挂载行 + 受影响会话 + 一条警示——报告面呈现断言用；
 * D2 键域全字段：装机物路径 / 挂载行全集 / 数据根与体积） */
const INSPECT: UninstallReport = {
  id: 'demo',
  source: 'npm',
  appRef: 'demo-pkg',
  installPath: '/tmp/x/plugins/node_modules/demo',
  mountedRows: ['demo'],
  dataRoots: ['/tmp/x/plugins/demo'],
  dataBytes: 2048,
  events: { origin: 'live', names: ['demo/thing'] },
  affectedSessions: { 'demo/thing': 3 },
  warnings: ['共享词点名：demo/thing ×3 个会话'],
};

/** 标准 execute 回执（正常四段走完 · 数据域保留） */
const EXEC: UninstallExecReport = {
  id: 'demo',
  source: 'npm',
  outcome: 'uninstalled',
  dataAction: 'keep',
  installRemoved: 'removed',
  mountedRows: ['demo'],
  dataRemoved: false,
};

describe('/apps-uninstall 命令面（第二刀：human-only execute 唯一入口的壳）', () => {
  it('用法面：缺 id 只提示用法，不触服务不重载', async () => {
    const { get, notes, calls, reloadCount } = rig({ inspect: INSPECT, exec: EXEC });
    await get('apps-uninstall').handler('');
    expect(notes[0]).toContain('用法：/apps-uninstall');
    expect(calls).toEqual([]); // 服务零调用
    expect(reloadCount()).toBe(0);
  });

  it('裸调 = 只检视不执行（SF-5 机制承载）：报告渲染 + --confirm 指引，execute 零触', async () => {
    const { get, notes, calls, reloadCount } = rig({ inspect: INSPECT, exec: EXEC });
    await get('apps-uninstall').handler('demo');
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
    await get('apps-uninstall').handler('demo --confirm');
    expect(calls).toEqual([{ mode: 'execute', dataAction: 'keep' }]); // --confirm 直达 execute（报告上一条已看）
    expect(notes).toHaveLength(2); // 回执 + 重载结果（不再重渲染检视报告）
    expect(notes[0]).toContain('已卸载 demo');
    expect(notes[0]).toContain('保留'); // 数据域保留事实
    expect(reloadCount()).toBe(1); // 壳链 reload（删行热应用）
  });

  it('--confirm --purge-data：dataAction 裁决为 purge，回执呈现已清除', async () => {
    const exec: UninstallExecReport = { ...EXEC, dataAction: 'purge', dataRemoved: true } as UninstallExecReport;
    const { get, notes, calls } = rig({ inspect: INSPECT, exec });
    await get('apps-uninstall').handler('demo --confirm --purge-data');
    expect(calls).toEqual([{ mode: 'execute', dataAction: 'purge' }]);
    expect(notes[0]).toContain('已清除');
  });

  it('outcome 三态如实呈现：no-op / residual 各自的回执文案', async () => {
    const noOp: UninstallExecReport = { ...EXEC, outcome: 'no-op' } as UninstallExecReport;
    const rigA = rig({ inspect: INSPECT, exec: noOp });
    await rigA.get('apps-uninstall').handler('gone --confirm');
    expect(rigA.notes[0]).toContain('无动作');
    expect(rigA.notes[0]).toContain('已卸载过或从未安装');

    const residual: UninstallExecReport = { ...EXEC, outcome: 'residual', source: 'git' } as UninstallExecReport;
    const rigB = rig({ inspect: INSPECT, exec: residual });
    await rigB.get('apps-uninstall').handler('demo --confirm');
    expect(rigB.notes[0]).toContain('残迹收尾');
  });
});

describe('/apps-mount 与 /apps-unmount 壳链：单目标链单区 reload（R4 行为小刀——修复前必红）', () => {
  /**
   * 最小装配台：appsService 只桩 mount/unmount 两面（服务面行为已在
   * apps.test.ts 全锁，此处只锁壳面 reload 实参——单区/全量判据与 mount
   * 透传面）；mount 桩记录 {installId, options} 实参序列（D4 拒绝式语义的
   * 透传锚——重复元素是否被壳面吞掉在此可断言）；reload 桩记录 app 实参
   * 序列。unmount 桩按行 id 分派预设报告。
   */
  function rigRig(mountReport: MountReport, unmountReports: Record<string, UnmountReport>) {
    const { registry, get } = fakeRegistry();
    const { ui, notes } = fakeUi();
    const reloadArgs: Array<string | undefined> = [];
    const mountCalls: Array<{ installId: string; options: unknown }> = [];
    const appsService = {
      mount: async (installId: string, options: unknown) => {
        mountCalls.push({ installId, options });
        return mountReport;
      },
      unmount: async (rowId: string) => unmountReports[rowId]!,
    } as unknown as AppsService;
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
      appsService,
      // reload 桩记录 app 实参（undefined = 全量）——单区收窄的唯一判据面
      reload: async (app?: string) => {
        reloadArgs.push(app);
        return { payload: { activated: [], failed: [], skipped: [] } };
      },
      usage: () => '',
      allowlist: { list: () => [], remove: () => false } as unknown as Parameters<
        typeof registerBuiltinCommands
      >[0]['allowlist'],
    });
    return { get, notes, reloadArgs, mountCalls, dispose };
  }

  /** 标准 mount 回执（单目标形态） */
  const MOUNT: MountReport = {
    id: 'my-plugin',
    apps: ['chat'],
    source: 'local',
    appRef: '/tmp/x/my-plugin',
    message: '已挂载生效',
  };

  it('mount 恰一应用 → reload(chat) 单区；跨区共享行（多元素）→ reload() 全量', async () => {
    const { get, reloadArgs } = rigRig(MOUNT, {});
    await get('apps-mount').handler('my-plugin --apps chat --carrier main');
    await get('apps-mount').handler('my-plugin --apps chat,code --carrier main');
    // 第一发单目标 = 该区行 → 单区 reload（app 实参）；第二发共享行 → 全量（undefined）
    expect(reloadArgs).toEqual(['chat', undefined]);
  });

  it('unmount 被删行恰一目标应用 → reload(app)；无 apps 键行/跨区行 → 全量', async () => {
    const single: UnmountReport = { id: 'row-a', apps: ['chat'], warnings: [], message: '已卸挂载' };
    const crossZone: UnmountReport = { id: 'row-b', apps: ['chat', 'code'], warnings: [], message: '已卸挂载' };
    const noApps: UnmountReport = { id: 'row-c', apps: [], warnings: [], message: '已卸挂载' };
    const { get, reloadArgs } = rigRig(MOUNT, { 'row-a': single, 'row-b': crossZone, 'row-c': noApps });
    await get('apps-unmount').handler('row-a');
    await get('apps-unmount').handler('row-b');
    await get('apps-unmount').handler('row-c');
    expect(reloadArgs).toEqual(['chat', undefined, undefined]);
  });

  it('apps 多值透传面（D4 维持拒绝式）：逗号分隔 + 重复旗标并存——去空不去重，重复元素原样透传给服务面', async () => {
    const { get, mountCalls } = rigRig(MOUNT, {});
    await get('apps-mount').handler('my-plugin --apps a --apps b --apps a,b');
    // 壳面只去空不去重：'a','b' + 'a,b' 逗号拆分 = ['a','b','a','b'] 原样透传——
    // 重复元素的拒绝式执法在组合树（composition「重复元素」= 配置面笔误响亮
    // 拒启），壳面吞掉重复反而会掩盖笔误
    expect(mountCalls).toEqual([{ installId: 'my-plugin', options: { apps: ['a', 'b', 'a', 'b'] } }]);
  });

  it('carrier 非三值 → 壳面可读报错 + 零服务调用（不透传坏值）', async () => {
    const { get, notes, mountCalls, reloadArgs } = rigRig(MOUNT, {});
    await get('apps-mount').handler('my-plugin --apps chat --carrier vmware');
    expect(notes[0]).toContain('--carrier 只认 main | worker | external');
    expect(mountCalls).toEqual([]);
    expect(reloadArgs).toEqual([]);
  });

  it('config 非法 JSON / 非对象 → 壳面可读报错 + 零服务调用', async () => {
    const { get, notes, mountCalls } = rigRig(MOUNT, {});
    await get('apps-mount').handler("my-plugin --apps chat --carrier main --config '{bad'");
    expect(notes[0]).toContain('--config 不是合法 JSON 对象');
    expect(mountCalls).toEqual([]);
  });

  it('缺装机 id → 用法提示 + 零服务调用', async () => {
    const { get, notes, mountCalls, reloadArgs } = rigRig(MOUNT, {});
    await get('apps-mount').handler('--apps chat');
    expect(notes[0]).toContain('用法：/apps-mount');
    expect(mountCalls).toEqual([]);
    expect(reloadArgs).toEqual([]);
  });
});
