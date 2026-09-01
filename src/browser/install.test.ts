/**
 * L3 browser 引擎装机编排测试 — installEngine 全链回归锁（契约篇 §6.10
 * 「引擎下载装机」段，第五十四批刀三余量）。
 *
 * 外部边界全注假：manifestFetch（清单 JSON）/ download（写真 zip 档）。
 * 解包器/锁档/布局表/发现序全真——端到端走到 discoverEngine 命中
 * source='downloaded'（③ 下载引擎位与装机产物的闭环自证）。
 */

import { access, constants, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { AppError, BROWSER_INSTALL_FAILED } from '../contracts/errors.js';
import { discoverEngine } from './discover.js';
import { CFT_ALLOWED_HOSTS, installEngine, platformSlotOf, type InstallDeps } from './install.js';

/* ---------------- 手构最小 zip（装机布局面专用——只 store 一条） ---------------- */

/** 单条 store 条目 zip（布局尾件可执行体假体） */
function singleEntryZip(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const checksum = crc32(data) >>> 0;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6); // flags
  lh.writeUInt16LE(0, 8); // store
  lh.writeUInt32LE(checksum, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0, 8); // flags
  ch.writeUInt16LE(0, 10); // method store
  ch.writeUInt32LE(checksum, 16);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 普通档 644（chmod 面由 install 补 755）
  ch.writeUInt32LE(0, 42); // local offset 0
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
  return Buffer.concat([lh, nameBuf, data, ch, nameBuf, eocd]);
}

/* ---------------- 假外部边界 ---------------- */

/** 装机版本（四段式假体） */
const VERSION = '138.0.7204.4';
/** mac-arm64 布局尾件（discover.ts ENGINE_LAYOUTS 首条同串） */
const LAYOUT_TAIL = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
/** 假清单（with-downloads 形——Stable 通道 mac-arm64 直给 URL） */
const MANIFEST = JSON.stringify({
  channels: {
    Stable: {
      version: VERSION,
      downloads: { chrome: [{ platform: 'mac-arm64', url: 'https://storage.googleapis.com/cft/z.zip' }] },
    },
  },
});

/** 假 manifestFetch（清单腿——记 caller 供归因断言） */
function fakeManifest(calls: string[], res = { status: 200, text: MANIFEST, truncated: false }) {
  return async (url: string, opts?: { caller?: string }) => {
    calls.push(`${opts?.caller ?? '?'} ${url}`);
    return res;
  };
}

/** 假 download（写真 zip 档 + 记调用——下载腿外部边界） */
function fakeDownload(
  zipBytes: Buffer,
  calls: Array<{ url: string; destPath: string; allowedHosts: readonly string[] }>,
) {
  return async (url: string, opts: { destPath: string; allowedHosts: readonly string[]; caller?: string }) => {
    await writeFile(opts.destPath, zipBytes);
    calls.push({ url, destPath: opts.destPath, allowedHosts: opts.allowedHosts });
    return {
      finalUrl: url,
      bytes: zipBytes.byteLength,
      sha256: 'ab12cd34ef56', // 假体回执——锁档记档面（不对照远端）
    };
  };
}

/** 在场判定 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 断言以 BROWSER_INSTALL_FAILED 拒绝 */
function expectInstallFail(promise: Promise<unknown>): Promise<void> {
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

let dataDir: string;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'berry-install-'));
});
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/* ---------------- 装机全链 ---------------- */

describe('installEngine 装机编排', () => {
  it('端到端：清单解析 → 下载（白名单注入）→ 解包 → chmod 755 → 锁档 → zip 即清；发现序命中 downloaded', async () => {
    const zipBytes = singleEntryZip(LAYOUT_TAIL, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    const dlCalls: Array<{ url: string; destPath: string; allowedHosts: readonly string[] }> = [];
    const manifestCalls: string[] = [];
    const deps: InstallDeps = {
      manifestFetch: fakeManifest(manifestCalls),
      download: fakeDownload(zipBytes, dlCalls),
      dataDir,
    };

    const report = await installEngine(deps, { platform: 'darwin', arch: 'arm64' });

    // 清单腿归因（caller 注入——logger 面之外的测试锚）
    expect(manifestCalls[0]).toContain('browser-install');
    // 下载腿：URL 直给免拼装 + 白名单 = CfT 两域 + 目标在 engine/ 下
    expect(dlCalls).toHaveLength(1);
    expect(dlCalls[0]!.url).toBe('https://storage.googleapis.com/cft/z.zip');
    expect(dlCalls[0]!.allowedHosts).toEqual(CFT_ALLOWED_HOSTS);
    expect(dlCalls[0]!.destPath).toBe(join(dataDir, 'browser', 'engine', `${VERSION}.zip`));

    // 回执：版本/平台档位/引擎路径/已装标注
    expect(report.version).toBe(VERSION);
    expect(report.slot).toEqual(platformSlotOf('darwin', 'arm64'));
    expect(report.alreadyInstalled).toBe(false);
    expect(report.enginePath).toBe(join(dataDir, 'browser', 'engine', VERSION, LAYOUT_TAIL));
    expect(report.sha256).toBe('ab12cd34ef56');
    expect(report.bytes).toBe(zipBytes.byteLength);

    // 解包产物 + chmod 755（zip 内 644 → install 布局面补执行位——发现序 X_OK 的双保险）
    const engineFile = join(dataDir, 'browser', 'engine', VERSION, LAYOUT_TAIL);
    expect(await exists(engineFile)).toBe(true);
    expect((await stat(engineFile)).mode & 0o777).toBe(0o755);

    // 锁档 install.json（幂等判据 + 人工核对档——六字段全落）
    const lock = JSON.parse(await readFile(join(dataDir, 'browser', 'engine', VERSION, 'install.json'), 'utf8'));
    expect(lock).toMatchObject({
      version: VERSION,
      platform: 'mac-arm64',
      sha256: 'ab12cd34ef56',
      bytes: zipBytes.byteLength,
      url: 'https://storage.googleapis.com/cft/z.zip',
    });
    expect(typeof lock.installedAt).toBe('string');
    // zip 即用即清（tarball 自锁先例）
    expect(await exists(join(dataDir, 'browser', 'engine', `${VERSION}.zip`))).toBe(false);

    // 发现序闭环：③ 下载引擎位命中（系统位注入空表隔离真机 Chrome）
    const found = discoverEngine({}, join(dataDir, 'browser', 'engine'), { systemPaths: [], pathEnv: '' });
    expect(found.source).toBe('downloaded');
    expect(found.path).toBe(engineFile);
    expect(found.fallbackWarning).toContain('/browser install');
  });

  it('幂等：同版本锁档在场即回执 alreadyInstalled，不重下（两判据不同源——锁档非探测）', async () => {
    const zipBytes = singleEntryZip(LAYOUT_TAIL, Buffer.from('v2'));
    const dlCalls: Array<{ url: string; destPath: string; allowedHosts: readonly string[] }> = [];
    const deps: InstallDeps = {
      manifestFetch: fakeManifest([]),
      download: fakeDownload(zipBytes, dlCalls),
      dataDir,
    };
    const report = await installEngine(deps, { platform: 'darwin', arch: 'arm64' });
    expect(report.alreadyInstalled).toBe(true); // 上一测已装同版本——锁档命中
    expect(report.version).toBe(VERSION);
    expect(dlCalls).toHaveLength(0); // 零重下
  });

  it('平台无发行（linux/arm64——CfT 无 chrome 发行档）→ BROWSER_INSTALL_FAILED 附指引', async () => {
    const deps: InstallDeps = {
      manifestFetch: fakeManifest([]),
      download: fakeDownload(Buffer.alloc(0), []),
      dataDir,
    };
    await expectInstallFail(installEngine(deps, { platform: 'linux', arch: 'arm64' }));
  });

  it('清单版本号形状非法（../../evil 路径逃逸形）→ 拒载（m-2 白名单——远端原文不进 join）', async () => {
    // 修复前形态：version 串直接 join(engineRoot, version)——`../../evil` 把
    // 解包目录与 zip 落盘锚移出 engine/。白名单在幂等检查与任何 fs 操作之前。
    const evil = JSON.stringify({
      channels: {
        Stable: {
          version: '../../evil',
          downloads: { chrome: [{ platform: 'mac-arm64', url: 'https://storage.googleapis.com/cft/z.zip' }] },
        },
      },
    });
    const dlCalls: Array<{ url: string; destPath: string; allowedHosts: readonly string[] }> = [];
    const deps: InstallDeps = {
      manifestFetch: fakeManifest([], { status: 200, text: evil, truncated: false }),
      download: fakeDownload(Buffer.alloc(0), dlCalls),
      dataDir,
    };
    await expectInstallFail(installEngine(deps, { platform: 'darwin', arch: 'arm64' }));
    expect(dlCalls).toHaveLength(0); // 零下载零落盘
  });

  it('清单非 2xx → BROWSER_INSTALL_FAILED（不走抓取 isError 面）', async () => {
    const deps: InstallDeps = {
      manifestFetch: fakeManifest([], { status: 503, text: '', truncated: false }),
      download: fakeDownload(Buffer.alloc(0), []),
      dataDir,
    };
    await expectInstallFail(installEngine(deps, { platform: 'darwin', arch: 'arm64' }));
  });

  it('清单缺本平台条目 → BROWSER_INSTALL_FAILED（manifest 有 Stable 无匹配 platform）', async () => {
    const emptyManifest = JSON.stringify({ channels: { Stable: { version: '1.0.0.0', downloads: { chrome: [] } } } });
    const deps: InstallDeps = {
      manifestFetch: fakeManifest([], { status: 200, text: emptyManifest, truncated: false }),
      download: fakeDownload(Buffer.alloc(0), []),
      dataDir,
    };
    await expectInstallFail(installEngine(deps, { platform: 'darwin', arch: 'x64' }));
  });

  it('清单截断标记 → 拒载（异常形态不硬解）', async () => {
    const deps: InstallDeps = {
      manifestFetch: fakeManifest([], { status: 200, text: MANIFEST, truncated: true }),
      download: fakeDownload(Buffer.alloc(0), []),
      dataDir,
    };
    await expectInstallFail(installEngine(deps, { platform: 'darwin', arch: 'arm64' }));
  });
});
