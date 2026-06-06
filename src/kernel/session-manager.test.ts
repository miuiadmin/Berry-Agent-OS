/**
 * SessionManager.resolvePending 单元测试
 *
 * 覆盖:
 * 1. 完整三步：保存对话轮次 → 删除 pending → resolve 闭包
 * 2. saveTurn: false 时不保存但仍 delete + resolve
 * 3. pending 不存在返回 false
 * 4. saveConversationTurn 抛错时不影响 delete + resolve
 * 5. contentOverride 入库覆盖但 resolve 原始 response
 *
 * 背景：PR-3 消除 delegation-orchestrator 中 7 处重复的
 * try/saveTurn/catch + deletePending + pending.resolve 三步补丁。
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

describe('SessionManager.resolvePending', () => {
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

    const result = manager.resolvePending('msg-1', 'world');

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

    const result = manager.resolvePending('msg-1', 'response', { saveTurn: false });

    expect(result).toBe(true);
    expect(memoryRuntime.saveConversationTurn).not.toHaveBeenCalled();
    expect(manager.getPending('msg-1')).toBeUndefined();
  });

  it('pending 不存在返回 false', () => {
    const result = manager.resolvePending('non-existent', 'response');
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
    const result = manager.resolvePending('msg-1', 'response');

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

    manager.resolvePending('msg-1', 'partial response', {
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

  it('同时支持 contentOverride 和 saveTurn: false', () => {
    manager.createPending('msg-1', {
      sessionId: 'ses-1',
      userMessage: 'hello',
      resolve: () => {},
    });

    manager.resolvePending('msg-1', 'response', {
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

    manager.resolvePending('msg-1', 'response');

    expect(memoryRuntime.saveConversationTurn).toHaveBeenCalledWith(
      'ses-1',
      'hello',
      'response',
      'thinking process...',
    );
  });
});
