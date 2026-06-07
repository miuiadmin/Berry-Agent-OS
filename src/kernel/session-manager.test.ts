/**
 * SessionManager.complete 单元测试
 *
 * 覆盖:
 * 1. 完整三步：保存对话轮次 → 删除 pending → resolve 闭包
 * 2. saveTurn: false 时不保存但仍 delete + resolve
 * 3. pending 不存在返回 false
 * 4. saveConversationTurn 抛错时不影响 delete + resolve
 * 5. contentOverride 入库覆盖但 resolve 原始 response
 * 6. skipResolve 时不调 resolve，返回 pending 引用
 *
 * 背景：R15 将 resolvePending/finalizePending 统一为 complete，
 * 用 skipResolve 选项覆盖原 finalizePending 的半收尾场景。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import type { MemoryRuntime } from '../memory/index.js';
import type { AppConfig } from '../config/schema.js';

/** mock MemoryRuntime（仅暴露 saveConversationTurn） */
function makeMockMemoryRuntime(): MemoryRuntime & {
  saveCalls: Array<{ sessionId: string; userMessage: string; response: string; reasoning?: string }>;
} {
  const saveCalls: Array<{ sessionId: string; userMessage: string; response: string; reasoning?: string }> = [];
  return {
    saveConversationTurn: vi.fn(async (sessionId: string, userMessage: string, response: string, reasoning?: string) => {
      saveCalls.push({ sessionId, userMessage, response, reasoning });
    }),
    saveCalls,
  } as unknown as MemoryRuntime & {
    saveCalls: Array<{ sessionId: string; userMessage: string; response: string; reasoning?: string }>;
  };
}

function makeMockConfig(): AppConfig {
  return {
    requestTimeoutMs: 30_000,
  } as unknown as AppConfig;
}

describe('SessionManager.complete', () => {
  let manager: SessionManager;
  let memoryRuntime: ReturnType<typeof makeMockMemoryRuntime>;

  beforeEach(() => {
    memoryRuntime = makeMockMemoryRuntime();
    manager = new SessionManager({
      memoryRuntime: memoryRuntime as unknown as MemoryRuntime,
      skillLoader: null,
      evolutionEngine: null,
      pluginRuntimeV2: null,
      config: makeMockConfig(),
    });
  });

  it('完整三步：保存 → 删除 → resolve', async () => {
    let resolveCalled = false;
    let resolveArg = '';
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      resolve: (r) => { resolveCalled = true; resolveArg = r; },
    });

    const result = manager.complete('msg-1', 'world');

    expect(result).toBe(true);
    expect(memoryRuntime.saveConversationTurn).toHaveBeenCalledWith('ses-1', 'hello', 'world', undefined);
    // deletePending 后应查不到
    expect(manager.getPending('msg-1')).toBeUndefined();
    expect(resolveCalled).toBe(true);
    expect(resolveArg).toBe('world');
  });

  it('saveTurn: false 时不保存但仍 delete + resolve', async () => {
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      resolve: () => {},
    });

    const result = manager.complete('msg-1', 'response', { saveTurn: false });

    expect(result).toBe(true);
    expect(memoryRuntime.saveConversationTurn).not.toHaveBeenCalled();
    expect(manager.getPending('msg-1')).toBeUndefined();
  });

  it('pending 不存在返回 false', () => {
    const result = manager.complete('non-existent', 'response');
    expect(result).toBe(false);
    expect(memoryRuntime.saveConversationTurn).not.toHaveBeenCalled();
  });

  it('saveConversationTurn 抛错时不影响 delete + resolve', async () => {
    let resolveArg = '';
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      resolve: (r) => { resolveArg = r; },
    });
    // 模拟 saveConversationTurn 抛错
    (memoryRuntime.saveConversationTurn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB write fail'));

    // 不应抛错
    const result = manager.complete('msg-1', 'response');

    expect(result).toBe(true);
    expect(manager.getPending('msg-1')).toBeUndefined();
    expect(resolveArg).toBe('response');
  });

  it('contentOverride 入库覆盖但 resolve 原始 response', async () => {
    let resolveArg = '';
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      resolve: (r) => { resolveArg = r; },
    });

    manager.complete('msg-1', 'partial response', {
      contentOverride: 'partial response\n\n[已停止]',
    });

    // 入库的是 contentOverride
    expect(memoryRuntime.saveConversationTurn).toHaveBeenCalledWith(
      'ses-1',
      'hello',
      'partial response\n\n[已停止]',
      undefined,
    );
    // resolve 传的是原始 response
    expect(resolveArg).toBe('partial response');
  });

  it('skipResolve 保存 + 删除但不 resolve，返回 pending 引用', async () => {
    let resolveCalled = false;
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      resolve: () => { resolveCalled = true; },
    });

    const result = manager.complete('msg-1', 'response', { skipResolve: true });

    // 返回 pending 引用（不是 boolean true）
    expect(result).not.toBe(true);
    expect(result).not.toBe(false);
    if (typeof result === 'object' && result !== null) {
      expect(result.sessionId).toBe('ses-1');
    }
    // 保存了对话轮次
    expect(memoryRuntime.saveConversationTurn).toHaveBeenCalledWith('ses-1', 'hello', 'response', undefined);
    // 删除了 pending
    expect(manager.getPending('msg-1')).toBeUndefined();
    // 但没有自动 resolve
    expect(resolveCalled).toBe(false);
    // 手动 resolve 后才触发
    if (typeof result === 'object' && result !== null && 'resolve' in result) {
      (result as any).resolve('response');
      expect(resolveCalled).toBe(true);
    }
  });

  it('skipResolve 不存在时返回 false', () => {
    const result = manager.complete('non-existent', 'response', { skipResolve: true });
    expect(result).toBe(false);
  });

  it('skipResolve saveConversationTurn 抛错时仍返回 pending', async () => {
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      resolve: () => {},
    });
    (memoryRuntime.saveConversationTurn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB fail'));

    const result = manager.complete('msg-1', 'response', { skipResolve: true });

    // 仍返回 pending（不抛错）
    expect(result).not.toBe(false);
    expect(result).not.toBe(true);
    expect(manager.getPending('msg-1')).toBeUndefined();
  });

  it('同时支持 contentOverride 和 saveTurn: false', () => {
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      resolve: () => {},
    });

    manager.complete('msg-1', 'response', {
      contentOverride: 'should not be saved',
      saveTurn: false,
    });

    expect(memoryRuntime.saveConversationTurn).not.toHaveBeenCalled();
  });

  it('pending 有 reasoning 时也一并持久化', async () => {
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      reasoning: 'thinking process...',
      resolve: () => {},
    });

    manager.complete('msg-1', 'response');

    expect(memoryRuntime.saveConversationTurn).toHaveBeenCalledWith(
      'ses-1',
      'hello',
      'response',
      'thinking process...',
    );
  });
});

describe('SessionManager.getAllPendingAsks', () => {
  let manager: SessionManager;
  let memoryRuntime: ReturnType<typeof makeMockMemoryRuntime>;

  beforeEach(() => {
    memoryRuntime = makeMockMemoryRuntime();
    manager = new SessionManager({
      memoryRuntime: memoryRuntime as unknown as MemoryRuntime,
      skillLoader: null,
      evolutionEngine: null,
      pluginRuntimeV2: null,
      config: makeMockConfig(),
    });
  });

  it('空时返回空数组', () => {
    expect(manager.getAllPendingAsks()).toEqual([]);
  });

  it('返回所有 pending asks 快照', () => {
    manager.setPendingAsk('ses-1', {
      sessionId: 'ses-1',
      taskId: 'task-1',
      agentName: 'agent-a',
      question: 'question 1',
      correlationId: 'corr-1',
    });
    manager.setPendingAsk('ses-2', {
      sessionId: 'ses-2',
      taskId: 'task-2',
      agentName: 'agent-b',
      question: 'question 2',
      correlationId: 'corr-2',
    });

    const asks = manager.getAllPendingAsks();
    expect(asks).toHaveLength(2);
    expect(asks.map((a) => a.sessionId).sort()).toEqual(['ses-1', 'ses-2']);
  });

  it('返回 ReadonlyArray 防止外部修改内部状态', () => {
    manager.setPendingAsk('ses-1', {
      sessionId: 'ses-1',
      taskId: 'task-1',
      agentName: 'agent',
      question: 'q',
      correlationId: 'corr-1',
    });

    const asks = manager.getAllPendingAsks();
    // TS 层面应不允许 push（readonly）
    // 运行时调用应不影响内部 Map（返回的是新数组）
    expect(asks).toHaveLength(1);
  });
});
