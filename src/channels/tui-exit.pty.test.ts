/**
 * channels — TUI 硬退终端态复原真 pty 锁（第十轮 TUI 专项扫雷 TUI-1；骨架篇
 * §1.3 终端态复原条款执法）。
 *
 * 标的：硬退路径（fatal exit(1) / 二次 SIGINT exit(130)）不经 tui.stop()——
 * 终端私有模式（括号粘贴 / kitty 键盘协议栈 / modifyOtherKeys）是写字节开启
 * 的设备态，进程退出不自动复原，崩溃后宿主 shell 键序错乱。修法 = 通道工厂
 * 层（createTuiChannel）起屏武装 process exit 复原钩子、停屏解除（仅真
 * ProcessTerminal）。
 *
 * 为什么必须真 pty：PassThrough 非 TTY 复现不了私有模式设备态（起屏写不发生
 * / raw 模式无意义）——kernel-shell.pty.test.ts 同款判语「输入面竞速只有真
 * pty 探针可靠」（第八轮教训），终端态竞速同律。python3 pty 中继挂真终端，
 * 子进程以 tsx 起真 createTuiChannel（真 ProcessTerminal 缺省构造）。
 *
 * 两腿（字节计数判据，扫描探针 entry-rawmode-probe 同款 on/off 归因）：
 * - graceful 对照腿：channel.stop() 后退——tui.stop() 单源复位（?2004l +
 *   kitty 弹栈必须在场）——验收计数法本身能看见复位写（防假绿：坏计数法
 *   会让 fatal 腿也假绿）；
 * - fatal 腿：起屏后直接 process.exit(1)（镜像 signals.ts onFatalExit 的
 *   surface.exit(1)——同为 process.exit，'exit' 钩子是唯一兜底位）——修前
 *   复位写零在场（红），修后复原钩子补位（?2004l + kitty 弹栈 +
 *   modifyOtherKeys 复位全在场）。
 *
 * 纪律同 kernel-shell：子脚本经 cfg 注入源路径（临时目录无相对链）、子进程
 * 登记 afterEach 兜杀、真 pty 缺席即跳过不失信。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/* ---------------- 公共基座（kernel-shell.pty 同款取舍） ---------------- */

/** 仓内 tsx CLI（src/channels → 上三级 = 仓根——子进程以 tsx 转译真源码形态起跑） */
const TSX_CLI = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
/** 通道工厂与命令注册表源路径（子脚本经 cfg 注入 import——脚本自身在临时目录无相对链） */
const TUI_TS = fileURLToPath(new URL('./tui.ts', import.meta.url));
const COMMANDS_TS = fileURLToPath(new URL('./commands.ts', import.meta.url));

/** 临时目录（realpath 防 macOS /var 符号链——goal 批真缺陷同款） */
function makeTmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/** 子进程登记簿（afterEach 兜杀——测试失败路径不留孤儿进程） */
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL'); // 复原锁标的已退：直接兜杀不等优雅收场
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

/**
 * pty 中继脚本（python3 标准库 pty——零新增 npm 依赖；kernel-shell.pty 同款）：
 * fork 子进程挂真 pty 从端（isTTY 真 / 私有模式写字节真实落终端），自身只在
 * pty 主端与我们的管道间转抄字节。
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
 * 复原锁子脚本：真 createTuiChannel + 真 ProcessTerminal（terminal 不注入 =
 * 工厂缺省构造——本锁唯一标的；起屏即写私有模式开启序列）。cfg.mode 两形态：
 * graceful 走 channel.stop() 正常停屏（对照腿）；fatal 起屏后直接
 * process.exit(1) 硬退（修前零复位写的红位）。
 */
const PTY_CHILD_SCRIPT = `// cfg 经末位 argv 注入（JSON 串）：mode + tui/commands 源路径
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { createTuiChannel } = await import(cfg.tuiPath);
const { createCommandRegistry } = await import(cfg.commandsPath);
const channel = createTuiChannel({
  // 宿主三面 no-op：本锁只验终端设备态，输入路由/退出编舞不在射程
  host: { submit() {}, requestQuit() {}, interrupt() {} },
  commands: createCommandRegistry(),
  // terminal 不注入 = 真 ProcessTerminal（复原钩子只对真终端武装）
});
channel.start();
process.stdout.write('PROBE_READY\\n');
setTimeout(() => {
  if (cfg.mode === 'graceful') {
    // 对照腿：正常停屏——tui.stop() 单源复位（?2004l + kitty 弹栈）
    channel.stop();
    process.exit(0);
  }
  // fatal 腿：硬退镜像——signals.ts onFatalExit 的 surface.exit(1) 同为
  // process.exit(1)，'exit' 钩子是唯一兜底位；零 tui.stop()
  process.exit(1);
}, 1500);
`;

describe('TUI 硬退终端态复原真 pty 锁（骨架篇 §1.3 终端态复原条款——TUI-1）', () => {
  /** 起锁子进程：python3 pty 中继 → tsx 起子脚本（真 TTY stdio），输出全收；
   * exit 监听 spawn 即挂（子进程可能在断言前已退——事件不重放） */
  function spawnLock(mode: 'graceful' | 'fatal'): {
    output: () => string;
    exited: Promise<number | null>;
  } {
    const scriptDir = makeTmpDir('tui-exit-script-');
    const scriptPath = join(scriptDir, 'child.mts');
    const relayPath = join(scriptDir, 'pty-relay.py');
    writeFileSync(scriptPath, PTY_CHILD_SCRIPT);
    writeFileSync(relayPath, PTY_RELAY_PY);
    const cfg = { mode, tuiPath: TUI_TS, commandsPath: COMMANDS_TS };
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

  /** 终端序列计数（字节级判据——扫描探针 entry-rawmode-probe 同款 on/off 归因） */
  const count = (out: string, seq: string): number => out.split(seq).length - 1;

  it.skipIf(!hasPtyRelay())(
    'graceful 对照腿：channel.stop() 复位在场（?2004l + kitty 弹栈 ≥1——计数法有效性的活证）',
    async () => {
      const lock = spawnLock('graceful');
      await waitFor('TUI 起屏（PROBE_READY）', 45_000, () => lock.output().includes('PROBE_READY'), lock.output);
      const code = await exitWithTimeout(lock.exited, 30_000, lock.output);
      expect(code).toBe(0);
      const out = lock.output();
      // 起屏确实开启了私有模式（判据前提：本腿数的是「复位」不是「从未开启」）
      expect(count(out, '\x1b[?2004h')).toBeGreaterThanOrEqual(1);
      // tui.stop() 单源复位在场——修前修后都必须绿（否则计数法坏 = fatal 腿假绿）
      expect(count(out, '\x1b[?2004l')).toBeGreaterThanOrEqual(1);
      expect(count(out, '\x1b[<u')).toBeGreaterThanOrEqual(1);
      // 光标显同腿活证：pi-tui stop() 的 showCursor 复位（A8——渲染期 hideCursor
      // 藏掉的设备态由停屏写回；缺省 PI_HARDWARE_CURSOR 关 = 渲染期无自发 ?25h）
      expect(count(out, '\x1b[?25h')).toBeGreaterThanOrEqual(1);
    },
  );

  it.skipIf(!hasPtyRelay())(
    'fatal 硬退腿：exit(1) 复原钩子补位（修前 ?2004l/kitty 弹栈/modifyOtherKeys 复位零在场 = 红）',
    async () => {
      const lock = spawnLock('fatal');
      await waitFor('TUI 起屏（PROBE_READY）', 45_000, () => lock.output().includes('PROBE_READY'), lock.output);
      const code = await exitWithTimeout(lock.exited, 30_000, lock.output);
      expect(code).toBe(1); // 硬退退出码透传（fatal 语义保持——复原不吞退出码）
      const out = lock.output();
      // 起屏开启写在场（TUI 真武装了终端——判据前提）
      expect(count(out, '\x1b[?2004h')).toBeGreaterThanOrEqual(1);
      // 复原写必须在场：修前这三行全 0（tui.stop() 不经、'exit' 钩子不存在）
      expect(count(out, '\x1b[?2004l')).toBeGreaterThanOrEqual(1); // 括号粘贴关闭
      expect(count(out, '\x1b[<u')).toBeGreaterThanOrEqual(1); // kitty 键盘协议弹栈
      expect(count(out, '\x1b[>4;0m')).toBeGreaterThanOrEqual(1); // modifyOtherKeys 复位
      // 光标显补位（A8）：pi-tui 起屏/渲染期 hideCursor 藏光标，tui.stop() 的
      // showCursor 不经——修前 0 在场（缺省 PI_HARDWARE_CURSOR 关 = 渲染期无自发
      // ?25h，计数判据不掺水），修后复原钩子写回
      expect(count(out, '\x1b[?25h')).toBeGreaterThanOrEqual(1); // 光标显
    },
  );
});
