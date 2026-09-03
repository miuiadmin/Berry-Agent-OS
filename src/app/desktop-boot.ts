/**
 * L5 app — 桌面首启两连崩熔断账本（第八十五批批 C，骨架篇 boot 序）。
 *
 * `<dataDir>/desktop-boot-failures.json` = `{ version, count }`：
 * - **计数语义**：桌面起屏失败（shell.start 同步抛）记一次；**两连崩**（同版本
 *   连续 ≥ 2 次）即熔断——下次 no-arg 启动回锁内核最小 shell（带原因与
 *   `--no-desktop` 提示 + `/desktop` 重试动词）。
 * - **跨进程存活**：进程正常退出不清账（count 落盘）；**版本变更清零**（升级
 *   换了渲染栈 = 新的计量周期）；`/desktop` 重试成功清账（用户裁决盖过机器判死）。
 * - 版本来源 = package.json 顶层 `readFileSync(new URL(...))`——**不 require
 *   子路径**（package.json 无 exports 子路径，require/import 解析形态不定；
 *   读文件是唯一稳定面）。
 *
 * 损坏/缺省账本 = 零计数起步（warn 不炸启动——熔断是保底机制不是启动前置）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 账本文件名（落 <dataDir>/ 下——与 boot-failures.json / allowlist.json 同域） */
export const DESKTOP_BOOT_FAILURES_FILE = 'desktop-boot-failures.json';

/** 熔断阈值：同版本连续失败次数达到即回锁内核 shell */
export const BOOT_BREAKER_THRESHOLD = 2;

/** 账本形状（磁盘 JSON 面） */
export interface DesktopBootFailures {
  /** 计量版本（package.json version——版本变更清零重计） */
  readonly version: string;
  /** 同版本连续失败次数 */
  readonly count: number;
}

/**
 * 本进程包版本（package.json 顶层 readFileSync——版本计量锚。不用 version.ts
 * 字面量：那是构建期手工镜像，账本锚必须跟 package.json 同源防漂）。
 */
export function currentPackageVersion(): string {
  // 相对本文件（src/app/）上溯两级即包根；dist 形态目录结构同构（dist/app/）
  const url = new URL('../../package.json', import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

/** 账本文件全路径（dataDir 由调用方解析——入口用 paths.dataDir() 单源） */
export function bootFailuresPath(dataDir: string): string {
  return join(dataDir, DESKTOP_BOOT_FAILURES_FILE);
}

/**
 * 读账本：缺省/损坏 = 当前版本零计数起步（warn 不炸——熔断是保底机制；损坏
 * 视同重计，比拒启动更符合「保底不挡路」的定位）。
 */
export function readBootFailures(
  dataDir: string,
  opts: { warn?: (message: string) => void } = {},
): DesktopBootFailures {
  const version = currentPackageVersion();
  const file = bootFailuresPath(dataDir);
  if (!existsSync(file)) return { version, count: 0 };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopBootFailures>;
    if (typeof parsed.version !== 'string' || typeof parsed.count !== 'number') throw new Error('形状不符');
    return { version: parsed.version, count: Math.max(0, Math.floor(parsed.count)) };
  } catch (err) {
    opts.warn?.(`桌面启动失败账本损坏（视同重计）：${err instanceof Error ? err.message : String(err)}`);
    return { version, count: 0 };
  }
}

/** 原子写账本（tmp + rename——与 allowlist.json 同款落盘纪律；目录缺省建档） */
function writeBootFailures(dataDir: string, ledger: DesktopBootFailures): void {
  const file = bootFailuresPath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger)}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * 记一次失败（写时归一）：账本版本 ≠ 当前版本先清零再计（版本变更清零语义
 * 单点落此）；同版本则 count+1。返回写后的账本（调用方可判阈值）。
 */
export function recordBootFailure(
  dataDir: string,
  opts: { warn?: (message: string) => void } = {},
): DesktopBootFailures {
  const version = currentPackageVersion();
  const prior = readBootFailures(dataDir, opts);
  const ledger: DesktopBootFailures = {
    version,
    count: prior.version === version ? prior.count + 1 : 1,
  };
  writeBootFailures(dataDir, ledger);
  return ledger;
}

/** 清账（/desktop 重试成功时——用户裁决盖过机器判死；缺省文件时 no-op） */
export function clearBootFailures(dataDir: string): void {
  const file = bootFailuresPath(dataDir);
  if (!existsSync(file)) return;
  writeBootFailures(dataDir, { version: currentPackageVersion(), count: 0 });
}

/**
 * 熔断判据：同版本连续失败 ≥ 阈值（版本不匹配 = 升级清零语义，恒不熔断）。
 * 读侧不写盘（判定纯函数化——测试与入口共用）。
 */
export function isBootBreakerTripped(dataDir: string, opts: { warn?: (message: string) => void } = {}): boolean {
  const version = currentPackageVersion();
  const ledger = readBootFailures(dataDir, opts);
  return ledger.version === version && ledger.count >= BOOT_BREAKER_THRESHOLD;
}
