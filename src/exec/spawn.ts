/**
 * L4 exec — spawn 管道（骨架篇 §7.6/§9.3 定稿落码）。
 *
 * 职责四件：
 * - **失败二分**：未启动（spawn error 事件）= 抛 EXEC_SPAWN_FAILED 携
 *   cause.code（ENOENT/EACCES/E2BIG），绝不折算 exit 1；已启动退出非零 =
 *   正常返回 { exitCode, stderr }（pi-7：pi 生态吞 spawn 错误逼出七条
 *   正则嗅探的教训）；
 * - **进程组纪律**（pi-7）：一切命令进程建进程组/树——POSIX detached +
 *   killpg 负 pid 树杀；Windows taskkill /T 按树终结。kill 永远杀树，
 *   不只杀直接子进程；
 * - **超时自治**：execute 内自计时，到点树杀并抛 TOOL_TIMEOUT（复用工具族
 *   码义不另立 EXEC_TIMEOUT——码族不膨胀；调用方 def 级预算旁路由 bash
 *   工具件负责置最高护栏值实现）；
 * - **输出预算**：stdout/stderr 合并预算保尾截断（与 durable 写侧同值
 *   60 KiB——模型所见与落库同一文本，无两层分叉；骨架篇 §7.6 输出护栏）。
 */

import { spawn } from 'node:child_process';
import { AppError, EXEC_SPAWN_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import type { SandboxMeta } from '../contracts/exec.js';
import { buildChildEnv } from './env.js';

/** 输出合并预算（字节）——与 durable 写侧内容预算同值（src/chat/durable.ts），骨架篇 §7.6 对齐 */
export const OUTPUT_BUDGET_BYTES = 60 * 1024;

/** 流式采集过程中的内存硬顶（单流）——防超长输出撑爆内存；超过即丢头保尾 */
const STREAM_HARD_CAP_BYTES = 2 * 1024 * 1024;

/** 原语运行选项（bash 工具件与 ctx.exec 服务共用——env 表由各自选项面翻译过来） */
export interface RunArgvOptions {
  /** 工作目录（缺省宿主 cwd） */
  readonly cwd?: string;
  /** 超时毫秒（到点树杀 + 抛 TOOL_TIMEOUT；缺省不限——bash 工具件已钳制） */
  readonly timeoutMs?: number;
  /** 取消信号（abort 即树杀；已启动的进程按正常结算，signal 记 SIGTERM） */
  readonly signal?: AbortSignal;
  /** UTF-8 写入 stdin 后关闭（v1 无流式喂入） */
  readonly stdin?: string;
  /** 环境变量表（buildChildEnv 产物——白名单+变更表已合成完毕） */
  readonly env?: Record<string, string>;
  /** 流式增量回调（执行中即推——run-to-completion 单品是 pi-7 反面） */
  readonly onOutput?: (chunk: { readonly stream: 'stdout' | 'stderr'; readonly text: string }) => void;
}

/** 原语运行结果（ExecResult 减沙箱元数据——沙箱包装由调用层负责，本层只见裸进程） */
export interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  readonly signal?: string;
}

/** 流式采集器：边推 onOutput 边留档，超硬顶丢头保尾（内存护栏） */
class OutputCollector {
  /** 各流文本块（丢头 = shift 整块，粒度即 chunk 粒度） */
  private readonly parts: Record<'stdout' | 'stderr', string[]> = { stdout: [], stderr: [] };
  /** 各流累计字节数（丢头时同步扣减） */
  private readonly sizes: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };
  /** 是否触发过硬顶丢头 */
  private droppedHead = false;

  /** 收一块：推回调 + 留档（超硬顶从最老块丢起） */
  push(stream: 'stdout' | 'stderr', text: string, onOutput: RunArgvOptions['onOutput']): void {
    if (text === '') return;
    this.parts[stream].push(text);
    this.sizes[stream] += Buffer.byteLength(text, 'utf8');
    if (onOutput !== undefined) onOutput({ stream, text });
    while (this.sizes[stream] > STREAM_HARD_CAP_BYTES && this.parts[stream].length > 1) {
      // 丢最老块（至少留最新一块——当前块永不自丢）；size 按字节近似扣减
      const head = this.parts[stream].shift()!;
      this.sizes[stream] -= Buffer.byteLength(head, 'utf8');
      this.droppedHead = true;
    }
  }

  /** 终态文本：两流合并预算（60 KiB）保尾截断（UTF-8 安全边界） */
  finalize(): { stdout: string; stderr: string; truncated: boolean } {
    // 合并预算：超出即从 stdout 头部开始丢（保尾——错误信息/结论通常在尾部）
    const outBuf = Buffer.from(this.parts.stdout.join(''), 'utf8');
    const errBuf = Buffer.from(this.parts.stderr.join(''), 'utf8');
    const total = outBuf.length + errBuf.length;
    if (total <= OUTPUT_BUDGET_BYTES) {
      return { stdout: outBuf.toString('utf8'), stderr: errBuf.toString('utf8'), truncated: this.droppedHead };
    }
    // 超预算：stdout 上限半预算、stderr 吃余量（两流都不越合计线）
    const stdout = tailUtf8(outBuf, Math.floor(OUTPUT_BUDGET_BYTES / 2));
    const stderr = tailUtf8(errBuf, OUTPUT_BUDGET_BYTES - Buffer.byteLength(stdout, 'utf8'));
    return { stdout, stderr, truncated: true };
  }
}

/**
 * 取缓冲区尾部至多 maxBytes 字节（UTF-8 安全：起点若落在多字节字符中间，
 * 前移过续字节——产至多 3 字节损耗，不产 U+FFFD 乱码首字符）。
 */
function tailUtf8(buf: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let start = Math.max(0, buf.length - maxBytes);
  // 续字节 = 0b10xxxxxx（0x80-0xBF）：起点在字符中间就前移到真字符边界
  while (start > 0 && start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

/**
 * 按进程组纪律终结进程树（骨架篇 §7.6 进程组纪律，pi-7）：
 * POSIX 用 killpg 负 pid（spawn 时 detached 建组）；Windows 用 taskkill /T。
 * 失败静默（进程可能已退出——close 事件自会结算）。
 */
function killTree(pid: number | undefined, childPidAlive: () => boolean): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows：按树终结（/T 含子进程；/F 强制——超时路径不Graceful）
    spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    return;
  }
  try {
    // POSIX：负 pid = 进程组整组信号（组内全部命令进程一并终结）
    if (childPidAlive()) process.kill(-pid, 'SIGKILL');
  } catch {
    // 组已不存在（主进程先退出带塌了组）——无事可做
  }
}

/**
 * spawn 一条 argv 并跑到结算（不包装沙箱——沙箱 confine 是调用层的事，
 * 本层只见裸 argv；bash 工具件与 ctx.exec 服务共用本管道）。
 *
 * @throws AppError(EXEC_SPAWN_FAILED) 未启动（失败二分的「未启动」腿）
 * @throws AppError(TOOL_TIMEOUT) 超时（树杀后抛——自治超时，不依赖外层预算）
 */
export async function runArgv(argv: readonly string[], opts: RunArgvOptions = {}): Promise<RunResult> {
  const started = Date.now();
  const collector = new OutputCollector();
  const program = argv[0] ?? '';
  if (program === '') {
    // 空 argv 是调用方 bug——按「未启动」类处理（无进程可谈）
    throw new AppError(EXEC_SPAWN_FAILED, 'argv 为空（无可执行的程序名）');
  }

  return await new Promise<RunResult>((resolve, reject) => {
    // detached（POSIX）= 新进程组（child.pid 即 pgid）——树杀的前提
    const child = spawn(program, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? buildChildEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    let settled = false; // close 与 error 竞速的单次结算闸
    let closeInfo: { code: number | null; signal: string | null } | undefined;
    let spawnError: Error | undefined;
    let timedOut = false;

    /** 一次性结算（两事件都可能来：spawn 失败时 error 先至、close 可能跟随） */
    const settle = (): void => {
      if (settled || closeInfo === undefined) return;
      settled = true;
      const { stdout, stderr, truncated } = collector.finalize();
      if (spawnError !== undefined) {
        // 失败二分·未启动腿：绝不折算 exit 1（Node error.cause.code 是身份）
        const causeCode =
          spawnError instanceof Error && 'code' in spawnError
            ? String((spawnError as NodeJS.ErrnoException).code ?? '')
            : '';
        reject(
          new AppError(
            EXEC_SPAWN_FAILED,
            `子进程未启动：${program}${causeCode !== '' ? `（cause.code=${causeCode}）` : ''}：${spawnError.message}`,
            { cause: spawnError },
          ),
        );
        return;
      }
      if (timedOut) {
        // 超时腿：树杀已完成（killTree 即时执行），抛 TOOL_TIMEOUT（码族复用）
        reject(new AppError(TOOL_TIMEOUT, `命令执行超时（>${opts.timeoutMs}ms），进程组已树杀：${program}`));
        return;
      }
      resolve({
        exitCode: closeInfo.code,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - started,
        ...(closeInfo.signal !== null ? { signal: closeInfo.signal } : {}),
      });
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      // spawn/启动失败（ENOENT 找不到程序、EACCES 无权限、E2BIG env 超限）
      spawnError = err;
      if (closeInfo === undefined) {
        // 无 close 跟随的早期失败（典型 ENOENT）：合成 close 语义立即结算
        closeInfo = { code: null, signal: null };
        settle();
      }
    });
    child.on('close', (code, signal) => {
      closeInfo = { code, signal };
      settle();
    });

    // 流式采集：setEncoding 使 data 事件直接给 UTF-8 字符串（多字节安全）
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collector.push('stdout', chunk, opts.onOutput));
    child.stderr.on('data', (chunk: string) => collector.push('stderr', chunk, opts.onOutput));

    // stdin：一次性写入后关闭（v1 无流式喂入——骨架篇 §9.3 刻意不对称）
    if (opts.stdin !== undefined) {
      child.stdin.on('error', () => undefined); // 子进程不读 stdin 的 EPIPE 不算失败
      child.stdin.end(opts.stdin, 'utf8');
    } else {
      child.stdin.end();
    }

    /** 树杀并标记超时（结算走 close 事件——等进程真死再抛，flush 已采集输出） */
    const armTimeout = (): void => {
      timedOut = true;
      killTree(child.pid, () => child.exitCode === null);
    };
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      const timer = setTimeout(armTimeout, opts.timeoutMs);
      // 进程结算后清计时器（防泄漏与误触发）
      child.on('close', () => clearTimeout(timer));
    }
    if (opts.signal !== undefined) {
      // 取消信号：树杀 + 正常结算（close 记录 signal=SIGKILL——「已启动被外部取消」
      // 不是失败二分的任何一腿，不抛错；调用方以 signal 字段识别取消）
      const onAbort = (): void => {
        timedOut = false;
        killTree(child.pid, () => child.exitCode === null);
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 把 stderr 按后端 denialSignatures 分类（骨架篇 §7.6 结果元数据）：
 * 命中签名的列表（大小写不敏感子串）；空数组 = 未命中（命令正常跑完）。
 */
export function classifyDenials(stderr: string, denialSignatures: readonly string[]): readonly string[] {
  const lower = stderr.toLowerCase();
  const hits: string[] = [];
  for (const sig of denialSignatures) {
    if (sig !== '' && lower.includes(sig.toLowerCase())) hits.push(sig);
  }
  return hits;
}

/** 沙箱元数据类型再导出（bash 工具件与 ExecResult 组装共用——类型单一来源在 contracts） */
export type { SandboxMeta };
