/**
 * L4 channels — fd 可执行发现序（契约篇 §6.8 fd 接线小刀，2026-08-30）。
 *
 * TUI `@` 文件段补全的行走后端是 pi-tui 内建 fd 子进程调用（fast,
 * respects .gitignore）——provider 构造第三参 fdPath 空则该腿恒空建议。
 * 本文件把 fd 可执行的发现接到该构造点。
 *
 * 两级发现序（exec 件 bash 发现序〔骨架篇 §7.6〕的同族异语义平移）：
 * ⓪ APP_FD_PATH 显式覆盖（操作员主权——存在即用，可为任意 fd 兼容实现；
 *    指定但不存在或空串则落 ①）；
 * ① PATH 查找：POSIX 基名序 fd → fdfind（Debian/Ubuntu `apt install
 *    fd-find` 的实名变体——fd README 明示须手工 symlink 才叫 fd）；
 *    win32 基名 fd.exe（无知名位序——fd 安装渠道全走 PATH）。
 *
 * 缺席语义 = 诚实缺席不 fail-loud（与 bash 硬依赖的本质分野）：全序皆空
 * 返回 null——@ 文件段无建议、无提示（辅助面，对照 bash 缺席整个 exec
 * 域不可用须响亮失败）。探到的 fd 运行失败（坏文件/版本不兼容）由
 * pi-tui spawn error 静默容错兜底——宿主不叠加试跑校验。
 *
 * 缓存 = 成功缓存失败重探（进程级，与 bash-path 同款）：探测时机 =
 * provider 构造（boot 武装 + commands.onChange 重建——低频），不在按键
 * 热路径；失败不缓存给「命令面变动触发重建即重探」的可发现性。诚实
 * 边界：命令面无变动的长命进程，中途安装 fd 须重启方可见。
 */

import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 注入面（测试与特殊装配用——缺省全真） */
export interface FdResolveDeps {
  /** 平台判定（缺省 process.platform——测试注入 'win32' 锁形状） */
  readonly platform?: NodeJS.Platform;
  /** 环境变量表（缺省 process.env——读 APP_FD_PATH 与 PATH） */
  readonly env?: Record<string, string | undefined>;
  /** 存在性探针（缺省 existsSync + X_OK——测试计数探测次序） */
  readonly exists?: (path: string) => boolean;
}

/** 成功缓存（模块级——发现序是进程级事实，与通道实例无关） */
let cachedFd: string | undefined;

/** PATH 目录切分（空段过滤——win32 分号 / POSIX 冒号） */
function pathDirs(env: Record<string, string | undefined>, platform: NodeJS.Platform): string[] {
  const raw = env['PATH'] ?? '';
  return raw.split(platform === 'win32' ? ';' : ':').filter((p) => p !== '');
}

/**
 * 解析 fd 可执行绝对路径（发现序两级；见模块头注释）。
 * @returns 绝对路径；全序皆空返回 null（诚实缺席——@ 文件段禁用）
 */
export function resolveFdPath(deps: FdResolveDeps = {}): string | null {
  if (cachedFd !== undefined) return cachedFd;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  // 统一探针（注入时完全替换——测试只控存在性形状；缺省 = 存在 + X_OK 可执行）
  const exists = deps.exists ?? defaultExists;

  // ⓪ 显式覆盖：操作员主权——存在即用（空串视同未设，与 bash-path ⓪ 同款）
  const override = env['APP_FD_PATH'];
  if (override !== undefined && override !== '') {
    if (exists(override)) {
      cachedFd = override;
      return override;
    }
    // 指定但不存在：静默落 ①（诚实缺席哲学无出口反馈面——已知静默角落，
    // 见契约篇条款接受式注记；PATH 查找可能选中另一 fd）
  }

  // ① PATH 查找：POSIX 基名序 fd → fdfind；win32 基名 fd.exe
  const basenames = platform === 'win32' ? ['fd.exe'] : ['fd', 'fdfind'];
  for (const base of basenames) {
    for (const dir of pathDirs(env, platform)) {
      const candidate = join(dir, base);
      if (exists(candidate)) {
        cachedFd = candidate;
        return candidate;
      }
    }
  }
  return null; // 全序皆空——诚实缺席（不 fail-loud，与 bash 的分野）
}

/**
 * 消费点三态决策（契约篇验收判据：提为纯函数供单测全覆盖）。
 * TuiChannelOptions.fdPath 注入键三态：undefined = 未注入走真发现序 /
 * null = 显式禁用 / 字符串 = 显式指定（空串与 null 同效禁用——pi-tui
 * 真值判定 !fdPath 同款退化）。`??` 合并会抹掉 null 语义——用全等判断。
 */
export function fdPathFor(injected: string | null | undefined): string | null {
  return injected === undefined ? resolveFdPath() : injected;
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
export function resetFdCacheForTest(): void {
  cachedFd = undefined;
}
