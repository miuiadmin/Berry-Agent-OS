/**
 * L3 browser — 引擎发现序（契约篇 §6.10 引擎发现序段，第四十九批刀一）。
 *
 * 四级序（前级缺席落次级——落级即记 fallbackWarning 自述）：
 * ① config `executablePath` / env `APP_BROWSER_PATH`（同义位——fd/bash 先例）；
 * ② 系统 Chrome 知名位 + PATH 可执行名；
 * ③ `<dataDir>/browser/engine/`（/browser install 产物——刀三落装）；
 * ④ 全缺席 = 诚实缺席 BROWSER_ENGINE_NOT_FOUND 附安装指引（**不自动下载**）。
 *
 * fallbackWarning 语义：发现序回退自述（首选缺席落到次选），与题库 025 的
 * 运行期质量回退（彼挂账）语义分离——本面只报「用的哪级、为何」。
 */

import { accessSync, constants, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AppError, BROWSER_ENGINE_NOT_FOUND } from '../contracts/errors.js';
import type { DiscoveredEngine } from './types.js';

/** 系统 Chrome 知名位（macOS/Linux——win32 v1 诚实缺席：知名位缺 → ④ 同码附指引） */
const SYSTEM_KNOWN_PATHS: readonly string[] = [
  // macOS 应用包双位（系统 /Applications 与用户 ~/Applications）
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  // Linux 发行版包装位
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** PATH 可执行名（② 的 PATH 腿——which 语义手写：PATH 逐目录 accessSync X_OK） */
const PATH_EXECUTABLE_NAMES: readonly string[] = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
];

/** 可执行判定（存在 + X_OK——EACCES/ENOENT 一律「不在」） */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH 逐目录找可执行名（找到即返绝对路径——不依赖 shell which） */
function findOnPath(name: string, pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * CfT zip 解包知名布局（③ 下载引擎位探测 + install 侧 chmod 面单源——契约篇
 * §6.10「布局表单源」钉死两消费面共享，禁两真相）。
 * 平台键与 CfT with-downloads 清单实测对齐（chrome-mac/chrome-linux 为旧
 * 命名幽灵条目，2026-09-01 冷读实测清出——现行清单 mac 侧只有 arm64/x64、
 * linux 侧只有 linux64）。
 */
export const ENGINE_LAYOUTS: readonly string[] = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux64/chrome',
  'chrome-win64/chrome.exe',
];

/**
 * ③ 下载引擎位探测（/browser install 产物——CfT zip 解包后的已知相对布局）。
 * engineDir 缺席/空 = undefined（未装过——常态）。逐版本子目录扫第一命中。
 */
function findDownloadedEngine(engineDir: string): string | undefined {
  let entries: readonly string[];
  try {
    entries = readdirSync(engineDir);
  } catch {
    return undefined; // 目录缺席 = 未装（常态）
  }
  for (const version of entries) {
    for (const layout of ENGINE_LAYOUTS) {
      const candidate = join(engineDir, version, layout);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * 引擎发现序主口（每工具会话首用前的 ensureEngine 消费——纯同步零副作用，
 * 可重复调用）。attach 形态（cdpEndpoint）不走本口。
 *
 * @param config 行 config（executablePath 显式覆盖）
 * @param engineDir 下载引擎目录（<dataDir>/browser/engine——组合根钉死）
 * @param opts 注入缝（系统位/PATH 覆盖——测试确定性缺席/命中；缺省真实表）
 * @returns 发现产物（path + 来源档位 + 回退自述）；全缺席 throw BROWSER_ENGINE_NOT_FOUND
 */
export function discoverEngine(
  config: { readonly executablePath?: string },
  engineDir: string,
  opts?: DiscoverOptions,
): DiscoveredEngine {
  /** ① config / env 显式位（env 同义位——APP_BROWSER_PATH） */
  const explicit = config.executablePath ?? process.env.APP_BROWSER_PATH;
  if (explicit !== undefined && explicit !== '') {
    if (isExecutable(explicit)) {
      return { path: explicit, source: 'config' };
    }
    // 显式位缺席：不静默落次级——继续发现序但记回退自述（诚实披露不 fail-loud，
    // 用户显式配置漂移该看见警告而非硬失败——题库 025 语义分离裁决）
    const fallback = findSystemOrDownloaded(engineDir, opts);
    return {
      ...fallback,
      fallbackWarning: `配置的引擎路径不可执行（${explicit}）——发现序回落到 ${labelOf(fallback.source)}`,
    };
  }

  /* ---- ②/③：系统位 → 下载位（各自缺席落次级并记自述） ---- */
  return findSystemOrDownloaded(engineDir, opts);
}

/** 发现序注入缝（测试确定性缺席/命中——buildChildEnv processEnv 同款先例） */
export interface DiscoverOptions {
  /** 系统 Chrome 知名位覆盖（缺省内置表——测试注入空表） */
  readonly systemPaths?: readonly string[];
  /** PATH 值覆盖（缺省 process.env.PATH——测试注入空串） */
  readonly pathEnv?: string;
}

/** ②→③ 两级发现（① 在场缺席时也复用本序） */
function findSystemOrDownloaded(engineDir: string, opts?: DiscoverOptions): DiscoveredEngine {
  const systemPaths = opts?.systemPaths ?? SYSTEM_KNOWN_PATHS;
  const pathEnv = opts?.pathEnv ?? process.env.PATH ?? '';
  for (const known of systemPaths) {
    if (isExecutable(known)) return { path: known, source: 'system' };
  }
  for (const name of PATH_EXECUTABLE_NAMES) {
    const found = findOnPath(name, pathEnv);
    if (found !== undefined) return { path: found, source: 'system' };
  }
  const downloaded = findDownloadedEngine(engineDir);
  if (downloaded !== undefined) {
    return {
      path: downloaded,
      source: 'downloaded',
      fallbackWarning: '系统未装 Chrome——使用 /browser install 下载的引擎（版本可能落后于系统渠道）',
    };
  }

  /* ---- ④ 诚实缺席：附安装指引，不自动下载 ---- */
  throw new AppError(
    BROWSER_ENGINE_NOT_FOUND,
    '未发现浏览器引擎（发现序：配置路径/APP_BROWSER_PATH → 系统 Chrome → 下载引擎目录 全缺席）。' +
      '安装指引：装系统 Chrome（macOS /Applications 或 Linux 包管理器），' +
      '或在行 config 配 executablePath，或运行 /browser install 下载 Chrome for Testing。',
  );
}

/** 来源档位人读名（fallbackWarning 组装用） */
function labelOf(source: 'config' | 'system' | 'downloaded'): string {
  if (source === 'config') return '配置路径';
  if (source === 'system') return '系统 Chrome';
  return '下载引擎';
}
