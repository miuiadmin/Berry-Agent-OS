/**
 * L5 app — daemon.json 持有态与 token 鉴权物（契约篇 §6.8 常驻执行体条·刀一）。
 *
 * 本文件是 daemon 机制的**无装配依赖半边**：daemon.json 生命周期 + processStartId
 * 判活探针 + token 文件。拆出独立模块的原因：组合根 assembly 需要零环引用
 * readDaemonState/isDaemonAlive（heldElsewhere 租约闭包），而命令半边
 * daemon.ts 引 createRuntime（assembly）——两半分置后 assembly→daemon-state
 * 单向，无 ESM 环。
 *
 * daemon.json 单文件三面（M5/M6）：
 * - **单实例仲裁**：O_EXCL（'wx' 旗）原子创建——文件已存在即撞，物理面唯一真相；
 * - **heldSessions 租约登记面**：open/retire 通知驱动重写（rename 原子更新），
 *   他进程（TUI/run）open 前查它拒开双写者——登记面非锁，库 cursor/incarnation
 *   护栏是第二防线（窄竞窗文档化）；
 * - **退出清理闭 PID 复用窗**：pid + processStartId 双匹配才删——本进程退出后
 *   同 pid 被新进程占走的场合，新 daemon 的文件不被误删。
 *
 * pid 文件明示非锁：三层仲裁 = O_EXCL + EADDRINUSE + 库 cursor 护栏（flock
 * 已否决——跨平台语义碎）。token（P1）红线：不进 URL / 查询参数 / CLI 参数
 * （进程内/非 daemon 形态维持免 token——回环三防线即闭环）。
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, DAEMON_ALREADY_RUNNING } from '../contracts/errors.js';
import { writeAtomicFile } from '../persist/index.js';
import { dataDir } from './paths.js';

/** daemon.json 持有态文件名（数据目录 daemon/ 子目录内） */
const STATE_FILE = 'daemon.json';
/** token 文件名（0600——手动轮换 = 删文件重启） */
const TOKEN_FILE = 'daemon-token';

/** daemon 子目录路径（数据目录内 daemon/——mkdir 由各写点先行） */
export function daemonDirOf(dataRoot: string = dataDir()): string {
  return join(dataRoot, 'daemon');
}

/** daemon.json 路径 */
export function daemonStatePath(dataRoot: string = dataDir()): string {
  return join(daemonDirOf(dataRoot), STATE_FILE);
}

/** token 文件路径（0600） */
export function daemonTokenPath(dataRoot: string = dataDir()): string {
  return join(daemonDirOf(dataRoot), TOKEN_FILE);
}

/* ------------------------------------------------------------------ */
/* processStartId 探针（判活判据源——「不猜 pid」的执法面）              */
/* ------------------------------------------------------------------ */

/**
 * 进程身份探针：返回 pid 的**进程起始标识**（同 pid 不同进程 ⇒ 不同标识——
 * 闭 PID 复用窗）。undefined = 进程不存在。
 * - Linux：/proc/\<pid\>/stat field 22（starttime 时钟滴答——内核口径，最准）；
 * - macOS：`ps -o lstart=` 起始时刻串（秒粒度——与 pid 联用足以判复用）；
 * - 其余平台（win32）：退化为 process.kill(pid, 0) 存活探（复用窗开放——
 *   诚实边界，v1 daemon 主面 macOS/Linux）。
 */
export interface ProcessProbe {
  startId(pid: number): string | undefined;
}

/** 平台缺省探针（测试注入假探针替换——daemon 全部判活单源走它） */
export const defaultProcessProbe: ProcessProbe = {
  startId(pid: number): string | undefined {
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // comm 字段可含空格/括号——最后一个 ')' 之后才是字段 3 起，starttime
        // 是全表 field 22 ⇒ 后缀表下标 22 - 3 = 19
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
        const ticks = rest[19];
        return ticks === undefined || ticks === '' ? undefined : `linux:${ticks}`;
      } catch {
        return undefined; // 进程不在 = 判死
      }
    }
    if (process.platform === 'darwin') {
      try {
        // lstart 例形 "Mon Aug 30 10:24:15 2026"；进程不存在时 ps 输出空串
        const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        return out === '' ? undefined : `darwin:${out}`;
      } catch {
        return undefined;
      }
    }
    // 兜底平台：只判存活不辨身份（复用窗开放——诚实边界注记见接口注释）
    try {
      process.kill(pid, 0);
      return `alive:${pid}`;
    } catch {
      return undefined;
    }
  },
};

/* ------------------------------------------------------------------ */
/* daemon.json 生命周期（读/判活/清扫/创建/更新/释放）                  */
/* ------------------------------------------------------------------ */

/** daemon.json 形状（heldSessions 供他进程租约执法 + status 披露） */
export interface DaemonState {
  /** daemon 进程 pid */
  readonly pid: number;
  /** 进程起始标识（判活判据——探针输出与它比对，见 ProcessProbe） */
  readonly processStartId: string;
  /** 本次 boot 的随机 id（升级窗口辨识——status 披露面） */
  readonly bootId: string;
  /** webui 监听端口（常开回环） */
  readonly port: number;
  /** 本 daemon 持有的会话 id 清单（租约登记面——registry.open() 执法数据源） */
  readonly heldSessions: readonly string[];
  /**
   * boot 时数据目录绝对路径（体检对象记录键——基建大扫 20260901 #6）：doctor
   * 优先按此值体检 token/log 面，env 当场解析仅兜底——env 分叉（doctor 进程
   * 与 daemon boot 时 APP_DATA_DIR 不同）下体检对象与实际持有物不脱钩。
   * 可选 = 旧版 daemon.json 兼容（缺席时 doctor 兜底 env 值并披露来源）。
   */
  readonly dataRoot?: string;
  /** boot 时会话库文件绝对路径（同上——④ 库体检的记录键；缺席兜底 env 解析） */
  readonly dbPath?: string;
}

/** 读 daemon.json（缺失/损坏/形状不符 = undefined——损坏态视同陈旧可清扫） */
export function readDaemonState(dataRoot: string = dataDir()): DaemonState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(daemonStatePath(dataRoot), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const s = parsed as Record<string, unknown>;
    if (typeof s['pid'] !== 'number' || typeof s['processStartId'] !== 'string') return undefined;
    if (typeof s['bootId'] !== 'string' || typeof s['port'] !== 'number' || !Array.isArray(s['heldSessions'])) {
      return undefined;
    }
    return {
      pid: s['pid'],
      processStartId: s['processStartId'],
      bootId: s['bootId'],
      port: s['port'],
      heldSessions: (s['heldSessions'] as unknown[]).filter((id): id is string => typeof id === 'string'),
      // 体检对象记录键（#6）：string 校验过滤非串脏值——缺席 = 旧版文件（合法态）
      ...(typeof s['dataRoot'] === 'string' ? { dataRoot: s['dataRoot'] } : {}),
      ...(typeof s['dbPath'] === 'string' ? { dbPath: s['dbPath'] } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 判活：探针现值 === 落账 processStartId（undefined = 进程不在 = 死） */
export function isDaemonAlive(state: DaemonState, probe: ProcessProbe = defaultProcessProbe): boolean {
  return probe.startId(state.pid) === state.processStartId;
}

/**
 * 陈旧清扫（M6 第三钉·动作）：daemon.json 在而进程判死 ⇒ 删文件返回 true。
 * 时点两处：start 的 O_EXCL 失败路径内自检 + --foreground 直起前。判活态
 * （返回 false）不动文件——活 daemon 的态不许碰。
 */
export function sweepStaleDaemonState(dataRoot: string, probe: ProcessProbe = defaultProcessProbe): boolean {
  const state = readDaemonState(dataRoot);
  if (state === undefined) return false;
  if (isDaemonAlive(state, probe)) return false;
  try {
    unlinkSync(daemonStatePath(dataRoot));
    return true;
  } catch {
    return false; // 删失败（并发/权限）——调用方按仍占用处理
  }
}

/**
 * 创建 daemon.json（O_EXCL 原子创建 = 单实例仲裁）。撞既有文件时按 M6 三钉
 * 处置：判死即删重建（重试一次）；判活 = DAEMON_ALREADY_RUNNING 响亮失败。
 */
export function acquireDaemonState(dataRoot: string, state: DaemonState, probe: ProcessProbe): void {
  const path = daemonStatePath(dataRoot);
  const json = JSON.stringify(state, null, 2);
  mkdirSync(daemonDirOf(dataRoot), { recursive: true });
  try {
    // 'wx' 独占创建：文件已存在即 EEXIST——单实例仲裁的物理面
    writeFileSync(path, json + '\n', { flag: 'wx', mode: 0o600 });
    return;
  } catch (err) {
    if (!isNodeErrorWithCode(err, 'EEXIST')) throw err;
  }
  // 撞文件：自检（时点钉）→ 判死即删重建 / 判活响亮
  const existing = readDaemonState(dataRoot);
  if (existing !== undefined && isDaemonAlive(existing, probe)) {
    throw new AppError(
      DAEMON_ALREADY_RUNNING,
      `daemon 已在运行（pid ${existing.pid}、端口 ${existing.port}）——单实例仲裁拒绝二次启动；` +
        `先 berry daemon stop，或 berry daemon status 查看现状`,
    );
  }
  try {
    unlinkSync(path);
  } catch {
    /* 删失败让下一轮 O_EXCL 再撞再报 */
  }
  try {
    writeFileSync(path, json + '\n', { flag: 'wx', mode: 0o600 });
  } catch {
    // 重试仍撞 = 判活/清扫与创建之间的窄竞窗里有真 daemon 落位——按已占用响亮失败
    throw new AppError(
      DAEMON_ALREADY_RUNNING,
      'daemon.json 独占创建失败（清扫与创建之间有并发落位）——按已在运行收场；berry daemon status 查看现状',
    );
  }
}

/** 更新 daemon.json（rename 原子写——heldSessions 刷新专用，0600 保持） */
export function updateDaemonState(dataRoot: string, state: DaemonState): void {
  writeAtomicFile(daemonStatePath(dataRoot), JSON.stringify(state, null, 2) + '\n', 0o600);
}

/**
 * 退出清理：仅当文件仍属本进程（pid + processStartId 双匹配）才删——闭 PID
 * 复用窗（本进程退出后同 pid 被新进程占走的场合，新 daemon 的文件不被误删）。
 */
export function releaseDaemonState(
  dataRoot: string,
  identity: { readonly pid: number; readonly processStartId: string },
): void {
  const cur = readDaemonState(dataRoot);
  if (cur === undefined) return;
  if (cur.pid !== identity.pid || cur.processStartId !== identity.processStartId) return;
  try {
    unlinkSync(daemonStatePath(dataRoot));
  } catch {
    /* 已被并发清掉——幂等收场 */
  }
}

/* ------------------------------------------------------------------ */
/* token（P1 鉴权物）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 确保 token 在场：既有文件非空 → 用之（并 chmod 0600 收紧历史文件）；缺失/
 * 空文件 → 生成 32 字节 hex 原子写 0600。手动轮换 = 删文件重启（无自动过期）。
 * @returns token 值（父进程 ready-gate 握手与 daemon 子进程共用同一份）
 */
export function ensureDaemonToken(dataRoot: string): string {
  mkdirSync(daemonDirOf(dataRoot), { recursive: true });
  const path = daemonTokenPath(dataRoot);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing !== '') {
      // boot 收紧：历史文件可能带宽权限（手工建/旧版本写）——每次读到即收 0600
      try {
        chmodSync(path, 0o600);
      } catch {
        /* chmod 失败不阻断——写面原子性不受影响，权限面由下次重试 */
      }
      return existing;
    }
  } catch {
    /* 缺失走生成路 */
  }
  const token = randomBytes(32).toString('hex');
  writeAtomicFile(path, token, 0o600);
  return token;
}

/** err 是否为携带指定 code 的 Node 系错误（EEXIST/EACCES 等判别小面） */
function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === code;
}
