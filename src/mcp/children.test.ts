/**
 * L3 mcp 单元测试 — 子进程登记簿 + 启动期孤儿清扫（契约篇 §6.6 子进程
 * 治理条；Hermes 探矿轮九 #26/#28 修法）。
 *
 * 探针全注入（isAlive/commandOf/kill）——零真进程零真 ps；文件面走临时
 * 目录真读写（tmp+rename 原子换的物理形态在测）。
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildRegistry } from './children.js';

/** 本用例临时目录登记（afterEach 提示性清点——tmp 目录随系统清理） */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) dirs.pop();
});

/** 新登记簿（独立临时目录） */
function makeRegistry(): { registry: ChildRegistry; dir: string } {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mcp-children-')));
  dirs.push(dir);
  return { registry: new ChildRegistry(join(dir, 'mcp', 'children.json')), dir };
}

/** 样例条目 */
function entry(overrides: Partial<{ hostPid: number; childPid: number; server: string }> = {}) {
  return {
    hostPid: 11111,
    childPid: 22222,
    server: 'srv',
    command: '/usr/local/bin/srv-mcp',
    ...overrides,
  };
}

describe('ChildRegistry — 文件面读写', () => {
  it('文件缺失 = 空表（首启无文件——清扫语义 fail-open 不阻启动）', () => {
    const { registry } = makeRegistry();
    expect(registry.list()).toEqual([]);
  });

  it('文件损坏 = 空表（半写 JSON 不炸启动）', () => {
    const { registry, dir } = makeRegistry();
    mkdirSync(join(dir, 'mcp'), { recursive: true });
    writeFileSync(join(dir, 'mcp', 'children.json'), '{"hostPid": 1, ', 'utf8');
    expect(registry.list()).toEqual([]);
  });

  it('add 落盘 remove 删行；add 同 childPid 去重（不积重复条目）', () => {
    const { registry } = makeRegistry();
    registry.add(entry());
    registry.add(entry({ childPid: 33333, server: 'srv2' }));
    // 同 childPid 再 add = 更新而非追加
    registry.add(entry({ server: 'srv-renamed' }));
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.find((it) => it.childPid === 22222)?.server).toBe('srv-renamed');
    registry.remove(22222);
    expect(registry.list().map((it) => it.childPid)).toEqual([33333]);
  });

  it('写盘形态：JSON 数组 + 换行收尾（人读 + 原子换 tmp 同目录）', () => {
    const { registry, dir } = makeRegistry();
    registry.add(entry());
    const raw = readFileSync(join(dir, 'mcp', 'children.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toHaveLength(1);
  });
});

describe('ChildRegistry.sweep — 孤儿清扫判定序', () => {
  it('hostPid 活 = 兄弟宿主（允许双开）——保留不动', async () => {
    const { registry } = makeRegistry();
    registry.add(entry({ hostPid: process.pid }));
    const report = await registry.sweep({ isAlive: () => true, kill: () => undefined });
    expect(report).toEqual({ killed: [], reapedRecords: [], kept: 1 });
    expect(registry.list()).toHaveLength(1);
  });

  it('hostPid 死 + childPid 死：只删条目不 kill', async () => {
    const { registry } = makeRegistry();
    registry.add(entry());
    const killed: number[] = [];
    const report = await registry.sweep({ isAlive: () => false, kill: (pid) => killed.push(pid) });
    expect(report).toEqual({ killed: [], reapedRecords: [22222], kept: 0 });
    expect(killed).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('hostPid 死 + childPid 活 + ps 命令行匹配 → 树杀 + 删条目', async () => {
    const { registry } = makeRegistry();
    registry.add(entry());
    const killed: number[] = [];
    const report = await registry.sweep({
      isAlive: (pid) => pid === 22222,
      commandOf: async (pid) => (pid === 22222 ? '/usr/local/bin/srv-mcp --stdio' : undefined),
      kill: (pid) => killed.push(pid),
    });
    expect(report.killed).toEqual([22222]);
    expect(killed).toEqual([22222]);
    expect(registry.list()).toEqual([]);
  });

  it('PID 复用防护：ps 命令行不含登记 command → 只删条目不杀无辜进程', async () => {
    const { registry } = makeRegistry();
    registry.add(entry());
    const killed: number[] = [];
    const report = await registry.sweep({
      isAlive: (pid) => pid === 22222,
      commandOf: async () => '/usr/sbin/httpd -DFOREGROUND', // 22222 已被复用给 httpd
      kill: (pid) => killed.push(pid),
    });
    expect(report).toEqual({ killed: [], reapedRecords: [22222], kept: 0 });
    expect(killed).toEqual([]); // 不动手是关键
  });

  it('ps 不可用（undefined）= 验证降级放行 → 照杀（保守侧防孤儿漏网）', async () => {
    const { registry } = makeRegistry();
    registry.add(entry());
    const killed: number[] = [];
    const report = await registry.sweep({
      isAlive: (pid) => pid === 22222,
      commandOf: async () => undefined, // 平台无 ps
      kill: (pid) => killed.push(pid),
    });
    expect(report.killed).toEqual([22222]);
  });

  it('kill 必填（缺省不动手会谎报 killed——类型面钉死调用方必注入）', async () => {
    const { registry } = makeRegistry();
    registry.add(entry());
    const killed: number[] = [];
    const report = await registry.sweep({
      isAlive: (pid) => pid === 22222,
      commandOf: async () => '/usr/local/bin/srv-mcp',
      kill: (pid) => killed.push(pid),
    });
    expect(report.killed).toEqual([22222]);
    expect(killed).toEqual([22222]);
    expect(registry.list()).toEqual([]); // 条目照删（簿记不依赖 kill 成败）
  });

  it('多条目混合判定：各走各腿互不干扰', async () => {
    const { registry } = makeRegistry();
    registry.add(entry({ hostPid: 1, childPid: 10 })); // 双死 → reap
    registry.add(entry({ hostPid: 2, childPid: 20 })); // 宿主死+子活+验身过 → kill
    registry.add(entry({ hostPid: process.pid, childPid: 30 })); // 兄弟宿主 → keep
    const report = await registry.sweep({
      isAlive: (pid) => pid === 20 || pid === process.pid,
      commandOf: async (pid) => (pid === 20 ? '/usr/local/bin/srv-mcp' : 'x'),
      kill: () => undefined,
    });
    expect(report.killed).toEqual([20]);
    expect(report.reapedRecords).toEqual([10]);
    expect(report.kept).toBe(1);
    expect(registry.list().map((it) => it.childPid)).toEqual([30]);
  });

  it('死账分类：childPid 非正（历史 -1 哨兵）= 无进程可杀——不探活不验命令行不 kill，只删条目归 reaped（遗漏大扫 20260904 #16）', async () => {
    const { registry } = makeRegistry();
    registry.add(entry({ childPid: -1 })); // 在册历史死账（哨兵代偿时代遗留）
    const kill = vi.fn();
    // 假探针忠实真形状（防测试资产共谋——形状取自真探针行为推演，非反向凑绿）：
    // 真探针 isPidAlive 是 EPERM=活（children.ts 「活但非属主」）——非 root 下
    // process.kill(-1, 0) 恒 EPERM，-1 必判「活」；ps -p -1 必败 → commandOf
    // undefined（验证降级照杀分支）。修前这条链直通 kill(-1)：真调用方
    // killTree(-1) 归一 process.kill(1)/杀全用户会话进程（批 90 哨兵毒化漏网）
    const report = await registry.sweep({
      isAlive: (pid) => pid === -1,
      commandOf: async () => undefined,
      kill,
    });
    // 修前红位：kill 收 -1 + killed 账含 -1（报告谎报「已树杀」）；
    // 修后：非正 pid 在判定序最前归类 reaped——无进程可杀的纯簿记
    expect(kill).not.toHaveBeenCalled();
    expect(report.killed).toEqual([]);
    expect(report.reapedRecords).toContain(-1);
    expect(registry.list()).toEqual([]);
  });
});
