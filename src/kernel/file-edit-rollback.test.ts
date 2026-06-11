/**
 * 13.0 §13.7: 文件回滚机制单元测试。
 *
 * 验证 recordMutation / rollbackTask / commitTask 的核心行为：
 * - 写入前备份旧内容
 * - 回滚按写入倒序恢复（最后写的最先回滚）
 * - 新建文件（旧内容 null）回滚时删除
 * - commit 后清除备份
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setAppHome } from '../utils/paths.js';
import {
  setCurrentTask,
  clearCurrentTask,
  recordMutation,
  rollbackTask,
  commitTask,
  hasMutations,
} from './file-edit-rollback.js';

let tmpHome: string;
let workDir: string;

beforeEach(() => {
  // 隔离的 app home（备份目录）+ 工作目录（被改文件）
  tmpHome = mkdtempSync(join(tmpdir(), 'rollback-home-'));
  workDir = mkdtempSync(join(tmpdir(), 'rollback-work-'));
  setAppHome(tmpHome);
  clearCurrentTask();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe('file-edit-rollback §13.7', () => {
  it('写入前备份旧内容，回滚恢复到原始', async () => {
    const file = join(workDir, 'a.ts');
    writeFileSync(file, 'original');
    await setCurrentTask('t1');
    // 模拟 write_file：先备份，再写入新内容
    await recordMutation(file);
    writeFileSync(file, 'modified');
    expect(readFileSync(file, 'utf-8')).toBe('modified');

    const result = await rollbackTask('t1');
    expect(result.restored).toBe(1);
    expect(result.failed).toBe(0);
    expect(readFileSync(file, 'utf-8')).toBe('original');
  });

  it('新建文件（旧内容 null）回滚后删除', async () => {
    const file = join(workDir, 'new.ts');
    await setCurrentTask('t2');
    await recordMutation(file); // 文件不存在 → oldContent=null
    writeFileSync(file, 'created');
    expect(existsSync(file)).toBe(true);

    const result = await rollbackTask('t2');
    expect(result.restored).toBe(1);
    expect(existsSync(file)).toBe(false); // 新建文件被删除
  });

  it('多次修改同一文件：倒序回滚恢复到最初状态', async () => {
    const file = join(workDir, 'multi.ts');
    writeFileSync(file, 'v0');
    await setCurrentTask('t3');
    // 第一次改：v0 → v1
    await recordMutation(file);
    writeFileSync(file, 'v1');
    // 第二次改：v1 → v2
    await recordMutation(file);
    writeFileSync(file, 'v2');
    expect(readFileSync(file, 'utf-8')).toBe('v2');

    const result = await rollbackTask('t3');
    expect(result.restored).toBe(2);
    // 倒序：先恢复 v1，再恢复 v0 → 最终 v0
    expect(readFileSync(file, 'utf-8')).toBe('v0');
  });

  it('commitTask 正常完成后清除备份，无法再回滚', async () => {
    const file = join(workDir, 'c.ts');
    writeFileSync(file, 'orig');
    await setCurrentTask('t4');
    await recordMutation(file);
    writeFileSync(file, 'changed');
    expect(await hasMutations('t4')).toBe(true);

    await commitTask('t4');
    expect(await hasMutations('t4')).toBe(false);

    // commit 后再回滚：无备份记录，restored=0
    const result = await rollbackTask('t4');
    expect(result.restored).toBe(0);
    // 文件保持 changed（未被回滚）
    expect(readFileSync(file, 'utf-8')).toBe('changed');
  });

  it('无当前 task 上下文时 recordMutation 静默跳过（向后兼容）', async () => {
    clearCurrentTask();
    const file = join(workDir, 'noctx.ts');
    await recordMutation(file); // 无 task 上下文，不报错
    writeFileSync(file, 'x');
    // 无备份可回滚
    const result = await rollbackTask('no-such-task');
    expect(result.restored).toBe(0);
  });
});
