/**
 * app — 内核最小 shell 真 pty 交接锁（第九十二批，契约篇 §6.11 内核 shell
 * 交接同律——遗漏大扫 20260903 conc D1-1【high】/conc D1-2【major】/desktop D4-1）。
 *
 * 与 kernel-shell.test.ts（PassThrough 流对）互补：PassThrough 非 TTY 走
 * 非终端行协议，复现不了 raw 模式/流态语义——输入面竞速只有真 pty 探针可靠
 * （第八轮教训）。python3 pty 中继挂真终端：isTTY 真 / setRawMode 真实生效 /
 * pause-resume 真实流态。两锁：
 *
 * - /desktop 接管锁（D1-1 + D4-1）：修前 close 后置在 finally——停流 + TTY
 *   raw 复原砸在已起屏接收方的输入面上，桌面 100% 失聪死锁（'Q' 永不到达，
 *   4s 看门狗 MARKER_DEAD 自曝）；且接管成功还写「桌面已接管」文案——引擎
 *   已占 alt-screen，视觉污染差分永不修复。修后：交出先行 + 静默退位。
 * - /start 泄漏锁（D1-2）：修前只 rl.pause()——停流不拆 data 监听，接收方
 *   resume 即双消费，视图期按键泄漏进 REPL 编辑线（'/apps' 被污染成未知
 *   命令）。修后：交出方三件套先行，视图期按键只有视图一个去向。
 *
 * 纪律同 desktop-boot-order：子脚本经 cfg 注入源路径（临时目录无相对链）、
 * 子进程登记 afterEach 兜杀、真 pty 缺席即跳过不失信。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/* ---------------- 公共基座（desktop-boot-order 同款取舍） ---------------- */

/** 仓内 tsx CLI（src/app → 上两级 = 仓根——子进程以 tsx 转译真源码形态起跑） */
const TSX_CLI = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
/** kernel-shell 源路径（子脚本经 cfg 注入 import——脚本自身在临时目录无相对链） */
const KERNEL_SHELL_TS = fileURLToPath(new URL('./kernel-shell.ts', import.meta.url));

/** 临时目录（realpath 防 macOS /var 符号链——goal 批真缺陷同款） */
function makeTmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/** 子进程登记簿（afterEach 兜杀——测试失败路径不留孤儿进程） */
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    // SIGTERM 兜杀：优雅退出钩子自行收口；不等待（测试已败/已过，收尾不挡道）
    child.kill('SIGTERM');
  }
});

/** 通用轮询等待（daemon-fullstack 同款）：判词转真或超时抛错（含现场输出） */
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

/** 子进程退出码（resolve 型——配合 waitFor 竞速用） */
function waitExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
}

/** 退出码限时等待（超时抛错带现场输出——防子进程悬死挂测试）。
 * 注意 exit 监听必须 spawn 后立即挂（waitExit 先行调用）——事件只发一次，
 * 子进程先退后再挂监听永不触发（exitWithTimeout 只竞速已挂好的 promise） */
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

/* ---------------- 真 pty 中继 + 子脚本（desktop-boot-order 同款） ---------------- */

/**
 * pty 中继脚本（python3 标准库 pty——零新增 npm 依赖）：fork 子进程挂真 pty
 * 从端（isTTY 真 / raw 模式真实生效），自身只在 pty 主端与我们的管道间转抄
 * 字节。macOS `script` 不可用（tcgetattr 前提炸管道 stdio）——python 中继无
 * termios 前提。
 */
const PTY_RELAY_PY = `import os, pty, select, struct, fcntl, termios, subprocess, sys
argv = sys.argv[1:]
master, slave = pty.openpty()
# 显式窗口尺寸 80x24（openpty 缺省 0x0——列 0 会让渲染层除零/空帧）
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
child = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = sys.stdout.buffer
while True:
    if child.poll() is not None:
        break
    try:
        ready, _, _ = select.select([master, sys.stdin], [], [], 0.2)
    except OSError:
        break
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if data:
            out.write(data)
            out.flush()
    if sys.stdin in ready:
        try:
            data = os.read(sys.stdin.fileno(), 65536)
        except OSError:
            data = b''
        if data:
            os.write(master, data)
# 子进程已退：抽干主端余量再退（退出码透传）
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

/** python3 + pty 模块可用性探针（缺席即跳过本审计——非 unix/精简环境不失信） */
let ptyRelayAvailable: boolean | undefined;
function hasPtyRelay(): boolean {
  if (ptyRelayAvailable === undefined) {
    // spawnSync 查退出码——python3 不在/无 pty 模块即非 0；win32 无本形态
    ptyRelayAvailable =
      process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
  }
  return ptyRelayAvailable;
}

/**
 * 交接锁子脚本：真 kernel-shell + 真进程 stdio（真 pty 从端）。接收方（桌面
 * 引擎/应用视图替身）接管输入面的形态与真件同构：setRawMode(true) + resume +
 * 自有 data 面——与修后 shell 的交出次序（close 先行）对上即活；被旧实现的
 * 后置停流/raw 复原砸中即死锁自曝。cfg.mode 分两形态（desktop/start）。
 */
const PTY_CHILD_SCRIPT = `// cfg 经末位 argv 注入（JSON 串）：mode + kernel-shell 源路径
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { runKernelShell } = await import(cfg.shellPath);
const write = (s) => process.stdout.write(s + '\\n');
/** 接收方替身共通：接管真 pty 输入面；返回交还器（拆自有监听 + raw 复原） */
const armReceiver = (onKey) => {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  return () => {
    process.stdin.setRawMode?.(false);
    process.stdin.removeListener('data', onKey);
  };
};
let outcome;
if (cfg.mode === 'desktop') {
  outcome = await runKernelShell({
    banner: 'PTY-LOCK',
    listApps: () => [],
    startApp: async () => ({ ok: true }),
    retryDesktop: async () => {
      // 桌面引擎替身：接管即布防看门狗——4s 内收不到 'Q' = 失聪死锁形态自曝
      armReceiver((b) => {
        if (b.includes(0x51)) { write('MARKER_ALIVE'); process.exit(0); }
      });
      write('TAKEOVER_ARMED');
      setTimeout(() => { write('MARKER_DEAD'); process.exit(2); }, 4000);
      return { ok: true };
    },
    requestExit: () => write('EXITED'),
  });
  write('OUTCOME:' + outcome);
  if (outcome !== 'desktop-takeover') process.exit(3);
  // 接管成功 = shell 静默退位——进程由接收方收口（挂起保活等 'Q'/看门狗）
  await new Promise(() => {});
} else {
  let releaseView;
  outcome = await runKernelShell({
    banner: 'PTY-LOCK',
    listApps: () => [],
    startApp: async () => {
      // 应用视图替身：Esc 交还；其余字节自吞不回显（泄漏形态唯一去向 = shell
      // 旧监听——修前 pause 不拆监听，接收方 resume 即双消费）
      const disarm = armReceiver((b) => {
        if (b.includes(0x1b)) { disarm(); write('VIEW_OFF'); releaseView(); }
      });
      write('VIEW_ON');
      await new Promise((r) => { releaseView = r; });
      return { ok: true };
    },
    retryDesktop: async () => ({ ok: false, error: '不该走到' }),
    requestExit: () => write('EXITED'),
  });
  write('OUTCOME:' + outcome);
  process.exit(outcome === 'exit' ? 0 : 3);
}
`;

describe('kernel-shell 真 pty 交接锁（契约篇 §6.11 交接次序执法）', () => {
  /** 起锁子进程：python3 pty 中继 → tsx 起子脚本（真 TTY stdio），输出全收；
   * exit 监听 spawn 即挂（子进程可能在断言前已退——事件不重放） */
  function spawnLock(mode: 'desktop' | 'start'): {
    child: ChildProcessWithoutNullStreams;
    output: () => string;
    send: (data: string) => void;
    exited: Promise<number | null>;
  } {
    const scriptDir = makeTmpDir('kernel-pty-script-');
    const workspace = makeTmpDir('kernel-pty-ws-');
    const scriptPath = join(scriptDir, 'child.mts');
    const relayPath = join(scriptDir, 'pty-relay.py');
    writeFileSync(scriptPath, PTY_CHILD_SCRIPT);
    writeFileSync(relayPath, PTY_RELAY_PY);
    const cfg = { mode, shellPath: KERNEL_SHELL_TS };
    const child = spawn('python3', [relayPath, process.execPath, TSX_CLI, scriptPath, JSON.stringify(cfg)], {
      env: { ...process.env, APP_LOG_LEVEL: 'warn' },
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    children.push(child);
    const chunks: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => chunks.push(chunk));
    return {
      child,
      output: () => chunks.join(''),
      send: (data: string) => void child.stdin.write(data),
      exited: waitExit(child),
    };
  }

  // python3 pty 中继缺席（非 unix/精简环境）即跳过——审计不失信
  it.skipIf(!hasPtyRelay())(
    '/desktop 接管：交出方先行——接收方输入面活到能收键；静默退位零污染文案（conc D1-1 + desktop D4-1 修死）',
    async () => {
      const lock = spawnLock('desktop');
      await waitFor('REPL 就绪（横幅）', 45_000, () => lock.output().includes('PTY-LOCK'), lock.output);
      lock.send('/desktop\r');
      await waitFor('接收方已布防', 15_000, () => lock.output().includes('TAKEOVER_ARMED'), lock.output);
      // 布防后发 'Q'：修前——retryDesktop 结算后 finally rl.close() 的停流 +
      // raw 复原砸在接收方输入面 → 'Q' 永不到达 → 4s 看门狗 MARKER_DEAD；
      // 修后——交出先行（close 前于起屏），接收方独占活流 → MARKER_ALIVE
      lock.send('Q');
      await waitFor('接收方收到 Q（输入面活）', 15_000, () => lock.output().includes('MARKER_ALIVE'), lock.output);
      const out = lock.output();
      expect(out).toContain('重试桌面起屏');
      expect(out).not.toContain('桌面已接管'); // 静默退位：桌面首帧即回执（D4-1）
      expect(out).not.toContain('MARKER_DEAD'); // 死锁形态未发生
      const code = await exitWithTimeout(lock.exited, 15_000, lock.output);
      expect(code).toBe(0);
    },
    90_000,
  );

  it.skipIf(!hasPtyRelay())(
    '/start 视图期按键不泄漏进 REPL 编辑线：交还后 /apps 干净落行（conc D1-2 修死）',
    async () => {
      const lock = spawnLock('start');
      await waitFor('REPL 就绪（横幅）', 45_000, () => lock.output().includes('PTY-LOCK'), lock.output);
      lock.send('/start chat\r');
      await waitFor('视图已接管', 15_000, () => lock.output().includes('VIEW_ON'), lock.output);
      lock.send('XY'); // 视图期按键——修前同时进 readline 编辑线缓冲（双消费）
      lock.send('\x1b'); // Esc 出视图（交还）
      await waitFor('视图交还', 15_000, () => lock.output().includes('VIEW_OFF'), lock.output);
      await new Promise((resolve) => setTimeout(resolve, 300)); // 重武装落定
      lock.send('/apps\r'); // 修前编辑线带 'XY' 残留 → 行污染 → 未知命令
      await waitFor('清单命令干净落行', 15_000, () => lock.output().includes('组合树空'), lock.output);
      lock.send('/exit\r');
      await waitFor('OUTCOME:exit', 15_000, () => lock.output().includes('OUTCOME:exit'), lock.output);
      const out = lock.output();
      expect(out).not.toContain('未知命令'); // 泄漏形态（行污染）零出现
      const code = await exitWithTimeout(lock.exited, 15_000, lock.output);
      expect(code).toBe(0);
    },
    90_000,
  );
});
