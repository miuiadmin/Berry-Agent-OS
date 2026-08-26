/**
 * bash 可执行发现序（骨架篇 §7.6「平台形态与 bash 发现序」，2026-08-27
 * P1-3——挖矿 B11 缺口③：`['bash','-c']` 裸名硬编码在 win32 撞 System32
 * WSL 启动器陷阱——错 shell、错根文件系统视图、量级启动成本）。
 *
 * 四级发现序：
 * ⓪ APP_BASH_PATH 显式覆盖（操作员主权——可为 WSL bash，不做排除检查）；
 * ① POSIX：PATH 查找 bash（绝对路径解析——confine 包装前首参定型）；
 * ② win32 知名位序探（git-bash 家族三常位）；
 * ③ win32 PATH 查找带 WSL 启动器排除（绝对路径落 System32 且基名 bash.exe
 *    → 跳过该命中继续找）。
 *
 * 全序皆空 = EXEC_SPAWN_FAILED fail-loud（消息列已探测位清单）——不静默
 * 降级 cmd.exe（平台门控纪律：平台不支持的能力显式缺席，不换壳冒充）。
 *
 * 解析结果成功缓存、失败不缓存（装上 bash 无需重启进程——成功缓存是
 * 「每次调用都 stat 一遍 PATH」的无谓开销规避，失败重探是可安装性）。
 * 同步实现：调用点（bash 工具 execute）逐调用 resolve，探测成本 =
 * 少量 existsSync/accessSync（成功后缓存为纯字符串返回）。
 */

import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, EXEC_SPAWN_FAILED } from '../contracts/errors.js';

/** 注入面（测试与特殊装配用——缺省全真） */
export interface BashResolveDeps {
  /** 平台判定（缺省 process.platform——测试注入 'win32' 锁形状） */
  readonly platform?: NodeJS.Platform;
  /** 环境变量表（缺省 process.env——读 APP_BASH_PATH） */
  readonly env?: Record<string, string | undefined>;
  /** 存在性探针（缺省 existsSync + X_OK——测试计数探测次序） */
  readonly exists?: (path: string) => boolean;
}

/** 成功缓存（模块级——发现序是进程级事实，与会话/驱动无关） */
let cachedBash: string | undefined;

/** win32 知名位（git-bash 家族常装位序——bin 优先于 usr/bin：前者 PATH 语义更全） */
function wellKnownWin32Paths(env: Record<string, string | undefined>): string[] {
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
  const localAppData = env['LOCALAPPDATA'] ?? '';
  return [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    ...(localAppData !== '' ? [join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')] : []),
  ];
}

/** PATH 目录切分（空段过滤——win32 分号 / POSIX 冒号） */
function pathDirs(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const raw = env['PATH'] ?? '';
  return raw.split(platform === 'win32' ? ';' : ':').filter((p) => p !== '');
}

/** win32 WSL 启动器判定：路径落 System32 且基名 bash.exe（不区分大小写；
 * 分隔符兼容 / 与 \——node:path 在非 win32 宿主上拼 POSIX 分隔符，注入
 * platform='win32' 的测试形态也须判得中） */
function isWslLauncher(path: string): boolean {
  const lowered = path.toLowerCase();
  return /[\\/]system32[\\/]/.test(lowered) && lowered.endsWith('bash.exe');
}

/**
 * 解析 bash 可执行绝对路径（发现序四级；见模块头注释）。
 * @throws AppError(EXEC_SPAWN_FAILED) 全序皆空（消息列已探测位清单）
 */
export function resolveBash(deps: BashResolveDeps = {}): string {
  if (cachedBash !== undefined) return cachedBash;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  // 统一探针（注入时完全替换——测试只控存在性形状；缺省 = 存在 + X_OK 可执行）
  const exists = deps.exists ?? defaultExists;
  const probed: string[] = [];

  // ⓪ 显式覆盖：操作员主权——存在即用（可为 WSL bash，不做排除检查）
  const override = env['APP_BASH_PATH'];
  if (override !== undefined && override !== '') {
    if (exists(override)) {
      cachedBash = override;
      return override;
    }
    probed.push(`${override}（APP_BASH_PATH 指定但不存在）`);
  }

  // POSIX：PATH 查找 bash（X_OK 可执行 + 绝对路径定型）
  if (platform !== 'win32') {
    for (const dir of pathDirs(env, platform)) {
      const candidate = join(dir, 'bash');
      probed.push(candidate);
      if (exists(candidate)) {
        cachedBash = candidate;
        return candidate;
      }
    }
    throw new AppError(
      EXEC_SPAWN_FAILED,
      `未找到 bash（PATH 已探 ${probed.length} 位）——请安装 bash 或设 APP_BASH_PATH 指向其绝对路径；不降级 cmd.exe（平台门控纪律）`,
    );
  }

  // win32：知名位序探（git-bash 家族——命令与 cwd 都是 Windows 语义）
  for (const candidate of wellKnownWin32Paths(env)) {
    probed.push(candidate);
    if (exists(candidate)) {
      cachedBash = candidate;
      return candidate;
    }
  }

  // win32：PATH 查找带 WSL 启动器排除（System32\bash.exe = WSL 发行版启动器——
  // 不同根文件系统即不同机器，接受它是「换壳冒充」的变体）
  for (const dir of pathDirs(env, platform)) {
    const candidate = join(dir, 'bash.exe');
    if (!exists(candidate)) continue;
    if (isWslLauncher(candidate)) {
      probed.push(`${candidate}（WSL 启动器，已排除）`);
      continue;
    }
    cachedBash = candidate;
    return candidate;
  }

  throw new AppError(
    EXEC_SPAWN_FAILED,
    `未找到 Windows 侧 bash（git-bash/MSYS2/Cygwin）——已探测：${probed.slice(0, 8).join('、')}${probed.length > 8 ? ' 等' : ''}；请安装 git-bash 或设 APP_BASH_PATH（显式指定 WSL bash 亦可）；不降级 cmd.exe（平台门控纪律）`,
  );
}

/** 缺省探针：存在 + X_OK 可执行（win32 下 accessSync X_OK 近似恒真——存在即算） */
function defaultExists(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants_F_OK_X_OK);
    return true;
  } catch {
    return false;
  }
}

/** fs.constants 组合（F_OK|X_OK——单独常量防每调用解构开销） */
const constants_F_OK_X_OK = fsConstants.F_OK | fsConstants.X_OK;

/** 测试出口：清成功缓存（发现序单测隔离用——生产面永不调用） */
export function resetBashCacheForTest(): void {
  cachedBash = undefined;
}
