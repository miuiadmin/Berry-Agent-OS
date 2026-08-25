/**
 * L5 app — subagent 官方件全栈测试（纵切四：默认插件行 + 委派工具 + 真工厂）。
 *
 * mock 只停在模型层（scripted streamFn 父子同源），其余全真：真装配（默认层
 * subagent 行激活）、真委派工具（agent 经三段管道）、真工厂（每子独立 ctx +
 * 工具管道 + 守门 + forkSession）、真结算链（provider → job → 通知）。
 * 父子共用同一 streamFn——contexts 按调用序即父子交替记录（嵌套调用的形态证据）。
 */

import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, LlmContext, StreamFn, StreamFnOptions, Usage } from '../contracts/llm.js';
import { createContext } from '../context/context.js';
import type { ContextScope } from '../context/types.js';
import { createInProcessProvider } from '../subagent/inprocess.js';
import { deriveMessages } from '../session/derive.js';
import { defaultConvertToLlm } from './convert.js';
import { createSubagentChildFactory } from './subagent-factory.js';
import { createBerryRuntime } from './assembly.js';
import type { BerryRuntime } from './assembly.js';

/* ---------------- 测试基建（与 assembly.test 同款） ---------------- */

/** 零用量（totalTokens=3——预算帽用例以 1 触发） */
const NO_USAGE: Usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 };

const textMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: NO_USAGE,
  stopReason: 'stop',
  timestamp: 1,
});

const toolCallMessage = (name: string, args: Record<string, unknown>): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: `call-${name}`, name, arguments: args }],
  usage: NO_USAGE,
  stopReason: 'toolUse',
  timestamp: 1,
});

/** 合成流（start → done；loop 只消费事件序与 result()）。
 * 真 provider 取消契约模拟（contracts/llm.ts StreamFn 注释）：调用时 signal 已
 * abort → 终值改判 aborted（loop 层零重试短路）——预算帽用例的生效点 */
function syntheticStream(message: AssistantMessage, signal?: AbortSignal) {
  if (signal?.aborted) {
    message = { ...message, content: [], stopReason: 'aborted' };
  }
  const events = [
    { type: 'start' as const, partial: { ...message, content: [] } },
    { type: 'done' as const, reason: 'stop' as const, message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          index < events.length
            ? Promise.resolve({ value: events[index++]!, done: false as const })
            : Promise.resolve({ value: undefined, done: true as const }),
      };
    },
    result: async () => message,
  };
}

/** 脚本化 StreamFn（按调用序取响应；记录请求上下文——父子同源交替记录） */
function scriptedStream(responses: AssistantMessage[]) {
  const contexts: LlmContext[] = [];
  const streamFn: StreamFn = (context: LlmContext, _options: StreamFnOptions, signal?: AbortSignal) => {
    contexts.push(context);
    const message = responses[Math.min(contexts.length - 1, responses.length - 1)]!;
    return syntheticStream(message, signal);
  };
  return { streamFn, contexts };
}

/** 自旋等待（微任务级——同步 scripted 流即触即达） */
async function spinUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect.unreachable(`等待超时：${what}`);
}

/** 临时工作区 / 组合目录（realpath 归一） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏） */
const runtimes: BerryRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/** 装配 + 登记 */
async function assemble(overrides: Parameters<typeof createBerryRuntime>[0] = {}): Promise<BerryRuntime> {
  const runtime = await createBerryRuntime({
    dbPath: ':memory:',
    workspace: makeTempDir('app-subplug-'),
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}

/* ---------------- 全栈用例 ---------------- */

describe('subagent 官方件全栈（纵切四：默认行 + agent 工具 + 真工厂）', () => {
  it('默认层第二行激活 + 清单段物化：agent 工具进面、subagent/list 段含 provider 名', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn });
    // 默认层七行全激活（官方全家桶：chat 首行 + memory 次行 + subagent 第三行 +
    // goal 第四行 + scheduler 第五行 + mcp 第六行 + tools 第七行〔Ring 1 行树化〕）
    expect(runtime.plugins.list().map((r) => [r.id, r.status])).toEqual([
      ['chat', 'activated'],
      ['memory', 'activated'],
      ['subagent', 'activated'],
      ['goal', 'activated'],
      ['scheduler', 'activated'],
      ['mcp', 'activated'],
      ['tools', 'activated'],
    ]);
    // 委派工具已进工具面（fs 四件 + memory 五件之后）
    expect(runtime.tools.list().map((t) => t.name)).toContain('agent');
    // 清单披露段物化：provider 名 + 能力位（§6.3 技能式渐进披露）
    expect(runtime.systemPrompt).toContain('可用子代理类型');
    expect(runtime.systemPrompt).toContain('in-process');
    expect(runtime.systemPrompt).toContain('工具子集');
  });

  it('前台委派全栈：父 toolCall agent → 子独立装配（toolFilter/persona 生效）→ 汇报文本回父；子会话 fork 落库', async () => {
    // 脚本消费序：contexts[0]=父 turn1（toolCall）→ contexts[1]=子 turn（子答）→ contexts[2]=父 turn2（汇总）
    const { streamFn, contexts } = scriptedStream([
      toolCallMessage('agent', { prompt: '审读这份设计', toolFilter: ['read'], persona: '你是资深审读员' }),
      textMessage('子代理汇报：审毕无阻塞项'),
      textMessage('父汇总完成'),
    ]);
    const runtime = await assemble({ streamFn });
    // delegation fork 的 session_start 走根总线（插件 keyed 面——载荷 sessionId 即归属键）
    const starts: Array<{ sessionId: string; origin: string }> = [];
    runtime.ctx.on('session_start', (payload: unknown) => {
      const data = payload as { sessionId: string; origin: string };
      starts.push(data);
    });

    const answer = await runtime.conversation!.submitOnce('帮我审读');
    expect(answer?.status).toBe('completed');
    // 三次模型调用 = 父问 → 子答 → 父汇总（嵌套形态：子在父的工具执行内）
    expect(contexts).toHaveLength(3);
    // 子装配证据①：toolFilter include 过滤——子工具面只 read（缺省全量 fs 四件+检索两件的对照）
    expect(contexts[1]!.tools?.map((t) => t.name)).toEqual(['read']);
    // 子装配证据②：persona 覆盖缺省子提示词
    expect(contexts[1]!.systemPrompt).toContain('你是资深审读员');
    // 子装配证据③：工具子集之外守门照装（effect 'read' 的子工具经子管道自己的 gate）
    // ——子未调工具即结算，此处不重复测守门（safety 模块 1-to-1 已锁）
    // 父会话投影：委派工具结果 = 子汇报文本（结算折叠回父面）
    const toolResults = deriveMessages(runtime.session!.events).filter((m) => m.type === 'toolResult');
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0])).toContain('子代理汇报：审毕无阻塞项');
    // delegation fork 上总线：origin=delegation 的 session_start 恰一次（boot initial 不算）
    const delegationStarts = starts.filter((s) => s.origin === 'delegation');
    expect(delegationStarts).toHaveLength(1);
    // 子会话落库：dispose 序列的 flush 屏障已定向排空——直接可回读
    const childSession = runtime.persistence!.loadSession(delegationStarts[0]!.sessionId);
    expect(childSession).toBeTruthy();
    expect(childSession!.header.delegationDepth).toBe(1); // 父 0 + 1（§6.5 单调下界）
    const childProjected = deriveMessages(childSession!.events);
    expect(childProjected.map((m) => m.type)).toEqual(['user', 'assistant']); // 子完整一轮
    // 子结算后子装配已释放（前台路 run.dispose 即释放——此处经 shutdown 前提下不再需要）
  });

  it('后台路：background:true 立即返回任务 id；job 注册表结算 completed + 通知注入父会话', async () => {
    // 父脚本：toolCall（后台委派）→ 父文本收尾；子脚本：后台子答（第三条兜底）
    const { streamFn, contexts } = scriptedStream([
      toolCallMessage('agent', { prompt: '后台调研', background: true, label: '后台调研' }),
      textMessage('已入后台'),
      textMessage('后台子答'),
    ]);
    const runtime = await assemble({ streamFn });
    const answer = await runtime.conversation!.submitOnce('去调研');
    expect(answer?.status).toBe('completed');
    // 工具立即返回：结果文本含任务 id（不等待子结算）
    const toolResults = deriveMessages(runtime.session!.events).filter((m) => m.type === 'toolResult');
    expect(JSON.stringify(toolResults[0])).toContain('任务 id');
    // 子在后台跑完（父 run 已结束——子调 streamFn 独立于父循环）
    await spinUntil(() => contexts.length >= 3, '后台子结算');
    // job 注册表：kind=subagent 结算 completed（ownerSessionId 归属父会话）
    const jobs = runtime.ctx.get<{ list(): Array<{ kind: string; status: string; label?: string }> }>('jobs');
    await spinUntil(() => jobs.list().some((j) => j.kind === 'subagent' && j.status === 'completed'), 'job 结算');
    const job = jobs.list().find((j) => j.kind === 'subagent')!;
    expect(job.label).toBe('后台调研');
    // 通知三通道（§6.4）：结算折叠为 user message 注入父会话（source=subagent-settled）
    await spinUntil(
      () =>
        runtime.session!.events.some(
          (e) => e.type === 'user/message' && (e.data as { source?: string }).source === 'subagent-settled',
        ),
      '结算通知注入',
    );
  });

  it('预算帽：行 config tokenBudget 触顶 → 结算 max-tokens → 工具结果 isError 文本带诊断', async () => {
    // overlay 同 id 行字段级合并：subagent 行带 config（plugin 引用沿用官方默认层）
    const compositionDir = makeTempDir('app-subplug-cfg-');
    const workspace = makeTempDir('app-subplug-ws-');
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: subagent\n    config:\n      tokenBudget: 1\n');
    // 消费序：[0] 父 toolCall(agent) → [1] 子 turn1 toolCall(ls)（message_end 即触帽
    // abort——NO_USAGE.totalTokens=3 ≥ 1）→ [2] 子 turn2 调用时 signal 已 abort →
    // 流终值 aborted（真 provider 取消契约）→ loop 短路 → [3] 父收尾
    const { streamFn } = scriptedStream([
      toolCallMessage('agent', { prompt: '超帽任务' }),
      toolCallMessage('ls', { path: workspace }),
      textMessage('不会到这'),
      textMessage('父收尾'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir, workspace });
    const answer = await runtime.conversation!.submitOnce('跑一个');
    expect(answer?.status).toBe('completed');
    // 工具结果：未完成 + max-tokens + 帽文案（diagnostic 优先预算解释）
    const toolResults = deriveMessages(runtime.session!.events).filter((m) => m.type === 'toolResult');
    const text = JSON.stringify(toolResults[0]);
    expect(text).toContain('未完成（max-tokens');
    expect(text).toContain('token 预算帽触顶');
  });

  it('无持久层工厂路径：内存子会话照跑 + 缺省子提示词兜底 + delegation 生命周期事件照发', async () => {
    // persist:false 全栈 run 面随 chat 纵切退役（件自降级空转无驱动——run 不可达），
    // 但工厂的无持久层路径仍是真代码（诊断面/未来无库宿主）：改由工厂直测覆盖。
    // 无 persona 请求位 → 缺省子提示词兜底（静态 DEFAULT_CHILD_PROMPT）。
    const { streamFn, contexts } = scriptedStream([textMessage('子答（内存面）')]);
    /** 根总线（session_start/session_shutdown keyed 面——与装配层 ROOT 同角色） */
    const rootCtx: ContextScope = createContext({ name: 'subagent-factory-nodb' });
    const starts: Array<{ sessionId: string; origin: string }> = [];
    rootCtx.on('session_start', (payload: unknown) => {
      starts.push(payload as { sessionId: string; origin: string });
    });
    const factory = createSubagentChildFactory({
      // persist 双缺：无父会话（getSession 恒 undefined）+ 无 persistence
      // → 降级内存 Session（origin 'delegation'）
      getSession: () => undefined,
      streamFn,
      model: 'test/model',
      convertToLlm: defaultConvertToLlm,
      workspace: makeTempDir('app-subplug-nodb-'),
      sandboxMode: 'workspace-write',
      rootCtx,
    });
    const provider = createInProcessProvider({ factory });
    // SubagentStart 面（provider/background 已在服务面剥离——provider 只见任务本体）
    const execution = provider.start({ prompt: '诊断面任务' });
    const result = await execution.result;
    expect(result.stopReason).toBe('completed');
    expect(result.output).toBe('子答（内存面）');
    // 子完整一轮模型调用（内存会话照跑——持久层只影响落库不影响循环）
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.systemPrompt).toContain('被委派的子代理');
    // 内存子会话不落库——但生命周期事件面不豁免（session_start delegation 照发根总线）
    expect(starts.some((s) => s.origin === 'delegation')).toBe(true);
    await execution.dispose();
  });
});
