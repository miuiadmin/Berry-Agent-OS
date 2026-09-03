/**
 * app — 桌面 boot 序 + 真终端换防 子进程级测试（第八十五批批 C，骨架篇 boot
 * 序 + 契约篇 §6.11）。
 *
 * 与 desktop-main.test.ts（进程内注入假终端）互补的子进程真 CLI 形态：
 * - boot 序三形态（tsx 起真 `berry` 入口，stdio 管道）：无参 → 桌面备屏
 *   （1049h + 桌面帧）；--no-desktop → 内核横幅直进 REPL；熔断账本两连崩 →
 *   熔断回锁横幅且不试起屏（引擎零字节）。
 * - 真 pty 换防全链（darwin `script -q /dev/null`，linux `-qec`）：桌面 →
 *   Enter 进应用 → Esc 回桌面 → /exit——字节级审计：备屏/还屏对称（1049h/l
 *   计数平衡）、bracketed-paste 2004 推弹平衡、kitty 键盘增强推弹平衡、
 *   换防回桌面后流静默（挂起栈零残留字节——pi-tui 停屏后不得再写一字节）。
 *
 * 纪律同 daemon-fullstack：数据目录钉扎到临时目录（G1 教训——防污染真
 * ~/.berry）；子进程登记 afterEach 兜杀；APP_LOG_LEVEL=warn 降噪。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootFailuresPath, currentPackageVersion } from './desktop-boot.js';

/* ---------------- 公共基座（daemon-fullstack 同款取舍） ---------------- */

/** 仓内 tsx CLI（src/app → 上两级 = 仓根——子进程以 tsx 转译真源码形态起跑） */
const TSX_CLI = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
/** 真 CLI 入口（main.ts——boot 序的执法面在入口分派层，须走真 argv 解析） */
const MAIN_TS = fileURLToPath(new URL('./main.ts', import.meta.url));
/** 桌面主入口源路径（pty 子脚本经 cfg 注入 import——脚本自身在临时目录无相对链） */
const DESKTOP_MAIN_TS = fileURLToPath(new URL('./desktop-main.ts', import.meta.url));
/** llm 模块源路径（faux provider 注入——mock 停在模型层的组合根纪律） */
const LLM_INDEX_TS = fileURLToPath(new URL('../llm/index.ts', import.meta.url));

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

/** 退出码限时等待（超时抛错带现场输出——防子进程悬死挂测试） */
async function exitWithTimeout(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  output: () => string,
): Promise<number | null> {
  const timer = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`子进程 ${timeoutMs}ms 未退出——输出尾段：\n${output().slice(-1500)}`)),
      timeoutMs,
    );
  });
  return Promise.race([waitExit(child), timer]);
}

/** 字节串计数（审计平衡用——split 技巧兼容含重叠的定长转义串） */
const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;

/* ---------------- boot 序三形态（真 CLI 子进程，stdio 管道） ---------------- */

/**
 * 起真 CLI 子进程：tsx 转译 main.ts + 指定 argv；数据目录钉扎临时目录
 * （daemon.json 检测随之扑空——不与真机 daemon 相互干扰）；stdout 全收。
 */
function spawnCli(args: readonly string[]): {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  send: (data: string) => void;
  exited: Promise<number | null>;
} {
  const dataDir = makeTmpDir('desktop-boot-data-');
  const workspace = makeTmpDir('desktop-boot-ws-');
  const child = spawn(process.execPath, [TSX_CLI, MAIN_TS, ...args], {
    env: { ...process.env, APP_DATA_DIR: dataDir, APP_LOG_LEVEL: 'warn' },
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  const chunks: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => chunks.push(chunk));
  const errChunks: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => errChunks.push(chunk));
  return {
    child,
    output: () => chunks.join(''),
    send: (data: string) => void child.stdin.write(data),
    exited: waitExit(child),
  };
}

describe('桌面 boot 序（子进程真 CLI）', () => {
  it('无参默认 = 桌面首启：备屏 1049h + 桌面帧；桌面 /exit 退出码 0', async () => {
    const cli = spawnCli([]);
    // 桌面起屏：备屏进 + 首帧品牌行（真引擎真 stdout——管道形态 isTTY 缺席不挡写）
    await waitFor(
      '桌面首帧',
      45_000,
      () => cli.output().includes('Berry 桌面') && cli.output().includes('\x1b[?1049h'),
      cli.output,
    );
    // 桌面态输入走路（引擎 stdin data 面，\r = enter）：/exit → 退出码 0
    cli.send('/exit\r');
    const code = await exitWithTimeout(cli.child, 15_000, cli.output);
    expect(code).toBe(0);
  }, 60_000);

  it('--no-desktop：内核最小 shell 横幅直进 REPL；/exit 退出码 0', async () => {
    const cli = spawnCli(['--no-desktop']);
    await waitFor(
      '内核横幅',
      45_000,
      () => cli.output().includes('内核最小 shell（--no-desktop 显式形态）'),
      cli.output,
    );
    expect(cli.output()).toContain('/apps'); // 命令面披露在场
    expect(cli.output()).not.toContain('\x1b[?1049h'); // 不起屏（桌面引擎零字节）
    // 内核态行走 readline 行协议（\n 结行）
    cli.send('/exit\n');
    const code = await exitWithTimeout(cli.child, 15_000, cli.output);
    expect(code).toBe(0);
  }, 60_000);

  it('熔断账本两连崩：回锁横幅披露原因且不试起屏；/exit 退出码 0', async () => {
    // 预置同版本两连崩账（子进程数据目录独立——须在 spawn 前落位）
    const dataDir = makeTmpDir('desktop-breaker-data-');
    const workspace = makeTmpDir('desktop-breaker-ws-');
    writeFileSync(bootFailuresPath(dataDir), JSON.stringify({ version: currentPackageVersion(), count: 2 }));
    const child = spawn(process.execPath, [TSX_CLI, MAIN_TS], {
      env: { ...process.env, APP_DATA_DIR: dataDir, APP_LOG_LEVEL: 'warn' },
      cwd: workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    children.push(child);
    const chunks: string[] = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => chunks.push(chunk));
    const output = (): string => chunks.join('');
    await waitFor('熔断横幅', 45_000, () => output().includes('已熔断回锁内核最小 shell'), output);
    expect(output()).toContain('连续 2 次'); // 横幅披露账本真相
    expect(output()).toContain('--no-desktop'); // 绕行位提示在场
    expect(output()).not.toContain('\x1b[?1049h'); // 不试起屏（熔断判据先行）
    child.stdin.write('/exit\n');
    const code = await exitWithTimeout(child, 15_000, output);
    expect(code).toBe(0);
  }, 60_000);
});

/* ---------------- 真 pty 换防字节审计（契约篇 §6.11） ---------------- */

/**
 * pty 中继脚本（python3 标准库 pty——零新增 npm 依赖）：fork 子进程挂真 pty
 * 从端（isTTY 真 / raw 模式真实生效 / 列行数真实），自身只在 pty 主端与我们
 * 的管道间转抄字节。macOS `script` 不可用——其对自身 stdin 施 tcgetattr，
 * 测试进程的 socket/管道 stdio 直接炸（tcgetattr/ioctl: Operation not
 * supported）；python pty 中继无 termios 前提。
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

/** pty 换防子脚本：真 desktopMain + 真进程 stdio（引擎/通道各自接管真终端） */
const PTY_CHILD_SCRIPT = `import { writeFileSync } from 'node:fs';
// cfg 经末位 argv 注入（JSON 串）：desktop-main/llm 源路径 + 库/工作区/退出码文件
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { desktopMain } = await import(cfg.desktopMainPath);
const { fauxProvider } = await import(cfg.llmPath);
// faux 模型层（mock 只停在模型层——换防链路零模型调用，纯确定性占位）
const faux = fauxProvider({ provider: 'faux-ledger', models: [{ id: 'm1' }] });
desktopMain({ dbPath: cfg.dbPath, workspace: cfg.workspace, providers: [faux.provider] }).then(
  (code) => {
    writeFileSync(cfg.exitFile, String(code));
    process.exit(code);
  },
  (err) => {
    writeFileSync(cfg.exitFile, 'ERR ' + (err?.stack ?? String(err)));
    process.exit(1);
  },
);
`;

describe('真 pty 换防全链（桌面 → Enter 应用 → Esc 回桌面 → /exit）', () => {
  // python3 pty 中继缺席（非 unix/精简环境）即跳过——审计不失信
  it.skipIf(!hasPtyRelay())(
    '备屏/还屏字节对称 + 模式推弹平衡 + 换防后流静默（零残留字节）',
    async () => {
      const dataDir = makeTmpDir('desktop-pty-data-');
      const workspace = makeTmpDir('desktop-pty-ws-');
      const scriptDir = makeTmpDir('desktop-pty-script-');
      const scriptPath = join(scriptDir, 'child.mts');
      const relayPath = join(scriptDir, 'pty-relay.py');
      const exitFile = join(scriptDir, 'exit-code');
      writeFileSync(scriptPath, PTY_CHILD_SCRIPT);
      writeFileSync(relayPath, PTY_RELAY_PY);
      const cfg = {
        desktopMainPath: DESKTOP_MAIN_TS,
        llmPath: LLM_INDEX_TS,
        dbPath: join(dataDir, 'pty.db'),
        workspace,
        exitFile,
      };
      // python3 中继挂真 pty → tsx 起子脚本（真进程 stdio——引擎/通道接管 pty 从端）
      const child = spawn('python3', [relayPath, process.execPath, TSX_CLI, scriptPath, JSON.stringify(cfg)], {
        env: { ...process.env, APP_DATA_DIR: dataDir, APP_LOG_LEVEL: 'warn' },
        cwd: workspace,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      children.push(child);
      const chunks: string[] = [];
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => chunks.push(chunk));
      const output = (): string => chunks.join('');
      const enterCount = (): number => countOf(output(), '\x1b[?1049h');

      // ① 首启桌面：备屏 + 首帧品牌行（真 pty 下 raw 模式真实生效）
      await waitFor('桌面首帧', 60_000, () => output().includes('Berry 桌面') && enterCount() >= 1, output);
      expect(enterCount()).toBe(1); // 起屏恰一次（此时无换防）

      // ② Enter（空输入）打开默认应用：引擎挂起三件套出屏（1049l）
      child.stdin.write('\r');
      await waitFor('引擎交出（1049l）', 15_000, () => output().includes('\x1b[?1049l'), output);
      // pi-tui 起屏画首屏（settle 让渡——无需断言其内容，换防平衡不依赖）
      await new Promise((resolve) => setTimeout(resolve, 500));

      // ③ Esc 回桌面：pi-tui 停屏保画面 + 引擎复位（1049h 二次进 + 全量重绘）
      child.stdin.write('\x1b');
      await waitFor('引擎复位（1049h ×2）', 15_000, () => enterCount() >= 2, output);
      await waitFor('桌面帧再现', 15_000, () => countOf(output(), 'Berry 桌面') >= 2, output);
      await new Promise((resolve) => setTimeout(resolve, 300)); // 尾帧落定

      // ④ 流静默审计：换防回桌面后挂起栈零残留字节（停屏的 pi-tui 不得再写；
      //    引擎无输入零帧——测试全程 ≪30s 时钟重绘节拍，静默是确定性的）
      const quietSince = output().length;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(output().length).toBe(quietSince);

      // ⑤ /exit 退出（桌面态行走引擎输入面）→ 退出码 0（exitFile 由子脚本落盘——
      //    pty 包裹层退出码透传不可靠，文件即真相）
      child.stdin.write('/exit\r');
      await waitFor(
        '子进程退出码 0',
        15_000,
        () => {
          try {
            return readFileSync(exitFile, 'utf8') === '0';
          } catch {
            return false; // 文件未落（子进程尚未退出）——继续等
          }
        },
        output,
      );

      // ⑥ 字节级终审计（全流）：备屏/还屏对称 + bracketed-paste 推弹 + kitty 推弹
      const full = output();
      expect(countOf(full, '\x1b[?1049l')).toBe(countOf(full, '\x1b[?1049h')); // 1049 平衡
      expect(countOf(full, '\x1b[?2004l')).toBe(countOf(full, '\x1b[?2004h')); // 2004 平衡
      // kitty 键盘增强：推（\x1b[>Nu）与弹（\x1b[<Nu）族形计数平衡（两栈各自对称）
      expect(countRegex(full, /\x1b\[<[0-9;]*u/g)).toBe(countRegex(full, /\x1b\[>[0-9;]*u/g));
      expect(full).not.toContain('桌面启动失败'); // 全程无失败回锁路径
    },
    90_000,
  );
});

/** 正则计数（kitty 推弹族形——/g 全局匹配计数） */
function countRegex(hay: string, re: RegExp): number {
  return [...hay.matchAll(re)].length;
}
