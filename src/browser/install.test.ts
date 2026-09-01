/**
 * L3 browser 引擎装机编排测试 — installEngine 全链回归锁（契约篇 §6.10
 * 「引擎下载装机」段，第五十四批刀三余量）。
 *
 * 外部边界全注假：manifestFetch（清单 JSON）/ download（写真 zip 档）。
 * 解包器/锁档/布局表/发现序全真——端到端走到 discoverEngine 命中
 * source='downloaded'（③ 下载引擎位与装机产物的闭环自证）。
 */

import { access, constants, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

/* ---------------- 并发重入互斥（2026-09-01 遗漏大扫 20260901-c #12 回归锁） ---------------- */

/** 互斥用例独立版本（共享 dataDir 的 VERSION 锁档有串行依赖——幂等用例赖上一测
 * 产物；本组用例各带独立数据目录 + 独立版本，互不沾染） */
const CONC_VERSION = '139.0.1000.1';
const CONC_MANIFEST = JSON.stringify({
  channels: {
    Stable: {
      version: CONC_VERSION,
      downloads: { chrome: [{ platform: 'mac-arm64', url: 'https://storage.googleapis.com/cft/c.zip' }] },
    },
  },
});

describe('installEngine 并发重入互斥（#12）', () => {
  it('在飞窗内重入共享同一 promise：单下载、回执同一份（修前：双下载写同一 .part 交错互毁）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-install-c1-'));
    try {
      const zipBytes = singleEntryZip(LAYOUT_TAIL, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
      // 门控下载假体：entered 计数 + 门放行后才写真 zip——分钟级下载窗的确定性替身
      let entered = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const download = async (
        url: string,
        opts: { destPath: string; allowedHosts: readonly string[]; caller?: string },
      ) => {
        entered += 1;
        await gate;
        await writeFile(opts.destPath, zipBytes);
        return { finalUrl: url, bytes: zipBytes.byteLength, sha256: 'ab12cd34ef56' };
      };
      const manifestCalls: string[] = [];
      const deps: InstallDeps = {
        manifestFetch: fakeManifest(manifestCalls, { status: 200, text: CONC_MANIFEST, truncated: false }),
        download,
        dataDir: dir,
      };

      // 腿 1（首发）进入下载窗：entered=1 即已在门内挂起
      const p1 = installEngine(deps, { platform: 'darwin', arch: 'arm64' });
      await vi.waitFor(() => expect(entered).toBe(1), { timeout: 5000 });
      // 腿 2：TUI 连敲窗内重入（命令派发 fire-and-forget 双跑形态）
      const p2 = installEngine(deps, { platform: 'darwin', arch: 'arm64' });
      // 一个宏任务位让腿 2 走完清单拉取/幂等检查/互斥检查的微任务链
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [a, b] = await Promise.all([p1, p2]);
      // 单下载（修前 = 2：两腿各写同一 destPath 的 .part 交错互毁）
      expect(entered).toBe(1);
      // 清单两腿各拉一次：互斥点在清单与幂等检查之后（KB 级重拉是裁决接受的代价）
      expect(manifestCalls).toHaveLength(2);
      // 回执同一份：重入腿共享在飞 promise（同一对象，非两份等值回执）
      expect(a).toBe(b);
      expect(a.alreadyInstalled).toBe(false);
      // 产物恰一份：锁档 + 引擎档在场、zip 已清（无第二腿再解一遍）
      expect(await exists(join(dir, 'browser', 'engine', CONC_VERSION, 'install.json'))).toBe(true);
      expect(await exists(join(dir, 'browser', 'engine', CONC_VERSION, LAYOUT_TAIL))).toBe(true);
      expect(await exists(join(dir, 'browser', 'engine', `${CONC_VERSION}.zip`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('失败腿共享同一拒绝且出表不卡重试：并发同错（同一错误对象）→ 修复后重装即成（成败均出表）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-install-c2-'));
    try {
      const zipBytes = singleEntryZip(LAYOUT_TAIL, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
      let entered = 0;
      let serveCorrupt = true; // 首轮供损坏字节（EOCD 未找到腿）；重试轮供真 zip
      const download = async (
        url: string,
        opts: { destPath: string; allowedHosts: readonly string[]; caller?: string },
      ) => {
        entered += 1;
        const bytes = serveCorrupt ? Buffer.from('不是 zip') : zipBytes;
        await writeFile(opts.destPath, bytes);
        return { finalUrl: url, bytes: bytes.byteLength, sha256: 'ab12cd34ef56' };
      };
      const deps: InstallDeps = {
        manifestFetch: fakeManifest([], { status: 200, text: CONC_MANIFEST, truncated: false }),
        download,
        dataDir: dir,
      };

      // 同 tick 背靠背双跑（互斥点后全部同步段：腿 1 resume 内入表，腿 2 resume 必见表项）
      const p1 = installEngine(deps, { platform: 'darwin', arch: 'arm64' });
      const p2 = installEngine(deps, { platform: 'darwin', arch: 'arm64' });
      const e1 = await p1.then(
        () => {
          throw new Error('期望装机失败');
        },
        (err) => err,
      );
      const e2 = await p2.then(
        () => {
          throw new Error('期望装机失败');
        },
        (err) => err,
      );
      // 双腿同一拒绝（共享在飞 promise——同一错误对象非两份同码错）
      expect(e1).toBe(e2);
      expect(e1).toBeInstanceOf(AppError);
      expect((e1 as AppError).code).toBe(BROWSER_INSTALL_FAILED);
      expect(entered).toBe(1); // 单下载（修前 = 2，且一腿 rm versionDir 毁另一腿产物）

      // 出表验证：失败后重试不被在飞表卡（finally 删键）——重装成功
      serveCorrupt = false;
      const retry = await installEngine(deps, { platform: 'darwin', arch: 'arm64' });
      expect(retry.alreadyInstalled).toBe(false);
      expect(entered).toBe(2); // 重试腿真下载了一次
      expect(await exists(join(dir, 'browser', 'engine', CONC_VERSION, 'install.json'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/* ---------------- 摘要账本（成熟度扫描 20260901 P1-4——TOFU 首装锚 + 重装比对） ---------------- */

/** 摘要账本组独立版本（独立目录独立版本——不沾染共享 dataDir 组的锁档串行链） */
const LEDGER_VERSION = '137.0.99.9';
const LEDGER_MANIFEST = JSON.stringify({
  channels: {
    Stable: {
      version: LEDGER_VERSION,
      downloads: { chrome: [{ platform: 'mac-arm64', url: 'https://storage.googleapis.com/cft/l.zip' }] },
    },
  },
});
/** 摘要账本档路径（engine/ 根——刻意在 versionDir 外：删版本重装不丢锚） */
const digestsPath = (dir: string) => join(dir, 'browser', 'engine', 'digests.json');
/** 账本组假下载回执摘要（与 fakeDownload 假体同串——比对逻辑的「相符」侧） */
const LEDGER_SHA = 'ab12cd34ef56';

describe('installEngine 摘要账本（P1-4）', () => {
  it('重装摘要漂移 → 拒解压执行：BROWSER_INSTALL_FAILED + versionDir 零落盘 + 账本不被覆写', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-install-d1-'));
    try {
      const zipBytes = singleEntryZip(LAYOUT_TAIL, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
      // 预置账本：该 version/platform 已锚 deadbeef——本次下载回执 ab12… 即漂移
      await mkdir(join(dir, 'browser', 'engine'), { recursive: true });
      await writeFile(digestsPath(dir), JSON.stringify({ [`${LEDGER_VERSION}/mac-arm64`]: 'deadbeef00' }));
      const dlCalls: Array<{ url: string; destPath: string; allowedHosts: readonly string[] }> = [];
      const deps: InstallDeps = {
        manifestFetch: fakeManifest([], { status: 200, text: LEDGER_MANIFEST, truncated: false }),
        download: fakeDownload(zipBytes, dlCalls),
        dataDir: dir,
      };

      // 修前形态：无账本面——装机照常成功解包执行（本测红即证缺陷在场）
      const err = await installEngine(deps, { platform: 'darwin', arch: 'arm64' }).then(
        () => {
          throw new Error('期望抛 AppError(BROWSER_INSTALL_FAILED)');
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe(BROWSER_INSTALL_FAILED);
      expect((err as Error).message).toContain('digests.json'); // 处置指引含重锚路

      // 比对在下载后解包前：下载已发生、解压零落盘、zip 即清
      expect(dlCalls).toHaveLength(1);
      expect(await exists(join(dir, 'browser', 'engine', LEDGER_VERSION))).toBe(false);
      expect(await exists(join(dir, 'browser', 'engine', `${LEDGER_VERSION}.zip`))).toBe(false);
      // 拒绝腿不重锚（重锚是人工处置非自动——账本保持原值）
      expect(JSON.parse(await readFile(digestsPath(dir), 'utf8'))).toEqual({
        [`${LEDGER_VERSION}/mac-arm64`]: 'deadbeef00',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('首装 TOFU 锚定落账本 + 重装比对相符放行（删 versionDir 强制重下形态）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-install-d2-'));
    try {
      const zipBytes = singleEntryZip(LAYOUT_TAIL, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
      const deps: InstallDeps = {
        manifestFetch: fakeManifest([], { status: 200, text: LEDGER_MANIFEST, truncated: false }),
        download: fakeDownload(zipBytes, []),
        dataDir: dir,
      };

      // 首装：账本键缺席 = TOFU 锚定（首下载无对照面——诚实披露语义）
      await installEngine(deps, { platform: 'darwin', arch: 'arm64' });
      // 修前形态：无账本文件（本断言红即证锚定缺席）
      const anchored = JSON.parse(await readFile(digestsPath(dir), 'utf8'));
      expect(anchored).toEqual({ [`${LEDGER_VERSION}/mac-arm64`]: LEDGER_SHA });

      // 删整个版本目录（用户清理形态——账本在 engine/ 根不受牵连）→ 重下比对相符 → 放行
      await rm(join(dir, 'browser', 'engine', LEDGER_VERSION), { recursive: true, force: true });
      const second = await installEngine(deps, { platform: 'darwin', arch: 'arm64' });
      expect(second.alreadyInstalled).toBe(false); // 锁档随版本目录已删——真重下
      // 账本锚不变（比对相符腿零改写）
      expect(JSON.parse(await readFile(digestsPath(dir), 'utf8'))).toEqual(anchored);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('账本损坏 → warn 点名 + 重锚降级不 brick：装机照常成功、账本重建为有效形', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'berry-install-d3-'));
    try {
      const zipBytes = singleEntryZip(LAYOUT_TAIL, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
      await mkdir(join(dir, 'browser', 'engine'), { recursive: true });
      // 损坏账本（截断/半写形态）——纯保护面 sidecar：降级不 brick 装机，但降级必可见
      await writeFile(digestsPath(dir), 'not json {{{');
      const warns: string[] = [];
      const deps: InstallDeps = {
        manifestFetch: fakeManifest([], { status: 200, text: LEDGER_MANIFEST, truncated: false }),
        download: fakeDownload(zipBytes, []),
        dataDir: dir,
        warn: (message) => warns.push(message),
      };

      // 修前形态：无 warn 面、无账本面——本测两断言红即证缺陷在场
      const report = await installEngine(deps, { platform: 'darwin', arch: 'arm64' });
      expect(report.alreadyInstalled).toBe(false);
      // 降级可见：warn 点名损坏路径
      expect(warns.some((w) => w.includes('digests.json'))).toBe(true);
      // 账本重建为有效形（本次摘要入锚——后续重装恢复比对保护）
      expect(JSON.parse(await readFile(digestsPath(dir), 'utf8'))).toEqual({
        [`${LEDGER_VERSION}/mac-arm64`]: LEDGER_SHA,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
