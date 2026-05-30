import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, closeDb } from '../memory/db.js';
import { CodeRuntime } from './runtime.js';
import { genId } from '../utils/id.js';

let tempDir: string;
let db: Database.Database;
let runtime: CodeRuntime;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'berry-code-runtime-'));
  const dbPath = join(tempDir, 'test.db');
  db = initDb(dbPath);
  runtime = new CodeRuntime(db);

  db.prepare(`
    INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, status, input_payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('task_test_1', 'sess_1', 'corr_1', 'code_task', 'test', 'code', 'running', '{}', Date.now());
});

afterEach(() => {
  closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('CodeRuntime', () => {
  describe('recordArtifact', () => {
    it('记录 summary artifact', () => {
      const id = runtime.recordArtifact('task_test_1', 'summary', { action: 'analyze', response: 'done' });
      expect(id).toMatch(/^cta_/);

      const row = db.prepare('SELECT * FROM code_task_artifacts WHERE id = ?').get(id) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.task_id).toBe('task_test_1');
      expect(row.artifact_type).toBe('summary');
      expect(JSON.parse(row.payload as string).action).toBe('analyze');
    });

    it('记录 patch_plan artifact 带 file_path', () => {
      const id = runtime.recordArtifact('task_test_1', 'patch_plan', {
        description: '修改 index.ts',
        steps: [{ file: 'index.ts', action: 'edit', description: '添加导出' }],
      }, { filePath: 'index.ts' });

      const row = db.prepare('SELECT file_path FROM code_task_artifacts WHERE id = ?').get(id) as { file_path: string };
      expect(row.file_path).toBe('index.ts');
    });

    it('记录 test_run artifact 带 command', () => {
      const id = runtime.recordArtifact('task_test_1', 'test_run', {
        exitCode: 0,
        passed: true,
        stdout: 'all tests pass',
      }, { command: 'npm test' });

      const row = db.prepare('SELECT command FROM code_task_artifacts WHERE id = ?').get(id) as { command: string };
      expect(row.command).toBe('npm test');
    });

    it('记录 file_change artifact', () => {
      runtime.recordArtifact('task_test_1', 'file_change', { path: 'src/foo.ts', action: 'edit' });
      const artifacts = runtime.getArtifacts('task_test_1');
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].type).toBe('file_change');
    });

    it('记录 diagnostic artifact', () => {
      runtime.recordArtifact('task_test_1', 'diagnostic', { error: 'type error', file: 'bar.ts' });
      const artifacts = runtime.getArtifacts('task_test_1');
      expect(artifacts[0].type).toBe('diagnostic');
    });
  });

  describe('getArtifacts', () => {
    it('按时间顺序返回所有 artifact', () => {
      runtime.recordArtifact('task_test_1', 'patch_plan', { step: 1 });
      runtime.recordArtifact('task_test_1', 'file_change', { step: 2 });
      runtime.recordArtifact('task_test_1', 'test_run', { step: 3 });
      runtime.recordArtifact('task_test_1', 'summary', { step: 4 });

      const artifacts = runtime.getArtifacts('task_test_1');
      expect(artifacts).toHaveLength(4);
      expect(artifacts.map(a => a.type)).toEqual(['patch_plan', 'file_change', 'test_run', 'summary']);
    });

    it('不同 task 的 artifact 互不干扰', () => {
      db.prepare(`
        INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, status, input_payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('task_test_2', 'sess_2', 'corr_2', 'code_task', 'test', 'code', 'running', '{}', Date.now());

      runtime.recordArtifact('task_test_1', 'summary', { x: 1 });
      runtime.recordArtifact('task_test_2', 'summary', { x: 2 });

      expect(runtime.getArtifacts('task_test_1')).toHaveLength(1);
      expect(runtime.getArtifacts('task_test_2')).toHaveLength(1);
    });

    it('无 artifact 返回空数组', () => {
      expect(runtime.getArtifacts('task_test_1')).toEqual([]);
    });
  });
});
