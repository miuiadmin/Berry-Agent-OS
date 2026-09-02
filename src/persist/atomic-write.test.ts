/**
 * L1 persist — 原子写公共件测试（契约篇 §1.5.1(b)）。
 * 断言面：内容完整落盘 / 无临时残骸 / 覆盖整体替换 / 失败路径清理且目标不被碰；
 * 盘满形态注入（ENOSPC 物理故障路径——成熟度扫描 20260901 P1-7）。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeAtomicBuffer, writeAtomicFile } from './atomic-write.js';

/** 临时测试目录（realpath 归一——macOS /var 与 /private/var 差异教训） */
function makeDir(): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'persist-atomic-')));
}

/* ── 盘满注入台（成熟度扫描 20260901 P1-7）──────────────────────────────
 * 物理故障路径回归锁：真盘满时 writeSync/fsyncSync 抛 ENOSPC——本文件用
 * vi.mock 只覆写这两个成员（其余成员透传真实现，本文件自用的 readdir/
 * readFileSync 等断言面不受影响），钉死三不变式：错误原样上抛（fail-loud
 * 不改炸不吞不换）、临时文件清理（不留半写垃圾）、目标保持旧内容（rename
 * 从未发生——盘满不毁已有数据）。
 */
const enospc = vi.hoisted(() => ({
  /** 注入位点：'' 关（全部真实现）| 'write'（writeSync 抛）| 'fsync'（fsyncSync 抛） */
  fail: '' as '' | 'write' | 'fsync',
  /** 注入实际触发次数（防假绿锚：断言命中数证明故障真注入过、非平空跑绿） */
  calls: 0,
  /** 最近一次注入的错误实例（身份比对——上抛的必须是同一个错误对象） */
  lastError: null as Error | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  /** 造 ENOSPC 形错误（Node 磁盘满物理形态：code/errno 对齐 libuv 值 -28） */
  const shaped = (): Error =>
    Object.assign(new Error('mock 磁盘满：no space left on device'), { code: 'ENOSPC', errno: -28 });
  return {
    ...real,
    writeSync: ((...args: unknown[]) => {
      if (enospc.fail === 'write') {
        enospc.calls++;
        enospc.lastError = shaped();
        throw enospc.lastError;
      }
      return (real.writeSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof real.writeSync,
    fsyncSync: ((fd: number) => {
      if (enospc.fail === 'fsync') {
        enospc.calls++;
        enospc.lastError = shaped();
        throw enospc.lastError;
      }
      return (real.fsyncSync as (f: number) => void)(fd);
    }) as typeof real.fsyncSync,
  };
});

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

describe('盘满形态注入（ENOSPC 物理故障路径——成熟度扫描 20260901 P1-7）', () => {
  // 每例收尾关注入（防串染本文件其余用例——flag 关 = 全部真实现）
  afterEach(() => {
    enospc.fail = '';
    enospc.calls = 0;
    enospc.lastError = null;
  });

  it('fsyncSync 抛 ENOSPC（string 形）：错误原样上抛 + 临时残骸清理 + 目标保持旧内容', () => {
    const dir = makeDir();
    const target = join(dir, 'overlay.yaml');
    writeAtomicFile(target, '旧内容 v1'); // 注入关闭态先落一份真实旧内容
    enospc.fail = 'fsync';
    let caught: unknown;
    try {
      writeAtomicFile(target, '新内容 v2'); // fsync 位点失败（内容已写临时文件、rename 未发生）
    } catch (err) {
      caught = err;
    }
    // fail-loud：上抛的就是注入的那个错误对象（身份不改炸、不吞不换皮）
    expect(caught).toBe(enospc.lastError);
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(enospc.calls).toBe(1); // 防假绿锚：故障真注入过
    // 临时文件清理：目录里只有目标文件，无 .tmp 半写残骸
    expect(readdirSync(dir)).toEqual(['overlay.yaml']);
    // 目标保持旧内容——rename 从未发生，盘满不毁已有数据
    expect(readFileSync(target, 'utf8')).toBe('旧内容 v1');
  });

  it('writeSync 抛 ENOSPC（Buffer 形——checkpoint blob 半写形态）：同清理同保持 + 解除后重写成功', () => {
    const dir = makeDir();
    const target = join(dir, 'blob-payload');
    const oldBytes = Buffer.from([0x01, 0x02, 0x03]);
    writeAtomicBuffer(target, oldBytes);
    enospc.fail = 'write';
    let caught: unknown;
    try {
      writeAtomicBuffer(target, Buffer.from([0xaa, 0xbb])); // 写入位点失败（临时文件半写）
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(enospc.lastError);
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(enospc.calls).toBe(1);
    expect(readdirSync(dir)).toEqual(['blob-payload']); // 零 .tmp 残骸（force 清半写）
    expect(readFileSync(target).equals(oldBytes)).toBe(true); // 旧字节原样
    // 盘满解除后重写成功：新临时文件 'wx' 新 UUID 不撞旧残骸名——恢复路径
    enospc.fail = '';
    writeAtomicBuffer(target, Buffer.from([0xcc]));
    expect(readFileSync(target).equals(Buffer.from([0xcc]))).toBe(true);
    expect(readdirSync(dir)).toEqual(['blob-payload']); // 仍零残骸
  });
});
