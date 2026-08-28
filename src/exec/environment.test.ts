/**
 * L4 exec 单元测试 — environment 披露段（骨架篇 §7.3 S 量级）。
 *
 * 覆盖：四件齐备（平台/日期/工作区根/档位+可写根）/ 快照语义（render 时
 * 现取——档位切换后下次物化即见新档）。
 */

import { describe, expect, it } from 'vitest';
import { renderEnvironmentSection } from './environment.js';
import type { SandboxMode } from '../safety/index.js';

describe('renderEnvironmentSection（四件披露）', () => {
  it('平台/日期/工作区根/档位+可写根 齐备', () => {
    const text = renderEnvironmentSection({
      mode: () => 'workspace-write' as SandboxMode,
      workspaceRoot: () => '/tmp/ws-canonical',
    });
    expect(text).toContain(`平台：${process.platform}`);
    expect(text).toMatch(/当前日期：\d{4}-\d{2}-\d{2}（周[一二三四五六日]）/);
    expect(text).toContain('工作区根：/tmp/ws-canonical');
    expect(text).toContain('沙箱档位：workspace-write');
    expect(text).toContain('/tmp/ws-canonical'); // 可写根含工作区自身
    expect(text).toContain('/tmp'); // workspace-write 档可写根含 /tmp
  });
  it('read-only 档可写根为空表', () => {
    const text = renderEnvironmentSection({ mode: () => 'read-only', workspaceRoot: () => '/tmp/ws' });
    expect(text).toContain('沙箱档位：read-only');
    expect(text).toMatch(/可写根：\s*）/); // 空列表形态（“可写根：”后即收束）
  });
  it('快照语义：render 时现取——档位切换后新渲染即见新档', () => {
    let mode: SandboxMode = 'read-only';
    const text1 = renderEnvironmentSection({ mode: () => mode, workspaceRoot: () => '/w' });
    expect(text1).toContain('read-only');
    mode = 'danger-full-access';
    const text2 = renderEnvironmentSection({ mode: () => mode, workspaceRoot: () => '/w' });
    expect(text2).toContain('danger-full-access');
  });
});

describe('renderEnvironmentSection（第五件：应用装载计数——契约篇 §3.4 admin 刀）', () => {
  it('appCounts 注入：计数行呈现（总数/activated/failed/skipped + apps_list 指引）', () => {
    const text = renderEnvironmentSection({
      mode: () => 'workspace-write',
      workspaceRoot: () => '/tmp/ws',
      appCounts: () => ({ total: 10, activated: 8, failed: 1, skipped: 1 }),
    });
    expect(text).toContain('应用 10 行：activated 8 · failed 1 · skipped 1');
    expect(text).toContain('apps_list');
  });
  it('appCounts 缺省：无应用计数行（向后兼容——旧装配面零变化）', () => {
    const text = renderEnvironmentSection({ mode: () => 'read-only', workspaceRoot: () => '/tmp/ws' });
    expect(text).not.toContain('应用');
  });
  it('计数为幂等取值：render 两次同值（访问器无副作用，快照语义）', () => {
    let calls = 0;
    const accessor = () => {
      calls++;
      return { total: 3, activated: 3, failed: 0, skipped: 0 };
    };
    const t1 = renderEnvironmentSection({ mode: () => 'read-only', workspaceRoot: () => '/w', appCounts: accessor });
    const t2 = renderEnvironmentSection({ mode: () => 'read-only', workspaceRoot: () => '/w', appCounts: accessor });
    expect(t1).toContain('应用 3 行：activated 3 · failed 0 · skipped 0');
    expect(t2).toContain('应用 3 行：activated 3 · failed 0 · skipped 0');
    expect(calls).toBe(2); // 每次 render 各取一次（无缓存无副作用）
  });
});
