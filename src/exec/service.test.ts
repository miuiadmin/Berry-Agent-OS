/**
 * L4 exec 单元测试 — ctx.exec 服务（骨架篇 §9.3：同一条三段管道不旁路）。
 *
 * 真 context + 真三段管道（schema 校验/守门/执行/后处理全真）；confine 用
 * 注入假件。核心断言：服务调用同样吃守门（block 即 TOOL_BLOCKED 抛回）、
 * env 表执法（EXEC_ENV_FORBIDDEN）、失败二分两腿、stdin/env 选项面。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, EXEC_ENV_FORBIDDEN, EXEC_SPAWN_FAILED, TOOL_BLOCKED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { TOOL_PRE_EXECUTE_EVENT } from '../contracts/tools.js';
import { createContext } from '../context/index.js';
import { runInCallerChain } from '../context/chain.js';
import { createToolPipeline } from '../tools/index.js';
import type { SandboxMode, SandboxService } from '../safety/index.js';
import { registerExecService } from './service.js';
import { hostInjectRecord } from './env.js';

/** 测试工作区 */
let workspace = '';
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'exec-service-test-'));
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** confine 假件：透传 + partial 元数据（真包装语义在 safety 模块测） */
const fakeSandbox: SandboxService = {
  confine: (argv) => ({ argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }),
  registerBackend: () => () => undefined,
  listBackends: () => [],
};

/** 组装真管道 + 被测服务（每用例独立 context）。extra = 按用例注入的
 *  ExecServiceOptions 扩展面（行代执行强制预算注入位 rowExecTimeoutMs——
 *  60s 缺省在测试形态不可观察，测试专用覆写面） */
function makeService(mode: () => SandboxMode = () => 'workspace-write', extra?: { rowExecTimeoutMs?: number }) {
  const ctx = createContext({ name: 'test-exec-service' });
  const pipeline = createToolPipeline(ctx);
  const service = registerExecService(ctx, {
    pipeline,
    sandbox: fakeSandbox,
    mode,
    workspaceRoot: workspace,
    ...extra,
  });
  return { ctx, service };
}

describe('ctx.exec 基本面', () => {
  it('exec(cmd, args) → ExecResult（exitCode/stdout/sandbox 元数据）', async () => {
    const { service } = makeService();
    const result = await service.exec('bash', ['-c', 'echo svc-ok']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('svc-ok');
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: [], enforcement: 'partial' });
  });
  it('退出非零 = 正常返回（失败二分·已启动腿——服务面不折算异常）', async () => {
    const { service } = makeService();
    const result = await service.exec('bash', ['-c', 'exit 4']);
    expect(result.exitCode).toBe(4);
  });
  it('程序不存在 = EXEC_SPAWN_FAILED（未启动腿携 cause 语义）', async () => {
    const { service } = makeService();
    await expect(() => service.exec('not-a-program-xyz', [])).rejects.toThrowError(AppError);
    try {
      await service.exec('not-a-program-xyz', []);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(EXEC_SPAWN_FAILED);
    }
  });
  it('内部名 exec 不进模型词汇表（工具注册表无此名——经管道但非注册 def）', async () => {
    const { ctx, service } = makeService();
    // 注册表服务本测试未挂（tools 服务未 provide）——间接证明：管道跑通且
    // 无 TOOL_DUPLICATE/注册依赖，即合成 def 不依赖注册表面
    await service.exec('bash', ['-c', 'true']);
    expect(ctx.tryGet('tools')).toBeUndefined();
  });
});

describe('ctx.exec 选项面（原语侧宽——与 bash 工具侧刻意不对称）', () => {
  it('stdin 一次性喂入', async () => {
    const { service } = makeService();
    const result = await service.exec('bash', ['-c', 'cat'], { stdin: 'piped-input' });
    expect(result.stdout).toBe('piped-input');
  });
  it('env.set 显式值传进子进程', async () => {
    const { service } = makeService();
    const result = await service.exec('bash', ['-c', 'echo "$FOO"'], { env: { set: { FOO: 'bar-via-set' } } });
    expect(result.stdout.trim()).toBe('bar-via-set');
  });
  it('env.inherit 命中禁运名 = EXEC_ENV_FORBIDDEN（先于执行响亮拒）', async () => {
    const { service } = makeService();
    try {
      await service.exec('bash', ['-c', 'true'], { env: { inherit: ['SOME_API_KEY'] } });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(EXEC_ENV_FORBIDDEN);
    }
  });
  it('timeoutMs 自治超时 = TOOL_TIMEOUT 树杀', async () => {
    const { service } = makeService();
    try {
      await service.exec('bash', ['-c', 'sleep 30'], { timeoutMs: 300 });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(TOOL_TIMEOUT);
    }
  });
});

describe('行代执行强制预算（契约篇 §1.7 第十一轮遗漏大扫 20260904-b 增补第 2 条——A19 腿三）', () => {
  it('caller 链有行帧且未显式给 timeoutMs → 强制行预算截停永挂 sleep（修前红：内部 def 预算 0 不设限，行帧代执行可永挂宿主侧进程）', async () => {
    const { service } = makeService(() => 'workspace-write', { rowExecTimeoutMs: 400 });
    try {
      // runInCallerChain 注入行帧（svc-invoke/tool-run 过桥的代执行形态——
      // chainCallers() 非空即行帧在场；worker-threads 行 confinementFor 返回
      // undefined 不可作行判据，行帧在场性本身才是判据）
      await runInCallerChain('apps-hostile', () => service.exec('bash', ['-c', 'sleep 30']));
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(TOOL_TIMEOUT);
    }
  }, 15_000);
  it('宿主 origin（链无行帧）不受强制预算——1.2s 命令跑过 800ms 注入面（锁修复射界：预算只对行帧调用生效，宿主 origin 维持原语侧超时自治）', async () => {
    const { service } = makeService(() => 'workspace-write', { rowExecTimeoutMs: 800 });
    const result = await service.exec('bash', ['-c', 'sleep 1.2; echo done']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done');
  }, 15_000);
});

describe('同一条三段管道（服务调用不旁路守门）', () => {
  it('守门 block = TOOL_BLOCKED 抛回服务调用方（落账归发起方会话的管道接线）', async () => {
    const { ctx, service } = makeService();
    ctx.on(TOOL_PRE_EXECUTE_EVENT, () => ({ decision: 'block' as const, reason: 'exec 测试拦截' }));
    try {
      await service.exec('bash', ['-c', 'echo must-not-run']);
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe(TOOL_BLOCKED);
      expect((err as AppError).message).toContain('exec 测试拦截');
    }
  });
});

describe('行收窄注入面（R1 P0-4——confinementFor 按 caller-chain 行 id 收窄，契约篇 §1.7 增补 2c）', () => {
  it('caller-chain 行帧命中 → confine 收行有效白名单（writableRoots 显式覆盖面）；非行帧维持会话档现行为', async () => {
    // confine 记录桩：捕获收到的完整 policy（writableRoots 有无即收窄有无）
    const policies: Array<{ mode: SandboxMode; workspaceRoot: string; writableRoots?: readonly string[] }> = [];
    const recording: SandboxService = {
      confine: (argv, policy) => {
        policies.push({ ...policy });
        return { argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
      },
      registerBackend: () => () => undefined,
      listBackends: () => [],
    };
    const ctx = createContext({ name: 'test-exec-row-confinement' });
    const pipeline = createToolPipeline(ctx);
    const service = registerExecService(ctx, {
      pipeline,
      sandbox: recording,
      mode: () => 'workspace-write',
      workspaceRoot: workspace,
      // 行收窄注入面：'row-x' → 行有效白名单；其余 caller = undefined = 不收窄
      confinementFor: (caller) => (caller === 'row-x' ? ['/ws/row-x-data'] : undefined),
    });
    // 行帧调用（svc-invoke/tool-run 罩 runInCallerChain 的同族形态）→ 收窄传导
    await runInCallerChain('row-x', () => service.exec('bash', ['-c', 'true']));
    expect(policies.at(-1)).toMatchObject({ writableRoots: ['/ws/row-x-data'] });
    // 非行帧（宿主直调——无 chain）→ confinementFor 收 undefined → confine
    // 不带 writableRoots（会话档现行为；修复前：恒 {mode, workspaceRoot} 两键，
    // 行声明收窄不进间接写面）
    await service.exec('bash', ['-c', 'true']);
    expect(policies.at(-1)).not.toHaveProperty('writableRoots');
    // 不相干的行 id（注入面回 undefined）→ 同样不收窄
    await runInCallerChain('row-other', () => service.exec('bash', ['-c', 'true']));
    expect(policies.at(-1)).not.toHaveProperty('writableRoots');
  });

  it('多帧命中取交集（R1 复盘批二栈化）：嵌套帧窄者胜——借道不丢约束', async () => {
    // 栈形：external 行帧（svc-invoke/tool-run 还帧）内再起委派工具（执行段
    // 按注册归属重包）→ 栈 = [row-a, row-b]。两行各有声明时交集收窄：
    // row-a → [/ws/a]，row-b → [/ws/a/sub, /ws/c] → 交集 = [/ws/a/sub]。
    // 修复前（chainCaller 单帧读最近）：只取 row-b → [/ws/a/sub, /ws/c]，
    // /ws/c 混入（外层行 a 的约束丢失）——本例必红
    const policies: Array<{ writableRoots?: readonly string[] }> = [];
    const recording: SandboxService = {
      confine: (argv, policy) => {
        policies.push({ ...policy });
        return { argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
      },
      registerBackend: () => () => undefined,
      listBackends: () => [],
    };
    const ctx = createContext({ name: 'test-exec-row-intersect' });
    const pipeline = createToolPipeline(ctx);
    const service = registerExecService(ctx, {
      pipeline,
      sandbox: recording,
      mode: () => 'workspace-write',
      workspaceRoot: workspace,
      confinementFor: (caller) =>
        caller === 'row-a' ? ['/ws/a'] : caller === 'row-b' ? ['/ws/a/sub', '/ws/c'] : undefined,
    });
    await runInCallerChain('row-a', () => runInCallerChain('row-b', () => service.exec('bash', ['-c', 'true'])));
    expect(policies.at(-1)?.writableRoots).toEqual(['/ws/a/sub']);
  });

  it('read-only 会话档 + 行帧：执法面 = 行基线非会话档投影（契约篇 §1.7 第 11b 条裁定——行为锁）', async () => {
    // 两轴正交裁定：会话档管「会话上下文里的写」，行帧管「行代执行的写」——
    // read-only 会话下行帧 svc-invoke 调 exec 的间接子进程仍按行基线可写
    // （与域本体 PM 旗同权：域后台不受宿主会话档约束）。本例锁现行行为，
    // 防未来「交集化」误改静默翻转语义
    const policies: Array<{ mode: SandboxMode; writableRoots?: readonly string[] }> = [];
    const recording: SandboxService = {
      confine: (argv, policy) => {
        policies.push({ ...policy });
        return { argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
      },
      registerBackend: () => () => undefined,
      listBackends: () => [],
    };
    const ctx = createContext({ name: 'test-exec-row-readonly' });
    const pipeline = createToolPipeline(ctx);
    const service = registerExecService(ctx, {
      pipeline,
      sandbox: recording,
      mode: () => 'read-only',
      workspaceRoot: workspace,
      confinementFor: (caller) => (caller === 'row-x' ? ['/ws/row-x-data'] : undefined),
    });
    await runInCallerChain('row-x', () => service.exec('bash', ['-c', 'true']));
    // 行帧覆盖在场（writableRoots = 行基线）——read-only 会话档不放大也不清空它
    expect(policies.at(-1)).toMatchObject({ mode: 'read-only', writableRoots: ['/ws/row-x-data'] });
    // 对照：非行帧 read-only = 会话档现行为（无 writableRoots 覆盖）
    await service.exec('bash', ['-c', 'true']);
    expect(policies.at(-1)).not.toHaveProperty('writableRoots');
  });

  it('danger-full-access 档透传不 confine（行收窄只发生在受限档——会话级豁免优先）', async () => {
    const policies: unknown[] = [];
    const recording: SandboxService = {
      confine: (argv, policy) => {
        policies.push(policy);
        return { argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] };
      },
      registerBackend: () => () => undefined,
      listBackends: () => [],
    };
    const ctx = createContext({ name: 'test-exec-row-danger' });
    const pipeline = createToolPipeline(ctx);
    const service = registerExecService(ctx, {
      pipeline,
      sandbox: recording,
      mode: () => 'danger-full-access',
      workspaceRoot: workspace,
      confinementFor: () => ['/ws/never-reaches'],
    });
    await runInCallerChain('row-x', () => service.exec('bash', ['-c', 'true']));
    expect(policies).toEqual([]); // danger 透传：confine 全程不被调
  });
});

describe('宿主主动注入通道接线（契约篇 §1.2，2026-08-31 第四十四批）', () => {
  /** 组装带 hostEnv 的被测服务（真子进程 echo 探测——行为级物证） */
  function makeInjectedService(sessionId: string | undefined) {
    const ctx = createContext({ name: 'test-exec-hostenv' });
    const pipeline = createToolPipeline(ctx);
    const service = registerExecService(ctx, {
      pipeline,
      sandbox: fakeSandbox,
      mode: () => 'workspace-write',
      workspaceRoot: workspace,
      hostEnv: () => hostInjectRecord(sessionId),
    });
    return service;
  }

  it('hostEnv 在场无 env 表：注入层恒生效（合成 env 不缺席）', async () => {
    const service = makeInjectedService('sess-svc-1');
    // 无 callOpts.env 也无注入时 env=undefined 走 spawn 缺省；注入在场则必合成
    const result = await service.exec('bash', ['-c', 'echo "$AI_AGENT|$APP_SESSION_ID"']);
    expect(result.stdout).toContain('berry|sess-svc-1');
  });
  it('注入层与变更表同层序单源：set 覆盖注入值、白名单照透', async () => {
    const service = makeInjectedService('sess-svc-2');
    const result = await service.exec('bash', ['-c', 'echo "$AI_AGENT|$APP_SESSION_ID|$FOO"'], {
      env: { set: { FOO: 'table-wins' } },
    });
    expect(result.stdout).toContain('berry|sess-svc-2|table-wins');
  });
  it('无会话语境：APP_SESSION_ID 诚实缺席、AI_AGENT 恒在', async () => {
    const service = makeInjectedService(undefined);
    const result = await service.exec('bash', ['-c', 'echo "[$AI_AGENT][$APP_SESSION_ID]"']);
    expect(result.stdout).toContain('[berry][]');
  });
});
