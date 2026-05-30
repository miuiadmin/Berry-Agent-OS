import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createTaskWorkspace,
  closeTaskWorkspace,
  checkWorkspaceSize,
  cleanupStaleTaskWorkspaces,
  safeWriteWorkspaceFile,
} from './task-workspace.js';

describe('Task Workspace', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'berry-ws-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('createTaskWorkspace 创建标准目录结构', () => {
    const paths = createTaskWorkspace(tempDir, 'tsk_1', { message: 'hello' });

    expect(existsSync(paths.root)).toBe(true);
    expect(existsSync(paths.outputs)).toBe(true);
    expect(existsSync(paths.artifacts)).toBe(true);
    expect(existsSync(paths.tmp)).toBe(true);
  });

  it('写入 task.json 和 context.json', () => {
    const input = { sessionId: 'ses_1', message: 'test', createdAt: 1234567890 };
    const paths = createTaskWorkspace(tempDir, 'tsk_2', input);

    const taskData = JSON.parse(readFileSync(paths.taskJson, 'utf-8'));
    expect(taskData).toEqual(input);

    const contextData = JSON.parse(readFileSync(paths.contextJson, 'utf-8'));
    expect(contextData).toEqual({});
  });

  it('closeTaskWorkspace 写入 result.json', () => {
    const paths = createTaskWorkspace(tempDir, 'tsk_3', {});
    const result = { response: 'hi', reviewVerdict: 'approve', completedAt: Date.now() };

    closeTaskWorkspace(paths.root, result);

    const saved = JSON.parse(readFileSync(join(paths.root, 'result.json'), 'utf-8'));
    expect(saved).toEqual(result);
  });

  it('checkWorkspaceSize 计算目录大小', () => {
    const paths = createTaskWorkspace(tempDir, 'tsk_4', { data: 'x'.repeat(1000) });
    const { bytes, exceeded } = checkWorkspaceSize(paths.root);

    expect(bytes).toBeGreaterThan(0);
    expect(exceeded).toBe(false);
  });

  it('workspace 路径包含 taskId', () => {
    const paths = createTaskWorkspace(tempDir, 'tsk_abc', {});
    expect(paths.root).toBe(join(tempDir, 'tsk_abc'));
  });

  it('多个 workspace 互不干扰', () => {
    const paths1 = createTaskWorkspace(tempDir, 'tsk_a', { a: 1 });
    const paths2 = createTaskWorkspace(tempDir, 'tsk_b', { b: 2 });

    const data1 = JSON.parse(readFileSync(paths1.taskJson, 'utf-8'));
    const data2 = JSON.parse(readFileSync(paths2.taskJson, 'utf-8'));

    expect(data1).toEqual({ a: 1 });
    expect(data2).toEqual({ b: 2 });
  });

  it('拒绝包含路径穿越的 taskId', () => {
    expect(() => createTaskWorkspace(tempDir, '../evil', {})).toThrow('无效的 taskId');
    expect(() => createTaskWorkspace(tempDir, '../../etc/passwd', {})).toThrow('无效的 taskId');
    expect(() => createTaskWorkspace(tempDir, 'foo/bar', {})).toThrow('无效的 taskId');
    expect(() => createTaskWorkspace(tempDir, '', {})).toThrow('无效的 taskId');
  });

  it('允许合法的 taskId 格式', () => {
    expect(() => createTaskWorkspace(tempDir, 'tsk_valid-123', {})).not.toThrow();
    expect(() => createTaskWorkspace(tempDir, 'ABC_xyz-999', {})).not.toThrow();
  });

  it('safeWriteWorkspaceFile 拒绝路径越界', () => {
    const paths = createTaskWorkspace(tempDir, 'tsk_safe', {});

    expect(() => safeWriteWorkspaceFile(paths.root, '../evil.txt', 'bad')).toThrow('路径越界');
  });

  it('safeWriteWorkspaceFile 拒绝经过符号链接写入', () => {
    const paths = createTaskWorkspace(tempDir, 'tsk_symlink', {});
    symlinkSync(tempDir, join(paths.root, 'link'));

    expect(() => safeWriteWorkspaceFile(paths.root, 'link/evil.txt', 'bad')).toThrow('符号链接');
  });

  it('safeWriteWorkspaceFile 执行大小限制', () => {
    const paths = createTaskWorkspace(tempDir, 'tsk_limit', {});

    expect(() => safeWriteWorkspaceFile(paths.root, 'outputs/a.txt', '12345', { maxWorkspaceBytes: 4 }))
      .toThrow('超出大小限制');
  });

  it('cleanupStaleTaskWorkspaces 清理过期任务目录', () => {
    const oldPaths = createTaskWorkspace(tempDir, 'tsk_old', {});
    const newPaths = createTaskWorkspace(tempDir, 'tsk_new', {});
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(oldPaths.root, oldTime, oldTime);

    const removed = cleanupStaleTaskWorkspaces(tempDir, 5_000);

    expect(removed).toContain(oldPaths.root);
    expect(existsSync(oldPaths.root)).toBe(false);
    expect(existsSync(newPaths.root)).toBe(true);
  });
});
