/**
 * L5 app — e1 宿主沙箱包裹（技术栈篇 §5 装配选项，第二十八批题 3A 落码）。
 *
 * 形态 = **wrapper 重 exec**：进程不可在位自套沙箱（seatbelt/bwrap 两后端均
 * 只在 spawn 侧生效）——旗标检出后 CLI 自 spawn 一次、于 wrapper argv 下重启
 * 自身（argv 剥本旗标防无限递归 exec）。
 *
 * 宿主版策略**复用 safety 现役件的 profile/argv 构造面**（seatbeltProfile/
 * bwrapArgs 零改动）——与子进程档的唯一差异在可写根：宿主必须写库/凭证
 * （数据目录）+ 跑活（工作区档位对应根），故 writableRoots = 档位推导根 ∪
 * 数据目录 ∪ 显式库路径父目录（APP_DB_PATH 指到别处时库写面照样放行）。
 * denySignatures/runnerFailureRules 子进程诊断面不随迁移（wrapper 透传 stdio，
 * 子进程即宿主自身——失败分类只需 runner 前缀一档）。
 *
 * 无后端平台（Windows：createDefaultBackends 空链）→ SANDBOX_UNAVAILABLE
 * fail-closed 响亮拒（退出码 1），绝不静默裸跑——诚实边界第四条（Windows 无
 * 后端明示降级）的执法面即此。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError, SANDBOX_UNAVAILABLE } from '../contracts/errors.js';
import { canonicalPath, createDefaultBackends, createSandboxService, deriveWritableRoots } from '../safety/index.js';
import type { ConfinedSandboxMode, SandboxPolicy } from '../safety/index.js';
import { dataDir, dbPath, ensureDbDir } from './paths.js';

/** 旗标词（CLI 面；帮助文案与解析层同词） */
export const HOST_SANDBOX_FLAG = '--sandbox-host';

/**
 * 宿主版可写根：档位推导根 ∪ 数据目录 ∪ 库路径父目录（canonical 去重）。
 * read-only 档推导根为空——宿主仍须写库（事件日志是 durable 承诺），数据
 * 目录恒放行；workspace-write 档再加工作区 + /tmp 族（fs 工具在宿主进程内
 * 执行写工作区——官方件永主线程三处拍板的可写面事实）。
 */
export function hostWritableRoots(workspaceRoot: string, mode: ConfinedSandboxMode): string[] {
  return [
    ...new Set([
      ...deriveWritableRoots(workspaceRoot, mode),
      canonicalPath(dataDir()),
      canonicalPath(dirname(dbPath())),
    ]),
  ];
}

/**
 * 宿主版沙箱策略：mode/workspaceRoot 与 run 的 sandboxMode 同源（--read-only
 * → read-only，缺省 workspace-write）；writableRoots 显式覆盖（缺省推导不含
 * 宿主库写面——覆盖即本件存在的全部差异）。
 */
export function hostSandboxPolicy(workspaceRoot: string, mode: ConfinedSandboxMode): SandboxPolicy {
  return { mode, workspaceRoot: canonicalPath(workspaceRoot), writableRoots: hostWritableRoots(workspaceRoot, mode) };
}

/**
 * 组装 wrapper 内层 argv：[execPath, ...execArgv, scriptPath, ...原参数剥 --sandbox-host]。
 * argv[0]/[1] 原样保留（node 直跑 / bin shim / tsx dev 三形态统一：argv[0] = node
 * 路径、argv[1] = 脚本绝对路径）；**execArgv 必须随行**——tsx dev 形态下 argv[1]
 * 是 .ts 源文件，node 解释器旗标（`--require preflight` + `--import loader`）在
 * process.execArgv 里，丢了即内层 ERR_MODULE_NOT_FOUND（真机冒烟实证）；剥旗标
 * 滤净首层全部出现（重复传入本就冗余，剥净防递归）。
 */
export function relaunchArgv(processArgv: readonly string[], execArgv: readonly string[] = []): string[] {
  const rest = processArgv.slice(2).filter((arg) => arg !== HOST_SANDBOX_FLAG);
  return [processArgv[0]!, ...execArgv, processArgv[1]!, ...rest];
}

/** 重启选项（测试注入面：后端链/解释器旗标） */
export interface RelaunchOptions {
  /** 覆盖后端链（缺省平台链 createDefaultBackends；传 [] = Windows 形态测试） */
  readonly backends?: ReturnType<typeof createDefaultBackends>;
  /** 覆盖 node 解释器旗标（缺省 process.execArgv——tsx loader 随行；传 [] = 裸 node 形态） */
  readonly execArgv?: readonly string[];
}

/**
 * 于宿主沙箱 wrapper 下重启自身（同步等待、stdio 透传、退出码透传）。
 * @param processArgv 原 process.argv（剥旗标后作内层 argv 主体）
 * @param workspaceRoot 工作区根（策略推导锚点）
 * @param mode 宿主档位（与 run 的 sandboxMode 同源）
 * @param opts 测试注入面（后端链/execArgv）
 * @returns 子进程退出码（wrapper/后端失败 = 1）
 */
export function relaunchUnderHostSandbox(
  processArgv: readonly string[],
  workspaceRoot: string,
  mode: ConfinedSandboxMode,
  opts: RelaunchOptions = {},
): number {
  // 外层建档先行（遗漏大扫 20260901-d #18，技术栈篇 §5 e1 勘正）：宿主可写根
  // canonical 化的隐含前提是目录已存在——首跑数据目录未建时 canonicalPath 对
  // 缺失路径回退原始串，符号链祖先（/tmp→/private/tmp、$TMPDIR=/var/folders/…、
  // /var）未解析，seatbelt subpath 字面量与内核 namei 解析路径失配，内层
  // ensureDbDir 建档 EPERM 首跑即砖（read-only 档恒中——推导根为空无 /tmp 宽
  // 根兜底；tick wrapper 档恒 read-only 同中；多级缺失父目录 recursive mkdir
  // 越出白名单叶是同族第二因）。外层（未受限进程）预建数据目录与库父目录
  // ——建档本就是宿主职责（e1「read-only 建库刚需」的时点前移），复用
  // ensureDbDir 语义（0700 新建段 + 产权面 chmod 同款），目录既建 canonical
  // 化前提恒成立、内层建档幂等；建档失败 = 响亮退出码 1（不裸栈——与内层
  // EPERM 旧形同为首跑失败，但消息面提前到外层且带归因）
  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    ensureDbDir(dbPath());
  } catch (err) {
    process.stderr.write(
      `数据目录建档失败（--sandbox-host 外层预建）：${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  // 无 ctx 服务形态：CLI 入口早于组合根——直接组装一次性服务（probe/仲裁/
  // fail-closed 语义与 ctx.sandbox 同源，链即平台默认链）
  const service = createSandboxService({ backends: opts.backends ?? createDefaultBackends() });
  let confined;
  try {
    confined = service.confine(
      relaunchArgv(processArgv, opts.execArgv ?? process.execArgv),
      hostSandboxPolicy(workspaceRoot, mode),
    );
  } catch (err) {
    // fail-closed：无后端（Windows）/链探测全败 → 响亮拒，绝不静默裸跑
    const detail = err instanceof AppError && err.code === SANDBOX_UNAVAILABLE ? `（${err.message}）` : '';
    process.stderr.write(
      `宿主沙箱不可用，拒绝裸跑${detail}\n` +
        `--sandbox-host 需要 macOS（seatbelt）或 Linux（bwrap）后端；Windows 无后端（诚实边界四）。\n`,
    );
    return 1;
  }
  // wrapper 重 exec：同步等待（run 单发短命形态）、stdio inherit（stdout/
  // stderr/Ctrl+C 前台进程组全透传）。spawn 自身失败（runner 缺失/参数拒载）
  // = 退出码 1 响亮（stderr 已由 inherit 透传 runner 报错——fail-closed 同向）
  const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { stdio: 'inherit' });
  if (result.error !== undefined || result.status === null) {
    process.stderr.write(`宿主沙箱 wrapper 启动失败：${result.error?.message ?? '子进程异常终止'}\n`);
    return 1;
  }
  return result.status;
}
