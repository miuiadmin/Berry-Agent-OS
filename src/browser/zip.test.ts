/**
 * L3 browser 手写 zip 读取器测试 — 解包正路径 + 拒载面全谱回归锁
 * （契约篇 §6.10「解包」段，第五十四批刀三余量）。
 *
 * 测试自构 zip 字节（local header + central directory + EOCD 三段全手写，
 * zlib 仅出 deflate 数据与 crc32——读取器面对的是真二进制结构非 mock）。
 */

import { access, constants, lstat, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32, deflateRawSync } from 'node:zlib';
import { AppError, BROWSER_INSTALL_FAILED } from '../contracts/errors.js';
import { extractZip } from './zip.js';

/* ---------------- 手构 zip 写入器（测试面专用） ---------------- */

/** 条目规格（externalAttr 高 16 位 unix mode 由调用方预移位） */
interface EntrySpec {
  readonly name: string;
  /** 未压缩数据（目录条目空；symlink 条目 = 目标路径 UTF-8） */
  readonly data?: Buffer;
  /** 压缩法（0 store / 8 deflate——白名单外值留给拒载测试） */
  readonly method?: number;
  /** external attributes（unix mode << 16 | DOS 位） */
  readonly externalAttr?: number;
  /** general purpose bit flags（bit 0 = 加密——拒载测试用） */
  readonly flags?: number;
}

/** 三段式 zip 构造（local + central directory + EOCD——偏移全真） */
function buildZip(specs: readonly EntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0; // local 区游标（条目数据后的下一偏移）
  for (const s of specs) {
    const nameBuf = Buffer.from(s.name, 'utf8');
    const raw = s.data ?? Buffer.alloc(0);
    const stored = s.method === 8 ? deflateRawSync(raw) : raw;
    const checksum = crc32(raw) >>> 0;
    const method = s.method ?? 0;
    const flags = s.flags ?? 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header 签名
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0x6020, 10); // 修改时间（任意合法值）
    lh.writeUInt16LE(0x5a21, 12); // 修改日期
    lh.writeUInt32LE(checksum, 14);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // local extra 长（0——读取器须按 local 自身值跳）
    locals.push(lh, nameBuf, stored);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory 签名
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0x6020, 12);
    ch.writeUInt16LE(0x5a21, 14);
    ch.writeUInt32LE(checksum, 16);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // CD extra 长
    ch.writeUInt16LE(0, 32); // 条目注释长
    ch.writeUInt16LE(0, 34); // 起始盘号
    ch.writeUInt16LE(0, 36); // internal attributes
    ch.writeUInt32LE(s.externalAttr ?? 0, 38);
    ch.writeUInt32LE(offset, 42); // local header 偏移
    centrals.push(ch, nameBuf);

    offset += 30 + nameBuf.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // 起始盘号
  eocd.writeUInt16LE(0, 6); // CD 起始盘号
  eocd.writeUInt16LE(specs.length, 8); // 本盘条目数
  eocd.writeUInt16LE(specs.length, 10); // 总条目数
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16); // CD 起始偏移 = local 区总长
  eocd.writeUInt16LE(0, 20); // 尾注释长
  return Buffer.concat([...locals, cd, eocd]);
}

/** unix mode → external attributes（高 16 位——S_IFREG/S_IFLNK 前缀全真；>>>0 归一无符号） */
function attrOf(mode: number): number {
  return (((mode << 16) | 0x20) >>> 0) as number; // 低 16 位 DOS 归档位（常见形态）
}

/** 断言以 BROWSER_INSTALL_FAILED 拒绝（统一装箱错误码） */
function expectZipFail(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => {
      throw new Error('期望抛 AppError(BROWSER_INSTALL_FAILED)');
    },
    (err) => {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(BROWSER_INSTALL_FAILED);
    },
  );
}

/* ---------------- 测试目录 ---------------- */

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'berry-zip-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 在场判定（半解包清理断言用） */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 落 zip 档并返回解包目标目录（每测独立子目录防串扰） */
async function writeZip(label: string, bytes: Buffer): Promise<{ zipPath: string; dest: string }> {
  const zipPath = join(dir, `${label}.zip`);
  await writeFile(zipPath, bytes);
  return { zipPath, dest: join(dir, `${label}-out`) };
}

/* ---------------- 正路径：混合档案全谱 ---------------- */

describe('extractZip 解包', () => {
  it('混合档案：目录/store/deflate/symlink/权限恢复 + 回执计数', async () => {
    const deflatable = Buffer.from('chrome payload 行文本。'.repeat(200), 'utf8'); // 可压缩体
    const bytes = buildZip([
      { name: 'chrome-mac-arm64/', externalAttr: attrOf(0o040755) }, // 目录条目（名以 / 结尾）
      { name: 'chrome-mac-arm64/README', data: Buffer.from('readme', 'utf8'), externalAttr: attrOf(0o100644) },
      {
        name: 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        data: Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x01]),
        method: 8, // deflate（mach-o 头假体）
        externalAttr: attrOf(0o100755),
      },
      {
        name: 'chrome-mac-arm64/ Versions/Framework',
        data: Buffer.from('lib', 'utf8'),
        externalAttr: attrOf(0o120777),
      }, // symlink（S_IFLNK）
      { name: 'chrome-mac-arm64/noattr', data: Buffer.from('x', 'utf8'), externalAttr: 0 }, // mode 缺席 → 保 0o644
    ]);
    const { zipPath, dest } = await writeZip('mixed', bytes);
    const result = await extractZip(zipPath, dest);

    expect(result).toEqual({ files: 3, symlinks: 1, directories: 1 });
    // store 内容逐字节等
    expect((await readFile(join(dest, 'chrome-mac-arm64/README'))).toString('utf8')).toBe('readme');
    // deflate 还原
    expect(
      await readFile(
        join(dest, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      ),
    ).toEqual(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x01]));
    // symlink：链而非普通档 + 目标路径即数据区内容
    expect((await lstat(join(dest, 'chrome-mac-arm64/ Versions/Framework'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(dest, 'chrome-mac-arm64/ Versions/Framework'))).toBe('lib');
    // unix 权限恢复：755 执行位 / 644 / mode 缺席保底
    expect((await stat(join(dest, 'chrome-mac-arm64/README'))).mode & 0o777).toBe(0o644);
    expect(
      (
        await stat(
          join(dest, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        )
      ).mode & 0o777,
    ).toBe(0o755);
    expect((await stat(join(dest, 'chrome-mac-arm64/noattr'))).mode & 0o777).toBe(0o644);
  });

  it('幂等重装：同档二次解包覆盖旧链旧档不炸（symlink rm force 先清）', async () => {
    const bytes = buildZip([{ name: 'top/link', data: Buffer.from('t.txt', 'utf8'), externalAttr: attrOf(0o120777) }]);
    const { zipPath, dest } = await writeZip('idem', bytes);
    await extractZip(zipPath, dest);
    await expect(extractZip(zipPath, dest)).resolves.toEqual({ files: 0, symlinks: 1, directories: 0 });
  });
});

/* ---------------- 拒载面（fail-loud + 半解包清理） ---------------- */

describe('extractZip 拒载面', () => {
  it('加密 zip（flags bit 0）→ 拒载 + destDir 整删（不留半态）', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: Buffer.from('x'), flags: 0x1 }]);
    const { zipPath, dest } = await writeZip('enc', bytes);
    await expectZipFail(extractZip(zipPath, dest));
    expect(await exists(dest)).toBe(false);
  });

  it('zip64 locator 在场 → 拒载（EOCD 前 20 字节签名形态）', async () => {
    const base = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); // zip64 EOCD locator 签名
    // 把 locator 插进 CD 与 EOCD 之间（EOCD 尾扫仍命中，前置 20 字节即 locator 位）
    const eocd = base.subarray(base.length - 22);
    const spliced = Buffer.concat([base.subarray(0, base.length - 22), locator, eocd]);
    const { zipPath, dest } = await writeZip('z64loc', spliced);
    await expectZipFail(extractZip(zipPath, dest));
    expect(await exists(dest)).toBe(false);
  });

  it('EOCD 条目数溢出标记 0xFFFF → 拒载（按标记非按尺寸归因）', async () => {
    const base = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    base.writeUInt16LE(0xffff, base.length - 22 + 10); // EOCD+10 = 总条目数位
    const { zipPath, dest } = await writeZip('z64cnt', base);
    await expectZipFail(extractZip(zipPath, dest));
  });

  it('压缩法白名单外（method 12 bzip2）→ 拒载 + 半解包清理', async () => {
    const bytes = buildZip([{ name: 'a.txt', data: Buffer.from('x'), method: 12 }]);
    const { zipPath, dest } = await writeZip('m12', bytes);
    await expectZipFail(extractZip(zipPath, dest));
    expect(await exists(dest)).toBe(false);
  });

  it('zip slip：`..` 段条目名 → 拒载 + 目标文件不落地 + destDir 整删', async () => {
    const bytes = buildZip([{ name: '../evil.txt', data: Buffer.from('pwned') }]);
    const { zipPath, dest } = await writeZip('slip', bytes);
    await expectZipFail(extractZip(zipPath, dest));
    expect(await exists(dest)).toBe(false);
    expect(await exists(join(dir, 'evil.txt'))).toBe(false); // 逃逸目标未落地
  });

  it('条目名含反斜杠（跨平台逃逸形）→ 拒载', async () => {
    const bytes = buildZip([{ name: 'a\\..\\b.txt', data: Buffer.from('x') }]);
    const { zipPath, dest } = await writeZip('bslash', bytes);
    await expectZipFail(extractZip(zipPath, dest));
  });

  it('EOCD 未找到（尾窗无签名）→ 拒载', async () => {
    const bytes = Buffer.from('这不是一个 zip 档——纯文本噪声。');
    const { zipPath, dest } = await writeZip('noeocd', bytes);
    await expectZipFail(extractZip(zipPath, dest));
  });

  it('条目数据区越界（CD compressedSize 虚报超出档尾）→ 拒载', async () => {
    const base = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    // CD 第一条 compressedSize 位（CD 起点 = 总长 - 22 - CD 长；46 头 +20 偏移）
    const cdStart = base.length - 22 - (46 + 5); // 5 = 'a.txt' 名长
    base.writeUInt32LE(9_999, cdStart + 20); // 虚报压缩尺寸 → dataEnd 越界
    const { zipPath, dest } = await writeZip('oob', base);
    await expectZipFail(extractZip(zipPath, dest));
  });

  it('local header 签名错位 → 拒载（数据区定位防线）', async () => {
    const base = buildZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    base.writeUInt32LE(0xdeadbeef, 0); // 打坏首条 local 签名
    const { zipPath, dest } = await writeZip('badloc', base);
    await expectZipFail(extractZip(zipPath, dest));
  });
});
