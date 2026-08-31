/**
 * subagent 模块 — SubagentProvider 一致性套件（契约篇 §6.3 seam 清单落码形态细化，
 * 2026-08-31 第四十一批——Ring 3 前置行动 7 销账批）。
 *
 * 目的：单实现 seam 的「第二实现验证」——inprocess（fixture 工厂）× oop-fixture
 * （真子进程）跑**同一共享断言族**，驱动面 = 真 createSubagentsService（能力协商
 * fail-loud / background Job 终态映射 / onSettle 两链 / dispose 语义 / result 永不
 * reject）。任何契约漏在此暴露后须回写契约（§6.5 pre-release 自由窗口），禁带病通过。
 *
 * oop-fixture 子进程协议（行帧 JSON 单发单收——SubagentStart 契约 JSON-clean 是
 * 序列化面成立的判据本身）：
 *   父→子 start 载荷单行 {prompt, persona?, model?, mode}
 *   子→父 结果单行 {output, diagnostic?, usage?, stopReason}
 *   mode=ok        → 应答 echo 文本 + usage 自报 + completed
 *   mode=diagnose  → 应答 {stopReason:'error', diagnostic} ——测 diagnostic 优先路
 *   mode=fail      → 写 stderr 后异常退出（无结果行）——provider 兜底映射 error
 *   mode=hang      → 永不应答；SIGTERM 退出——dispose 兜底映射 aborted（kill 收场）
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import { AppError, SUBAGENT_CAPABILITY_UNSUPPORTED, SUBAGENT_DEPTH_EXCEEDED } from '../contracts/errors.js';
import type { Usage } from '../contracts/llm.js';
import type { AgentMessage } from '../contracts/messages.js';
import type {
  SubagentProvider,
  SubagentRequest,
  SubagentResult,
  SubagentSettlement,
  SubagentStopReason,
} from '../contracts/subagent.js';
import type { RunResult } from '../agent/loop.js';
import { Session } from '../session/session.js';
import { createInProcessProvider, type InProcessChildFactory } from './inprocess.js';
import { createJobsService } from './jobs.js';
import { createSubagentsService } from './service.js';

/* ---------------- 公共 fixture 零件 ---------------- */

/** 场景三态：ok=正常结算 / error=失败族 / hang=悬挂至取消（dispose/终链测试用） */
type Scenario = 'ok' | 'error' | 'hang';

/** fixture 用量自报（oop 子进程与 inprocess 工厂同报此值——usage 面共享断言用） */
const FIXTURE_USAGE: Usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

/** 零用量（合成 assistant 消息基线） */
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

/** 合成 assistant 文本消息（fixture RunResult 尾块用） */
function fixtureAssistant(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], usage: NO_USAGE, stopReason: 'stop', timestamp: 3 };
}

/* ---------------- inprocess fixture 工厂（第一实现侧） ---------------- */

/** inprocess fixture 工厂选项：深度执法/预算帽专节的旋钮 */
interface InprocessFixtureOptions {
  /** 子 header 深度（深度执法专节用；缺省 1——常规帽下不触法） */
  readonly delegationDepth?: number;
  /** 预算帽专节：run 起步即自报的用量（totalTokens ≥ 帽即触顶改判） */
  readonly usageReport?: Usage;
}

/**
 * inprocess 侧 fixture 工厂：纯内存 Session（零 persistence 接线——provider 只读
 * header.delegationDepth / header.sessionId 两面）+ 直造 RunResult 的子装配。
 * 场景行为：ok → 自报用量后回 completed；error → run 抛错（provider 兜底映射）；
 * hang → 悬挂至取消信号后回 aborted。
 */
function inprocessFactory(scenario: Scenario, opts: InprocessFixtureOptions = {}): InProcessChildFactory {
  return ({ request, signal, onUsage }) => ({
    // 纯内存会话——fork origin 语义由 header.delegationDepth 表达即够
    session: new Session({ delegationDepth: opts.delegationDepth ?? 1 }),
    async run(): Promise<RunResult> {
      if (scenario === 'error') throw new Error('fixture 子装配崩溃');
      // ok 路缺省自报用量（与 oop 子进程同形——usage 面共享断言双侧成立）
      onUsage(opts.usageReport ?? FIXTURE_USAGE);
      if (scenario === 'hang') {
        // 悬挂至 abort：dispose / Job cancel / 预算帽触顶共此一源（真子 loop 同语义）。
        // 已 abort 的信号不回放事件——先查 aborted 再挂监听（预算帽同步触顶竞速）
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 'aborted', messages: [fixtureAssistant('半途')], errorMessage: '取消' };
      }
      return {
        status: 'completed',
        messages: [fixtureAssistant(`echo:${request.prompt}`)],
        stopReason: 'stop',
      };
    },
    dispose() {
      // fixture 子装配零资源——释放为空操作（真工厂此处 flush/销毁）
    },
  });
}

/** inprocess 场景化 provider 构造（专节旋钮透传） */
function makeInprocess(
  scenario: Scenario,
  opts: InprocessFixtureOptions = {},
  providerOpts?: { tokenBudget?: number; maxDepth?: number },
): SubagentProvider {
  return createInProcessProvider({
    factory: inprocessFactory(scenario, opts),
    ...(providerOpts?.tokenBudget !== undefined ? { tokenBudget: providerOpts.tokenBudget } : {}),
    ...(providerOpts?.maxDepth !== undefined ? { maxDepth: providerOpts.maxDepth } : {}),
  });
}

/* ---------------- oop fixture provider（第二实现侧——真子进程） ---------------- */

/**
 * oop 子进程脚本（node -e 内联——MCP 测试先例同款落位，不进 src 产品面）。
 * 行帧协议见文件头注；只处理首行载荷（单发单收）。
 */
const OOP_CHILD_SCRIPT = `
let buf = '';
let served = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const nl = buf.indexOf('\\n');
  if (nl < 0 || served) return;
  served = true;
  const payload = JSON.parse(buf.slice(0, nl));
  if (payload.mode === 'fail') {
    process.stderr.write('fixture 子进程崩溃\\n');
    process.exit(3); // 异常退出：无结果行 → 父侧兜底映射 error
  }
  if (payload.mode === 'hang') return; // 永不应答：等 SIGTERM（dispose kill 收场）
  if (payload.mode === 'diagnose') {
    process.stdout.write(JSON.stringify({ output: '', diagnostic: '子进程自报故障', stopReason: 'error' }) + '\\n');
    return;
  }
  // ok：echo 应答 + usage 自报 + model/persona 透传回显（裁决①证据）
  const out = {
    output: 'echo:' + payload.prompt +
      (payload.model !== undefined ? ' model:' + payload.model : '') +
      (payload.persona !== undefined ? ' persona:' + payload.persona : ''),
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
    stopReason: 'completed',
  };
  process.stdout.write(JSON.stringify(out) + '\\n');
});
process.on('SIGTERM', () => process.exit(9)); // hang 收场：退出码即「无结果行」信号
`;

/** 场景 → 子进程 mode 映射（error 场景用 fail——异常退出兜底路；diagnose 归专节直调） */
function scenarioToMode(scenario: Scenario): string {
  if (scenario === 'error') return 'fail';
  if (scenario === 'hang') return 'hang';
  return 'ok';
}

/**
 * oop fixture provider（SubagentProvider 第二实现）：spawn node 子进程行帧 JSON。
 * 结算三路：结果行 → 原样映射；异常退出（无结果行）→ dispose 在场判 aborted、
 * 否则 error 兜底（stderr 尾段载 diagnostic）；spawn 失败 → error。
 * 能力声明窄面：仅 persona（model 位按裁决①透传不入协商面）。
 */
function makeOop(mode: string): SubagentProvider {
  const provider: SubagentProvider = {
    name: 'oop-fixture',
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: true, context: false },
    start(request) {
      const child = spawn(process.execPath, ['-e', OOP_CHILD_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
      /** dispose 幂等标记（重复 dispose 只 kill 一次——终链取消即收工） */
      let disposedFlag = false;
      /** 结算单点（first-wins——结果行与退出兜底竞速的裁决阀） */
      let settled = false;
      let resolveResult!: (result: SubagentResult) => void;
      const result = new Promise<SubagentResult>((resolve) => {
        resolveResult = resolve;
      });
      const finish = (r: SubagentResult): void => {
        if (settled) return;
        settled = true;
        resolveResult(r);
      };
      /** stderr 尾段（异常退出兜底的 diagnostic 素材；只留尾 200 字防巨量） */
      let stderrTail = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-200);
      });
      // stdout 行帧读：首行 JSON 即结果（单发单收——行缓冲 accumulate 后截断）
      let stdoutBuf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        const nl = stdoutBuf.indexOf('\n');
        if (nl < 0) return;
        const payload = JSON.parse(stdoutBuf.slice(0, nl)) as {
          output: string;
          diagnostic?: string;
          usage?: Usage;
          stopReason: SubagentStopReason;
        };
        finish({
          output: payload.output,
          ...(payload.diagnostic !== undefined ? { diagnostic: payload.diagnostic } : {}),
          ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
          stopReason: payload.stopReason,
        });
      });
      // 退出兜底：无结果行退出——dispose 在场判 aborted（kill 收场），否则 error
      child.on('exit', (code) => {
        if (settled) return;
        finish(
          disposedFlag
            ? { output: '', stopReason: 'aborted' }
            : {
                output: '',
                stopReason: 'error',
                diagnostic: `子进程异常退出 code=${code} stderr=${stderrTail}`,
              },
        );
      });
      child.on('error', (err) => {
        finish({ output: '', stopReason: 'error', diagnostic: `spawn 失败：${err.message}` });
      });
      // start 载荷单行写入（SubagentStart 整包序列化——JSON-clean 判据的实测面）
      child.stdin.write(
        JSON.stringify({
          prompt: request.prompt,
          ...(request.persona !== undefined ? { persona: request.persona } : {}),
          ...(request.model !== undefined ? { model: request.model } : {}),
          mode,
        }) + '\n',
      );
      child.stdin.end();
      const dispose = (): void => {
        if (disposedFlag) return;
        disposedFlag = true;
        child.kill(); // SIGTERM → 子进程 exit(9) → 退出兜底映射 aborted
      };
      return { id: `oop-${child.pid ?? 'noid'}`, result, dispose };
    },
  };
  return provider;
}

/** 场景化 oop 构造（共享族用；专节直调 makeOop(mode) 取 diagnose 等特殊 mode） */
function makeOopScenario(scenario: Scenario): SubagentProvider {
  return makeOop(scenarioToMode(scenario));
}

/* ---------------- 共享断言族（两实现同跑同一份代码） ---------------- */

/** 真 service 组装（真 createContext + 真 Job 注册表 + 真服务——onSettle 记录器内置） */
function makeService() {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const jobs = createJobsService(ctx);
  /** onSettle 投递记录（前台/后台两链断言共用） */
  const settlements: SubagentSettlement[] = [];
  const service = createSubagentsService(ctx, {
    jobs,
    onSettle: (settlement) => settlements.push(settlement),
  });
  return { service, settlements, jobs };
}

/** 共享断言族主体：make = 场景化 provider 构造（每测试新件——注册面重复名拒） */
function runProviderConformance(implName: string, make: (scenario: Scenario) => SubagentProvider) {
  it('前台链：completed 结算 + output 非空 + usage 在场 + onSettle 前台投递', async () => {
    const { service, settlements } = makeService();
    service.register(make('ok'));
    const run = service.start({ provider: implName, prompt: '任务甲' } satisfies SubagentRequest);
    const result = await run.result;
    expect(result.stopReason).toBe('completed');
    expect(result.output).toContain('任务甲');
    expect(result.usage).toMatchObject({ totalTokens: expect.any(Number) });
    // 前台链 onSettle：结算即回调（dispose 归调用方——此处消费后不再持有）
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.result.stopReason).toBe('completed');
    run.dispose();
  });

  it('失败族 result 永不 reject：error 结算 + diagnostic 在场 + Job failed + onSettle 投递', async () => {
    const { service, settlements } = makeService();
    service.register(make('error'));
    const run = service.start({ provider: implName, prompt: '任务乙', background: true } satisfies SubagentRequest);
    // 契约：execution.result 永不 reject——失败族一律 resolve（await 不炸即证）
    const result = await run.result;
    expect(result.stopReason).toBe('error');
    expect(result.diagnostic).toBeTruthy();
    expect(await run.job?.done).toBe('failed');
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.result.stopReason).toBe('error');
  });

  it('dispose 双调幂等 + result 必结算 aborted 不悬挂（provider 直测）', async () => {
    const provider = make('hang');
    const execution = provider.start({ prompt: '任务丙' });
    execution.dispose();
    expect(() => execution.dispose()).not.toThrow(); // 幂等：重复 dispose 无副作用
    const result = await execution.result; // 悬挂即抽象漏——终须 settle
    expect(result.stopReason).toBe('aborted');
  });

  it('服务终链：cancel→dispose→result settle→Job killed→onSettle（终态语义全链贯通）', async () => {
    const { service, settlements } = makeService();
    service.register(make('hang'));
    const run = service.start({ provider: implName, prompt: '任务丁', background: true } satisfies SubagentRequest);
    run.job?.cancel(); // 请求停止 → abort signal → service 接 execution.dispose
    const result = await run.result;
    expect(result.stopReason).toBe('aborted');
    expect(await run.job?.done).toBe('killed');
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.result.stopReason).toBe('aborted');
  });

  it('能力协商 fail-loud：outputSchema 未声明位 → SUBAGENT_CAPABILITY_UNSUPPORTED 且不建 Job', () => {
    const { service, jobs } = makeService();
    service.register(make('ok')); // 两实现均声明 outputSchema:false——协商位一致
    expect(() =>
      service.start({
        provider: implName,
        prompt: '任务戊',
        outputSchema: { type: 'object' },
      } satisfies SubagentRequest),
    ).toThrowError(AppError);
    try {
      service.start({
        provider: implName,
        prompt: '任务己',
        outputSchema: { type: 'object' },
      } satisfies SubagentRequest);
    } catch (err) {
      expect((err as AppError).code).toBe(SUBAGENT_CAPABILITY_UNSUPPORTED);
    }
    // fail-loud 语义：start 前拒——不触 provider、不建 Job（无孤儿账目）
    expect(jobs.list()).toHaveLength(0);
  });
}

describe('SubagentProvider 一致性套件 × inprocess（第一实现）', () => {
  runProviderConformance('in-process', (scenario) => makeInprocess(scenario));
});

describe('SubagentProvider 一致性套件 × oop-fixture（第二实现——真子进程）', () => {
  runProviderConformance('oop-fixture', makeOopScenario);
});

/* ---------------- 各实现专节 ---------------- */

describe('inprocess 专节（深度执法/预算帽/结算映射）', () => {
  it('深度执法：子 delegationDepth 超装配帽 → SUBAGENT_DEPTH_EXCEEDED 且子装配已销毁', () => {
    const provider = makeInprocess('ok', { delegationDepth: 5 }, { maxDepth: 2 });
    expect(() => provider.start({ prompt: '深挖' })).toThrowError(AppError);
    try {
      provider.start({ prompt: '深挖' });
    } catch (err) {
      expect((err as AppError).code).toBe(SUBAGENT_DEPTH_EXCEEDED);
    }
  });

  it('预算帽触顶：usage 自报 ≥ 帽 → abort 改判 max-tokens（diagnostic 帽文案优先）', async () => {
    // 帽 5 + 自报 totalTokens 10：onUsage 即触顶 → abort → hang 收场映射 max-tokens
    const provider = makeInprocess('hang', { usageReport: { ...FIXTURE_USAGE, totalTokens: 10 } }, { tokenBudget: 5 });
    const execution = provider.start({ prompt: '烧 token' });
    const result = await execution.result;
    expect(result.stopReason).toBe('max-tokens');
    expect(result.diagnostic).toContain('预算帽');
  });

  it('结算映射：output = 最后一条非空 assistant 文本（尾随空文本块跳过）', async () => {
    // 直造工厂覆写 messages：非空→空→非空三块，取末条非空
    const factory: InProcessChildFactory = () => ({
      session: new Session({ delegationDepth: 1 }),
      async run() {
        return {
          status: 'completed',
          messages: [fixtureAssistant('前文'), fixtureAssistant(''), fixtureAssistant('答案文本')],
          stopReason: 'stop',
        };
      },
      dispose() {},
    });
    const provider = createInProcessProvider({ factory });
    const result = await provider.start({ prompt: 'q' }).result;
    expect(result.output).toBe('答案文本');
  });
});

describe('oop 专节（异常退出兜底/kill 收场/model 透传/diagnostic 优先路）', () => {
  it('异常退出兜底：无结果行退出 → error 结算且 diagnostic 载退出码与 stderr', async () => {
    const execution = makeOop('fail').start({ prompt: '会崩' });
    const result = await execution.result;
    expect(result.stopReason).toBe('error');
    expect(result.diagnostic).toContain('code=3');
    expect(result.diagnostic).toContain('fixture 子进程崩溃');
  });

  it('kill 收场：hang 模式 dispose → SIGTERM → aborted 结算（子进程真死）', async () => {
    const execution = makeOop('hang').start({ prompt: '悬挂' });
    execution.dispose();
    const result = await execution.result;
    expect(result.stopReason).toBe('aborted');
  });

  it('model 透传回显（裁决①证据）：string 载荷无宿主语义——子进程原样可见', async () => {
    const { service } = makeService();
    service.register(makeOop('ok'));
    const run = service.start({ provider: 'oop-fixture', prompt: '问', model: 'replay/m9' } satisfies SubagentRequest);
    const result = await run.result;
    expect(result.output).toContain('model:replay/m9');
    run.dispose();
  });

  it('diagnostic 优先路：子自报 diagnostic → Job error 段载 diagnostic 而非 stopReason 兜底串', async () => {
    const { service, jobs } = makeService();
    service.register(makeOop('diagnose'));
    const run = service.start({ provider: 'oop-fixture', prompt: '自报', background: true } satisfies SubagentRequest);
    await run.result;
    expect(await run.job?.done).toBe('failed');
    // service 落账：error = result.diagnostic ?? String(stopReason)——优先路在此 oop 侧可测
    const view = run.job ? jobs.get(run.job.id) : undefined;
    expect(view?.settled?.error).toBe('子进程自报故障');
  });
});
