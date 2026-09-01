/**
 * L5 app — subagent 官方件全栈测试（纵切四：默认应用行 + 委派工具 + 真工厂）。
 *
 * mock 只停在模型层（scripted streamFn 父子同源），其余全真：真装配（默认层
 * subagent 行激活）、真委派工具（agent 经三段管道）、真工厂（每子独立 ctx +
 * 工具管道 + 守门 + forkSession）、真结算链（provider → job → 通知）。
 * 父子共用同一 streamFn——contexts 按调用序即父子交替记录（嵌套调用的形态证据）。
 * 守门行传导 + context 腿回归锁（第三十一批 P1-4）在本文件尾段。
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, LlmContext, StreamFn, StreamFnOptions, Usage } from '../contracts/llm.js';
import { TOOL_PRE_EXECUTE_EVENT } from '../contracts/tools.js';
import { createContext } from '../context/context.js';
import { chainSessionId, runInCallerChain } from '../context/chain.js';
import type { ContextScope } from '../context/types.js';
import { createInProcessProvider } from '../subagent/inprocess.js';
import { deriveMessages } from '../session/derive.js';
import { registerToolsService } from '../tools/registry.js';
import { defaultConvertToLlm } from './convert.js';
import { createSubagentChildFactory } from './subagent-factory.js';
import { createRuntime } from './assembly.js';
import type { AppRuntime } from './assembly.js';

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

/** 脚本化 StreamFn（按调用序取响应；记录请求上下文与模型——父子同源交替记录） */
function scriptedStream(responses: AssistantMessage[]) {
  const contexts: LlmContext[] = [];
  /** 每次模型调用的 model 标识（StreamFnOptions.model——声明式 agent 的 frontmatter
   * model 覆盖经子工厂透传，在此观测） */
  const models: string[] = [];
  const streamFn: StreamFn = (context: LlmContext, options: StreamFnOptions, signal?: AbortSignal) => {
    contexts.push(context);
    models.push(options.model);
    const message = responses[Math.min(contexts.length - 1, responses.length - 1)]!;
    return syntheticStream(message, signal);
  };
  return { streamFn, contexts, models };
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
const runtimes: AppRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/** 装配 + 登记 */
async function assemble(overrides: Parameters<typeof createRuntime>[0] = {}): Promise<AppRuntime> {
  const runtime = await createRuntime({
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
    // 默认层十四行全激活（官方全家桶：chat 首行 + memory 次行 + subagent 第三行 +
    // goal 第四行 + scheduler 第五行 + mcp 第六行 + tools 第七行〔Ring 1 行树化〕+
    // web 第八行〔fetch 刀〕+ compaction 第九行〔压缩刀〕+ admin 第十行〔管理刀〕+
    // checkpoint 第十一行〔快照回退刀——会话篇 §5.3〕+ lsp 第十二行〔语言服务器刀
    // ——契约篇 §6.7〕+ channels 第十三行〔Ring 1 第二行树化——契约篇 §6.8〕+
    // webui 第十四行〔Web 通道刀——enabled 缺省 false 惰性零监听〕）
    expect(runtime.appsService.list().map((r) => [r.id, r.status])).toEqual([
      ['chat', 'activated'],
      ['memory', 'activated'],
      ['subagent', 'activated'],
      ['goal', 'activated'],
      ['scheduler', 'activated'],
      ['mcp', 'activated'],
      ['tools', 'activated'],
      ['web', 'activated'],
      ['compaction', 'activated'],
      ['admin', 'activated'],
      ['checkpoint', 'activated'],
      ['lsp', 'activated'],
      ['channels', 'activated'],
      ['webui', 'activated'],
      ['obs', 'activated'],
      ['browser', 'activated'],
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
    // delegation fork 的 session_start 走根总线（应用 keyed 面——载荷 sessionId 即归属键）
    const starts: Array<{ sessionId: string; origin: string }> = [];
    runtime.ctx.on('session_start', (payload: unknown) => {
      const data = payload as { sessionId: string; origin: string };
      starts.push(data);
    });

    const answer = await runtime.conversation!.submitOnce('帮我审读');
    expect(answer?.status).toBe('completed');
    // 三次模型调用 = 父问 → 子答 → 父汇总（嵌套形态：子在父的工具执行内）
    expect(contexts).toHaveLength(3);
    // 子装配证据①：toolFilter include 过滤——子工具面只 read（缺省全量 =
    // 全局层派生 + 自建 fs 四名，见下方域键升级批结构默认断言）
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

  it('S5 链写点③：子 run 边界包本子会话——子 streamFn 时点 chainSessionId = 子会话 id（冷读闸 F3）', async () => {
    // 消费序：[0] 父 turn1 toolCall(agent) → [1] 子 turn → [2] 父收尾。
    // 每次模型调用时点记录 chainSessionId()：父两调 = 父会话（launch 链包裹）；
    // 子调 = **子会话**——startRun 边界的 runInSessionChain 包裹使子内经链取数的
    // 消费面（deliver 默认路由 / usage 折叠 / 审批 priority）全数归子。修复前
    // （startRun 无包裹）子调继承父链——chains[1] = 父会话 id，本断言必红。
    const base = scriptedStream([
      toolCallMessage('agent', { prompt: '子任务' }),
      textMessage('子答'),
      textMessage('父收尾'),
    ]);
    const chains: Array<string | undefined> = [];
    const streamFn: StreamFn = (context, options, signal) => {
      chains.push(chainSessionId());
      return base.streamFn(context, options, signal);
    };
    const runtime = await assemble({ streamFn });
    const delegationStarts: string[] = [];
    runtime.ctx.on('session_start', (payload: unknown) => {
      const data = payload as { sessionId: string; origin?: string };
      if (data.origin === 'delegation') delegationStarts.push(data.sessionId);
    });
    const answer = await runtime.conversation!.submitOnce('委派一个');
    expect(answer?.status).toBe('completed');
    expect(chains).toHaveLength(3); // 父问 → 子答 → 父收尾
    expect(delegationStarts).toHaveLength(1);
    // 父两调在父链上；子调在子链上（≠ 父——归因不串账）
    const parentId = runtime.session!.header.sessionId;
    expect(chains[0]).toBe(parentId);
    expect(chains[2]).toBe(parentId);
    expect(chains[1]).toBe(delegationStarts[0]);
    expect(chains[1]).not.toBe(parentId);
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
    // 父工具注册表（S2 派生腿契约：委派时父注册表必在场——Ring 1 tools 行的
    // 测试等价物；诊断面无管道不执行派生工具，服务在即可）
    registerToolsService(rootCtx, {});
    const starts: Array<{ sessionId: string; origin: string }> = [];
    rootCtx.on('session_start', (payload: unknown) => {
      starts.push(payload as { sessionId: string; origin: string });
    });
    const factory = createSubagentChildFactory({
      // persist 双缺：无父驱动（getParent 恒 undefined）+ 无 persistence
      // → 降级内存 Session（origin 'delegation'）
      getParent: () => undefined,
      streamFn,
      model: 'test/model',
      convertToLlm: defaultConvertToLlm,
      workspace: makeTempDir('app-subplug-nodb-'),
      sandboxMode: 'workspace-write',
      rootCtx,
      // 传导判据占位（第三十一批必传面）：无父诊断面不发生传导——空锚/空集
      // 与装配层占位同语义（本测试 rootCtx 虽有 session_start 行但锚集为空，
      // 守门两段传导恒零行）
      gateRowFilter: { anchors: [], mainRows: () => new Set<string>() },
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

  it('委派工具面会话绑定（遗漏大扫 20260901-b #5 回归锁）：子内派生工具 ToolCtx.sessionId = 子会话 id', async () => {
    // 漏传形态：工厂 ⑦ toAgentTool(def) 不带 bindOpts → 管道第 7 参缺席 →
    // ToolCtx.sessionId = undefined → browser_* 等 per-session 语境工具全数坍缩
    // 进 '_default' 单上下文（兄弟子代理互踩同一浏览器页签）。修复 = per-entry
    // 携带子会话 id（与 chat/app.ts 驱动绑定同一先例）。探针经派生腿进子工具面，
    // 真实执行捕获语境值断言。
    const { streamFn } = scriptedStream([toolCallMessage('probe_sid', {}), textMessage('子答')]);
    const rootCtx: ContextScope = createContext({ name: 'subagent-factory-sid' });
    const parentTools = registerToolsService(rootCtx, {});
    /** 探针观测面：子内执行时捕获 ToolCtx.sessionId */
    const seen: Array<string | undefined> = [];
    parentTools.register({
      name: 'probe_sid',
      description: '会话绑定探针（捕获 ToolCtx.sessionId——read 过守门无需审批）',
      parameters: { type: 'object', properties: {}, required: [] },
      effect: 'read',
      execute: async (_args, tctx) => {
        seen.push(tctx.sessionId);
        return { content: [{ type: 'text', text: '已记录' }] };
      },
    });
    /** 委派子会话 id 观测（session_start delegation 载荷——工厂 ⑥ 同源单发） */
    let childSessionId = '';
    rootCtx.on('session_start', (payload: unknown) => {
      const p = payload as { sessionId: string; origin: string };
      if (p.origin === 'delegation') childSessionId = p.sessionId;
    });
    const factory = createSubagentChildFactory({
      getParent: () => undefined,
      streamFn,
      model: 'test/model',
      convertToLlm: defaultConvertToLlm,
      workspace: makeTempDir('app-subplug-sid-'),
      sandboxMode: 'workspace-write',
      rootCtx,
      gateRowFilter: { anchors: [], mainRows: () => new Set<string>() },
    });
    const provider = createInProcessProvider({ factory });
    const execution = provider.start({ prompt: '带探针的任务' });
    const result = await execution.result;
    expect(result.stopReason).toBe('completed');
    // 探针经派生腿进子工具面并被真实调用（无父诊断面 = list() 全局层同口径）
    expect(seen).toHaveLength(1);
    // 绑定成立：捕获值 = 子会话 id（漏传形态此值为 undefined——修复前必红）
    expect(seen[0]).toBe(childSessionId);
    expect(childSessionId).not.toBe('');
    await execution.dispose();
  });

  /* ---------------- 声明式子代理（agents/*.md——尾刀三） ---------------- */

  /** 声明式 fixture 目录：一份好文件 + 三份边界文件（坏 YAML/撞内建名/非法工具名） */
  const makeAgentsFixture = (): string => {
    const dir = makeTempDir('app-subplug-agents-');
    writeFileSync(
      join(dir, 'reviewer.md'),
      [
        '---',
        'name: reviewer',
        'description: 资深代码审读员',
        'tools:',
        '  - read',
        '  - grep',
        "model: 'test/child-model'",
        '---',
        '你是资深审读员，逐行审查。',
      ].join('\n'),
    );
    // 坏文件：description 缺失 → warning 跳过（不炸装配）
    writeFileSync(join(dir, 'broken.md'), '---\n---\n正文无元数据');
    // 撞内建 provider 名 → 坏文件语义跳过（不炸 SUBAGENT_PROVIDER_DUPLICATE）
    writeFileSync(join(dir, 'in-process.md'), '---\ndescription: 撞名件\n---\n正文');
    // 工具名字符集外（中文基名）→ provider 注册但无 agent_<name> 工具
    writeFileSync(join(dir, '审读员.md'), '---\ndescription: 中文名件\n---\n正文');
    return dir;
  };

  it('声明式装配面：agent_<name> 静态工具进面；坏文件/撞名/非法名只跳过不炸装配；清单段含 description', async () => {
    const { streamFn } = scriptedStream([textMessage('答')]);
    const runtime = await assemble({ streamFn, agentLocations: [{ dir: makeAgentsFixture(), source: 'project' }] });
    // 官方件照常激活（边界文件未炸装配）
    expect(runtime.appsService.list().find((r) => r.id === 'subagent')?.status).toBe('activated');
    // 静态工具在场：通用 agent + 声明式 agent_reviewer；三份边界文件零工具
    const names = runtime.tools.list().map((t) => t.name);
    expect(names).toContain('agent');
    expect(names).toContain('agent_reviewer');
    expect(names).not.toContain('agent_broken');
    expect(names).not.toContain('agent_in-process');
    expect(names.some((n) => n.startsWith('agent_审'))).toBe(false);
    // 静态工具 description = 文件 description（模型选择依据）+ 用法说明
    const tool = runtime.tools.list().find((t) => t.name === 'agent_reviewer')!;
    expect(tool.description).toContain('资深代码审读员');
    // 清单披露段：声明式 provider 行带 description（in-process 通用行无此位）
    expect(runtime.systemPrompt).toContain('reviewer：资深代码审读员');
  });

  it('声明式全栈委派：静态工具路由 named provider → persona=正文 / 工具=frontmatter / 模型=frontmatter', async () => {
    // 消费序：[0] 父 toolCall(agent_reviewer) → [1] 子 turn（审读员人格答）→ [2] 父汇总
    const { streamFn, contexts, models } = scriptedStream([
      toolCallMessage('agent_reviewer', { prompt: '审读这份设计' }),
      textMessage('审毕：无阻塞项'),
      textMessage('父汇总完成'),
    ]);
    const runtime = await assemble({ streamFn, agentLocations: [{ dir: makeAgentsFixture(), source: 'project' }] });
    const answer = await runtime.conversation!.submitOnce('帮我审读');
    expect(answer?.status).toBe('completed');
    expect(contexts).toHaveLength(3);
    // mergeRequest 三腿在真装配里生效：正文写 persona、tools 写工具子集、model 覆盖。
    // 工具序 = 派生腿在前（grep——父注册表全局层 def 复用）+ 自建 fs 腿在后（read）
    expect(contexts[1]!.systemPrompt).toBe('你是资深审读员，逐行审查。'); // 正文恒覆盖（非拼接缺省）
    expect(contexts[1]!.tools?.map((t) => t.name)).toEqual(['grep', 'read']);
    expect(models[1]).toBe('test/child-model'); // 子模型覆盖（父用缺省 test 流模型）
    // 汇报文本回父面（静态工具前台路与通用 agent 同一结算链）
    const toolResults = deriveMessages(runtime.session!.events).filter((m) => m.type === 'toolResult');
    expect(JSON.stringify(toolResults[0])).toContain('审毕：无阻塞项');
  });

  it('子装配缺省全量面（域键升级批·排除集退役回归）：全局层派生 + 自建 fs 四名，父驱动层内容零漏入', async () => {
    // 无 toolFilter——子面缺省全量。结构默认断言：fs 四名恰一份（自建腿）——
    // 父驱动层同名 def（含 bash）若漏入派生面即双名/多 Bash，排除集退役后靠
    // 三层结构保证（listFor(父 app) 不含驱动层）非名单过滤（CHILD_TOOL_EXCLUSION 已删）
    const { streamFn, contexts } = scriptedStream([
      toolCallMessage('agent', { prompt: '全量面任务' }),
      textMessage('子答'),
      textMessage('父汇总'),
    ]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('委派一个全量面任务');
    const names = contexts[1]!.tools!.map((t) => t.name);
    // 自建腿 fs 四名 + 全局派生腿检索两件在场
    for (const n of ['read', 'write', 'edit', 'ls', 'find', 'grep']) expect(names).toContain(n);
    // 排除集退役回归锁：全量面无双名（父驱动层 def 漏入即 read×2）+ bash 零出现
    //（bash 住驱动层——子代理无驱动层，结构上不进派生面）
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('bash');
  });
});

/* ---------------- 守门行传导 + context 腿（第三十一批 P1-4 回归锁） ---------------- */

/** 守门段入参形状（测试侧收形——owner/判据见 subagent-factory ⑤b） */
interface PreGateInput {
  readonly tool: { readonly name: string };
  args: Record<string, unknown>;
  mutated: boolean;
}

/**
 * 传导测试应用 fixture：组合目录写 overlay（一行 conduction-gate）+ 应用目录。
 * 应用行为：pre 守门行 block `conduction-block` / 就地改参 `conduction-probe`
 * （x 追加标记——mutate 契约 = 就地改属性，rebind input.args 不达执行段）+
 * 注册两探针工具（effect 'read'——子安全门读类放行，拦截归因唯一来自应用行）。
 * rowId 参数（R2 测试补课批）：行 id 字面可参数化——含 `:` 形即传导判据载体
 * 回归锁的攻击面（行 id 无字符集执法，owner 切片载体在此形取段错位）。
 */
function makeConductionComposition(rowId = 'conduction-gate'): { compositionDir: string } {
  const compositionDir = makeTempDir('app-cond-');
  const appDir = join(compositionDir, 'conduction-plugin');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(
    join(appDir, 'index.ts'),
    [
      'export const name = "conduction-gate";',
      'export default async function apply(ctx) {',
      '  ctx.effect(() =>',
      '    ctx.on("tools_pre_execute", (input, next) => {',
      '      if (input.tool.name === "conduction-block") {',
      '        return { decision: "block", reason: "应用行策略：conduction-block 禁用" };',
      '      }',
      '      if (input.tool.name === "conduction-probe") {',
      '        input.args.x = input.args.x + "·经应用行改写";',
      '        input.mutated = true;',
      '      }',
      '      return next();',
      '    }),',
      '  );',
      '  const tools = ctx.get("tools");',
      '  ctx.effect(() =>',
      '    tools.register({',
      '      name: "conduction-probe",',
      '      description: "回显 x 参数（传导 mutate 探针）",',
      '      parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },',
      '      effect: "read",',
      '      execute: async (args) => ({ content: [{ type: "text", text: `探针=${args.x}` }] }),',
      '    }),',
      '  );',
      '  ctx.effect(() =>',
      '    tools.register({',
      '      name: "conduction-block",',
      '      description: "注定被应用行拦下的探针",',
      '      parameters: { type: "object", properties: {} },',
      '      effect: "read",',
      '      execute: async () => ({ content: [{ type: "text", text: "不该执行到这里" }] }),',
      '    }),',
      '  );',
      '}',
    ].join('\n'),
  );
  // app: coder——触发②执法下第三方行必须挂应用（coder 为默认应用——组装批后
  // boot 委派驱动即 coder 域，传导判据按该域收行）。行 id 字面参数化（含冒号
  // 形合法——行 id 无字符集执法，正是不设闸的攻击面本体）
  writeFileSync(
    join(compositionDir, 'overlay.yaml'),
    `rows:\n  - id: ${rowId}\n    pkg: ${appDir}\n    apps: [coder]\n    sandbox: { carrier: main }\n`,
  );
  return { compositionDir };
}

describe('守门行传导 + context 腿（第三十一批 P1-4 回归锁）', () => {
  it('应用行 block 传导：子链拦下 conduction-block（gate 决策落子会话账）+ 固定行零触达（传导前必红）', async () => {
    const { compositionDir } = makeConductionComposition();
    // 消费序：[0] 父 toolCall(agent) → [1] 子 toolCall(conduction-block) →
    // [2] 子收尾（见拦截 isError 结果）→ [3] 父收尾
    const { streamFn } = scriptedStream([
      toolCallMessage('agent', { prompt: '子任务A', toolFilter: ['conduction-probe', 'conduction-block'] }),
      toolCallMessage('conduction-block', {}),
      textMessage('子已见拦截'),
      textMessage('父收尾'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir });
    // 固定行触达计数（owner=根名 'app' 的监听器——传导判据结构性排除的半边）：
    // 只数子侧工具（conduction-* 前缀）——父侧 agent 调用照走根链不在此列
    const fixedRowChildToolHits: string[] = [];
    runtime.ctx.on(TOOL_PRE_EXECUTE_EVENT, (input: PreGateInput) => {
      if (input.tool.name.startsWith('conduction-')) fixedRowChildToolHits.push(input.tool.name);
    });
    const delegationStarts: string[] = [];
    runtime.ctx.on('session_start', (payload: unknown) => {
      const data = payload as { sessionId: string; origin?: string };
      if (data.origin === 'delegation') delegationStarts.push(data.sessionId);
    });

    const answer = await runtime.conversation!.submitOnce('委派探测A');
    expect(answer?.status).toBe('completed');
    expect(delegationStarts).toHaveLength(1);
    // 子会话账：应用行 block 决策 durable 落账（reason 带应用行策略文案）
    const child = runtime.persistence!.loadSession(delegationStarts[0]!)!;
    const decisions = child.events
      .filter((e) => e.type === 'gate/decision')
      .map((e) => e.data as { decision: string; reason: string });
    expect(decisions.some((d) => d.decision === 'block' && d.reason.includes('应用行策略'))).toBe(true);
    // 拦截经 isError 结果回模型（block 文案进子工具结果——工具真体零执行）
    const childToolResults = deriveMessages(child.events).filter((m) => m.type === 'toolResult');
    expect(JSON.stringify(childToolResults)).toContain('应用行策略');
    expect(JSON.stringify(childToolResults)).not.toContain('不该执行到这里');
    // 固定行（owner=根名）零触达：根链监听器没被传导进子链——子审批 never
    // 无人值守语义不被根面交互审批冒破
    expect(fixedRowChildToolHits).toEqual([]);
  });

  it('应用行 mutate 传导：就地改参达子执行段（探针回显带改写标记）+ mutate 决策落账', async () => {
    const { compositionDir } = makeConductionComposition();
    const { streamFn } = scriptedStream([
      toolCallMessage('agent', { prompt: '子任务B', toolFilter: ['conduction-probe'] }),
      toolCallMessage('conduction-probe', { x: '原始' }),
      textMessage('子收尾'),
      textMessage('父收尾'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir });
    const delegationStarts: string[] = [];
    runtime.ctx.on('session_start', (payload: unknown) => {
      const data = payload as { sessionId: string; origin?: string };
      if (data.origin === 'delegation') delegationStarts.push(data.sessionId);
    });

    const answer = await runtime.conversation!.submitOnce('委派探测B');
    expect(answer?.status).toBe('completed');
    const child = runtime.persistence!.loadSession(delegationStarts[0]!)!;
    // mutate 决策 durable 落账（守门段改参汇总进决策面）
    const decisions = child.events.filter((e) => e.type === 'gate/decision').map((e) => e.data as { decision: string });
    expect(decisions.some((d) => d.decision === 'mutate')).toBe(true);
    // 改参到达执行段：探针回显的 x 已带应用行标记（就地改写——执行段同引用所见）
    const childToolResults = deriveMessages(child.events).filter((m) => m.type === 'toolResult');
    expect(JSON.stringify(childToolResults)).toContain('探针=原始·经应用行改写');
  });

  it('含冒号行 id 传导判据载体（R2 测试补课 P1-2 根治）：entry.rowId 判据下守门行照常传导——owner 末段切片载体在此形静默漏传导（修复前必红）', async () => {
    // 行 id 含 `:`（如 'acme:gate:row'）：fork name 原样拼接使 owner 形如
    // 'app:apps:app:chat:acme:gate:row'——旧「owner 末段」切片取到 'row' 查
    // mainRows 不中 → 守门行静默漏传导（block 失效、探针真体被执行）。
    // 修复后判据读 entry.rowId（on() 登记时携出的行归属），切片彻底退场
    const { compositionDir } = makeConductionComposition('acme:gate:row');
    const { streamFn } = scriptedStream([
      toolCallMessage('agent', { prompt: '子任务C', toolFilter: ['conduction-block'] }),
      toolCallMessage('conduction-block', {}),
      textMessage('子已见拦截'),
      textMessage('父收尾'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir });
    const delegationStarts: string[] = [];
    runtime.ctx.on('session_start', (payload: unknown) => {
      const data = payload as { sessionId: string; origin?: string };
      if (data.origin === 'delegation') delegationStarts.push(data.sessionId);
    });

    const answer = await runtime.conversation!.submitOnce('委派探测C');
    expect(answer?.status).toBe('completed');
    const child = runtime.persistence!.loadSession(delegationStarts[0]!)!;
    // block 决策照常落子会话账（应用行策略文案 = 传导发生的唯一信号）
    const decisions = child.events
      .filter((e) => e.type === 'gate/decision')
      .map((e) => e.data as { decision: string; reason: string });
    expect(decisions.some((d) => d.decision === 'block' && d.reason.includes('应用行策略'))).toBe(true);
    // 拦截真体执行（修复前：漏传导 → 探针真体跑通，'不该执行到这里' 出现在账面）
    const childToolResults = deriveMessages(child.events).filter((m) => m.type === 'toolResult');
    expect(JSON.stringify(childToolResults)).not.toContain('不该执行到这里');
  });

  it('context 腿：父闭合边界投影作子首请求种子——尾轮进、敞开段不进、轮数不足全量', async () => {
    // 消费序：[0] 父 turn1 收尾 → [1] 父 turn2 toolCall(agent 带 context) →
    // [2] 子首请求（种子观测点）→ [3] 父收尾
    const { streamFn, contexts } = scriptedStream([
      textMessage('第一轮结论：AAA 可行'),
      toolCallMessage('agent', { prompt: '接手BBB', context: { recentTurns: 2 } }),
      textMessage('子答BBB完毕'),
      textMessage('父收尾'),
    ]);
    const runtime = await assemble({ streamFn });
    await runtime.conversation!.submitOnce('第一问AAA');
    await runtime.conversation!.submitOnce('现在委派处理BBB');
    // 子首请求 = 尾轮种子 + 子自身 prompt：
    // - turn1（唯一闭合轮）user/assistant 全进（recentTurns=2 超界 → 不足全量）
    // - turn2 敞开段 user 消息（'现在委派处理BBB'）不进（委派发生在本 turn 内——
    //   lastClosedTurnBoundary 排除）
    const childMessages = JSON.stringify(contexts[2]!.messages);
    expect(childMessages).toContain('第一问AAA');
    expect(childMessages).toContain('第一轮结论：AAA 可行');
    expect(childMessages).not.toContain('现在委派处理BBB');
    expect(childMessages).toContain('接手BBB');
  });

  it('/reload 后新委派取新链：行卸载即传导消失（第一次被拦、重载后放行）', async () => {
    // blocker 应用只拦 'ls'（子自建 fs 腿——不依赖应用工具，卸载后探针仍在）
    const compositionDir = makeTempDir('app-cond-reload-');
    const appDir = join(compositionDir, 'reload-gate');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'index.ts'),
      [
        'export const name = "reload-gate";',
        'export default async function apply(ctx) {',
        '  ctx.effect(() =>',
        '    ctx.on("tools_pre_execute", (input, next) => {',
        '      if (input.tool.name === "ls") {',
        '        return { decision: "block", reason: "reload 批次策略：ls 暂禁" };',
        '      }',
        '      return next();',
        '    }),',
        '  );',
        '}',
      ].join('\n'),
    );
    // app: chat——触发②执法下第三方行必须挂应用（chat 为在册官方应用）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: reload-gate\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    const workspace = makeTempDir('app-cond-reload-ws-');
    // 八段消费序：委派一 [0..3]（子被拦）→ overlay 清行 + reload → 委派二 [4..7]（放行）
    const { streamFn } = scriptedStream([
      toolCallMessage('agent', { prompt: '列目录A' }),
      toolCallMessage('ls', { path: workspace }),
      textMessage('子A收尾'),
      textMessage('父A收尾'),
      toolCallMessage('agent', { prompt: '列目录B' }),
      toolCallMessage('ls', { path: workspace }),
      textMessage('子B收尾'),
      textMessage('父B收尾'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir, workspace });
    const delegationStarts: string[] = [];
    runtime.ctx.on('session_start', (payload: unknown) => {
      const data = payload as { sessionId: string; origin?: string };
      if (data.origin === 'delegation') delegationStarts.push(data.sessionId);
    });

    await runtime.conversation!.submitOnce('第一次委派');
    expect(delegationStarts).toHaveLength(1);
    const childA = runtime.persistence!.loadSession(delegationStarts[0]!)!;
    const childADecisions = childA.events
      .filter((e) => e.type === 'gate/decision')
      .map((e) => e.data as { decision: string; reason: string });
    expect(childADecisions.some((d) => d.decision === 'block' && d.reason.includes('reload 批次策略'))).toBe(true);

    // overlay 清行 → /reload（fresh 读盘）→ 应用行锚级回卷、新组合树无此行
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows: []\n');
    await runtime.reload();
    expect(runtime.appsService.list().map((r) => r.id)).not.toContain('reload-gate');

    await runtime.conversation!.submitOnce('第二次委派');
    expect(delegationStarts).toHaveLength(2);
    const childB = runtime.persistence!.loadSession(delegationStarts[1]!)!;
    const childBDecisions = childB.events
      .filter((e) => e.type === 'gate/decision')
      .map((e) => e.data as { decision: string; reason: string });
    // 新链零拦截 + ls 真放行（allow 决策在场；无 block）。子会话 = fork 含父
    // 前缀种子（父的 agent 工具结果也在 toolResult 面里）——只断言无拦截文案
    expect(childBDecisions.some((d) => d.decision === 'block')).toBe(false);
    expect(childBDecisions.some((d) => d.decision === 'allow')).toBe(true);
    const childBToolResults = deriveMessages(childB.events).filter((m) => m.type === 'toolResult');
    expect(JSON.stringify(childBToolResults)).not.toContain('reload 批次策略');
  });

  it('传导判据排除面（工厂直测）：固定行 owner 与非 main 集行不进子链；main 行为正控', async () => {
    const { streamFn, contexts } = scriptedStream([toolCallMessage('probe', {}), textMessage('子答')]);
    // 手搭根总线（镜像装配层字面量：根 'app' + 锚 'apps' fork + 行 fork——
    // owner 全链名即 'app:apps:<行id>'）
    const rootCtx: ContextScope = createContext({ name: 'app' });
    const rootTools = registerToolsService(rootCtx, {});
    rootTools.register({
      name: 'probe',
      description: '传导探针（回显固定标记）',
      parameters: { type: 'object', properties: {} },
      effect: 'read',
      execute: async () => ({ content: [{ type: 'text', text: '探针原始结果' }] }),
    });
    const anchor = rootCtx.fork({ name: 'apps' });
    // 行作用域按 loader 恒态 fork（name = 行 id + rowId = 行 id——R2 判据载体
    // 改 entry.rowId 后 fixture 同产线形态；只给 name 不给 rowId 的手搭形已被
    // 判据按「固定行」结构性排除）
    const mainRow = anchor.fork({ name: 'gate-row', rowId: 'gate-row' });
    // 有锚前缀 + rowId 但不在 main 集（worker 行形态——桥转发器吞链，判据排除）
    const workerLike = anchor.fork({ name: 'bridge-worker-row', rowId: 'bridge-worker-row' });
    const rootSeen: string[] = [];
    const workerSeen: string[] = [];
    // 固定行形态：owner = 根名 'app'（无锚前缀——结构性排除）
    rootCtx.on(TOOL_PRE_EXECUTE_EVENT, () => rootSeen.push('root'));
    workerLike.on(TOOL_PRE_EXECUTE_EVENT, () => workerSeen.push('worker'));
    // main 行（正控）：block probe——证明子链确实收到了 main 行传导
    mainRow.on(TOOL_PRE_EXECUTE_EVENT, (input: PreGateInput, next: () => Promise<undefined>) => {
      if (input.tool.name === 'probe') {
        return { decision: 'block' as const, reason: '应用行拦：传导正控' };
      }
      return next();
    });
    const factory = createSubagentChildFactory({
      getParent: () => undefined,
      streamFn,
      model: 'test/model',
      convertToLlm: defaultConvertToLlm,
      workspace: makeTempDir('app-cond-excl-'),
      sandboxMode: 'workspace-write',
      rootCtx,
      gateRowFilter: { anchors: ['app:apps:', 'app:ring1:'], mainRows: () => new Set(['gate-row']) },
    });
    const provider = createInProcessProvider({ factory });
    const execution = provider.start({ prompt: '探测', toolFilter: ['probe'] });
    const result = await execution.result;
    expect(result.stopReason).toBe('completed');
    // 正控：main 行进子链（probe 被拦——子第二轮请求可见拦截文案）
    expect(JSON.stringify(contexts[1]!.messages)).toContain('应用行拦：传导正控');
    // 排除面：固定行与 worker 形态行零触达（会被传导的只有 main 行——二者计数恒空）
    expect(rootSeen).toEqual([]);
    expect(workerSeen).toEqual([]);
    await execution.dispose();
  });

  it('委托时点快照冻结：子装配后再注册的行不进该子；新委派取新链；行卸载后再放行', async () => {
    // 六段消费序：子A [0,1]（快照空 → 放行）→ 注册 block 行 → 子B [2,3]（新链被拦）
    // → 撤销注册 → 子C [4,5]（再放行）
    const { streamFn, contexts } = scriptedStream([
      toolCallMessage('probe', {}),
      textMessage('子答A'),
      toolCallMessage('probe', {}),
      textMessage('子答B'),
      toolCallMessage('probe', {}),
      textMessage('子答C'),
    ]);
    const rootCtx: ContextScope = createContext({ name: 'app' });
    const rootTools = registerToolsService(rootCtx, {});
    rootTools.register({
      name: 'probe',
      description: '传导探针（回显固定标记）',
      parameters: { type: 'object', properties: {} },
      effect: 'read',
      execute: async () => ({ content: [{ type: 'text', text: '探针原始结果' }] }),
    });
    // 行作用域按 loader 恒态 fork（name + rowId 双携——R2 判据载体同产线形态）
    const mainRow = rootCtx.fork({ name: 'apps' }).fork({ name: 'gate-row', rowId: 'gate-row' });
    const factory = createSubagentChildFactory({
      getParent: () => undefined,
      streamFn,
      model: 'test/model',
      convertToLlm: defaultConvertToLlm,
      workspace: makeTempDir('app-cond-freeze-'),
      sandboxMode: 'workspace-write',
      rootCtx,
      gateRowFilter: { anchors: ['app:apps:', 'app:ring1:'], mainRows: () => new Set(['gate-row']) },
    });
    const provider = createInProcessProvider({ factory });

    // 子A：装配时行上无监听器（快照空）——probe 放行
    const execA = provider.start({ prompt: '任务A', toolFilter: ['probe'] });
    // A 出膛后再注册 block（provider.start 内工厂同步调——快照已在装配时冻结）
    const off = mainRow.on(TOOL_PRE_EXECUTE_EVENT, (input: PreGateInput, next: () => Promise<undefined>) => {
      if (input.tool.name === 'probe') {
        return { decision: 'block' as const, reason: '后注册拦' };
      }
      return next();
    });
    const resultA = await execA.result;
    expect(resultA.stopReason).toBe('completed');
    // 冻结证据：A 运行期间注册的行未加入 A 的链（probe 真执行——回显进 A 第二轮）
    expect(JSON.stringify(contexts[1]!.messages)).toContain('探针原始结果');
    await execA.dispose();

    // 子B：新委派取新链（含后注册行）——probe 被拦
    const execB = provider.start({ prompt: '任务B', toolFilter: ['probe'] });
    const resultB = await execB.result;
    expect(resultB.stopReason).toBe('completed');
    expect(JSON.stringify(contexts[3]!.messages)).toContain('后注册拦');
    await execB.dispose();

    // 行卸载（on disposer——/reload 锚级回卷的单行等价物）→ 子C 再放行
    off();
    const execC = provider.start({ prompt: '任务C', toolFilter: ['probe'] });
    const resultC = await execC.result;
    expect(resultC.stopReason).toBe('completed');
    expect(JSON.stringify(contexts[5]!.messages)).toContain('探针原始结果');
    await execC.dispose();
  });
});

/* ---------------- external 行委派借道收窄（R1 复盘批二 major 4 回归锁） ---------------- */

describe('external 行委派借道收窄（R1 复盘批二，契约篇 §1.7 第 11b 条）', () => {
  it('external 行帧 tool-run 委派子代理：子 fs 写面 = 会话档 ∩ 行声明交集——行外根被拒、行内根可写（修复前必红）', async () => {
    const workspace = makeTempDir('app-subplug-ext-');
    // 行声明收窄目标：workspace 下 sub/ 子目录（其余 workspace 区域 = 行外）
    mkdirSync(join(workspace, 'sub'), { recursive: true });
    const compositionDir = makeTempDir('app-subplug-extc-');
    // 组合树 external 行（**禁用态**——单元测试不起真 fork 域；行收窄查询单点
    // 闭包装配面按行 id + carrier 取数不问激活态，行随树合成即对查找可见）。
    // tool-run 行帧由 runInCallerChain 直接模拟（bootstrap.ts tool-run 处理器
    // 同款罩法——生产面该帧来自 external 域 worker 的桥调用）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      [
        'rows:',
        '  - id: ext-deleg',
        '    pkg: /nonexistent-ext-app',
        '    apps: [chat]',
        '    disabled: true',
        `    sandbox: { carrier: external, fs: { writableRoots: ['${join(workspace, 'sub')}'] } }`,
        '',
      ].join('\n'),
    );
    // 消费序（不走 submitOnce——直调工具面无父 turn）：[0] 子 turn1 写行内
    // （成功）→ [1] 子 turn2 写行外（fence 拒）→ [2] 子收尾（拒因进上下文）
    const { streamFn, contexts } = scriptedStream([
      toolCallMessage('write', { path: join(workspace, 'sub', 'ok.txt'), content: '行内写' }),
      toolCallMessage('write', { path: join(workspace, 'outside.txt'), content: '行外写' }),
      textMessage('子收工'),
    ]);
    const runtime = await assemble({ streamFn, compositionDir, workspace });
    // tool-run 形态：全局层 agent def + 宿主管道执行器 + 行帧罩（同
    // bootstrap 'tool-run' 的 executor 调用——管道内部再按注册 owner 重包，
    // 栈 = [ext-deleg, subagent 行帧]，栈化语义保证外层行帧不丢）
    const def = runtime.tools.get('agent');
    expect(def).toBeDefined();
    const executor = runtime.tools.executor;
    expect(executor).toBeDefined();
    const result = await runInCallerChain('ext-deleg', () =>
      executor!(def!, 'test:toolrun:1', { prompt: '写文件', toolFilter: ['write'] }, undefined, undefined, 'service'),
    );
    // 委派正常结算（子收尾文本 = 工具结果——拒写只影响文件不炸委派）
    expect(result.isError).not.toBe(true);
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('子收工');
    // 正边：行内根可写（收窄 = 交集不是全拒——空交集与正确交集的区分证据）
    expect(existsSync(join(workspace, 'sub', 'ok.txt'))).toBe(true);
    // 负边：行外根被拒（修复前：子 fs 写面 = 会话档宽面 workspace∪/tmp∪
    // os.tmpdir() → 写成功落盘 → 本断言必红——chainCaller 单帧拿不到 external
    // 行帧的洞即此形态）
    expect(existsSync(join(workspace, 'outside.txt'))).toBe(false);
    // fence 拒因进子上下文，且可写根列表 = 收窄后的行有效白名单（非会话档宽面）
    const turn3 = JSON.stringify(contexts[2]!.messages);
    expect(turn3).toContain('FS_OUTSIDE_WRITABLE_ROOTS');
    expect(turn3).toContain(join(workspace, 'sub'));
  });
});
