/**
 * channels — /history 全屏回看器真 pty 锁（TUI 强化批 3 增强 8；技术栈篇 §4.1）。
 *
 * 标的：TuiAltScreen 副屏切换编舞的真终端执法——?1049h 进屏 / ?1049l 收屏
 * 两写必须经真 TTY 私有模式路径（PassThrough 假终端复现不了交替屏缓冲语义，
 * kernel-shell.pty.test.ts 同款判语「输入面竞速只有真 pty 探针可靠」）。单测
 * 侧（tui.test.ts 捕获式终端）已锁生命周期行为面；本锁补真终端 + 真键盘
 * 链（Editor 派发 /history → 副屏 → q 收起全程走生产 onInput 链）。
 *
 * 纪律同 tui-exit.pty：python3 pty 中继（stdin 转发腿——kernel-shell 变体，
 * 测试驱动键盘）、tsx 起真 createTuiChannel + 真 ProcessTerminal、子进程登记
 * afterEach 兜杀、真 pty 缺席即跳过不失信。
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
    child.kill('SIGKILL'); // 回看器锁标的已退：直接兜杀不等优雅收场
  }
});

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
 * pty 中继脚本（python3 标准库 pty——零新增 npm 依赖；kernel-shell.pty 同款
 * stdin 转发腿）：fork 子进程挂真 pty 从端（isTTY 真 / 交替屏写字节真实落终端），
 * 自身在 pty 主端与我们的管道间双向转抄字节（测试侧 write stdin = 真键盘）。
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
 * 回看器锁子脚本：真 createTuiChannel + 真 ProcessTerminal + 真命令注册表 +
 * history 注入（user 消息形态——renderAgentMessage 行腿，避开 AssistantMessage
 * 全形状耦合；本锁标的 = 交替屏切换字节，正文断言是顺带活证）。30s 后优雅
 * 停屏退出（测试全程键盘驱动）。
 */
const PTY_CHILD_SCRIPT = `// cfg 经末位 argv 注入（JSON 串）：tui/commands 源路径
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { createTuiChannel } = await import(cfg.tuiPath);
const { createCommandRegistry } = await import(cfg.commandsPath);
const channel = createTuiChannel({
  // 宿主 submit/interrupt no-op；requestQuit 接干净退出（测试侧 Ctrl+D 驱动
  // 收场——主屏 quitKeys 路径顺带真键盘活证）
  host: { submit() {}, requestQuit() { channel.stop(); process.exit(0); }, interrupt() {} },
  commands: createCommandRegistry(),
  // history 注入在场 → /history 注册（真命令注册表真派发链）
  history: () => [
    { role: 'user', content: '回看探针问句一', timestamp: 1 },
    { role: 'user', content: '回看探针问句二', timestamp: 2 },
  ],
});
channel.start();
process.stdout.write('PROBE_READY\\n');
// 兜底长活（90s）：正常路由是 requestQuit → 干净退出；测试失败路径由登记簿兜杀
setTimeout(() => { channel.stop(); process.exit(0); }, 90000);
`;

describe('/history 全屏回看器真 pty 锁（增强 8——交替屏切换字节执法）', () => {
  /** 起锁子进程：python3 pty 中继 → tsx 起子脚本（真 TTY stdio），输出全收；
   * exit 监听 spawn 即挂（子进程可能在断言前已退——事件不重放） */
  function spawnLock(): { output: () => string; exited: Promise<number | null>; send: (data: string) => void } {
    const scriptDir = makeTmpDir('tui-history-script-');
    const scriptPath = join(scriptDir, 'child.mts');
    const relayPath = join(scriptDir, 'pty-relay.py');
    writeFileSync(scriptPath, PTY_CHILD_SCRIPT);
    writeFileSync(relayPath, PTY_RELAY_PY);
    const cfg = { tuiPath: TUI_TS, commandsPath: COMMANDS_TS };
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
    return {
      output: () => chunks.join(''),
      exited: waitExitCode(child),
      send: (data: string) => void child.stdin.write(data),
    };
  }

  /** 退出码（resolve 型——exit 监听 spawn 后立即挂，事件只发一次） */
  function waitExitCode(child: ChildProcessWithoutNullStreams): Promise<number | null> {
    return new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
  }

  /** 逐字符键入（真 Editor 输入节流安全余量——单测 type() 同款 5ms 间隔） */
  async function type(send: (data: string) => void, text: string): Promise<void> {
    for (const ch of text) {
      send(ch);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it.skipIf(!hasPtyRelay())(
    '/history 进副屏（?1049h + 正文上屏）→ q 收起（?1049l）全程真键盘链',
    async () => {
      const lock = spawnLock();
      await waitFor('TUI 起屏（PROBE_READY）', 45_000, () => lock.output().includes('PROBE_READY'), lock.output);
      const openMark = lock.output().length; // 分界：副屏写只应在 /history 之后
      await type(lock.send, '/history');
      lock.send('\r');
      await waitFor(
        '副屏进屏写（?1049h）',
        20_000,
        () => lock.output().slice(openMark).includes('\x1b[?1049h'),
        lock.output,
      );
      // 正文真上屏（渲染管线单源的顺带活证——user 行腿进副屏）
      await waitFor('副屏正文（回看探针问句）', 10_000, () => lock.output().includes('回看探针问句一'), lock.output);
      const closeMark = lock.output().length;
      lock.send('q');
      await waitFor(
        '副屏收屏写（?1049l）',
        20_000,
        () => lock.output().slice(closeMark).includes('\x1b[?1049l'),
        lock.output,
      );
      // 干净收场：Ctrl+D 走主屏 quitKeys → requestQuit → 子脚本优雅退出（顺带活证）
      lock.send('\x04');
      const code = await exitWithTimeout(lock.exited, 20_000, lock.output);
      expect(code).toBe(0); // 优雅停屏退出码透传
      const out = lock.output();
      // 全程字节账：进/退各至少一次（真交替屏消费的最终归因——修前 tui.ts 零 TuiAltScreen）
      expect(out.split('\x1b[?1049h').length - 1).toBeGreaterThanOrEqual(1);
      expect(out.split('\x1b[?1049l').length - 1).toBeGreaterThanOrEqual(1);
    },
    // per-test 放大（node 轨 15s 缺省）：tsx 冷启 + 键盘驱编舞全程壁钟 ~10-20s
    90_000,
  );
});
