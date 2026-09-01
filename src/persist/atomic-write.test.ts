/**
 * L1 persist — 原子写公共件测试（契约篇 §1.5.1(b)）。
 * 断言面：内容完整落盘 / 无临时残骸 / 覆盖整体替换 / 失败路径清理且目标不被碰。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeAtomicBuffer, writeAtomicFile } from './atomic-write.js';

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

  it('Buffer 形：字节完整落盘零残骸 + 覆盖整体替换（成熟度扫描 20260901 P1-6——checkpoint blob 仓首位消费面）', () => {
    const dir = makeDir();
    const target = join(dir, 'blob-payload');
    // 含非 UTF-8 安全字节的二进制内容（字符串形态会丢/转——Buffer 形的存在依据）
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a, 0xd8]);
    writeAtomicBuffer(target, content);
    // 逐字节一致（equals 全量比对）
    expect(readFileSync(target).equals(content)).toBe(true);
    // 覆盖替换语义同 string 形：新 Buffer 整体替换旧内容
    const second = Buffer.from([0x00, 0x01, 0x02]);
    writeAtomicBuffer(target, second);
    expect(readFileSync(target).equals(second)).toBe(true);
    expect(readdirSync(dir)).toEqual(['blob-payload']); // 两轮写零残骸
  });
});
