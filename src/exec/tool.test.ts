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
import { hostInjectRecord } from './env.js';

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

/** 审批假件：ask 可编程应答（缺省 allowed-once）；捕获完整载荷（草案断言用） */
function fakeApproval(outcome: 'allowed-once' | 'rejected' = 'allowed-once') {
  const asked: { summary: string; suggestedEntry?: { tool: string; pattern: string } }[] = [];
  const approval = {
    policyMode: 'ask',
    ask: async (req: { summary: string; suggestedEntry?: { tool: string; pattern: string } }) => {
      asked.push(req);
      return outcome;
    },
  } as unknown as ApprovalService;
  return { approval, asked };
}

/** 组装被测工具 + 假件（mode 缺省 workspace-write） */
function makeTool(overrides?: {
  mode?: () => SandboxMode;
  approvalOutcome?: 'allowed-once' | 'rejected';
  allowlist?: readonly { tool: string; pattern: string }[];
}) {
  const sb = fakeSandbox();
  const ap = fakeApproval(overrides?.approvalOutcome ?? 'allowed-once');
  const tool = createBashTool({
    sandbox: sb.sandbox,
    approval: ap.approval,
    mode: overrides?.mode ?? (() => 'workspace-write'),
    workspaceRoot: workspace,
    ...(overrides?.allowlist !== undefined ? { allowlist: overrides.allowlist } : {}),
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
    details: {
      exitCode: number | null;
      sandbox: { mode: string; denied: string[]; enforcement: string };
      outputEncoding: { stdout: string; stderr: string };
    };
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

describe('cwd 缺省 = workspaceRoot（§7.3 会话不可变 cwd 的工具面兑现）', () => {
  // 遗漏大扫 20260903 #29② 组合锁发现的同源单元锁：修前缺省直透 undefined →
  // spawn 继承宿主进程 cwd（vitest 下 = 仓根），pwd 不命中 mkdtemp 工作区即红
  it('不给 cwd 时 pwd 命中工作区根（不继承宿主进程 cwd）', async () => {
    const { tool } = makeTool();
    const result = await run(tool, { command: 'pwd' });
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

describe('升权 × allowlist 免问（§8.4 增补 2——bash 族唯一消费点）', () => {
  it('workspace-write 目标 + 词干命中条目：免问直接升档（allowed-once 语义同源）', async () => {
    const { tool, policies, asked } = makeTool({
      mode: () => 'read-only',
      allowlist: [{ tool: 'bash', pattern: 'git' }],
    });
    const result = await run(tool, {
      // git --version 词干 = 'git'（--version 属无害 flag 三件）仍命中条目，且
      // 不依赖 cwd 是否 git 仓——曾用 `git status` 隐性依赖宿主 cwd（仓根）是
      // git 仓（修前缺省继承宿主 cwd）；cwd 缺省 = workspaceRoot 后测试工作区
      // （mkdtemp）非 git 仓，status 会 exit 128（遗漏大扫 20260903 #29② 同源）
      command: 'git --version',
      sandbox_permissions: 'workspace-write',
      justification: '测试词干授权',
    });
    expect(asked).toHaveLength(0); // 免审批
    expect(policies.at(-1)?.mode).toBe('workspace-write'); // 仍按目标档包装（advisory 只免问）
    expect(result.details.sandbox.mode).toBe('workspace-write');
    expect(result.details.exitCode).toBe(0); // 命令真实执行
  });

  it('danger 目标恒问：条目在场也照审批（落码形态② danger 恒问边界）', async () => {
    const { tool, asked } = makeTool({
      allowlist: [{ tool: 'bash', pattern: 'git' }],
    });
    await run(tool, {
      command: 'git status',
      sandbox_permissions: 'danger-full-access',
      justification: '测试 danger 恒问',
    });
    expect(asked).toHaveLength(1);
  });

  it('草案透传：workspace-write 目标带剥壳词干；剥不出（管道）即无草案', async () => {
    const { tool, asked } = makeTool({ mode: () => 'read-only' });
    await run(tool, {
      command: 'echo clean',
      sandbox_permissions: 'workspace-write',
      justification: '测试草案',
    });
    expect(asked[0]!.suggestedEntry).toEqual({ tool: 'bash', pattern: 'echo clean' });
    // 管道命令剥不出单一词干。注意命令会被真实执行（审批桩放行）——必须选
    // 零写盘形态：曾用 `echo dirty | tee x` 在仓库根落 x 残留文件（2026-08-29
    // 清扫批根治），grep 纯消费无副作用
    await run(tool, {
      command: 'echo dirty | grep dirty',
      sandbox_permissions: 'workspace-write',
      justification: '测试无草案',
    });
    expect(asked[1]!.suggestedEntry).toBeUndefined(); // 不可判定 → 选项不呈现
  });

  it('词干不匹配条目：照问（pattern 双词 vs 命令子命令不同）', async () => {
    const { tool, asked } = makeTool({
      mode: () => 'read-only',
      allowlist: [{ tool: 'bash', pattern: 'git push' }],
    });
    await run(tool, {
      command: 'git status',
      sandbox_permissions: 'workspace-write',
      justification: '测试不匹配',
    });
    expect(asked).toHaveLength(1);
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

  it('非 UTF-8 输出 = 有损标注行随流标注（spawn 半边非静默纪律，P1-3 缺口④）', async () => {
    const { tool } = makeTool();
    // printf 直出 '测试' 的 GBK 字节——非 win32 无本地标签落④有损：
    // 标注行紧跟 --- stdout --- 之后（in-band；模型只见 content）
    const result = await run(tool, { command: "printf '\\xb2\\xe2\\xca\\xd4'" });
    const text = result.content[0]!.text;
    expect(text).toContain('--- stdout ---');
    expect(text).toContain('有损解码');
    // details.outputEncoding 双流终判随 ...run 展开自动携带
    expect(result.details.outputEncoding).toMatchObject({ stdout: 'utf-8-lossy', stderr: 'utf-8' });
  });
});

describe('宿主主动注入通道接线（契约篇 §1.2，2026-08-31 第四十四批）', () => {
  /** 组装带 hostEnv 的被测工具（真子进程 echo 探测——行为级物证非 mock 断言） */
  function makeInjectedTool(sessionId: string | undefined) {
    const sb = fakeSandbox();
    const ap = fakeApproval();
    const tool = createBashTool({
      sandbox: sb.sandbox,
      approval: ap.approval,
      mode: () => 'danger-full-access', // 透传 argv——聚焦 env 面不被 confine 包装干扰
      workspaceRoot: workspace,
      hostEnv: () => hostInjectRecord(sessionId),
    });
    return tool;
  }

  it('hostEnv 在场：子进程可见 AI_AGENT + APP_SESSION_ID（逐调用取最新）', async () => {
    const tool = makeInjectedTool('sess-tool-1');
    const result = await run(tool, { command: 'echo "$AI_AGENT|$APP_SESSION_ID"' });
    expect(result.content[0]!.text).toContain('berry|sess-tool-1');
    // 取值器逐调用取最新：第二次调用换会话 id，注入值跟随
    const toolAgain = makeInjectedTool('sess-tool-2');
    const result2 = await run(toolAgain, { command: 'echo "$APP_SESSION_ID"' });
    expect(result2.content[0]!.text).toContain('sess-tool-2');
  });
  it('hostEnv 缺席：装配形态不注入（spawn 缺省 env 面无注入词）', async () => {
    const { tool } = makeTool(); // makeTool 不带 hostEnv——缺省装配形态
    const result = await run(tool, { command: 'echo "[$AI_AGENT][$APP_SESSION_ID]"' });
    expect(result.content[0]!.text).toContain('[][]');
  });
  it('无会话语境：APP_SESSION_ID 诚实缺席、AI_AGENT 恒在', async () => {
    const tool = makeInjectedTool(undefined);
    const result = await run(tool, { command: 'echo "[$AI_AGENT][$APP_SESSION_ID]"' });
    expect(result.content[0]!.text).toContain('[berry][]');
  });
});
