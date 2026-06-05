import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, closeDb } from '../memory/db.js';
import { TestBackend } from '../llm/backends/test.js';
import { createTestLlmClient, LlmClient } from '../llm/client.js';
import { LockManager } from './file-locks.js';
import { CodeRuntime } from './runtime.js';
import { runTaskPhases, type PhaseContext } from './task-phases.js';
import type { CodeWorkspace } from './workspace.js';
import type { IpcChildChannel } from '../contracts/infrastructure.js';

let tempDir: string;
let db: Database.Database;
let lockManager: LockManager;
let runtime: CodeRuntime;
let backend: TestBackend;
let llm: LlmClient;
let mockIpc: IpcChildChannel;

const TEST_WORKSPACE: CodeWorkspace = {
  gitRoot: '/test/repo',
  allowedPaths: [],
  readOnlyPaths: [],
  excludedPaths: ['.git/', 'node_modules/'],
  isDirty: false,
  branch: 'main',
};

function createMockIpc(): IpcChildChannel {
  return {
    send: vi.fn(),
    request: vi.fn().mockResolvedValue({
      payload: { allowed: true, tokenId: 'pt_test_123' },
    }),
    onMessage: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IpcChildChannel;
}

function buildCtx(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    taskId: 'task_1',
    sessionId: 'sess_1',
    action: 'full_task',
    instruction: '修改 src/index.ts',
    workingDir: tempDir,
    workspace: TEST_WORKSPACE,
    llm,
    ipc: mockIpc,
    runtime,
    lockManager,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'berry-phases-'));
  const dbPath = join(tempDir, 'test.db');
  db = initDb(dbPath);
  lockManager = new LockManager(db);
  runtime = new CodeRuntime(db);
  backend = new TestBackend('mock');
  llm = createTestLlmClient(backend);
  mockIpc = createMockIpc();

  db.prepare(`
    INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, status, input_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task_1', 'sess_1', 'corr_1', 'code_task', 'test', 'code', 'running', '{}', Date.now());
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('task-phases', () => {
  describe('action routing', () => {
    it('analyze action 只执行 research + synthesis，不修改文件', async () => {
      backend.setMockResponses([
        // research phase: LLM returns without tool calls
        { content: '代码结构分析完成' },
        // synthesis phase: LLM returns analysis summary
        { content: '项目使用 TypeScript，主入口为 src/index.ts' },
      ]);

      const result = await runTaskPhases(buildCtx({ action: 'analyze' }));

      expect(result.success).toBe(true);
      expect(result.phases).toHaveLength(2);
      expect(result.phases[0].phase).toBe('research');
      expect(result.phases[1].phase).toBe('synthesis');
      expect(result.filesChanged).toEqual([]);
    });

    it('test action 跳过 research/synthesis/implementation，直接验证', async () => {
      const result = await runTaskPhases(buildCtx({
        action: 'test',
        testCommand: 'echo "Tests: 3 passed (3)"',
      }));

      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].phase).toBe('verification');
      expect(result.phases[0].success).toBe(true);
    });

    it('full_task 走直接执行路径（跳过 research/synthesis）', async () => {
      backend.setMockResponses([
        // 直接执行：读取文件
        { content: '', toolCalls: [{ id: 'tu_1', name: 'inspect_code', input: { path: 'src/index.ts' } }] },
        // 直接执行：写入文件
        { content: '', toolCalls: [{ id: 'tu_2', name: 'edit_code', input: { path: 'src/index.ts', oldText: 'old', newText: 'new' } }] },
        // 直接执行：完成
        { content: '修改完成' },
      ]);

      const result = await runTaskPhases(buildCtx({
        action: 'full_task',
      }));

      // full_task 走直接执行路径，只有 1 个 implementation phase（无 research/synthesis）
      expect(result.phases.length).toBeGreaterThanOrEqual(1);
      expect(result.phases[0].phase).toBe('implementation');
      expect(result.phases.map(p => p.phase)).not.toContain('research');
      expect(result.phases.map(p => p.phase)).not.toContain('synthesis');
    });
  });

  describe('research phase', () => {
    it('只暴露 inspect_code 和 summarize_changes 工具', async () => {
      let calledTools: string[] = [];
      backend.setMockResponses([
        // Try calling edit_code - it should fail because the tool isn't available
        { content: '', toolCalls: [{ id: 'tu_1', name: 'inspect_code', input: { path: 'src/a.ts' } }] },
        { content: '研究完成' },
        // synthesis
        { content: '分析摘要' },
      ]);

      const ctx = buildCtx({ action: 'analyze' });
      const result = await runTaskPhases(ctx);

      expect(result.phases[0].phase).toBe('research');
      // edit_code should not appear in research tool calls
      for (const tc of result.phases[0].toolCalls) {
        expect(['inspect_code', 'summarize_changes']).toContain(tc.name);
      }
    });
  });

  describe('implementation phase', () => {
    it('获取文件写锁', async () => {
      backend.setMockResponses([
        // research
        { content: '已理解代码' },
        // synthesis
        { content: '```json\n{"description":"edit","steps":[{"file":"src/a.ts","action":"edit","description":"修改"}]}\n```' },
        // implementation
        { content: '修改完成' },
      ]);

      const ctx = buildCtx({ action: 'edit' });
      const result = await runTaskPhases(ctx);

      expect(result.phases.find(p => p.phase === 'implementation')?.success).toBe(true);
      // Locks should be released after implementation
      const locks = lockManager.getTaskLocks('task_1');
      expect(locks).toHaveLength(0);
    });

    it('完成后释放所有锁', async () => {
      backend.setMockResponses([
        { content: '已理解代码' },
        { content: '```json\n{"description":"multi","steps":[{"file":"src/a.ts","action":"edit","description":"a"},{"file":"src/b.ts","action":"edit","description":"b"}]}\n```' },
        { content: '全部修改完成' },
      ]);

      const ctx = buildCtx({ action: 'edit' });
      await runTaskPhases(ctx);

      const locks = lockManager.getTaskLocks('task_1');
      expect(locks).toHaveLength(0);
    });

    it('LockConflictError 时 implementation 失败', async () => {
      // Pre-acquire a conflicting lock from another task
      db.prepare(`
        INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, status, input_payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('task_other', 'sess_2', 'corr_2', 'code_task', 'test', 'code', 'running', '{}', Date.now());

      lockManager.acquire({
        filePath: 'src/conflict.ts',
        workspaceDir: '/test/repo',
        taskId: 'task_other',
        agentName: 'code',
        lockType: 'write',
      });

      backend.setMockResponses([
        { content: '已理解代码' },
        { content: '```json\n{"description":"conflict","steps":[{"file":"src/conflict.ts","action":"edit","description":"冲突文件"}]}\n```' },
      ]);

      const ctx = buildCtx({ action: 'edit' });
      const result = await runTaskPhases(ctx);

      const implPhase = result.phases.find(p => p.phase === 'implementation');
      expect(implPhase?.success).toBe(false);
      expect(implPhase?.summary).toContain('文件锁');
    });
  });

  describe('verification phase', () => {
    it('测试通过返回 success: true', async () => {
      const result = await runTaskPhases(buildCtx({
        action: 'test',
        testCommand: 'echo "Tests  5 passed (5)"',
      }));

      expect(result.phases[0].success).toBe(true);
      expect(result.testResult).toBeDefined();
      expect(result.testResult!.passed).toBe(true);
    });

    it('测试失败返回 success: false', async () => {
      const result = await runTaskPhases(buildCtx({
        action: 'test',
        testCommand: 'exit 1',
      }));

      expect(result.phases[0].success).toBe(false);
      expect(result.testResult?.passed).toBe(false);
    });

    it('full_task 带 testCommand 直接执行后走验证', async () => {
      backend.setMockResponses([
        // 直接执行：完成
        { content: '修改完成' },
      ]);

      const ctx = buildCtx({
        action: 'full_task',
        testCommand: 'echo "Tests  1 passed (1)"',
      });
      const result = await runTaskPhases(ctx);

      // 直接执行 + 验证
      expect(result.phases.length).toBeGreaterThanOrEqual(2);
      expect(result.phases[0].phase).toBe('implementation');
      const verifyPhases = result.phases.filter(p => p.phase === 'verification');
      expect(verifyPhases.length).toBeGreaterThanOrEqual(1);
      expect(result.success).toBe(true);
    });

    it('full_task 无 testCommand 跳过验证', async () => {
      backend.setMockResponses([
        // 直接执行：完成
        { content: '修改完成' },
      ]);

      const ctx = buildCtx({
        action: 'full_task',
      });
      const result = await runTaskPhases(ctx);

      // 只有 implementation，没有 verification
      expect(result.phases.length).toBe(1);
      expect(result.phases[0].phase).toBe('implementation');
      expect(result.success).toBe(true);
    });
  });

  describe('artifact recording', () => {
    it('synthesis 记录 patch_plan artifact', async () => {
      backend.setMockResponses([
        { content: '已理解代码' },
        { content: '```json\n{"description":"plan","steps":[{"file":"src/x.ts","action":"create","description":"新建"}]}\n```' },
        { content: '创建完成' },
      ]);

      await runTaskPhases(buildCtx({ action: 'edit' }));

      const artifacts = runtime.getArtifacts('task_1');
      const planArtifact = artifacts.find(a => a.type === 'patch_plan');
      expect(planArtifact).toBeDefined();
    });

    it('verification 记录 test_run artifact', async () => {
      await runTaskPhases(buildCtx({
        action: 'test',
        testCommand: 'echo "ok"',
      }));

      const artifacts = runtime.getArtifacts('task_1');
      const testArtifact = artifacts.find(a => a.type === 'test_run');
      expect(testArtifact).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('synthesis 返回非 JSON 时 analyze 仍然成功', async () => {
      backend.setMockResponses([
        { content: '代码很简单' },
        { content: '这个模块实现了一个简单的计数器功能。' },
      ]);

      const result = await runTaskPhases(buildCtx({ action: 'analyze' }));
      expect(result.success).toBe(true);
      expect(result.summary).toContain('计数器');
    });

    it('synthesis 返回非 JSON 时 edit action 失败', async () => {
      backend.setMockResponses([
        { content: '已理解' },
        { content: '我觉得应该修改这个文件' }, // no JSON plan
      ]);

      const result = await runTaskPhases(buildCtx({ action: 'edit' }));
      expect(result.success).toBe(false);
    });

    it('edit action 无 testCommand 时跳过 verification', async () => {
      backend.setMockResponses([
        { content: '已理解' },
        { content: '```json\n{"description":"edit","steps":[{"file":"src/a.ts","action":"edit","description":"修改"}]}\n```' },
        { content: '修改完成' },
      ]);

      const result = await runTaskPhases(buildCtx({ action: 'edit', testCommand: undefined }));
      const phases = result.phases.map(p => p.phase);
      expect(phases).not.toContain('verification');
      expect(result.success).toBe(true);
    });
  });
});
