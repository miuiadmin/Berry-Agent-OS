/**
 * L3 safety 测试 — 守门固定行（骨架篇 §8.1/§8.5）。
 * 集成走真 tools 三段管道 + 真 fs 工具族：守门行 prepend 首位，carve-out
 * 命中走审批（allowed-once 放行 / 其余 block 带 §7.4 统一文案）；两端档位
 * （read-only / danger-full-access）不归本行管的分工也在此验证。
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError, FS_OUTSIDE_WRITABLE_ROOTS, TOOL_BLOCKED } from '../contracts/errors.js';
import { createContext } from '../context/index.js';
import { createFsTools, createToolPipeline, registerToolsService } from '../tools/index.js';
import { createApprovalService, installSafetyGate, type ApprovalDecisionSink } from './index.js';
import { deriveWritableRoots } from './roots.js';
import type { SandboxMode } from './types.js';

/** 集成测试装置：真 ctx + 真管道 + 真 fs 工具族 + 守门行 + 可控 answerer。
 * pre 回调在守门行安装前跑（carve-out glob「装配期展开」语义要求文件先在）。 */
function rig(opts: { mode: SandboxMode; answer?: 'approve' | 'reject'; pre?: (ws: string) => void }) {
  const ws = mkdtempSync(join(tmpdir(), 'safety-gate-'));
  opts.pre?.(ws);
  const ctx = createContext({ name: 'test' });
  let mode: SandboxMode = opts.mode;

  // 审批对收集器（模拟 app 装配层 durable 接线）
  const asked: { approvalId: string; summary: string }[] = [];
  const decided: { approvalId: string; decision: string }[] = [];
  const sink: ApprovalDecisionSink = {
    asked: (p) => asked.push(p),
    decided: (p) => decided.push(p),
  };
  const approval = createApprovalService(ctx, { sink });
  if (opts.answer) {
    ctx.on('approval/answer', (req: unknown, next: () => unknown) => {
      if ((req as { summary?: string }).summary?.includes('carve-out')) return opts.answer;
      return next();
    });
  }

  // 工具注册表 + 真管道 + fs 工具族（fence 数据源随档位切换，模拟 app 装配）
  const service = registerToolsService(ctx, { pipeline: createToolPipeline(ctx) });
  installSafetyGate(ctx, { approval, workspace: ws, mode: () => mode });
  const fsTools = createFsTools({
    workspace: () => ws,
    writableRoots: () => (mode === 'read-only' ? [] : deriveWritableRoots(ws)),
  });
  for (const def of fsTools.tools) service.register(def);

  /** 经三段管道执行一个工具（唯一合法路径） */
  const run = (name: string, args: Record<string, unknown>) => {
    const def = service.get(name)!;
    return service.toAgentTool(def).execute('call-1', args);
  };
  return { ws, run, asked, decided, setMode: (m: SandboxMode) => (mode = m) };
}

/** 异步工具调用抛错断言 */
async function expectToolError(fn: () => Promise<unknown>, code: string): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    const e = err as AppError;
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe(code);
    return e;
  }
  expect.unreachable(`期望抛 ${code} 但未抛出`);
}

describe('守门行 × carve-out（workspace-write 档）', () => {
  it('普通文件写入：不经审批直接放行', async () => {
    const { ws, run, asked } = rig({ mode: 'workspace-write', answer: 'reject' });
    await run('write', { path: 'a.ts', content: 'export {};' });
    expect(existsSync(join(ws, 'a.ts'))).toBe(true);
    expect(asked).toHaveLength(0); // 无 carve-out 命中，审批从未发起
  });

  it('carve-out 命中（.git）+ 审批通过：allowed-once 放行本次写入', async () => {
    const { ws, run, asked, decided } = rig({
      mode: 'workspace-write',
      answer: 'approve',
      pre: (w) => mkdirSync(join(w, '.git')), // 父目录预置（write 不建目录）
    });
    await run('write', { path: '.git/config', content: '[core]' });
    // 写入真实落盘（allowed-once = 本次调用放行）
    expect(existsSync(join(ws, '.git', 'config'))).toBe(true);
    // 审批对完整：asked 摘要含 carve-out 条目；decided = approve
    expect(asked).toHaveLength(1);
    expect(asked[0]!.summary).toContain('.git');
    expect(decided).toEqual([{ approvalId: asked[0]!.approvalId, decision: 'approve' }]);
  });

  it('carve-out 命中 + 审批拒绝：TOOL_BLOCKED，denial marker + 升权 hint，文件不落盘', async () => {
    const { ws, run, decided } = rig({ mode: 'workspace-write', answer: 'reject' });
    const err = await expectToolError(() => run('write', { path: '.git/config', content: '[core]' }), TOOL_BLOCKED);
    expect(existsSync(join(ws, '.git'))).toBe(false);
    // §7.4 统一文案：拒绝标记 + 提示标记
    expect(err.message).toContain('[sandbox: file access denied under workspace-write]');
    expect(err.message).toContain('.git');
    expect(err.message).toContain('sandbox_permissions');
    expect(decided).toEqual([{ approvalId: expect.any(String) as string, decision: 'reject' }]);
  });

  it('carve-out 命中 + 无人应答：unavailable 同样 block（fail-closed）', async () => {
    const { run, decided } = rig({ mode: 'workspace-write' }); // 不注册 answerer
    await expectToolError(() => run('write', { path: '.env', content: 'SECRET=1' }), TOOL_BLOCKED);
    expect(decided[0]!.decision).toBe('unavailable');
  });

  it('edit 补丁夹带 carve-out 目标：block 短路在执行段之前（CAS 都不会碰）', async () => {
    const { ws, run } = rig({ mode: 'workspace-write', answer: 'reject' });
    const patch = ['*** Begin Patch', '*** Add File: .env', '+SECRET=1', '*** End Patch'].join('\n');
    await expectToolError(() => run('edit', { patch }), TOOL_BLOCKED);
    expect(existsSync(join(ws, '.env'))).toBe(false);
  });

  it('glob 条目遮罩真实存在的敏感文件（*.env 先展开再遮罩）', async () => {
    // prod.env 必须在守门行安装前就存在——glob 展开时刻在装配期（诚实语义：
    // 展开后新建的文件不追溯遮罩，见 buildCarveOutTable 注释）
    const { ws, run, asked } = rig({
      mode: 'workspace-write',
      answer: 'reject',
      pre: (w) => writeFileSync(join(w, 'prod.env'), 'OLD=0'),
    });
    await expectToolError(() => run('write', { path: 'prod.env', content: 'NEW=1' }), TOOL_BLOCKED);
    expect(asked[0]!.summary).toContain('prod.env');
    // 原文件未被改动
    expect(await run('read', { path: 'prod.env' })).toMatchObject({
      content: [{ type: 'text', text: 'OLD=0' }],
    });
  });
});

describe('两端档位分工（不归守门行管）', () => {
  it('read-only：本行跳过（无审批），fence 拒全量写', async () => {
    const { run, asked } = rig({ mode: 'read-only', answer: 'approve' });
    await expectToolError(() => run('write', { path: 'src/a.ts', content: 'x' }), FS_OUTSIDE_WRITABLE_ROOTS);
    expect(asked).toHaveLength(0); // 本行不发起审批——fence 已管
  });

  it('danger-full-access：本行跳过，carve-out 也不拦（全放行档）', async () => {
    const { ws, run, asked } = rig({
      mode: 'danger-full-access',
      pre: (w) => mkdirSync(join(w, '.git')),
    });
    await run('write', { path: '.git/config', content: '[core]' });
    expect(existsSync(join(ws, '.git', 'config'))).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it('档位运行中切换（override 即时生效）：workspace-write→read-only 后 fence 接管', async () => {
    const { run, asked, setMode } = rig({ mode: 'workspace-write', answer: 'approve' });
    setMode('read-only');
    await expectToolError(() => run('write', { path: '.git/config', content: '[core]' }), FS_OUTSIDE_WRITABLE_ROOTS);
    expect(asked).toHaveLength(0);
  });
});
