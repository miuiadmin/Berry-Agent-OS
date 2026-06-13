import { beforeEach } from 'vitest';
import { describe, it, expect } from 'vitest';
import { routeReviewTarget } from './permission-flow.js';
import type { PermissionMode } from '../../safety/permissions.js';

/**
 * 15.0 机制 A：routeReviewTarget 路由决策纯函数测试。
 *
 * 钉死 requiresReview 的分流规则（handler 据此决定走 Brain 还是用户确认）：
 * - L2 moderate → 任何模式下都 'brain'（机制 A 核心行为，替代旧规则放行/用户确认）
 * - L3 dangerous / 危险工具类别（非 moderate）→ ask 'user' / yolo 'brain'
 */
const modes: PermissionMode[] = ['ask', 'allow-all', 'deny-all', 'yolo'];

describe('routeReviewTarget (15.0 机制 A)', () => {
  describe('L2 moderate → 一律 brain', () => {
    for (const mode of modes) {
      it(`moderate × ${mode} → brain`, () => {
        expect(routeReviewTarget('moderate', mode)).toBe('brain');
      });
    }
  });

  describe('L3 dangerous（及危险工具类别）', () => {
    it('dangerous × ask → user（用户最终权威）', () => {
      expect(routeReviewTarget('dangerous', 'ask')).toBe('user');
    });
    it('dangerous × yolo → brain（yolo 委托 Brain）', () => {
      expect(routeReviewTarget('dangerous', 'yolo')).toBe('brain');
    });
    it('dangerous × allow-all → user（非 yolo 即 user）', () => {
      expect(routeReviewTarget('dangerous', 'allow-all')).toBe('user');
    });
    it('dangerous × deny-all → user', () => {
      expect(routeReviewTarget('dangerous', 'deny-all')).toBe('user');
    });
  });

  describe('safe 但命中危险工具类别（仅此情况 safe 进 requiresReview）', () => {
    it('safe × ask → user', () => {
      expect(routeReviewTarget('safe', 'ask')).toBe('user');
    });
    it('safe × yolo → brain（yolo 下危险类别也交 Brain）', () => {
      expect(routeReviewTarget('safe', 'yolo')).toBe('brain');
    });
  });

  it('路由规则汇总矩阵', () => {
    // 完整矩阵快照，任何调整需显式更新
    const matrix: Record<string, Record<PermissionMode, 'brain' | 'user'>> = {
      moderate: { ask: 'brain', 'allow-all': 'brain', 'deny-all': 'brain', yolo: 'brain' },
      dangerous: { ask: 'user', 'allow-all': 'user', 'deny-all': 'user', yolo: 'brain' },
      safe: { ask: 'user', 'allow-all': 'user', 'deny-all': 'user', yolo: 'brain' },
    };
    for (const [level, expected] of Object.entries(matrix)) {
      for (const mode of modes) {
        expect(routeReviewTarget(level, mode)).toBe(expected[mode]);
      }
    }
  });
});

// ============================================================================
// handleBrainReview / handleUserConfirm / resolveUserConfirm 行为测试
//
// 这三个方法是 PermissionFlow 的核心审批路径，但都是 private/setupHandlers 内部触发。
// 测试策略：通过公开的 setupHandlers() + setupJudgeHandler() 驱动 —— 发送模拟 IPC 消息，
// 捕获回送消息，验证行为契约。这与真实运行时路径完全一致（避免反射访问 private 成员）。
//
// Mock 策略（PermissionFlowDeps）：
// - permissionCoordinator.resolve：返回带 id 的 token（approve 路径）/ null（签发失败）
// - permissionCoordinator.acquire：返回 requiresReview + requestId（进入 review 分流）
// - permissionCoordinator.getMode：返回 'yolo'（让 dangerous 也走 brain，便于单测 brain 路径）
// - registry.requireRole('orchestrator')：返回 brain agent manifest
// - agentManager.getAgent(brain)：返回 brain ipc（捕获 permission.judge 发送，供回灌 judge.result）
// - sessionManager.findPending*：返回 sessionId（isPrimary 分支需要）
// ============================================================================

import { PermissionFlow } from './permission-flow.js';
import type { PermissionFlowDeps } from './permission-flow.js';
import type { IpcMessage, IpcMessageType } from '../types.js';
import type { PermissionJudgeResultPayload } from '../../contracts/routing.js';
import type { PermissionResultPayload } from '../../contracts/permissions.js';
import { initEventBus, getEventBus } from '../event-bus.js';

// handleBrainReview / handleUserConfirm 内部调 getEventBus().emit，每个用例前初始化一个全新实例，
// 避免上一个用例注册的监听器泄漏到下一个用例（事件监听是单测干扰的高发区）。
beforeEach(() => {
  initEventBus();
});

/** 一个被捕获的 send() 调用记录（含 type/to/payload/correlationId），供断言 */
interface SentMsg {
  type: IpcMessageType;
  to: string;
  payload: unknown;
  correlationId?: string;
  replyId?: string;
}

/**
 * 构造可捕获消息的 mock IPC。
 * - send()：把每次发送记录到 sent 数组，返回 true（PermissionFlow 不检查返回值）
 * - onMessage()：按 type 注册 handler，供测试用 deliver() 注入入站消息（模拟 Brain 回 judge.result）
 *
 * 注意：send 的第四参（correlationId / replyId）在两种语义下复用 ——
 * permission.result 回送时是 replyId，permission.judge 发出时是 correlationId。
 * 这里统一记录第 4 参为 correlationId，再额外保留一个 replyId 别名以兼容两种断言。
 */
function makeMockIpc(name = 'mock-agent') {
  const handlers = new Map<IpcMessageType, (msg: IpcMessage) => void>();
  const sent: SentMsg[] = [];
  return {
    name,
    sent,
    /** 注册入站 handler（PermissionFlow.setupHandlers / setupJudgeHandler 调用） */
    onMessage(type: IpcMessageType, handler: (msg: IpcMessage) => void) {
      handlers.set(type, handler);
    },
    /** 捕获出站消息（PermissionFlow 回送 permission.result / 发出 permission.judge） */
    send(type: IpcMessageType, to: string, payload: unknown, correlationId?: string): boolean {
      sent.push({ type, to, payload, correlationId, replyId: correlationId });
      return true;
    },
    /** 测试辅助：模拟收到一条入站 IPC 消息，触发对应 type 的 handler */
    deliver(type: IpcMessageType, payload: unknown, opts: { id?: string; correlationId?: string; from?: string } = {}) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`makeMockIpc: 未注册入站 handler for type=${type}`);
      const msg: IpcMessage = {
        id: opts.id ?? 'msg-1',
        correlationId: opts.correlationId,
        type,
        from: opts.from ?? name,
        to: name,
        payload,
        timestamp: Date.now(),
      };
      handler(msg);
    },
  };
}

/** 构造最小可用的 PermissionFlowDeps mock（按测试场景定制返回值） */
function makeDeps(opts: {
  resolveToken?: { id: string } | null;
  acquireResult?: PermissionResultPayload;
  mode?: PermissionMode;
  brainName?: string;
}): { deps: PermissionFlowDeps; brainIpc: ReturnType<typeof makeMockIpc> } {
  const brainIpc = makeMockIpc('brain-agent');
  const brainName = opts.brainName ?? 'brain-agent';
  const deps: PermissionFlowDeps = {
    // permissionCoordinator mock —— 只 stub 测试会用到的 4 个方法
    permissionCoordinator: {
      resolve: () => opts.resolveToken ?? null,
      acquire: () => opts.acquireResult ?? ({} as PermissionResultPayload),
      getMode: () => opts.mode ?? 'yolo',
      // 以下方法测试用不到，给空实现满足 TS 类型
      checkAndIssue: () => ({} as PermissionResultPayload),
      checkAndIssueSimple: () => ({} as PermissionResultPayload),
      validate: () => ({} as PermissionResultPayload),
      consume: () => ({} as PermissionResultPayload),
    } as unknown as PermissionFlowDeps['permissionCoordinator'],
    // registry mock：requireRole('orchestrator') 返回 brain manifest
    registry: {
      requireRole: () => ({ manifest: { name: brainName } }),
    } as unknown as PermissionFlowDeps['registry'],
    // agentManager mock：getAgent(brain) 返回带 ipc 的 process，否则 undefined
    agentManager: {
      getAgent: (n: string) => (n === brainName ? { ipc: brainIpc } : undefined),
    } as unknown as PermissionFlowDeps['agentManager'],
    // sessionManager mock：isPrimary 分支反查 sessionId
    sessionManager: {
      findPendingByTaskId: () => ({ sessionId: 'sess-test' }),
      findAnyPendingWithTaskId: () => ({ sessionId: 'sess-test' }),
    } as unknown as PermissionFlowDeps['sessionManager'],
    // brainDecisionRecorder 不参与行为断言，置 null
    brainDecisionRecorder: null,
  };
  return { deps, brainIpc };
}

/**
 * 驱动一次 permission.acquire → handleBrainReview 流程，并回灌 Brain judge 结果。
 *
 * 返回 PermissionFlow 回送的 permission.result 消息（最后一条 permission.result），
 * 同时返回 brainIpc 捕获到的 permission.judge 发送记录（含 correlationId）。
 */
async function driveBrainReview(opts: {
  dangerLevel: string;
  judge: PermissionJudgeResultPayload;
  resolveToken?: { id: string } | null;
  acquireResult?: PermissionResultPayload;
}): Promise<{ result?: SentMsg; judgeSent?: SentMsg; allResults: SentMsg[]; brainIpc: ReturnType<typeof makeMockIpc>; flow: PermissionFlow }> {
  const { deps, brainIpc } = makeDeps({
    resolveToken: opts.resolveToken,
    acquireResult: opts.acquireResult,
    mode: 'yolo', // yolo 下 dangerous 也走 brain，便于覆盖 brain 路径
  });
  const flow = new PermissionFlow(deps);
  // 注册 Brain judge.result handler（handleBrainReview 的 requestJudge 依赖它 resolve）
  flow.setupJudgeHandler(brainIpc);
  // 注册 agent 侧 permission.* handler（isPrimary=true 走 acquire 分支）
  const agentIpc = makeMockIpc('work-agent');
  flow.setupHandlers(agentIpc, 'work-agent', true);

  // 触发 permission.acquire（requiresReview=true + requestId，进入 handleBrainReview）
  agentIpc.deliver('permission.acquire', {
    toolName: 'shell',
    toolInput: 'rm -rf /tmp/x',
    dangerLevel: opts.dangerLevel,
    taskId: 't-1',
  }, { id: 'reply-1' });

  // brainIpc 应已收到 permission.judge（携带 correlationId），回灌 judge 结果
  const judgeSent = brainIpc.sent.find(s => s.type === 'permission.judge');
  if (judgeSent?.correlationId) {
    brainIpc.deliver('permission.judge.result', opts.judge, { correlationId: judgeSent.correlationId });
  }

  // 关键：handleBrainReview 是 async（via `void this.handleBrainReview(...)`），
  // judge.result 回灌后 requestJudge 的 Promise resolve、后续 resolve()/send() 跑在微任务上。
  // 这里 flush 一个宏任务，确保 await requestJudge 之后的代码已执行完再断言。
  await new Promise((r) => setTimeout(r, 0));

  // 取回送的 permission.result（可能多条，取最后一条）
  const allResults = agentIpc.sent.filter(s => s.type === 'permission.result');
  return { result: allResults[allResults.length - 1], judgeSent, allResults, brainIpc, flow };
}

describe('handleBrainReview（Brain approve/deny/uncertain 三分支）', () => {
  it('Brain approve 且 token 签发成功 → permission.result allowed=true 且带 tokenId', async () => {
    const { result } = await driveBrainReview({
      dangerLevel: 'moderate',
      judge: { allowed: true, reason: '操作安全，批准' },
      resolveToken: { id: 'tok-123' },
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-1', reason: 'moderate 需 Brain 审批' },
    });

    expect(result).toBeDefined();
    const payload = result!.payload as PermissionResultPayload;
    expect(payload.allowed).toBe(true);
    // 关键：approve 必须回带 tokenId（工具执行层强制要求）
    expect(payload.tokenId).toBe('tok-123');
    expect(payload.reason).toBe('操作安全，批准');
  });

  it('Brain approve 但 coordinator.resolve 返回 null（签发失败）→ permission.result allowed=false', async () => {
    const { result } = await driveBrainReview({
      dangerLevel: 'moderate',
      judge: { allowed: true, reason: '批准' },
      resolveToken: null, // token 签发失败
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-1', reason: 'moderate' },
    });

    expect(result).toBeDefined();
    const payload = result!.payload as PermissionResultPayload;
    // 签发失败 = 拒绝（fail-closed），不能 allowed=true 无 token
    expect(payload.allowed).toBe(false);
    expect(payload.reason).toContain('签发 token 失败');
  });

  it('Brain deny → permission.result allowed=false，reason 取 Brain 给的理由', async () => {
    const { result } = await driveBrainReview({
      dangerLevel: 'moderate',
      judge: { allowed: false, reason: '命令危险，拒绝' },
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-2', reason: 'moderate' },
    });

    expect(result).toBeDefined();
    const payload = result!.payload as PermissionResultPayload;
    expect(payload.allowed).toBe(false);
    expect(payload.reason).toBe('命令危险，拒绝');
    // deny 路径不应签 token
    expect(payload.tokenId).toBeUndefined();
  });

  it('Brain uncertain → 升级到用户确认：handleBrainReview 不直接回 permission.result', async () => {
    const { result, flow } = await driveBrainReview({
      dangerLevel: 'moderate',
      judge: {
        allowed: false,
        reason: 'Brain 拿不准',
        uncertain: true,
        escalation: {
          source: 'approval',
          reason: '边界情况',
          questionToUser: '你确定要执行 rm -rf 吗？',
        },
      },
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-uncertain', reason: 'moderate' },
    });

    // uncertain 分支：handleBrainReview 不回 permission.result，而是转 handleUserConfirm（升级到用户确认）
    expect(result).toBeUndefined();
    // 升级后 requestId 已登记进 pendingUserConfirms —— resolveUserConfirm 能命中说明走了升级链路
    // （详细事件断言见下一个用例，这里只钉死"不直接拒绝"的行为）
    expect(flow.resolveUserConfirm('req-uncertain', true, '同意', 'tok-u')).toBe(true);
  });

  it('Brain uncertain：直接验证升级链路（emit 事件 + 注册 pending + 可 resolve）', async () => {
    // 单独构造一次，在事件 emit 时同步捕获（EventBus 无 messageBus 时 emit 是同步的）
    const { deps, brainIpc } = makeDeps({
      mode: 'yolo',
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-up', reason: 'moderate' },
    });
    const flow = new PermissionFlow(deps);
    flow.setupJudgeHandler(brainIpc);
    const agentIpc = makeMockIpc('work-agent');
    flow.setupHandlers(agentIpc, 'work-agent', true);

    const captured: Array<Record<string, unknown>> = [];
    const off = getEventBus().on('permission.user_confirm_needed', (p) => captured.push(p as Record<string, unknown>));

    agentIpc.deliver('permission.acquire', {
      toolName: 'shell',
      toolInput: 'rm -rf /tmp/x',
      dangerLevel: 'moderate',
      taskId: 't-2',
    }, { id: 'reply-up' });

    // 回灌 uncertain judge（handleBrainReview 异步，judge.result 解析后续走微任务）
    const judgeSent = brainIpc.sent.find(s => s.type === 'permission.judge');
    expect(judgeSent).toBeDefined();
    brainIpc.deliver('permission.judge.result', {
      allowed: false, reason: '拿不准', uncertain: true,
      escalation: { source: 'approval', reason: '边界', questionToUser: '要执行吗？' },
    }, { correlationId: judgeSent!.correlationId });

    // flush 微任务，让 async handleBrainReview 跑完到 handleUserConfirm → emit
    await new Promise((r) => setTimeout(r, 0));
    off();

    // 1) emit 了升级事件，且 brainReason 优先取 escalation.questionToUser
    expect(captured).toHaveLength(1);
    expect(captured[0].brainReason).toBe('要执行吗？');
    expect(captured[0].requestId).toBe('req-up');
    expect(captured[0].toolName).toBe('shell');

    // 2) 升级后不回 permission.result（等待用户回答）
    const results = agentIpc.sent.filter(s => s.type === 'permission.result');
    expect(results).toHaveLength(0);

    // 3) pendingUserConfirms 已登记：resolveUserConfirm('req-up', true, ..., tokenId) 应回带 token
    const resolved = flow.resolveUserConfirm('req-up', true, '用户同意', 'tok-up-1');
    expect(resolved).toBe(true);
    const afterResolve = agentIpc.sent.filter(s => s.type === 'permission.result');
    expect(afterResolve).toHaveLength(1);
    const payload = afterResolve[0].payload as PermissionResultPayload;
    expect(payload.allowed).toBe(true);
    expect(payload.tokenId).toBe('tok-up-1');
    expect(payload.reason).toBe('用户同意');
  });
});

describe('handleUserConfirm（直接触发：dangerous × ask 模式走用户确认）', () => {
  it('emit permission.user_confirm_needed，brainReason 取通用危险提示', () => {
    const { deps } = makeDeps({
      mode: 'ask',
      // requiresReview=true + requestId，否则 acquire handler 走 else 直接回 result，不进 handleUserConfirm
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-huc', reason: 'dangerous' },
    });
    const flow = new PermissionFlow(deps);
    const agentIpc = makeMockIpc('work-agent');
    flow.setupHandlers(agentIpc, 'work-agent', true);

    const captured: Array<Record<string, unknown>> = [];
    const off = getEventBus().on('permission.user_confirm_needed', (p) => captured.push(p as Record<string, unknown>));

    // dangerous × ask → routeReviewTarget==='user' → 直接 handleUserConfirm
    agentIpc.deliver('permission.acquire', {
      toolName: 'shell',
      toolInput: 'rm -rf /',
      dangerLevel: 'dangerous',
      taskId: 't-3',
    }, { id: 'reply-3' });

    off();

    expect(captured).toHaveLength(1);
    expect(captured[0].dangerLevel).toBe('dangerous');
    expect(captured[0].brainReason).toBe('危险操作，需要用户确认');
    expect(captured[0].sessionId).toBe('sess-test');
    // toolInput 截断到 500 字符以内
    expect((captured[0].toolInput as string).length).toBeLessThanOrEqual(500);
  });
});

describe('resolveUserConfirm', () => {
  it('对未登记的 requestId 返回 false（幂等 / 防重复处理）', () => {
    const { deps } = makeDeps({ mode: 'ask' });
    const flow = new PermissionFlow(deps);
    expect(flow.resolveUserConfirm('never-existed', true, 'ok', 'tok-x')).toBe(false);
  });

  it('已 resolve 后再次 resolve 同一 requestId → 返回 false（pending 已清除）', () => {
    const { deps } = makeDeps({
      mode: 'ask',
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-dup', reason: 'dangerous' },
    });
    const flow = new PermissionFlow(deps);
    const agentIpc = makeMockIpc('work-agent');
    flow.setupHandlers(agentIpc, 'work-agent', true);

    agentIpc.deliver('permission.acquire', {
      toolName: 'shell', toolInput: 'rm', dangerLevel: 'dangerous', taskId: 't-dup',
    }, { id: 'reply-dup' });

    // 第一次 resolve 成功
    expect(flow.resolveUserConfirm('req-dup', true, '同意', 'tok-dup')).toBe(true);
    // 第二次 resolve 应失败（pending 已删）
    expect(flow.resolveUserConfirm('req-dup', false, '反悔')).toBe(false);

    // 只回送了一条 permission.result（第一次的），第二次未生效
    const results = agentIpc.sent.filter(s => s.type === 'permission.result');
    expect(results).toHaveLength(1);
    expect((results[0].payload as PermissionResultPayload).tokenId).toBe('tok-dup');
  });

  it('用户拒绝 → permission.result allowed=false，不带 tokenId', () => {
    const { deps } = makeDeps({
      mode: 'ask',
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-deny', reason: 'dangerous' },
    });
    const flow = new PermissionFlow(deps);
    const agentIpc = makeMockIpc('work-agent');
    flow.setupHandlers(agentIpc, 'work-agent', true);

    agentIpc.deliver('permission.acquire', {
      toolName: 'shell', toolInput: 'rm', dangerLevel: 'dangerous', taskId: 't-deny',
    }, { id: 'reply-deny' });

    expect(flow.resolveUserConfirm('req-deny', false)).toBe(true);
    const results = agentIpc.sent.filter(s => s.type === 'permission.result');
    expect(results).toHaveLength(1);
    const payload = results[0].payload as PermissionResultPayload;
    expect(payload.allowed).toBe(false);
    expect(payload.tokenId).toBeUndefined();
    // reason 默认回退文案
    expect(payload.reason).toBe('用户已拒绝');
  });

  it('用户批准但不带 tokenId → allowed=true 但无 tokenId（暴露潜在缺口：执行层会因缺 token 拒绝）', () => {
    // 这是 resolveUserConfirm 的设计行为快照：allowed 与 tokenId 解耦。
    // 调用方若忘传 tokenId，这里仍 allowed=true —— 工具执行层会再判"缺 token"拒绝。
    // 测试钉死此行为，提醒调用方必须带 tokenId。
    const { deps } = makeDeps({
      mode: 'ask',
      acquireResult: { allowed: false, requiresReview: true, requestId: 'req-notoken', reason: 'dangerous' },
    });
    const flow = new PermissionFlow(deps);
    const agentIpc = makeMockIpc('work-agent');
    flow.setupHandlers(agentIpc, 'work-agent', true);

    agentIpc.deliver('permission.acquire', {
      toolName: 'shell', toolInput: 'rm', dangerLevel: 'dangerous', taskId: 't-notoken',
    }, { id: 'reply-notoken' });

    expect(flow.resolveUserConfirm('req-notoken', true)).toBe(true);
    const results = agentIpc.sent.filter(s => s.type === 'permission.result');
    const payload = results[0].payload as PermissionResultPayload;
    expect(payload.allowed).toBe(true);
    expect(payload.tokenId).toBeUndefined();
    expect(payload.reason).toBe('用户已确认');
  });
});
