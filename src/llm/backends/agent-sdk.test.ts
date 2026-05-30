import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentSdkBackend } from './agent-sdk.js';
import type { ModelRequest } from '../../contracts/model.js';

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    id: 'req_test_1',
    agent: 'code',
    purpose: 'code_task',
    modelTier: 'high',
    mode: 'live',
    backend: 'claude_agent_sdk',
    apiKind: 'claude_agent_sdk',
    sessionId: 'sess_1',
    taskId: 'task_1',
    correlationId: 'corr_1',
    stepIndex: 0,
    system: 'You are a coding assistant.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    options: { maxTokens: 4096 },
    promptHash: '',
    ...overrides,
  };
}

describe('AgentSdkBackend — session caching logic', () => {
  let backend: AgentSdkBackend;

  beforeEach(() => {
    backend = new AgentSdkBackend(
      { baseUrl: 'https://api.anthropic.com', apiKey: 'test-key', model: 'claude-opus-4-6-20250514', models: {}, mode: 'live' },
      { environmentId: 'env_test', sessionTtlMs: 5000 },
    );
  });

  it('generates cache key from taskId', () => {
    const key = (backend as unknown as { getCacheKey(r: ModelRequest): string | null }).getCacheKey(
      makeRequest({ agent: 'code', taskId: 'task_abc' }),
    );
    expect(key).toBe('code:task_abc');
  });

  it('generates cache key from sessionId when taskId absent', () => {
    const key = (backend as unknown as { getCacheKey(r: ModelRequest): string | null }).getCacheKey(
      makeRequest({ agent: 'conversation', taskId: undefined, sessionId: 'sess_xyz' }),
    );
    expect(key).toBe('conversation:sess_xyz');
  });

  it('returns null cache key when no taskId or sessionId', () => {
    const key = (backend as unknown as { getCacheKey(r: ModelRequest): string | null }).getCacheKey(
      makeRequest({ taskId: undefined, sessionId: '' }),
    );
    expect(key).toBeNull();
  });

  it('detects tool results in last message', () => {
    const hasTr = (backend as unknown as { hasToolResults(msgs: ModelRequest['messages']): boolean }).hasToolResults;

    expect(hasTr([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: 'done' }] },
    ])).toBe(true);

    expect(hasTr([
      { role: 'user', content: 'hello' },
    ])).toBe(false);

    expect(hasTr([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ])).toBe(false);

    expect(hasTr([])).toBe(false);
  });

  it('starts with zero sessions', () => {
    expect(backend.getSessionCount()).toBe(0);
  });

  it('evicts stale sessions', () => {
    const sessions = (backend as unknown as { sessions: Map<string, { agentId: string; sessionId: string; createdAt: number; lastUsedAt: number }> }).sessions;
    sessions.set('code:old_task', {
      agentId: 'agent_old',
      sessionId: 'sess_old',
      createdAt: Date.now() - 10000,
      lastUsedAt: Date.now() - 10000,
    });

    // Mock archiveAgent to avoid API call
    (backend as unknown as { archiveAgent: (id: string) => Promise<void> }).archiveAgent = vi.fn().mockResolvedValue(undefined);

    (backend as unknown as { evictStale(): void }).evictStale();
    expect(sessions.size).toBe(0);
  });

  it('does not evict fresh sessions', () => {
    const sessions = (backend as unknown as { sessions: Map<string, { agentId: string; sessionId: string; createdAt: number; lastUsedAt: number }> }).sessions;
    sessions.set('code:fresh_task', {
      agentId: 'agent_fresh',
      sessionId: 'sess_fresh',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    (backend as unknown as { archiveAgent: (id: string) => Promise<void> }).archiveAgent = vi.fn().mockResolvedValue(undefined);

    (backend as unknown as { evictStale(): void }).evictStale();
    expect(sessions.size).toBe(1);
  });
});
