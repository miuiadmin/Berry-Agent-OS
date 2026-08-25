/**
 * L4 exec 单元测试 — bash 工具件（参数面 v1 执法 + 升权词汇首个消费者）。
 *
 * confine/审批用注入假件（本测试聚焦工具件自身分支）；真子进程真跑。
 * 覆盖：cwd 前缀判定 / 超时钳制标注 / 升权成对校验与被拒标记 /
 * allowed-once 只授予当次 / sandbox 元数据与 denied 分类 / danger 透传 /
 * 退出非零 isError / onUpdate 流式。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, SANDBOX_ESCALATION_INVALID, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import type { ToolCtx } from '../contracts/tools.js';
import type { SandboxMode, SandboxService } from '../safety/index.js';
import type { ApprovalService } from '../safety/approval.js';
import { createBashTool } from './tool.js';

/** 测试工作区（beforeAll 建 / afterAll 拆） */
let workspace = '';

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'bash-tool-test-'));
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** confine 假件：透传 argv + 记录每次策略（测升权档传递与元数据反射） */
function fakeSandbox() {
  const policies: Array<{ mode: SandboxMode; workspaceRoot: string }> = [];
  const sandbox: SandboxService = {
    confine(argv, policy) {
      policies.push({ mode: policy.mode, workspaceRoot: policy.workspaceRoot });
      return {
        argv: [...argv],
        enforcement: 'partial',
        denialSignatures: ['Operation not permitted'],
        runnerFailureRules: [],
      };
    },
    registerBackend: () => () => undefined,
    listBackends: () => [],
  };
  return { sandbox, policies };
}

/** 审批假件：ask 可编程应答（缺省 allowed-once） */
function fakeApproval(outcome: 'allowed-once' | 'rejected' = 'allowed-once') {
  const asked: string[] = [];
  const approval = {
    policyMode: 'ask',
    ask: async (req: { summary: string }): Promise<'allowed-once' | 'rejected'> => {
      asked.push(req.summary);
      return outcome;
    },
  } as unknown as ApprovalService;
  return { approval, asked };
}

/** 组装被测工具 + 假件（mode 缺省 workspace-write） */
function makeTool(overrides?: { mode?: () => SandboxMode; approvalOutcome?: 'allowed-once' | 'rejected' }) {
  const sb = fakeSandbox();
  const ap = fakeApproval(overrides?.approvalOutcome ?? 'allowed-once');
  const tool = createBashTool({
    sandbox: sb.sandbox,
    approval: ap.approval,
    mode: overrides?.mode ?? (() => 'workspace-write'),
    workspaceRoot: workspace,
  });
  return { tool, policies: sb.policies, asked: ap.asked };
}

/** 最小工具执行上下文（execute 直调——管道行为另有 service 测试覆盖） */
const TCTX: ToolCtx = { toolCallId: 'test-call-1' };

/** 直调 execute 的速记 */
const run = (tool: ReturnType<typeof makeTool>['tool'], args: Record<string, unknown>, tctx: ToolCtx = TCTX) =>
  tool.execute(args, tctx) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details: { exitCode: number | null; sandbox: { mode: string; denied: string[]; enforcement: string } };
  }>;

describe('cwd 前缀判定（canonical 化后须落 workspaceRoot 内）', () => {
  it('工作区外绝对路径 = TOOL_ARGUMENTS_INVALID', async () => {
    const { tool } = makeTool();
    await expect(() => run(tool, { command: 'pwd', cwd: '/etc' })).rejects.toThrowError(AppError);
    try {
      await run(tool, { command: 'pwd', cwd: '/etc' });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
    }
  });
  it('工作区外相对路径（../ 逃逸）= TOOL_ARGUMENTS_INVALID', async () => {
    const { tool } = makeTool();
    try {
      await run(tool, { command: 'pwd', cwd: '../../outside' });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(TOOL_ARGUMENTS_INVALID);
    }
  });
  it('工作区内相对路径合法且生效（pwd 命中解析目录）', async () => {
    const { tool } = makeTool();
    const result = await run(tool, { command: 'pwd', cwd: '.' });
    expect(result.details.exitCode).toBe(0);
    expect(result.content[0]!.text).toContain(workspace);
  });
});

describe('超时钳制（缺省 120s / 上限 600s）', () => {
  it('超上限请求被钳到 600000ms 且结果开头标注', async () => {
    const { tool } = makeTool();
    const result = await run(tool, { command: 'echo hi', timeoutMs: 9_000_000 });
    expect(result.content[0]!.text).toContain('600000');
    expect(result.content[0]!.text).toContain('钳制');
    expect(result.details.exitCode).toBe(0);
  });
});

describe('升权两参数（成对非空词汇——首个消费者）', () => {
  it('单边提供 = SANDBOX_ESCALATION_INVALID（不给弹窗机会）', async () => {
    const { tool } = makeTool();
    try {
      await run(tool, { command: 'echo x', sandbox_permissions: 'danger-full-access' });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(SANDBOX_ESCALATION_INVALID);
    }
  });
  it('审批被拒 = 不执行命令、统一标记 + hint、isError', async () => {
    const { tool, asked } = makeTool({ approvalOutcome: 'rejected' });
    const result = await run(tool, {
      command: 'echo SHOULD-NOT-RUN',
      sandbox_permissions: 'danger-full-access',
      justification: '测试拒绝路径',
    });
    expect(asked).toHaveLength(1); // 审批确实发起过
    expect(result.content[0]!.text).not.toContain('SHOULD-NOT-RUN'); // 命令未执行（无 stdout 回显）
    expect(result.content[0]!.text).toContain('[sandbox: file access denied under workspace-write]');
    expect(result.content[0]!.text).toContain('[sandbox hint:');
    expect(result.isError).toBe(true);
    expect(result.details.sandbox.mode).toBe('workspace-write');
  });
  it('allowed-once = 目标档只授予当次调用（confine 收到升后档）', async () => {
    const { tool, policies } = makeTool({ mode: () => 'read-only' });
    const result = await run(tool, {
      command: 'echo ok',
      sandbox_permissions: 'workspace-write',
      justification: '测试批准路径',
    });
    expect(policies.at(-1)?.mode).toBe('workspace-write'); // 本次按目标档包装
    expect(result.details.exitCode).toBe(0);
    expect(result.details.sandbox.mode).toBe('workspace-write');
    // 后续无参调用回到原档（allowed-once 不留痕）
    const next = await run(tool, { command: 'echo again' });
    expect(policies.at(-1)?.mode).toBe('read-only');
    expect(next.details.sandbox.mode).toBe('read-only');
  });
});

describe('sandbox 元数据与 denied 分类', () => {
  it('confine 元数据反射进 details.sandbox；denied 命中即标记 + hint', async () => {
    const { tool } = makeTool();
    const result = await run(tool, { command: 'echo denied-ish >&2; echo "Operation not permitted" >&2; true' });
    expect(result.details.sandbox.enforcement).toBe('partial');
    expect(result.details.sandbox.denied).toContain('Operation not permitted');
    expect(result.content[0]!.text).toContain('[sandbox: file access denied under workspace-write]');
    expect(result.content[0]!.text).toContain('[sandbox hint:');
    expect(result.isError).toBe(true); // denied 命中即错
  });
  it('danger-full-access = 透传不进 confine、enforcement none', async () => {
    const { tool, policies } = makeTool({ mode: () => 'danger-full-access' });
    const result = await run(tool, { command: 'echo raw' });
    expect(policies).toHaveLength(0); // danger 档不调 confine
    expect(result.details.sandbox.enforcement).toBe('none');
    expect(result.details.exitCode).toBe(0);
  });
});

describe('结果面基础', () => {
  it('退出非零 = isError 且 exit code 进文本（失败二分·已启动腿）', async () => {
    const { tool } = makeTool();
    const result = await run(tool, { command: 'exit 7' });
    expect(result.details.exitCode).toBe(7);
    expect(result.content[0]!.text).toContain('exit code: 7');
    expect(result.isError).toBe(true);
  });
  it('onUpdate 流式增量透传（[stream] 前缀形态）', async () => {
    const { tool } = makeTool();
    const partials: string[] = [];
    await run(
      tool,
      { command: 'echo streaming' },
      {
        toolCallId: 't2',
        onUpdate: (partial) => partials.push((partial.content[0] as { text: string }).text),
      },
    );
    expect(partials.join('')).toContain('streaming');
    expect(partials.some((p) => p.startsWith('[stdout]'))).toBe(true);
  });
});
