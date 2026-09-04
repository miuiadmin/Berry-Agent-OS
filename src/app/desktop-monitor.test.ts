/**
 * L5 app — 统一管理器 `/monitor` 服务面测试（OS 三大管理面研究刀四）：
 * 行投影纯函数直测 + createMonitorFace 面动词（deps 边界 fake——记忆腿真库
 * :memory: MemoryStore 真跑，export 真写盘 tmp 目录；mock 只停在 deps 注入面）。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, type Store } from '../persist/index.js';
import {
  MEMORY_MIGRATION,
  MEMORY_UTILITY_MIGRATION,
  MEMORY_HOLDING_MIGRATION,
  MemoryStore,
  type MemoryRecord,
} from '../memory/index.js';
import {
  browserLine,
  createMonitorFace,
  formatBytes,
  jobRowText,
  memoryCountLine,
  memoryRowText,
  obsTodayLine,
  parseMonitorTabArg,
  tickRowText,
  type MonitorDeps,
} from './desktop-monitor.js';
import type { FleetStats } from './bridge-fleet.js';
import type { SchedulerViewRow } from '../scheduler/index.js';

/** 零计数舰队（基线——计数面单测在 fleetLine） */
const ZERO_FLEET: FleetStats = {
  spawned: 0,
  live: 0,
  crashed: 0,
  ooms: 0,
  heartbeatFreezes: 0,
  terminated: 0,
};

/** 最小 deps（各用例覆写注入面——缺省全「缺席/空」） */
function makeDeps(over: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    fleetStats: () => ({ ring1: ZERO_FLEET, apps: ZERO_FLEET }),
    schedulerView: () => undefined,
    jobs: () => undefined,
    browserStatus: () => undefined,
    reload: async () => ({}),
    formatReload: () => '（reload 回执测试替身）',
    dbFilePath: () => '/nonexistent/session.db',
    memoryStore: () => undefined,
    memoryOwnerKeys: () => [],
    workspaceRoot: () => tmpdir(),
    writableRoots: () => undefined,
    obsDbPath: () => '/nonexistent/rollup.db',
    now: () => 1_700_000_000_000,
    ...over,
  };
}

/** 记忆行最小件（memoryRowText 结构子集——kind/summary/frozen/status/id） */
function fakeRecord(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: '0123abcd-0000-7000-8000-000000000000',
    ownerKey: 'global',
    kind: 'preference',
    summary: '用户偏好 pnpm',
    content: '内容',
    confidence: 0.7,
    status: 'active',
    frozen: false,
    evidenceCount: 1,
    sourceRefs: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as MemoryRecord;
}

/** tick 行最小件（tickRowText 结构子集——SchedulerViewRow 全字段直构） */
function fakeTickRow(over: Partial<SchedulerViewRow> = {}): SchedulerViewRow {
  return {
    name: 't1',
    schedule: 'every@1h',
    owner: null,
    enabled: true,
    osState: 'unregistered',
    lastRunAt: null,
    lastRunReason: null,
    nextRun: '2026-09-04T00:00:00.000Z',
    ...over,
  };
}

/** 测试 tmp 目录池（afterAll 统一清） */
const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/* ---------------- 行投影纯函数 ---------------- */

describe('行投影纯函数', () => {
  it('formatBytes：MiB 一位小数 / KiB 整数 / 负值钳 0', () => {
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MiB');
    expect(formatBytes(2048)).toBe('2 KiB');
    expect(formatBytes(0)).toBe('0 KiB');
    expect(formatBytes(-512)).toBe('0 KiB');
  });

  it('browserLine：四态人读各就位', () => {
    expect(browserLine('idle')).toContain('未起');
    expect(browserLine('starting')).toContain('握手中');
    expect(browserLine('running')).toContain('引擎在跑');
    expect(browserLine('closed')).toContain('已关停');
  });

  it('jobRowText：状态帽 + kind + label 截短 + id8', () => {
    expect(jobRowText({ id: 'abcdefghijklmnop', kind: 'subagent', label: '调研任务', status: 'running' })).toBe(
      '[running] subagent 调研任务（abcdefgh）',
    );
    // label 缺席 = kind 后直接 id
    expect(jobRowText({ id: 'abcdefghijklmnop', kind: 'process', status: 'completed' })).toBe(
      '[completed] process（abcdefgh）',
    );
  });

  it('tickRowText：仅手动 / OS 三态 / 停用 / owner 徽标', () => {
    expect(tickRowText(fakeTickRow({ schedule: null }))).toContain('仅手动');
    expect(tickRowText(fakeTickRow({ osState: 'registered' }))).toContain('OS 已注册');
    expect(tickRowText(fakeTickRow({ osState: 'absent' }))).toContain('OS 面‖');
    expect(tickRowText(fakeTickRow({ enabled: false }))).toContain('已停用');
    expect(tickRowText(fakeTickRow({ owner: 'builtin:goal' }))).toContain('builtin:goal');
    // 用户行（owner null）不带 owner 徽标
    expect(tickRowText(fakeTickRow({ owner: null })).endsWith('未注册')).toBe(true);
  });

  it('memoryRowText：❄冻结与终态徽标；active 无帽', () => {
    expect(memoryRowText(fakeRecord())).toBe('[preference] 用户偏好 pnpm（0123abcd）');
    expect(memoryRowText(fakeRecord({ frozen: true }))).toContain('❄冻结');
    expect(memoryRowText(fakeRecord({ status: 'dismissed' }))).toContain('dismissed');
    expect(memoryRowText(fakeRecord({ frozen: true, status: 'expired' }))).toContain('❄冻结');
    expect(memoryRowText(fakeRecord({ frozen: true, status: 'expired' }))).toContain('expired');
  });

  it('memoryCountLine / obsTodayLine：计数行全量呈现', () => {
    expect(memoryCountLine({ active: 2, dismissed: 1, superseded: 0, expired: 3 })).toContain(
      'active 2 · dismissed 1 · superseded 0 · expired 3',
    );
    expect(obsTodayLine({ llm: 9, tool: 8, turn: 7, approval: 6, deprecation: 5 })).toContain(
      'llm 调用 9 · 工具 8 · 轮次 7 · 审批 6 · 废弃用法 5',
    );
  });

  it('parseMonitorTabArg：三值收 / 非法 undefined（壳诚实拒）', () => {
    expect(parseMonitorTabArg('proc')).toBe('proc');
    expect(parseMonitorTabArg('jobs')).toBe('jobs');
    expect(parseMonitorTabArg('mem')).toBe('mem');
    expect(parseMonitorTabArg('memory')).toBeUndefined();
    expect(parseMonitorTabArg('')).toBeUndefined();
  });
});

/* ---------------- 面板三页签 ---------------- */

describe('panel：三页签投影', () => {
  it('proc 页签：双舰队行 + browser/jobs 缺席诚实示', async () => {
    const face = createMonitorFace(makeDeps());
    const panel = await face.panel('proc');
    expect(panel.title).toContain('进程');
    const text = panel.rows.map((row) => row.text).join('\n');
    expect(text).toContain('ring1 舰队');
    expect(text).toContain('app 舰队');
    expect(text).toContain('行未装配'); // browserStatus 缺席
    expect(text).toContain('Job 服务不在场'); // jobs 缺席
  });

  it('proc 页签：jobs 在场 → 活/总计数 + item 行（k 动词宾语）', async () => {
    const cancelled: string[] = [];
    const face = createMonitorFace(
      makeDeps({
        browserStatus: () => ({ state: 'running' }),
        jobs: () =>
          ({
            list: () => [
              { id: 'job-1111', kind: 'subagent', label: '跑着', status: 'running' },
              { id: 'job-2222', kind: 'process', status: 'completed' },
            ],
            cancel: (id: string) => cancelled.push(id),
          }) as never,
      }),
    );
    const panel = await face.panel('proc');
    const text = panel.rows.map((row) => row.text).join('\n');
    expect(text).toContain('活 1 / 总 2');
    expect(text).toContain('[running] subagent 跑着（job-1111）');
    expect(text).toContain('引擎在跑'); // browserStatus 活取生效
    const jobItems = panel.rows.flatMap((row) => (row.item?.kind === 'job' ? [row.item] : []));
    expect(jobItems.map((item) => item.key)).toEqual(['job-1111', 'job-2222']);
    // k 动词：cancel 不带 as（operator 直控）——面动词直验
    const receipt = await face.cancelJob('job-1111');
    expect(receipt).toContain('job-1111');
    expect(cancelled).toEqual(['job-1111']);
  });

  it('jobs 页签：scheduler-view 缺席诚实示 / 在场 → tick item 行', async () => {
    const absent = await createMonitorFace(makeDeps()).panel('jobs');
    expect(absent.rows[0]?.text).toContain('scheduler-view 未装载');

    const face = createMonitorFace(
      makeDeps({
        schedulerView: () => ({
          list: async () => [fakeTickRow({ name: 'wake-main' })],
          dispatch: async () => '已注销（wake-main）',
        }),
      }),
    );
    const panel = await face.panel('jobs');
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0]?.item).toEqual({ kind: 'tick', key: 'wake-main', label: 'wake-main' });
    // e/d/n 动词经 dispatch 字符串分派（守卫单源）
    const receipt = await face.tick('disable', 'wake-main');
    expect(receipt).toEqual({ title: 'tick disable wake-main', lines: ['已注销（wake-main）'] });
  });

  it('mem 页签：RSS/库文件/记忆/obs 四段（缺席各诚实示）', async () => {
    const face = createMonitorFace(makeDeps());
    const panel = await face.panel('mem');
    const text = panel.rows.map((row) => row.text).join('\n');
    expect(text).toContain('进程内存：RSS');
    expect(text).toContain('会话库文件：读取失败'); // dbFilePath 不存在路径
    expect(text).toContain('记忆库不在场'); // memoryStore 缺席
    expect(text).toContain('obs 未启用'); // rollup.db 不存在
  });
});

/* ---------------- 记忆动词（真库 :memory: MemoryStore） ---------------- */

describe('记忆动词：真库 DAO 真跑', () => {
  /** 真库 + 面装配（每用例新库——迁移链一次到位） */
  const assembleMemory = (over: Partial<MonitorDeps> = {}) => {
    const store: Store = openStore({
      path: ':memory:',
      migrations: [MEMORY_MIGRATION, MEMORY_UTILITY_MIGRATION, MEMORY_HOLDING_MIGRATION],
    });
    const memory = new MemoryStore(store.connection);
    const face = createMonitorFace(makeDeps({ memoryStore: () => memory, memoryOwnerKeys: () => ['global'], ...over }));
    return { memory, face };
  };

  /** 写一条标准记忆（返回 id） */
  const seed = (memory: MemoryStore, over: Partial<Parameters<MemoryStore['addMemory']>[0]> = {}): string => {
    const out = memory.addMemory({
      ownerKey: 'global',
      kind: 'preference',
      summary: '用户偏好 pnpm',
      content: '会话中用户明确表示统一用 pnpm。',
      confidence: 0.7,
      sourceRefs: [{ sessionId: 's1', seq: 1 }],
      ...over,
    });
    if (out.outcome !== 'inserted') throw new Error(`种子写入失败：${out.outcome}`);
    return out.memory.id;
  };

  it('mem 页签记忆段：四状态计数 + active 在前 + item 行', async () => {
    const { memory, face } = assembleMemory();
    seed(memory);
    seed(memory, { summary: '第二条' });
    const dismissedId = seed(memory, { summary: '将被忘掉' });
    memory.forget(dismissedId, 'user', 1_700_000_000_000);
    const panel = await face.panel('mem');
    const text = panel.rows.map((row) => row.text).join('\n');
    expect(text).toContain('active 2 · dismissed 1 · superseded 0 · expired 0');
    const items = panel.rows.flatMap((row) => (row.item?.kind === 'memory' ? [row.item.key] : []));
    expect(items).toHaveLength(3); // 2 active + 1 dismissed（v 恢复宾语——终态也列示）
    expect(text).toContain('〔dismissed〕'); // 终态徽标
  });

  it('f 冻结/解冻翻转：双向回执 + ❄ 徽标', async () => {
    const { memory, face } = assembleMemory();
    const id = seed(memory);
    expect(await face.memoryToggleFrozen(id)).toContain('已冻结');
    expect(memory.get(id)?.frozen).toBe(true);
    expect(memoryRowText(memory.get(id)!)).toContain('❄冻结');
    expect(await face.memoryToggleFrozen(id)).toContain('已解冻');
    expect(memory.get(id)?.frozen).toBe(false);
  });

  it('x 忘掉：ok / frozen 拒 / 幂等三态', async () => {
    const { memory, face } = assembleMemory();
    const id = seed(memory);
    const frozenId = seed(memory, { summary: '冻结条' });
    memory.setFrozen(frozenId, true, 1_700_000_000_000);
    expect(await face.memoryForget(id)).toContain('已忘掉'); // 软删——可恢复
    expect(memory.get(id)?.status).toBe('dismissed');
    expect(await face.memoryForget(frozenId)).toContain('冻结中'); // 冻结免覆写
    expect(await face.memoryForget(id)).toContain('已是忘掉态'); // 幂等
  });

  it('v 恢复：dismissed → active；幽灵 id 拒', async () => {
    const { memory, face } = assembleMemory();
    const id = seed(memory);
    memory.forget(id, 'user', 1_700_000_000_000);
    expect(await face.memoryRestore(id)).toContain('已恢复');
    expect(memory.get(id)?.status).toBe('active');
    expect(await face.memoryRestore('0123abcd-0000-7000-8000-000000000009')).toContain('恢复失败');
  });

  it('e 导出：可写根内真写盘 + 计数 + ⚠ 明文警示；根外拒写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'berry-monitor-export-'));
    tmpDirs.push(dir);
    const { memory, face } = assembleMemory({
      workspaceRoot: () => dir,
      writableRoots: () => [dir],
    });
    seed(memory);
    const result = await face.memoryExport();
    if (typeof result === 'string') throw new Error(`导出应成功：${result}`);
    expect(result.title).toContain('已导出 1 条');
    expect(result.lines.join('\n')).toContain('⚠'); // 明文警示在场
    const files = result.lines[0]!.trim().split('\n');
    const target = files[0]!;
    expect(existsSync(target)).toBe(true); // 真写盘
    const text = readFileSync(target, 'utf8');
    expect(text.split('\n').filter((line) => line.trim() !== '')).toHaveLength(2); // header + 1 条
    // 根外拒写：可写根指别处 → 目标（工作区根内）不在根内 → 拒
    const other = mkdtempSync(join(tmpdir(), 'berry-monitor-other-'));
    tmpDirs.push(other);
    const rejecting = createMonitorFace(
      makeDeps({
        memoryStore: () => memory,
        workspaceRoot: () => dir,
        writableRoots: () => [other],
      }),
    );
    expect(await rejecting.memoryExport()).toContain('拒写');
  });

  it('记忆动词缺席降级：store 缺席三动词诚实拒', async () => {
    const face = createMonitorFace(makeDeps());
    expect(await face.memoryToggleFrozen('x')).toContain('不在场');
    expect(await face.memoryForget('x')).toContain('不在场');
    expect(await face.memoryRestore('x')).toContain('不在场');
    expect(await face.memoryExport()).toContain('不在场');
  });
});

/* ---------------- 其余动词 ---------------- */

describe('动词面：cancel / reload / tick 缺席降级', () => {
  it('cancelJob：jobs 缺席诚实拒', async () => {
    const receipt = await createMonitorFace(makeDeps()).cancelJob('job-1');
    expect(receipt).toContain('Job 服务不在场');
  });

  it('reloadAll：回执视图 = 标题 + formatReload 单源行', async () => {
    const result = await createMonitorFace(makeDeps()).reloadAll();
    expect(result).toEqual({ title: '全量 reload 完成', lines: ['（reload 回执测试替身）'] });
  });

  it('tick：scheduler-view 缺席诚实拒（/tick 命令面仍可用提示）', async () => {
    const receipt = await createMonitorFace(makeDeps()).tick('run', 't1');
    expect(receipt).toContain('scheduler-view 未装载');
    expect(receipt).toContain('/tick');
  });
});
