/**
 * ①permission producePermissionJudge 冒烟测试（①② 翻转前验证权限审核核心）。
 * mock chat 返固定 allowed 判断 → 验证 producePermissionJudge 解析 + 返回 + record。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../../../memory/db.js';
import { producePermissionJudge, type PermissionJudgeContext, type PermissionChatFn } from './produce-permission.js';
import type { PermissionJudgeRequestPayload } from '../../../contracts/routing.js';

describe('permission producePermissionJudge（①② 权限审核核心）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-perm-produce-'));
    initDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const mockChatAllow: PermissionChatFn = async () => ({
    content: JSON.stringify({ allowed: true, reason: '工具在 scope 内，安全' }),
  });

  function buildMockCtx() {
    const recorded: unknown[] = [];
    const ctx: PermissionJudgeContext = {
      db: undefined as never,
      getPermissionPrompt: () => 'PERMISSION_BASE_PROMPT',
      recallDecisionsBlock: () => '\n## PERM_DECISIONS',
      recordPermissionDecision: (sessionId, toolName, judgment) => recorded.push({ sessionId, toolName, judgment }),
    };
    return { ctx, recorded };
  }

  it('mock allow chat → 返回 allowed=true + 调 recordPermissionDecision', async () => {
    const { ctx, recorded } = buildMockCtx();
    const payload: PermissionJudgeRequestPayload = {
      sessionId: 's1', agentName: 'code', toolName: 'write_file', toolInput: '...', dangerLevel: 'moderate',
    } as PermissionJudgeRequestPayload;
    const result = await producePermissionJudge(payload, 'track-1', mockChatAllow, ctx, 'permission');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('工具在 scope 内，安全');
    expect(recorded).toHaveLength(1);
  });

  it('chat 抛错 → fail-closed（allowed=false，权限保守）', async () => {
    const { ctx } = buildMockCtx();
    const failingChat: PermissionChatFn = async () => { throw new Error('LLM down'); };
    const payload = { sessionId: 's2', agentName: 'code', toolName: 'shell', toolInput: 'rm', dangerLevel: 'dangerous' } as PermissionJudgeRequestPayload;
    const result = await producePermissionJudge(payload, 'track-2', failingChat, ctx, 'permission');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('LLM 失败');
  });
});
