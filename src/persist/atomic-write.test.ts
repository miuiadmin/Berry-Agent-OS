/**
 * L1 persist — 原子写公共件测试（契约篇 §1.5.1(b)）。
 * 断言面：内容完整落盘 / 无临时残骸 / 覆盖整体替换 / 失败路径清理且目标不被碰。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeAtomicFile } from './atomic-write.js';

/** 临时测试目录（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'persist-atomic-')));
}

describe('writeAtomicFile 原子写公共件', () => {
  it('写入成功：内容完整落盘、目录无 .tmp 残留', () => {
    const dir = makeDir();
    const target = join(dir, 'overlay.yaml');
    writeAtomicFile(target, 'rows: []\n');
    expect(readFileSync(target, 'utf8')).toBe('rows: []\n');
    // rename 语义：临时文件已消失，目录里只有目标文件
    expect(readdirSync(dir)).toEqual(['overlay.yaml']);
  });

  it('覆盖写：旧内容整体替换——不存在「半新半旧」中间态文件', () => {
    const dir = makeDir();
    const target = join(dir, 'data.json');
    writeAtomicFile(target, '{"v":1}');
    writeAtomicFile(target, '{"v":2}');
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}');
    expect(readdirSync(dir)).toEqual(['data.json']); // 两轮写零残骸
  });

  it('失败路径：rename 撞现存目录抛错——临时文件被清理、目标保持原样', () => {
    const dir = makeDir();
    // 目标占位为目录：rename(文件→目录) 在 POSIX 必抛（EISDIR/ENOTEMPTY）
    const target = join(dir, 'occupied');
    mkdirSync(target);
    expect(() => writeAtomicFile(target, 'x')).toThrowError();
    // 临时文件已清（不留半写垃圾）、目标未被碰（仍是目录）
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(statSync(target).isDirectory()).toBe(true);
  });
});
