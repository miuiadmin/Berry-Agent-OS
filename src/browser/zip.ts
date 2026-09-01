/**
 * L3 browser — 手写最小 zip 读取器（契约篇 §6.10「解包」段，第五十四批
 * 刀三余量——零新依赖，CDP 手写桥同精神）。
 *
 * 结构面：EOCD 定位（尾部签名扫描，fd 只读尾窗）→ central directory 条目
 * 解析（文件名/压缩法/两 size/local offset/external attributes——CD 区域
 * 有 65535 条帽 ≈ 数 MB 上界）→ local file header 跳过（**按其自身
 * nlen/elen**——local 与 central 的 extra 字段长度可不同，按 CD 长度跳会
 * 错位）→ 数据区。
 *
 * 压缩法两档：store 直拷 / deflate（node:zlib createInflateRaw）——逐条目
 * createReadStream(start,end) 起流，**zip 整档不进内存**（200MB 级装机物）。
 *
 * symlink 条目（external_attr 高 16 位 S_IFLNK——mac app bundle 实测 5 条，
 * Chrome.framework 常态结构）：数据区内容 = 目标路径 → fs.symlink 创建
 * （写成普通文件必坏 framework 结构——冷读 blocker 修死）。
 *
 * 拒载面 fail-loud（BROWSER_INSTALL_FAILED）：加密 zip（flags bit 0）/
 * zip64（locator 在场、条目数/CD offset·size 溢出标记——判据按标记非按
 * 条目尺寸归因）/ 压缩法白名单外 / 路径逃逸（`..`/绝对名——zip slip
 * 经典攻击面）。unix 权限恢复（external_attr 高 16 位 mode 应用）。
 *
 * 失败清理：半解包目录整体删除（fail-loud 不留半态——规范钉死）。
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rm, symlink } from 'node:fs/promises';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { AppError, BROWSER_INSTALL_FAILED } from '../contracts/errors.js';

/* ---------------- zip 结构常量（PKWARE APPNOTE 固定签名/偏移） ---------------- */

/** EOCD（End of Central Directory）签名 */
const EOCD_SIG = 0x06054b50;
/** zip64 EOCD locator 签名（在场即拒——>4GB/65535 条目形态 CfT 结构性不达） */
const ZIP64_LOCATOR_SIG = 0x07064b50;
/** central directory 文件头签名 */
const CEN_SIG = 0x02014b50;
/** local file header 签名 */
const LOC_SIG = 0x04034b50;
/** EOCD 尾部最大搜索窗（22 字节固定头 + 65535 注释帽） */
const EOCD_SCAN_WINDOW = 22 + 65_535;

/** central directory 条目（解析产物——逐条解包的元数据源） */
interface CenEntry {
  /** 条目名（UTF-8——目录条目以 / 结尾） */
  readonly name: string;
  /** 压缩法（0 = store / 8 = deflate——白名单外拒载） */
  readonly method: number;
  /** 压缩后字节数（数据区长度——data descriptor 形态也以 CD 为准） */
  readonly compressedSize: number;
  /** general purpose bit flags（bit 0 = 加密拒载） */
  readonly flags: number;
  /** local file header 的文件内偏移 */
  readonly localOffset: number;
  /** external attributes（高 16 位 = unix mode——symlink 判定与权限恢复源） */
  readonly externalAttr: number;
}

/** 解包产物（回执——install 锁档/notify 面） */
export interface ExtractResult {
  /** 普通文件条数 */
  readonly files: number;
  /** symlink 条数（mac framework 常态结构） */
  readonly symlinks: number;
  /** 目录条数 */
  readonly directories: number;
}

/** 装箱错误（统一 BROWSER_INSTALL_FAILED——message 载细节） */
function zipFail(detail: string): AppError {
  return new AppError(BROWSER_INSTALL_FAILED, `zip 解包失败：${detail}`);
}

/**
 * 解包主口（install.ts 消费——zipPath → destDir 全量展开）。
 * 任一条目失败 = 整体失败：半解包目录删除后 throw（不留半态）。
 */
export async function extractZip(zipPath: string, destDir: string): Promise<ExtractResult> {
  const { entries, fileSize } = await parseCentralDirectory(zipPath);

  let files = 0;
  let symlinks = 0;
  let directories = 0;
  const rooted = resolve(destDir);
  try {
    for (const entry of entries) {
      // 路径逃逸拒载（zip slip——`..` 段/绝对名/盘符形一律 fail-loud）
      const target = safeJoin(rooted, entry.name);
      const mode = unixModeOf(entry.externalAttr);

      if (entry.name.endsWith('/')) {
        // 目录条目（名以 / 结尾——mkdir 递归幂等）
        await mkdir(target, { recursive: true });
        directories += 1;
        continue;
      }
      // 数据区起点：local header 自身 nlen/elen（与 CD 记录可不同——错位即坏档）
      const dataStart = await locateDataStart(zipPath, entry.localOffset, entry.name);
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > fileSize) throw zipFail(`条目 ${entry.name} 数据区越界（${dataEnd} > ${fileSize}）`);
      await mkdir(dirname(target), { recursive: true });

      if ((mode & 0o170000) === 0o120000) {
        // symlink 条目：数据区内容 = 目标路径（小体量整读）
        const linkTarget = await readRange(zipPath, dataStart, dataEnd).then((b) => b.toString('utf8'));
        await rm(target, { force: true }); // 幂等重装：旧链/旧档先清
        await symlink(linkTarget, target);
        symlinks += 1;
        continue;
      }

      // 普通文件：两档压缩法流式落盘（createReadStream 区间起流——整档不进内存）
      const source = createReadStream(zipPath, { start: dataStart, end: dataEnd - 1 });
      if (entry.method === 0) {
        await pipeline(source, createWriteStream(target));
      } else if (entry.method === 8) {
        await pipeline(source, createInflateRaw(), createWriteStream(target));
      } else {
        throw zipFail(`条目 ${entry.name} 压缩法 ${entry.method} 不在白名单（0 store / 8 deflate）`);
      }
      // unix 权限恢复（external_attr 高 16 位；缺席/0 时保 0o644——执行位由 install 布局面补）
      const applied = mode === 0 ? 0o644 : mode & 0o7777;
      await chmod(target, applied);
      files += 1;
    }
  } catch (err) {
    // 半解包清理（fail-loud 不留半态）——原始错误上抛，清理失败不吞主因
    await rm(rooted, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { files, symlinks, directories };
}

/** EOCD + central directory 解析（fd 分区读取——尾窗 + CD 区域，内存有界） */
async function parseCentralDirectory(zipPath: string): Promise<{ entries: CenEntry[]; fileSize: number }> {
  const fh = await open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    // 尾窗读取（EOCD 扫描面——注释区变长故取整窗）
    const windowLen = Math.min(size, EOCD_SCAN_WINDOW);
    const tail = Buffer.alloc(windowLen);
    await fh.read(tail, 0, windowLen, size - windowLen);

    // EOCD 倒扫签名（从最后一个可能位起——注释只能更短不会更长）
    let eocd = -1;
    for (let i = windowLen - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw zipFail('EOCD 未找到（非 zip 或损坏）');

    // zip64 拒载面：locator 在场 / 计数·偏移溢出标记（0xFFFF/0xFFFFFFFF）任一即拒
    const locatorPos = eocd - 20; // zip64 EOCD locator 紧邻 EOCD 之前（20 字节固定长）
    if (locatorPos >= 0 && tail.readUInt32LE(locatorPos) === ZIP64_LOCATOR_SIG) {
      throw zipFail('zip64 形态拒载（CfT 量级结构性不达——条目数/尺寸溢出 32 位标记）');
    }
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw zipFail('zip64 溢出标记在场（条目数/CD 尺寸/偏移）——拒载');
    }
    const cdAbs = size - windowLen + eocd; // EOCD 在文件内的绝对偏移
    if (cdOffset + cdSize > cdAbs) throw zipFail(`central directory 越界（${cdOffset}+${cdSize} > EOCD@${cdAbs}）`);

    // CD 区域整读（65535 条帽 × ~100B ≈ 数 MB 上界——有界）
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    // 逐条目解析（46 字节固定头 + 变长名/extra/注释）
    const entries: CenEntry[] = [];
    let pos = 0;
    for (let i = 0; i < totalEntries; i += 1) {
      if (pos + 46 > cdSize) throw zipFail(`central directory 第 ${i} 条头越界`);
      if (cd.readUInt32LE(pos) !== CEN_SIG) throw zipFail(`central directory 第 ${i} 条签名错位`);
      const flags = cd.readUInt16LE(pos + 8);
      if ((flags & 0x1) !== 0) throw zipFail('加密 zip 拒载（general purpose bit 0）');
      const method = cd.readUInt16LE(pos + 10);
      const compressedSize = cd.readUInt32LE(pos + 20);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      const externalAttr = cd.readUInt32LE(pos + 38);
      const localOffset = cd.readUInt32LE(pos + 42);
      const name = cd.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
      entries.push({ name, method, compressedSize, flags, localOffset, externalAttr });
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, fileSize: size };
  } finally {
    await fh.close();
  }
}

/** local header 定位数据区起点（按其自身 nlen/elen——与 CD 记录可不同） */
async function locateDataStart(zipPath: string, localOffset: number, name: string): Promise<number> {
  const head = await readRange(zipPath, localOffset, localOffset + 30);
  if (head.readUInt32LE(0) !== LOC_SIG) throw zipFail(`条目 ${name} local header 签名错位`);
  const nlen = head.readUInt16LE(26);
  const elen = head.readUInt16LE(28);
  return localOffset + 30 + nlen + elen;
}

/** 小区间整读（symlink 目标/local header 元数据——体量有界的元数据位专用） */
async function readRange(zipPath: string, start: number, end: number): Promise<Buffer> {
  const fh = await open(zipPath, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    await fh.read(buf, 0, end - start, start);
    return buf;
  } finally {
    await fh.close();
  }
}

/** zip slip 防线：条目名 join 后必须仍在 destDir 内（`..` 段/绝对名/盘符形全拒） */
function safeJoin(rooted: string, name: string): string {
  if (name.includes('\\')) throw zipFail(`条目名含反斜杠（跨平台逃逸形拒载）：${name}`);
  const segments = name.split('/');
  if (segments.includes('..') || isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
    throw zipFail(`条目名路径逃逸拒载：${name}`);
  }
  const target = join(rooted, name);
  if (target !== rooted && !target.startsWith(rooted + '/')) {
    throw zipFail(`条目名解析逃逸拒载：${name}`);
  }
  return target;
}

/** external_attr 高 16 位 unix mode 提取（低 16 位 DOS 属性不消费） */
function unixModeOf(externalAttr: number): number {
  return (externalAttr >>> 16) & 0xffff;
}
