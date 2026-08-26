/**
 * app — `--no-plugins` 安全模式回归锁（技术栈篇 §5，第二十六批拍板 ③，2026-08-27 落码）。
 *
 * boot 组合树空装语义：默认层与 overlay 全跳过、只保 Ring 1 硬装配行
 * （RING1_REQUIRED_ROW_IDS = ['tools']）；无驱动形态是一等态（TUI 壳照启可退 /
 * run 语义性失败——本文件锁 boot 面）；救援环 = /reload 读盘不受旗标影响
 * （boot 安全模式 → 修 overlay → /reload 恢复全树 + 驱动就位，一进程内闭环）；
 * dump-config 同径可见（安全模式标记行 + 树只剩 Ring 1 行）。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBerryRuntime } from './assembly.js';
import { dumpConfigMain } from './dump-config.js';

/* ---------------- 测试基建 ---------------- */

/** 起临时组合树目录（无 overlay = 官方默认层全树——安全模式的对照基线） */
function freshDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `${prefix}-`)));
}

/** 用例收尾三件：关停运行时 + 清临时目录（安全模式 boot 不拒启即有 runtime 可关） */
async function teardown(runtime: { shutdown(): Promise<void> }, dir: string): Promise<void> {
  await runtime.shutdown();
  rmSync(dir, { recursive: true, force: true });
}

/* ---------------- 用例 ---------------- */

describe('--no-plugins 安全模式（boot 空装 + 救援环 + dump-config 同径）', () => {
  it('boot 空装：组合树只剩 tools 行激活、无驱动一等态（conversation undefined）、Ring 1 照常执法', async () => {
    const compositionDir = freshDir('safe-boot');
    const runtime = await createBerryRuntime({
      dbPath: ':memory:',
      compositionDir,
      interactive: false,
      noPlugins: true,
    });
    try {
      // 组合树只剩 Ring 1 硬装配行（默认层其余行 = 没进树，不是 skipped/failed）
      expect(runtime.composition.plan.map((row) => row.id)).toEqual(['tools']);
      // 状态面同源：ctx.plugins.list 唯一事实源 = 组合树全行（一行 activated）
      const list = runtime.plugins.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'tools', status: 'activated' });
      // 无驱动一等态：chat 件未装载 → 前台投影 undefined（TUI 壳照启可退）
      expect(runtime.conversation).toBeUndefined();
      // Ring 1 产物就位断言不受旗标软化：工具服务带管道（安全模式 ≠ 裸进程）
      expect(runtime.tools.executor).toBeDefined();
    } finally {
      await teardown(runtime, compositionDir);
    }
  });

  it('对照：同目录不带旗标 = 官方默认层全树（chat 在场 → conversation 有值——夹具目录本身有效）', async () => {
    const compositionDir = freshDir('safe-ctrl');
    const runtime = await createBerryRuntime({ dbPath: ':memory:', compositionDir, interactive: false });
    try {
      expect(runtime.composition.plan.map((row) => row.id)).toContain('chat');
      expect(runtime.conversation).toBeDefined();
    } finally {
      await teardown(runtime, compositionDir);
    }
  });

  it('overlay 全跳过：overlay 新增可装载 local 行在安全模式下不进树（默认层与 overlay 一视同仁）', async () => {
    const compositionDir = freshDir('safe-overlay');
    // overlay 加一个真实可装载的 local 插件行（正常 boot 会进树激活——被跳过
    // 才是旗标行为，不是「行本来就装不上」的假阳性）
    const pluginDir = join(compositionDir, 'plugins', 'extra');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'index.ts'), 'export const name = "extra";\nexport default async function () {};\n');
    writeFileSync(join(compositionDir, 'overlay.yaml'), `rows:\n  - id: extra\n    plugin: ${pluginDir}\n`);
    const runtime = await createBerryRuntime({
      dbPath: ':memory:',
      compositionDir,
      interactive: false,
      noPlugins: true,
    });
    try {
      expect(runtime.composition.plan.map((row) => row.id)).toEqual(['tools']); // extra 不在
    } finally {
      await teardown(runtime, compositionDir);
    }
  });

  it('救援环：boot 安全模式 → /reload 读盘不受旗标影响 → 全树恢复 + 驱动就位（一进程内闭环）', async () => {
    const compositionDir = freshDir('safe-rescue');
    const runtime = await createBerryRuntime({
      dbPath: ':memory:',
      compositionDir,
      interactive: false,
      noPlugins: true,
    });
    try {
      expect(runtime.conversation).toBeUndefined(); // 前置：安全模式 boot 无驱动
      const result = await runtime.reload();
      // 全量恢复：激活清单含 chat（Ring 2 官方件整批回装——fresh 读盘不过滤）
      expect(result.payload?.activated).toContain('chat');
      // 驱动面：chat apply 走 boot 全量支线（注册表空即开首个驱动）→ 前台投影就位
      expect(runtime.conversation).toBeDefined();
      // 状态面：chat 行 activated（无驱动不再是「装了没起」的暗坑）
      expect(runtime.plugins.list().some((row) => row.id === 'chat' && row.status === 'activated')).toBe(true);
    } finally {
      await teardown(runtime, compositionDir);
    }
  });

  it('dump-config 同径可见：安全模式标记行 + 树只剩 tools 行 + chat 行不打印（退出码 0）', async () => {
    const compositionDir = freshDir('safe-dump');
    // stdout 记录桩（诊断面唯一出口——mock 停在进程边界，装配全真跑）
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await dumpConfigMain({ compositionDir, noPlugins: true })).toBe(0);
      const out = write.mock.calls.map((call) => String(call[0])).join('');
      // 安全模式标记行：operator 一眼可辨「Ring 2/3 跳过是旗标使然不是树坏」
      expect(out).toContain('安全模式（--no-plugins）');
      // 树只剩 Ring 1 行：tools 在场、chat 不打印（同径 = 打印的就是实际生效装配）
      expect(out).toContain('- tools：');
      expect(out).not.toContain('- chat：');
    } finally {
      write.mockRestore();
      rmSync(compositionDir, { recursive: true, force: true });
    }
  });
});
