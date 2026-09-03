/**
 * desktop — 桌面引擎硬退备屏复原真 pty 锁（TUI-1 同族；骨架篇 §1.3 终端态
 * 复原条款——桌面栈腿执法）。
 *
 * 标的：DesktopEngine 进屏写 ENTER_MODES（备屏 1049h + 光标藏 + 粘贴开 +
 * kitty 推栈），持屏窗内 fatal exit(1)/二次 SIGINT exit(130) 不经 dispose
 * （LEAVE_MODES 不写）——用户被留在死备屏：shell 不可见、scrollback 丢失，
 * 直到外部重写 1049l。修法 = 引擎 start/resume 武装 process exit 复位钩子、
 * suspend/dispose 解除（仅真 ProcessTerminalIO）。
 *
 * 为什么必须真 pty：备屏/私有模式是写字节开启的设备态，PassThrough 非 TTY
 * 复现不了——kernel-shell.pty.test.ts 同款判语。python3 pty 中继挂真终端，
 * 子进程以 tsx 起真 DesktopEngine（缺省 ProcessTerminalIO——io 不注入）。
 *
 * 两腿（字节计数判据，tui-exit.pty 同款）：
 * - graceful 对照腿：dispose 后退——LEAVE_MODES 自写（1049l 必须在场），
 *   验收计数法本身能看见出屏写（防坏计数法假绿）；
 * - fatal 腿：进屏后直接 process.exit(1)——修前 1049l 零在场（红：死备屏
 *   残留），修后复原钩子补位（1049l + kitty 弹栈在场）。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/* ---------------- 公共基座（tui-exit.pty / kernel-shell.pty 同款取舍） ---------------- */

/** 仓内 tsx CLI（src/desktop → 上三级 = 仓根——子进程以 tsx 转译真源码形态起跑） */
const TSX_CLI = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
/** 引擎源路径（子脚本经 cfg 注入 import——脚本自身在临时目录无相对链） */
const ENGINE_TS = fileURLToPath(new URL('./engine.ts', import.meta.url));

/** 临时目录（realpath 防 macOS /var 符号链——goal 批真缺陷同款） */
function makeTmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/** 子进程登记簿（afterEach 兜杀——测试失败路径不留孤儿进程） */
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
});

/** 子进程退出码（resolve 型——exit 监听 spawn 后立即挂，事件只发一次） */
function waitExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
}

/** 退出码限时等待（超时抛错带现场输出——防子进程悬死挂测试） */
async function exitWithTimeout(
  exited: Promise<number | null>,
  timeoutMs: number,
  output: () => string,
): Promise<number | null> {
  const timer = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`子进程 ${timeoutMs}ms 未退出——输出尾段：\n${output().slice(-1500)}`)),
      timeoutMs,
    );
  });
  return Promise.race([exited, timer]);
}

/** 通用轮询等待：判词转真或超时抛错（含现场输出） */
async function waitFor(what: string, timeoutMs: number, pred: () => boolean, output: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) {
      throw new Error(`等待超时（${what}，${timeoutMs}ms）——当前输出尾段：\n${output().slice(-1500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** pty 中继脚本（python3 标准库 pty——零新增 npm 依赖；kernel-shell.pty 同款） */
const PTY_RELAY_PY = `import os, pty, select, struct, fcntl, termios, subprocess, sys
argv = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
child = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = sys.stdout.buffer
while True:
    if child.poll() is not None:
        break
    try:
        ready, _, _ = select.select([master], [], [], 0.2)
    except OSError:
        break
    if ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if data:
            out.write(data)
            out.flush()
while True:
    try:
        data = os.read(master, 65536)
    except OSError:
        break
    if not data:
        break
    out.write(data)
sys.exit(child.returncode or 0)
`;

/** python3 + pty 模块可用性探针（缺席即跳过——非 unix/精简环境不失信） */
let ptyRelayAvailable: boolean | undefined;
function hasPtyRelay(): boolean {
  if (ptyRelayAvailable === undefined) {
    ptyRelayAvailable =
      process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
  }
  return ptyRelayAvailable;
}

/**
 * 复原锁子脚本：真 DesktopEngine + 缺省 ProcessTerminalIO（io 不注入 = 真身
 * ——复原钩子只对真 io 武装）。cfg.mode 两形态：graceful 走 dispose 正常
 * 出屏（对照腿）；fatal 进屏后直接 process.exit(1) 硬退（修前零出屏写红位）。
 */
const PTY_CHILD_SCRIPT = `// cfg 经末位 argv 注入（JSON 串）：mode + 引擎源路径
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { DesktopEngine } = await import(cfg.enginePath);
const engine = new DesktopEngine(); // io 不注入 = 真 ProcessTerminalIO（pty 从端）
// 最小渲染树根（空渲染——本锁只验终端设备态，不验渲染内容）
engine.start({ desiredHeight: () => 1, render() {} });
process.stdout.write('PROBE_READY\\n');
setTimeout(() => {
  if (cfg.mode === 'graceful') {
    // 对照腿：正常出屏——dispose 自写 LEAVE_MODES（1049l 必须在场）
    engine.dispose();
    process.exit(0);
  }
  // fatal 腿：硬退镜像——signals.ts onFatalExit 的 surface.exit(1) 同为
  // process.exit(1)，'exit' 钩子是唯一兜底位；零 dispose
  process.exit(1);
}, 1500);
`;

describe('桌面引擎硬退备屏复原真 pty 锁（骨架篇 §1.3 终端态复原——桌面栈腿）', () => {
  /** 起锁子进程：python3 pty 中继 → tsx 起子脚本（真 TTY stdio），输出全收 */
  function spawnLock(mode: 'graceful' | 'fatal'): {
    output: () => string;
    exited: Promise<number | null>;
  } {
    const scriptDir = makeTmpDir('desktop-exit-script-');
    const scriptPath = join(scriptDir, 'child.mts');
    const relayPath = join(scriptDir, 'pty-relay.py');
    writeFileSync(scriptPath, PTY_CHILD_SCRIPT);
    writeFileSync(relayPath, PTY_RELAY_PY);
    const cfg = { mode, enginePath: ENGINE_TS };
    const child = spawn('python3', [relayPath, process.execPath, TSX_CLI, scriptPath, JSON.stringify(cfg)], {
      env: { ...process.env, APP_LOG_LEVEL: 'warn' },
      cwd: scriptDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    children.push(child);
    const chunks: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => chunks.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => chunks.push(chunk)); // tsx 报错混收——诊断现场
    return { output: () => chunks.join(''), exited: waitExit(child) };
  }

  /** 终端序列计数（字节级判据——tui-exit.pty 同款 on/off 归因） */
  const count = (out: string, seq: string): number => out.split(seq).length - 1;

  it.skipIf(!hasPtyRelay())(
    'graceful 对照腿：dispose 出屏写在场（1049l + kitty 弹栈 ≥1——计数法有效性的活证）',
    async () => {
      const lock = spawnLock('graceful');
      await waitFor('引擎进屏（PROBE_READY）', 45_000, () => lock.output().includes('PROBE_READY'), lock.output);
      const code = await exitWithTimeout(lock.exited, 30_000, lock.output);
      expect(code).toBe(0);
      const out = lock.output();
      // 进屏确实开了备屏（判据前提：数的是「出屏」不是「从未进屏」）
      expect(count(out, '\x1b[?1049h')).toBeGreaterThanOrEqual(1);
      // dispose 单源出屏在场——修前修后都必须绿（否则计数法坏 = fatal 腿假绿）
      expect(count(out, '\x1b[?1049l')).toBeGreaterThanOrEqual(1);
      expect(count(out, '\x1b[<u')).toBeGreaterThanOrEqual(1);
    },
  );

  it.skipIf(!hasPtyRelay())(
    'fatal 硬退腿：exit(1) 复原钩子补位（修前 1049l/kitty 弹栈零在场 = 死备屏残留红）',
    async () => {
      const lock = spawnLock('fatal');
      await waitFor('引擎进屏（PROBE_READY）', 45_000, () => lock.output().includes('PROBE_READY'), lock.output);
      const code = await exitWithTimeout(lock.exited, 30_000, lock.output);
      expect(code).toBe(1); // 硬退退出码透传（复原不吞退出码）
      const out = lock.output();
      // 进屏写在场（引擎真武装了终端——判据前提）
      expect(count(out, '\x1b[?1049h')).toBeGreaterThanOrEqual(1);
      // 出屏写必须在场：修前这两行全 0（dispose 不经、'exit' 钩子不存在 = 死备屏）
      expect(count(out, '\x1b[?1049l')).toBeGreaterThanOrEqual(1); // 备屏出（回主屏）
      expect(count(out, '\x1b[<u')).toBeGreaterThanOrEqual(1); // kitty 键盘协议弹栈
    },
  );
});
