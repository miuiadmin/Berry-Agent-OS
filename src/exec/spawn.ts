/**
 * L4 exec — spawn 管道（骨架篇 §7.6/§9.3 定稿落码）。
 *
 * 职责六件：
 * - **失败二分**：未启动（spawn error 事件）= 抛 EXEC_SPAWN_FAILED 携
 *   cause.code（ENOENT/EACCES/E2BIG），绝不折算 exit 1；已启动退出非零 =
 *   正常返回 { exitCode, stderr }（pi-7：pi 生态吞 spawn 错误逼出七条
 *   正则嗅探的教训）；
 * - **进程组纪律**（pi-7）：一切命令进程建进程组/树——POSIX detached +
 *   killpg 负 pid 树杀；Windows 先 PowerShell 快照进程表 PPID 边、自根
 *   闭包多 /PID 单发 + /T 竞态带（2026-08-27 P1-3 树杀两补，挖矿 B11
 *   缺口②：MSYS fork 斩父链场景裸 taskkill /T 漏杀孤儿；POSIX 结构性
 *   免疫——reparent 不改 pgid，killpg 即树等价物）。kill 永远杀树，
 *   不只杀直接子进程；
 * - **超时自治**：execute 内自计时，到点树杀并抛 TOOL_TIMEOUT（复用工具族
 *   码义不另立 EXEC_TIMEOUT——码族不膨胀；调用方 def 级预算旁路由 bash
 *   工具件负责置最高护栏值实现）；
 * - **输出预算**：stdout/stderr 合并预算保尾截断（与 durable 写侧同值
 *   60 KiB——模型所见与落库同一文本，无两层分叉；锚 = 终态文本 UTF-8
 *   字节，骨架篇 §7.6 输出护栏）；
 * - **输出编码**（2026-08-27 P1-3，挖矿 B11 缺口④ spawn 半边）：两流各自
 *   走骨架篇 §7.5 决策树（本地标签取 OEM——控制台输出面）；活体流式
 *   fatal UTF-8、首错切码页解码器（chunk 粒度重放——已发前缀不重复，
 *   边界至多 1 替换符损耗；中间态允许近似，终态以终判文本为准）；
 *   终段有损收文本 + outputEncoding 按流标注（「标注的转码」不是
 *   「静默错猜」）；
 * - **windowsHide 统一纪律**：本层一切 spawn（命令体/taskkill/树枚举器）
 *   无窗——win32 下 CREATE_NO_WINDOW，stdio 管道语义不变（唯一未来例外
 *   = 持久 PTY 挂账件，骨架篇 §7.6）。
 */

import { spawn } from 'node:child_process';
import { AppError, EXEC_SPAWN_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { decodeText, peekLocalCodepageLabels, resolveLocalCodepageLabels } from '../context/index.js';
import type { SandboxMeta } from '../contracts/exec.js';
import { buildChildEnv } from './env.js';

/** 输出合并预算（字节）——与 durable 写侧内容预算同值（src/chat/durable.ts），骨架篇 §7.6 对齐 */
export const OUTPUT_BUDGET_BYTES = 60 * 1024;

/** 流式采集过程中的内存硬顶（单流）——防超长输出撑爆内存；超过即丢头保尾 */
const STREAM_HARD_CAP_BYTES = 2 * 1024 * 1024;

/** 原语运行选项（bash 工具件与 ctx.exec 服务共用——env 表由各自选项面翻译过来） */
/**
 * 命令进程登记簿注入面（宿主猝死孤儿治理——契约篇 §6.6 子进程治理条 exec 腿，
 * 2026-08-29 critic #1）：spawn 即 add（pid + 命令行标签——标签 = PID 复用
 * 防护的比对基线）、净退即 remove（close 一路收全：正常退出/超时树杀/取消
 * 树杀/信号死）。组合根注 mcp ChildRegistry 适配器——exec 结构上不见 mcp
 * （killTree 闭包注入同款先例，拓扑边零新增）。
 */
export interface CommandProcessLog {
  /** spawn 即登记（进程真启动才来——'spawn' 事件配对） */
  add(pid: number, label: string): void;
  /** 净退即删（幂等——重复删无害） */
  remove(pid: number): void;
}

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
  /** 命令进程登记簿（宿主猝死后由启动期孤儿清扫认领树杀；缺省不登记） */
  readonly commandLog?: CommandProcessLog;
}

/** 单流编码终判标注：'utf-8' | '<本地标签>'（③命中） | '<标签>-lossy'（④终段有损） */
export type StreamEncoding = string;

/** 原语运行结果（ExecResult 减沙箱元数据——沙箱包装由调用层负责，本层只见裸进程） */
export interface RunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly durationMs: number;
  /** 按流独立的编码终判（骨架篇 §7.6——bash 内建 UTF-8 + 原生命令 OEM 分叉是 win32 常态） */
  readonly outputEncoding: { readonly stdout: StreamEncoding; readonly stderr: StreamEncoding };
  readonly signal?: string;
}

/** 单流终态（finalize 内部产物——文本 + 判定路径，供 outputEncoding 组装） */
interface StreamFinal {
  readonly text: string;
  readonly encoding: StreamEncoding;
  readonly method: 'bom' | 'utf8' | 'local' | 'lossy';
}

/**
 * 活体流式解码器：fatal UTF-8 起步，首个非法字节即切码页有损解码器
 * （骨架篇 §7.6「输出编码」流式形态）。chunk 粒度重放：fatal decode 抛错
 * 时该 chunk 零产出（decode 原子性），整 chunk 交码页解码器重解——已推
 * onOutput 的前缀不重复发射。中间态允许近似（标签未探得时走替换符路径），
 * 终态以 finalize 决策树终判文本为准（本类只服务活体预览）。
 */
class StreamTextDecoder {
  /** 起步解码器：严格 UTF-8（stream 模式跨 chunk 保多字节序列） */
  private decoder = new TextDecoder('utf-8', { fatal: true });
  /** 切换后的码页有损解码器（null = 尚在 UTF-8 路上；类型取构造器实例形） */
  private fallback: InstanceType<typeof TextDecoder> | null = null;

  constructor(private readonly localLabel: string | null) {}

  /** 收一块 Buffer 返回活体文本（近似——终态另走决策树） */
  push(chunk: Buffer): string {
    if (this.fallback !== null) return this.fallback.decode(chunk, { stream: true });
    try {
      return this.decoder.decode(chunk, { stream: true });
    } catch {
      // 首个非法字节：切码页有损解码器（标签缺席/不支持 = utf-8 替换符路）
      this.fallback = makeLossyDecoder(this.localLabel);
      return this.fallback.decode(chunk, { stream: true });
    }
  }
}

/** 构码页有损解码器（标签不支持/缺席退 utf-8 替换符——活体中间态接受面） */
function makeLossyDecoder(label: string | null): InstanceType<typeof TextDecoder> {
  if (label != null && label !== '') {
    try {
      return new TextDecoder(label);
    } catch {
      // ICU 不支持该标签（small-icu 构建）——替换符路
    }
  }
  return new TextDecoder('utf-8');
}

/** 流式采集器：原始字节留档（超硬顶丢头保尾），活体解码推 onOutput，终态走决策树 */
class OutputCollector {
  /** 各流原始字节块（丢头 = shift 整块，粒度即 chunk 粒度——编码未定不动字节） */
  private readonly parts: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
  /** 各流累计字节数（丢头时同步扣减——Buffer 字节精确计） */
  private readonly sizes: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };
  /** 各流活体解码器（onOutput 预览用——与终态解码独立） */
  private readonly live: Record<'stdout' | 'stderr', StreamTextDecoder>;
  /** 是否触发过硬顶丢头 */
  private droppedHead = false;

  constructor() {
    // 活体码页标签：同步窥探缓存（未探得 = 替换符近似；终态另等探测重解码）
    const oem = peekLocalCodepageLabels().oem;
    this.live = { stdout: new StreamTextDecoder(oem), stderr: new StreamTextDecoder(oem) };
  }

  /** 收一块：推回调 + 留档（超硬顶从最老块丢起） */
  push(stream: 'stdout' | 'stderr', chunk: Buffer, onOutput: RunArgvOptions['onOutput']): void {
    if (chunk.length === 0) return;
    const text = this.live[stream].push(chunk);
    this.parts[stream].push(chunk);
    this.sizes[stream] += chunk.length;
    if (onOutput !== undefined && text !== '') onOutput({ stream, text });
    while (this.sizes[stream] > STREAM_HARD_CAP_BYTES && this.parts[stream].length > 1) {
      // 丢最老块（至少留最新一块——当前块永不自丢）；丢头不对齐是接受面
      // （骨架篇 §7.6 字节窗两层角色——判定侧 decodeText 头部容忍兜底）
      const head = this.parts[stream].shift()!;
      this.sizes[stream] -= head.length;
      this.droppedHead = true;
    }
  }

  /**
   * 终态结算：两流各自走决策树（OEM 标签），再做合并预算保尾截断。
   * 预算锚 = 终态文本 UTF-8 字节（解码在先、截断在后——tailUtf8 既有语义）。
   */
  finalize(oemLabel: string | null): { stdout: StreamFinal; stderr: StreamFinal; truncated: boolean } {
    const out = decodeStream(this.parts.stdout, oemLabel);
    const err = decodeStream(this.parts.stderr, oemLabel);
    const total = Buffer.byteLength(out.text, 'utf8') + Buffer.byteLength(err.text, 'utf8');
    if (total <= OUTPUT_BUDGET_BYTES) {
      return { stdout: out, stderr: err, truncated: this.droppedHead };
    }
    // 超预算：stdout 上限半预算、stderr 吃余量（两流都不越合计线，保尾）
    const stdoutText = tailString(out.text, Math.floor(OUTPUT_BUDGET_BYTES / 2));
    const stderrText = tailString(err.text, OUTPUT_BUDGET_BYTES - Buffer.byteLength(stdoutText, 'utf8'));
    return { stdout: { ...out, text: stdoutText }, stderr: { ...err, text: stderrText }, truncated: true };
  }
}

/** 单流终态解码：原始字节窗 → 决策树（BOM/严格 UTF-8/OEM 码页/有损） */
function decodeStream(parts: readonly Buffer[], oemLabel: string | null): StreamFinal {
  const decoded = decodeText(Buffer.concat(parts), { localLabel: oemLabel });
  return { text: decoded.text, encoding: decoded.encoding, method: decoded.method };
}

/** 终态文本保尾截断（至多 maxBytes 字节 UTF-8；起点落在多字节中间前移过续字节） */
function tailString(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  return tailUtf8(Buffer.from(text, 'utf8'), maxBytes);
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

/** killTree 注入面（测试与特殊装配用——缺省全真；deps 形状断言测 win32 腿） */
export interface KillTreeDeps {
  /** 平台判定（缺省 process.platform） */
  readonly platform?: NodeJS.Platform;
  /** 杀进程 spawn 探针（缺省 node:child_process.spawn——测试记参序） */
  readonly spawnKill?: typeof spawn;
  /** 进程树枚举器（缺省 PowerShell 快照——测试注入同步假树） */
  readonly enumerateTree?: (root: number) => Promise<readonly number[]>;
}

/**
 * 按进程组纪律终结进程树（骨架篇 §7.6 进程组纪律，pi-7）：
 * POSIX 用 killpg 负 pid（spawn 时 detached 建组；reparent 不改 pgid——
 * 结构性免疫孤儿）；Windows 先快照再单发 taskkill 多 /PID + /T（异步
 * fire-and-forget——失败静默，进程可能已退出，close 事件自会结算）。
 *
 * 2026-08-26 导出（mcp 第一刀冷读 #1 裁决）：调用方 = 组合根闭包
 * （app/mcp-spawn.ts——mcp 件经闭包收 killTree，结构上不见 exec）。
 */
export function killTree(pid: number | undefined, childPidAlive: () => boolean, deps: KillTreeDeps = {}): void {
  if (pid === undefined) return;
  if ((deps.platform ?? process.platform) === 'win32') {
    void win32KillTree(pid, deps).catch(() => undefined);
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
 * win32 树杀两步：① PowerShell 快照进程表 PPID 边、自根闭包得多 /PID 集；
 * ② taskkill 单发多 /PID + /T（/T 是竞态带——快照后新孤儿由它尽力兜）。
 * 枚举失败/超时回退裸 taskkill /T /PID root（等价旧行为，绝不空手而归）。
 * 快照成本亚秒到秒级（骨架篇 §7.6 诚实声明）；Job Object 终态挂账 M2+。
 */
async function win32KillTree(pid: number, deps: KillTreeDeps): Promise<void> {
  const spawnKill = deps.spawnKill ?? spawn;
  let pids: readonly number[];
  try {
    pids = await (deps.enumerateTree ?? enumerateProcessTree)(pid);
  } catch {
    pids = [pid];
  }
  const args: string[] = ['/T', '/F'];
  for (const p of pids) args.push('/PID', String(p));
  await new Promise<void>((resolve) => {
    const child = spawnKill('taskkill', args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

/**
 * PowerShell 进程树快照：Get-CimInstance Win32_Process（wmic 已弃用——
 * 主路走 CIM）全表 PPID 边，自根 BFS 闭包得树内全部 PID。
 * 输出走 ConvertTo-Csv（ASCII 数字行——latin1 字节保真解，不涉本地码页）。
 */
function enumerateProcessTree(root: number): Promise<readonly number[]> {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let out = '';
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error('进程表快照超时（>10s）'));
    }, 10_000);
    ps.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('latin1');
    });
    ps.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ps.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`进程表快照退出码 ${code}`));
        return;
      }
      // CSV 行形如 "1234","567"——pid→ppid 边表（表头/空行自然不匹配）
      const edges = new Map<number, number>();
      for (const line of out.split(/\r?\n/)) {
        const m = /^"(\d+)","(\d+)"$/.exec(line.trim());
        if (m !== null) edges.set(Number(m[1]), Number(m[2]));
      }
      if (!edges.has(root)) {
        // 根已消失（快照前自亡）——杀根即无靶，交裸 taskkill 空转
        resolve([root]);
        return;
      }
      // 自根闭包 BFS（内层线性扫边表——进程表百行量级，无须索引）
      const pids: number[] = [];
      const queue = [root];
      const seen = new Set<number>([root]);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        pids.push(cur);
        for (const [childPid, ppid] of edges) {
          if (ppid === cur && !seen.has(childPid)) {
            seen.add(childPid);
            queue.push(childPid);
          }
        }
      }
      resolve(pids);
    });
  });
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
    // detached（POSIX）= 新进程组（child.pid 即 pgid）——树杀的前提；
    // windowsHide = 无窗纪律（win32 CREATE_NO_WINDOW，stdio 管道语义不变）
    const child = spawn(program, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? buildChildEnv(process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    // 命令进程登记：真启动才登记（'spawn' 事件——ENOENT 等未启动形态无 pid
    // 无条目），撤销与 'close' 配对（Node 保证已启动进程 error 后 close 仍来）。
    // 标签 = 命令行前缀（PID 复用防护的 includes 比对基线；长命令截前缀不失配）
    child.on('spawn', () => {
      if (child.pid !== undefined) opts.commandLog?.add(child.pid, argv.join(' ').slice(0, 256));
    });
    child.on('close', () => {
      if (child.pid !== undefined) opts.commandLog?.remove(child.pid);
    });

    let settled = false; // close 与 error 竞速的单次结算闸
    let closeInfo: { code: number | null; signal: string | null } | undefined;
    let spawnError: Error | undefined;
    let timedOut = false;

    /** 正常结算路：终态文本走两段式（快路同步窥探；lossy 未定才等探测） */
    const resolveResult = (finalized: ReturnType<OutputCollector['finalize']>): void => {
      const info = closeInfo!;
      resolve({
        exitCode: info.code,
        stdout: finalized.stdout.text,
        stderr: finalized.stderr.text,
        truncated: finalized.truncated,
        durationMs: Date.now() - started,
        outputEncoding: { stdout: finalized.stdout.encoding, stderr: finalized.stderr.encoding },
        ...(info.signal !== null ? { signal: info.signal } : {}),
      });
    };

    /** 一次性结算（两事件都可能来：spawn 失败时 error 先至、close 可能跟随） */
    const settle = (): void => {
      if (settled || closeInfo === undefined) return;
      settled = true;
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
      // 结算文本两段式：先同步窥探缓存标签解码；仅终判 lossy（编码未定）时
      // 等码页探测完成重解码一次——干净 UTF-8 输出零探测开销，首条非 UTF-8
      // 输出才付一次 reg query（探测进程内缓存，此后永走快路）
      const quick = collector.finalize(peekLocalCodepageLabels().oem);
      const unresolved = quick.stdout.method === 'lossy' || quick.stderr.method === 'lossy';
      if (!unresolved) {
        resolveResult(quick);
        return;
      }
      void resolveLocalCodepageLabels().then((labels) => {
        // 非 win32 探测即时空对——lossy 终态不变，多一 microtask 无害
        resolveResult(collector.finalize(labels.oem));
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

    // 流式采集：原始字节留档（编码决策后置到结算——setEncoding('utf8')
    // 硬编码已退役，挖矿 B11 缺口④）；活体解码在 collector 内（近似预览）
    child.stdout.on('data', (chunk: Buffer) => collector.push('stdout', chunk, opts.onOutput));
    child.stderr.on('data', (chunk: Buffer) => collector.push('stderr', chunk, opts.onOutput));

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
