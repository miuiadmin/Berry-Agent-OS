import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, Readable } from 'node:stream';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('../utils/kill-tree.js', () => ({
  killTree: vi.fn().mockResolvedValue(undefined),
}));

import { spawn } from 'node:child_process';
import { monitorStartTool, monitorStopTool, monitorStatusTool } from './monitor-tools.js';

const mockSpawn = vi.mocked(spawn);

function createMockChild() {
  const child = new EventEmitter() as any;
  child.pid = 9999;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  child.killed = false;
  child.unref = vi.fn();
  return child;
}

describe('monitor tools', () => {
  beforeEach(() => vi.clearAllMocks());

  it('monitor_start returns id and command info', async () => {
    mockSpawn.mockReturnValue(createMockChild());
    const result = await monitorStartTool.execute({ command: 'tail -f log.txt', description: 'watch logs' });
    expect(result.content).toContain('监控已启动');
    expect(result.content).toContain('tail -f log.txt');
    expect(result.isError).toBeUndefined();
  });

  it('monitor_status lists active monitors', async () => {
    mockSpawn.mockReturnValue(createMockChild());
    await monitorStartTool.execute({ command: 'echo test' });

    const result = await monitorStatusTool.execute({});
    expect(result.content).toContain('活跃监控');
    expect(result.content).toContain('echo test');
  });

  it('monitor_stop kills process and returns output', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child);

    const startResult = await monitorStartTool.execute({ command: 'watch' });
    const idMatch = startResult.content.match(/ID: (mon_\d+)/);
    const id = idMatch![1];

    // Simulate some output
    child.stdout.push(Buffer.from('line 1\nline 2\n'));

    // Give stream processing a tick
    await new Promise(r => setTimeout(r, 10));

    const stopResult = await monitorStopTool.execute({ monitorId: id });
    expect(stopResult.content).toContain('监控已停止');
    expect(stopResult.content).toContain('line 1');
  });

  it('monitor_stop returns error for unknown id', async () => {
    const result = await monitorStopTool.execute({ monitorId: 'mon_999' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未找到');
  });

  it('respects max concurrent monitors limit', async () => {
    for (let i = 0; i < 5; i++) {
      mockSpawn.mockReturnValue(createMockChild());
      await monitorStartTool.execute({ command: `cmd${i}` });
    }

    mockSpawn.mockReturnValue(createMockChild());
    const result = await monitorStartTool.execute({ command: 'overflow' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('最大并发');
  });
});
