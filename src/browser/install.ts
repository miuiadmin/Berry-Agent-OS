/**
 * L3 browser — 引擎装机编排（契约篇 §6.10「引擎下载装机」段，第五十四批
 * 刀三余量）。
 *
 * 流程：with-downloads 清单拉取（ctx.fetch.fetch——KB 级 JSON，抓取预算
 * 足够且 URL 直给免拼装）→ Stable 通道按 platform 键匹配 → downloadToFile
 * （白名单 = CfT 两域）→ 手写 zip 读取器解包至 `engine/<version>/` →
 * 布局表尾件 chmod 0o755（双保险）→ 锁档 `install.json` → 删 zip。
 *
 * 幂等：同版本锁档在场即回执不重下（幂等判据 = 锁档；发现序判据 = X_OK
 * 探测——两判据不同源：锁档在而尾件损时 install 回执已装、发现序落④，
 * 契约篇可接受注记）。
 *
 * 多版本并存允许（逐版本目录隔离）；显式命令不自动下载（发现序④指引
 * 文本即指向 /browser install——150MB 级惊喜下载不可接受）。
 */

import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, BROWSER_INSTALL_FAILED } from '../contracts/errors.js';
import { ENGINE_LAYOUTS } from './discover.js';
import { extractZip } from './zip.js';

/** CfT 清单端点（with-downloads 形——返回体直含各平台下载 URL，免拼装） */
export const CFT_MANIFEST_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
/** 装机域白名单（清单域 + 下载域——downloadToFile 每跳重过） */
export const CFT_ALLOWED_HOSTS: readonly string[] = ['googlechromelabs.github.io', 'storage.googleapis.com'];

/** 清单拉取面（ctx.fetch 服务的结构子集——窄面防绑 WebService 全形） */
export interface InstallFetchFace {
  fetch(url: string, opts?: { caller?: string }): Promise<{ status: number; text: string; truncated: boolean }>;
}

/** 下载面（ctx.fetch.downloadToFile 的结构子集——同上窄面） */
export interface InstallDownloadFace {
  (
    url: string,
    opts: { destPath: string; allowedHosts: readonly string[]; caller?: string },
  ): Promise<{
    finalUrl: string;
    bytes: number;
    sha256: string;
  }>;
}

/** 装机依赖束（app.ts 命令闭包注入——测试注假 fetch/download） */
export interface InstallDeps {
  /** 清单拉取面（ctx.fetch.fetch） */
  readonly manifestFetch: InstallFetchFace['fetch'];
  /** 下载面（ctx.fetch.downloadToFile） */
  readonly download: InstallDownloadFace;
  /** 数据目录（engine/ 物理锚——与 BrowserAppDeps.dataDir 同源） */
  readonly dataDir: string;
}

/** 平台档位（两级键：JSON platform 键 + zip 顶层目录名——契约篇钉死换算） */
export interface PlatformSlot {
  /** with-downloads 清单里的 platform 键（如 mac-arm64） */
  readonly key: string;
  /** zip 解包顶层目录名（chrome- + platform 键） */
  readonly layoutDir: string;
}

/**
 * 平台映射（冷读实测对齐现行 CfT 清单：mac 侧 arm64/x64、linux 侧 linux64、
 * win 侧 win64——chrome-mac/chrome-linux 是旧命名幽灵条目已清）。
 * linux arm64 等 CfT 无 chrome 发行——undefined（诚实拒附指引）。
 */
export function platformSlotOf(platform: NodeJS.Platform, arch: string): PlatformSlot | undefined {
  if (platform === 'darwin' && arch === 'arm64') return { key: 'mac-arm64', layoutDir: 'chrome-mac-arm64' };
  if (platform === 'darwin' && arch === 'x64') return { key: 'mac-x64', layoutDir: 'chrome-mac-x64' };
  if (platform === 'linux' && arch === 'x64') return { key: 'linux64', layoutDir: 'chrome-linux64' };
  if (platform === 'win32' && arch === 'x64') return { key: 'win64', layoutDir: 'chrome-win64' };
  return undefined;
}

/** with-downloads 清单的解析面（只取本编排消费的三层） */
interface CftManifest {
  channels?: { Stable?: { version?: string; downloads?: { chrome?: Array<{ platform?: string; url?: string }> } } };
}

/** 装机回执（命令面 notify 组装源） */
export interface InstallReport {
  /** 引擎版本（CfT 四段式） */
  readonly version: string;
  /** 平台档位（key/layoutDir 两级键回执） */
  readonly slot: PlatformSlot;
  /** 引擎可执行绝对路径（布局表命中位） */
  readonly enginePath: string | undefined;
  /** zip SHA256（记档供人工核——v1 不对照远端 checksum） */
  readonly sha256: string;
  /** zip 字节数 */
  readonly bytes: number;
  /** 幂等命中标注（同版本锁档在场 = true——未重下） */
  readonly alreadyInstalled: boolean;
}

/** 锁档 install.json 面（幂等判据 + 人工核对档） */
interface InstallLock {
  readonly version: string;
  readonly platform: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
  readonly installedAt: string;
}

/** 装机错误（统一 BROWSER_INSTALL_FAILED——message 载细节） */
function installFail(detail: string): AppError {
  return new AppError(BROWSER_INSTALL_FAILED, `引擎装机失败：${detail}`);
}

/**
 * 同 versionDir 在飞装机 promise 去重表（2026-09-01 遗漏大扫 20260901-c #12）：
 * 键 = versionDir 全路径（已含 dataDir——多数据目录测试态天然分键）；值 = 在飞
 * 装机 promise。重入腿直接共享同一 promise（回执同一份——不双下载不互删）；
 * finally 出表（成败均出——失败不卡后续重试）。生命周期 = 进程级：装机完成后
 * 表恒空（每键自清），无常驻条目。
 */
const inflightInstalls = new Map<string, Promise<InstallReport>>();

/**
 * 装机主口（/browser install 命令消费）。
 * 幂等：同版本 install.json 在场即回执 alreadyInstalled（不重下）。
 * 并发重入互斥：同 versionDir 在飞 promise 去重共享（重入腿回执同一份——
 * 20260901-c #12；成败均出表，失败不卡重试）。
 * 失败面：清单解析/平台无发行/下载（WEB_* 原样透传）/解包（BROWSER_INSTALL_FAILED
 * 半解包已清）——调用方 catch 后 notify 人读。
 */
export async function installEngine(
  deps: InstallDeps,
  opts?: { platform?: NodeJS.Platform; arch?: string },
): Promise<InstallReport> {
  const slot = platformSlotOf(opts?.platform ?? process.platform, opts?.arch ?? process.arch);
  if (slot === undefined) {
    throw installFail(
      `当前平台无 Chrome for Testing 发行（${opts?.platform ?? process.platform}/${opts?.arch ?? process.arch}）——请装系统 Chrome 或在行 config 配 executablePath`,
    );
  }

  /* ---- 清单拉取（ctx.fetch.fetch——KB 级 JSON，抓取预算足够） ---- */
  const manifestRes = await deps.manifestFetch(CFT_MANIFEST_URL, { caller: 'browser-install' });
  if (manifestRes.status < 200 || manifestRes.status >= 300) {
    throw installFail(`清单拉取非 2xx（${manifestRes.status}——${CFT_MANIFEST_URL}）`);
  }
  if (manifestRes.truncated) throw installFail('清单响应被截断（2MiB 预算内装不下——异常形态拒继续）');
  let manifest: CftManifest;
  try {
    manifest = JSON.parse(manifestRes.text) as CftManifest;
  } catch (err) {
    throw installFail(`清单 JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const stable = manifest.channels?.Stable;
  const version = stable?.version;
  const entry = stable?.downloads?.chrome?.find((d) => d.platform === slot.key);
  const zipUrl = entry?.url;
  if (version === undefined || zipUrl === undefined) {
    throw installFail(`清单缺 Stable/${slot.key} 下载条目（版本 ${version ?? '缺席'}）`);
  }
  // version 形状白名单（m-2，第五十五批）：远端清单原文（不可信输入）直接 join
  // 进文件系统路径——`../../evil` 形即把解包目录/zip 落盘锚移出 engine/。
  // upgrade.ts:356 对同源 registry 响应立有同款纪律（形状白名单钉死）
  if (!/^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.]+)?$/.test(version)) {
    throw installFail(`清单版本号形状非法拒载：${version}`);
  }

  /* ---- 幂等检查：同版本锁档在场即回执不重下 ---- */
  const engineRoot = join(deps.dataDir, 'browser', 'engine');
  const versionDir = join(engineRoot, version);
  const lockPath = join(versionDir, 'install.json');
  if (exists(lockPath)) {
    const prior = await readLock(lockPath);
    return {
      version,
      slot,
      enginePath: findLayoutExecutable(versionDir, slot.layoutDir),
      sha256: prior?.sha256 ?? '',
      bytes: prior?.bytes ?? 0,
      alreadyInstalled: true,
    };
  }

  /* ---- 并发重入互斥（20260901-c #12）：幂等判据（锁档在场）与锁档写入之间隔着
   * 分钟级下载窗——TUI 命令派发 fire-and-forget 下连敲两次即两条装机流并发（双
   * 下载写同一 .part 交错互毁；解包失败腿 rm 整 versionDir 把另一条流刚解包的
   * 产物一并删掉）。同 versionDir 在飞 promise 去重共享：重入腿回执同一份（§6.10
   * 并发重入互斥条款）。跨进程不在此执法面（双开本就违 P6 双开律） ---- */
  const running = inflightInstalls.get(versionDir);
  if (running !== undefined) return running;
  const attempt = (async (): Promise<InstallReport> => {
    /* ---- 下载（downloadToFile——.part 半档在其内部收口）→ 解包 → 锁档 ---- */
    const zipPath = join(engineRoot, `${version}.zip`);
    await mkdir(engineRoot, { recursive: true });
    const downloaded = await deps.download(zipUrl, {
      destPath: zipPath,
      allowedHosts: CFT_ALLOWED_HOSTS,
      caller: 'browser-install',
    });
    // 解包（失败腿：extractZip 自清半解包目录后 throw——zip 档同笔清理见下）
    try {
      await extractZip(zipPath, versionDir);
      // 布局表尾件 chmod 0o755（双保险——zip 权限位缺席时发现序 X_OK 仍可命中）
      for (const tail of layoutTailsFor(slot.layoutDir)) {
        await chmod(join(versionDir, tail), 0o755).catch(() => {}); // 非本平台布局缺席即跳过
      }
      const lock: InstallLock = {
        version,
        platform: slot.key,
        sha256: downloaded.sha256,
        bytes: downloaded.bytes,
        url: downloaded.finalUrl,
        installedAt: new Date().toISOString(),
      };
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    } finally {
      await rm(zipPath, { force: true }).catch(() => {}); // zip 即用即清（tarball 自锁先例）
    }
    return {
      version,
      slot,
      enginePath: findLayoutExecutable(versionDir, slot.layoutDir),
      sha256: downloaded.sha256,
      bytes: downloaded.bytes,
      alreadyInstalled: false,
    };
  })();
  // 入表与 IIFE 创建同一同步段（IIFE 首个 await 前无让位点）——并发重入腿必见表项
  inflightInstalls.set(versionDir, attempt);
  try {
    return await attempt;
  } finally {
    inflightInstalls.delete(versionDir); // 成败均出表（失败不卡重试）
  }
}

/** 本平台布局尾件（布局表过滤——mac 布局只 chmod mac 档） */
function layoutTailsFor(layoutDir: string): readonly string[] {
  return ENGINE_LAYOUTS.filter((layout) => layout.startsWith(`${layoutDir}/`));
}

/** 锁档在位判定（幂等判据——accessSync F_OK 同 discover 探测风格） */
function exists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 锁档读取（幂等回执补 sha256/bytes——形态异常回 undefined 容错） */
async function readLock(lockPath: string): Promise<InstallLock | undefined> {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8')) as InstallLock;
  } catch {
    return undefined;
  }
}

/** 布局表命中位探测（回执 enginePath——发现序同表同布局） */
function findLayoutExecutable(versionDir: string, layoutDir: string): string | undefined {
  for (const layout of layoutTailsFor(layoutDir)) {
    const candidate = join(versionDir, layout);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
