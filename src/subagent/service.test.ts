/**
 * subagent 模块单元测试 — ctx.subagents 服务面（骨架篇 §6.1 落码注记，纵切二）。
 *
 * 真件：真 createContext + 真 Job 注册表 + 真服务；provider 用测试替身
 * （provider 即单元边界——能力协商/Job 映射是被测逻辑，替身只回放结算契约）。
 * 锁行为面：注册词汇纪律 / provider 查找 / 四能力位协商 / 请求剥离 /
 * background Job 接线（stopReason→终态映射 + cancel→dispose）。
 */
import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import type { ContextScope } from '../context/types.js';
import {
  SUBAGENT_CAPABILITY_UNSUPPORTED,
  SUBAGENT_PROVIDER_DUPLICATE,
  SUBAGENT_PROVIDER_NOT_FOUND,
} from '../contracts/errors.js';
import type {
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentSettlement,
  SubagentStart,
  SubagentsServiceFace,
} from '../contracts/subagent.js';
import type { JobsServiceFace } from '../contracts/jobs.js';
import { createJobsService } from './jobs.js';
import { createSubagentsService } from './service.js';

/** 替身组装产物：provider + 观测面（start 收到的请求 / dispose 计数 / 结算注入） */
interface Stub {
  readonly provider: SubagentProvider;
  readonly started: SubagentStart[];
  /** 注入结算契约（start 时锁定的 promise resolve 值） */
  settleWith(result: SubagentResult): void;
  readonly disposeCalls: () => number;
}

/** 建 stub provider（能力面全 false 起步，逐测试开位） */
function stubProvider(name = 'stub', capabilities: Partial<SubagentCapabilities> = {}): Stub {
  const started: SubagentStart[] = [];
  let disposeCount = 0;
  let settleWith: (result: SubagentResult) => void = () => {};
  const result = new Promise<SubagentResult>((resolve) => {
    settleWith = resolve;
  });
  const provider: SubagentProvider = {
    name,
    capabilities: {
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
      context: false,
      ...capabilities,
    },
    start(request) {
      started.push(request);
      return { id: `run-${started.length}`, result, dispose: () => (disposeCount += 1) };
    },
  };
  return { provider, started, settleWith, disposeCalls: () => disposeCount };
}

/** 建服务组装（真 ctx + 真 Job 注册表 + 已注册一个默认 stub——返回面供测试改用） */
function setup(
  stub = stubProvider(),
  onSettle?: (settlement: SubagentSettlement) => void,
): {
  ctx: ContextScope;
  jobs: JobsServiceFace;
  service: SubagentsServiceFace;
  stub: Stub;
} {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const jobs = createJobsService(ctx);
  const service = createSubagentsService(ctx, { jobs, ...(onSettle ? { onSettle } : {}) });
  service.register(stub.provider);
  return { ctx, jobs, service, stub };
}

/** 断言某调用抛出指定码（同步/异步两形态） */
async function expectCode(code: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.unreachable(`预期抛出 ${code}，实际正常返回`);
  } catch (err) {
    expect(err).toMatchObject({ code });
  }
}

describe('ctx.subagents — 注册与查找', () => {
  it('register/list 正常；撞名即 SUBAGENT_PROVIDER_DUPLICATE；注销后回落 NOT_FOUND', async () => {
    const { service } = setup();
    const unregister = service.register(stubProvider('alpha').provider);
    expect(service.list().map((p) => p.name)).toEqual(['stub', 'alpha']);
    await expectCode(SUBAGENT_PROVIDER_DUPLICATE, () => service.register(stubProvider('alpha').provider));
    unregister();
    expect(service.list().map((p) => p.name)).toEqual(['stub']);
    await expectCode(SUBAGENT_PROVIDER_NOT_FOUND, () => service.start({ provider: 'alpha', prompt: 'hi' }));
  });

  it('start 未知 provider 即 SUBAGENT_PROVIDER_NOT_FOUND（报文带已注册清单）', async () => {
    const { service } = setup();
    await expectCode(SUBAGENT_PROVIDER_NOT_FOUND, () => service.start({ provider: 'ghost', prompt: 'x' }));
  });

  it('list 披露能力面（name + capabilities 快照）', () => {
    const { service } = setup();
    service.register(stubProvider('cap', { depthLimit: true }).provider);
    const info = service.list().find((p) => p.name === 'cap');
    expect(info?.capabilities).toEqual({
      outputSchema: false,
      depthLimit: true,
      toolFilter: false,
      persona: false,
      context: false,
    });
  });
});

describe('ctx.subagents — 能力协商布尔检查（start 前 fail-loud）', () => {
  // 请求面四能力位 ↔ 能力声明键（协商映射表逐位验证——请求带字段而未声明即拒）
  const CASES: readonly { field: string; extra: Record<string, unknown> }[] = [
    { field: 'outputSchema', extra: { outputSchema: { type: 'object' } } },
    { field: 'maxDepth', extra: { maxDepth: 2 } },
    { field: 'toolFilter', extra: { toolFilter: ['read_file'] } },
    { field: 'persona', extra: { persona: '你是审查员' } },
  ];

  it.each(CASES)(
    '请求携带 $field 而未声明 → SUBAGENT_CAPABILITY_UNSUPPORTED（provider.start 不被调）',
    async ({ extra }) => {
      const { service, stub } = setup();
      await expectCode(SUBAGENT_CAPABILITY_UNSUPPORTED, () =>
        service.start({ provider: 'stub', prompt: 'x', ...extra } as never),
      );
      expect(stub.started).toHaveLength(0);
    },
  );

  it('四能力全声明后全字段放行；请求剥离 provider/background 后达 provider', async () => {
    const { service, stub } = setup(
      stubProvider('full', { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }),
    );
    const run = service.start({
      provider: 'full',
      prompt: '审读这份代码',
      label: '委派-审读',
      ownerSessionId: 'sess-1',
      outputSchema: { type: 'object' },
      maxDepth: 2,
      toolFilter: ['read_file'],
      persona: '你是审查员',
    });
    expect(run.id).toBe('run-1');
    expect(stub.started[0]).toMatchObject({ prompt: '审读这份代码', label: '委派-审读', ownerSessionId: 'sess-1' });
    // 路由/形态字段不进 provider 面
    expect(stub.started[0]).not.toHaveProperty('provider');
    expect(stub.started[0]).not.toHaveProperty('background');
    stub.settleWith({ output: '审毕', stopReason: 'completed' });
    await expect(run.result).resolves.toMatchObject({ output: '审毕', stopReason: 'completed' });
  });

  it('能力位显式置 undefined 视为未携带（undefined !== undefined 为 false——不误伤空手请求）', async () => {
    const { service, stub } = setup();
    const run = service.start({ provider: 'stub', prompt: 'x', persona: undefined });
    expect(stub.started).toHaveLength(1);
    run.dispose();
  });
});

describe('ctx.subagents — background Job 接线（§6.2 一次性两形态）', () => {
  it('completed → Job 终态 completed（output 段载结算 output）', async () => {
    const { service, stub } = setup();
    const run = service.start({
      provider: 'stub',
      prompt: '干活',
      label: '后台件',
      ownerSessionId: 'sess-owner',
      background: true,
    });
    expect(run.job).toBeDefined();
    expect(run.job?.kind).toBe('subagent');
    expect(run.job?.ownerSessionId).toBe('sess-owner');
    stub.settleWith({ output: '产物摘要', stopReason: 'completed' });
    await expect(run.job?.done).resolves.toBe('completed');
    expect(run.job?.settled).toMatchObject({ terminal: 'completed', output: '产物摘要' });
  });

  it('aborted → killed；error → failed（error 段载 diagnostic；缺省落 stopReason）', async () => {
    const { service } = setup();
    const aborted = stubProvider('ab');
    const errored = stubProvider('err');
    service.register(aborted.provider);
    service.register(errored.provider);

    const runAb = service.start({ provider: 'ab', prompt: 'x', background: true });
    aborted.settleWith({ output: '', stopReason: 'aborted' });
    await expect(runAb.job?.done).resolves.toBe('killed');

    const runErr = service.start({ provider: 'err', prompt: 'x', background: true });
    errored.settleWith({ output: '', diagnostic: '子代理超时', stopReason: 'error' });
    await expect(runErr.job?.done).resolves.toBe('failed');
    expect(runErr.job?.settled).toMatchObject({ terminal: 'failed', error: '子代理超时' });

    // 无 diagnostic 的失败：error 段缺省落 stopReason 本身（扩展词汇 max-tokens 同走失败族）
    const capped = stubProvider('capped');
    service.register(capped.provider);
    const runCap = service.start({ provider: 'capped', prompt: 'x', background: true });
    capped.settleWith({ output: '', stopReason: 'max-tokens' });
    await expect(runCap.job?.done).resolves.toBe('failed');
    expect(runCap.job?.settled).toMatchObject({ terminal: 'failed', error: 'max-tokens' });
  });

  it('Job cancel → provider dispose（cancel 即子收工）；终态仍由 provider 结算落', async () => {
    const { service, stub } = setup();
    const run = service.start({ provider: 'stub', prompt: 'x', background: true });
    expect(stub.disposeCalls()).toBe(0);
    run.job?.cancel();
    expect(stub.disposeCalls()).toBe(1);
    // 终态由 provider 侧结算落（first-wins 在 executor 侧——此处 stub 手动落 killed）
    stub.settleWith({ output: '', stopReason: 'aborted' });
    await expect(run.job?.done).resolves.toBe('killed');
  });

  it('provider 违约 reject → 防御路兜底 failed（execution.result 契约永不 reject，此为保险）', async () => {
    // 专门造一个会 reject 的违约 provider（真实 provider 不该这样——防御路单测）
    let rejectWith: (err: Error) => void = () => {};
    const rogue: SubagentProvider = {
      name: 'rogue',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false, context: false },
      start() {
        return {
          id: 'rogue-1',
          result: new Promise<SubagentResult>((_resolve, reject) => (rejectWith = reject)),
          dispose: () => {},
        };
      },
    };
    const { service } = setup();
    service.register(rogue);
    const run = service.start({ provider: 'rogue', prompt: 'x', background: true });
    rejectWith(new Error('provider 违约崩溃'));
    await expect(run.job?.done).resolves.toBe('failed');
    expect(run.job?.settled).toMatchObject({ terminal: 'failed', error: 'provider 违约崩溃' });
  });

  it('前台模式（background 缺省）：无 Job，result 直通，dispose 直通', async () => {
    const { service } = setup();
    const fgStub = stubProvider('fg');
    service.register(fgStub.provider);
    const run = service.start({ provider: 'fg', prompt: 'x' });
    expect(run.job).toBeUndefined();
    run.dispose();
    expect(fgStub.disposeCalls()).toBe(1);
    fgStub.settleWith({ output: 'ok', stopReason: 'completed' });
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' });
  });
});

describe('ctx.subagents — onSettle 结算回调（§6.4 落码注记）', () => {
  it('background：Job 终态先落（回调内 status 已终态）→ onSettle → dispose（通知先于子所有权释放）', async () => {
    /** 回调时点观测面：Job 状态 / dispose 计数（顺序规则的同步证据） */
    let jobStatusAtCallback = '未触发';
    let disposeAtCallback = -1;
    const { service, stub } = setup(stubProvider('bg'), (s) => {
      jobStatusAtCallback = s.job?.status ?? '无 Job';
      disposeAtCallback = stub.disposeCalls();
    });
    const run = service.start({ provider: 'bg', prompt: '后台活', label: '标签', background: true });
    stub.settleWith({ output: '产物', stopReason: 'completed' });
    await expect(run.job!.done).resolves.toBe('completed');
    // 回调时点：Job 已终态（settle 先于 onSettle——折叠/通知基于已落定的终态）
    expect(jobStatusAtCallback).toBe('completed');
    // 回调时点：dispose 尚未发生（通知先于释放——§6.4 顺序规则）
    expect(disposeAtCallback).toBe(0);
    // 链尾：dispose 已执行（子所有权释放）
    expect(stub.disposeCalls()).toBe(1);
  });

  it('foreground：onSettle 照发（结算折叠要用）但 dispose 归调用方（服务不代释放）', async () => {
    const settlements: SubagentSettlement[] = [];
    const fgStub = stubProvider('fg2');
    const { service } = setup(fgStub, (s) => settlements.push(s));
    const run = service.start({ provider: 'fg2', prompt: '前台活' });
    fgStub.settleWith({ output: 'ok', stopReason: 'completed' });
    await run.result;
    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.job).toBeUndefined(); // 前台无 Job
    expect(settlements[0]!.result.stopReason).toBe('completed');
    expect(fgStub.disposeCalls()).toBe(0); // 服务不代释放——调用方消费 result 后自释放
  });

  it('onSettle 违约抛错：Job 照常结算、dispose 照常释放（回调隔离——不炸结算链）', async () => {
    const rogueStub = stubProvider('rogue-cb');
    const { service } = setup(rogueStub, () => {
      throw new Error('通知器炸了');
    });
    const run = service.start({ provider: 'rogue-cb', prompt: 'x', background: true });
    rogueStub.settleWith({ output: 'ok', stopReason: 'completed' });
    await expect(run.job!.done).resolves.toBe('completed');
    expect(rogueStub.disposeCalls()).toBe(1);
  });
});
