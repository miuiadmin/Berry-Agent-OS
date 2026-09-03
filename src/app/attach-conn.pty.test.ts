/**
 * app — attach 连接面真 pty 锁（TUI 第十一轮盲区 3 刀三：首连静默 / 401 退出码 /
 * repull 代际）。
 *
 * 标的三缺陷（盲区 3 深读 confirmed，均在 attachMain 闸后 TUI 段——本文件面外
 * 无 TTY 结构性依赖，故走真 pty）：
 * - ②首连静默：握手通、SSE 升级被拒（16 连接帽满 503）时 onDisconnected 被
 *   connectedOnce 门吞——横幅「已接上」已出、历史永不拉、零反馈空白屏；
 * - ⑥会话中 401 退出码 0：onAuthFailure → quitResolve → signals.exitCode 恒 0
 *   ——脚本无法分辨认证失败与干净退出；
 * - ⑦repull 无代际守卫：重连窗内两代 repull 并发，旧代迟到响应覆盖新代投影
 *   （historyCache 整代换 + repaint——旧画面回潮）。
 *
 * 为什么必须真 pty：attachMain 闸后段构造真 ProcessTerminal（stdin raw 模式 +
 * 备用屏），PassThrough 非 TTY 复现不了——kernel-shell.pty / tui-exit.pty 同款
 * 判语「输入/终端面竞速只有真 pty 探针可靠」。python3 pty 中继挂真终端，子进程
 * 以 tsx 起真 attachMain（真 daemon 夹具 = 本测试内 node:http 脚本化服务端）。
 *
 * 纪律同 tui-exit.pty：子脚本经 cfg 注入源路径、子进程登记 afterEach 兜杀、
 * 真 pty 缺席即跳过不失信、APP_DATA_DIR 钉扎临时目录（G1——绝不污染真 ~/.berry）。
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonDirOf, daemonStatePath, daemonTokenPath } from './daemon-state.js';

/* ---------------- 公共基座（tui-exit.pty 同款取舍） ---------------- */

/** 仓内 tsx CLI（src/app → 上两级 = 仓根——子进程以 tsx 转译真源码形态起跑） */
const TSX_CLI = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
/** attachMain 源路径（子脚本经 cfg 注入 import——脚本自身在临时目录无相对链） */
const ATTACH_MAIN_TS = fileURLToPath(new URL('./attach-main.ts', import.meta.url));

/** 临时目录（realpath 防 macOS /var 符号链——goal 批真缺陷同款） */
function makeTmpDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
}

/** 子进程登记簿（afterEach 兜杀——测试失败路径不留孤儿进程） */
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL'); // 连接面锁标的：直接兜杀不等优雅收场
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
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

/** pty 中继脚本（python3 标准库 pty——零新增 npm 依赖；tui-exit.pty 同款） */
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
 * attach 子脚本：真 attachMain 全流程（真 ProcessTerminal——terminal 不注入）。
 * cfg 经末位 argv 注入（JSON 串）：attachMain 源路径 + dataRoot + cwd + port；
 * 退出码透传（process.exit(code)——⑥ 腿的断言面）。
 */
const ATTACH_CHILD_SCRIPT = `// cfg 经末位 argv 注入（JSON 串）
const cfg = JSON.parse(process.argv[process.argv.length - 1]);
const { attachMain } = await import(cfg.attachMainPath);
const code = await attachMain({ dataRoot: cfg.dataRoot, cwd: cfg.cwd, port: cfg.port });
process.stdout.write('ATTACH_EXIT_' + code + '\\n');
process.exit(code);
`;

/** 脚本化 daemon 夹具：attachMain 全消费面（握手/健康/投影/审批/SSE）逐端点编排 */
interface FakeDaemonScript {
  /** SSE 升级行为：'503' = 恒拒（帽满形）/ 'drop-once' = 首连 200 供帧后
   * 200ms 毁 socket、此后长连（repull 代际形）/ 'drop-then-401' = 首连 200
   * 供帧后 600ms 毁 socket、此后一切升级 401（会话中 token 轮换形——起屏后
   * 重连撞 401，真世界形状）/ 'steady' = 首连即长连保活（运行态种子形——
   * SSE 零 display 事件，清单 running 键是运行态唯一真相源） */
  sse: '503' | 'drop-once' | 'drop-then-401' | 'steady';
  /** 投影分档：'delayed-old' = 首请求挂 1200ms 后答旧投影、后续即答新投影
   * （repull 代际腿——旧代迟到）；缺省恒答新投影 */
  messages?: 'delayed-old';
  /** 清单条目运行态（TUI 强化批 2 刀三）：true = sessions 行带 running: true
   * ——驱动在飞而 SSE 不发 agent_start（重连错过形），attach 状态行只可能经
   * 清单种子显示「工作中」（修前红位 = 状态行恒空） */
  running?: boolean;
}

/** 落一份形状完整的 daemon.json + token（前置闸只读形状——同 attach-main.test 夹具） */
function writeDaemonState(root: string, port: number): void {
  mkdirSync(daemonDirOf(root), { recursive: true });
  writeFileSync(
    daemonStatePath(root),
    JSON.stringify({ pid: 4321, processStartId: 'pty-x', bootId: 'pty-boot', port, heldSessions: [] }),
  );
  writeFileSync(daemonTokenPath(root), 'pty-token');
}

/** 投影行速造（projectedToAgentMessages 输入形——webui 投影消息最小行） */
function projectionRows(marker: string): unknown[] {
  return [
    { type: 'user', content: `${marker} 用户输入` },
    {
      type: 'assistant',
      content: [{ type: 'text', text: `${marker} 答复正文` }],
      toolCalls: [],
    },
  ];
}

/**
 * 起脚本化 daemon：sessions/health/approvals/messages 恒常态，SSE 按 script 编排。
 * @returns 监听端口
 */
async function startFakeDaemon(script: FakeDaemonScript): Promise<number> {
  /** SSE 升级计数（drop-once 分档依据） */
  let sseConnections = 0;
  /** 投影请求计数（delayed-old 分档依据） */
  let messageRequests = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/api/sessions') {
      // 握手 + 清单：单活会话（cwd 匹配 = 任意——cwd 匹配池回退最新 active 同形）；
      // running 可选键（刀三运行态种子形）：驱动在飞真相走清单不走 SSE
      const row: Record<string, unknown> = {
        id: 'sess-pty',
        appId: 'chat',
        active: true,
        cwd: '/w',
        createdAt: 1,
        updatedAt: 2,
      };
      if (script.running === true) row.running = true;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([row]));
      return;
    }
    if (url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (url === '/api/approvals') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ approvals: [] }));
      return;
    }
    if (url.endsWith('/messages')) {
      messageRequests += 1;
      if (script.messages === 'delayed-old' && messageRequests === 1) {
        // 旧代请求：挂起 1200ms（重连 + 新代 repull 完成后才放行——迟到腿）
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ messages: projectionRows('REPL_OLD') }));
        }, 1200);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: projectionRows('REPL_NEW') }));
      return;
    }
    if (url === '/api/events') {
      if (script.sse === '503') {
        res.writeHead(503).end(); // 帽满形（连接帽执法——非鉴权面）
        return;
      }
      // drop-once：首连供心跳后 200ms 毁 socket（逼重连），此后长连保活；
      // drop-then-401：首连供心跳后 600ms 毁 socket（起屏后的真断线），此后
      // 一切升级尝试 401（会话中 token 轮换——重连即撞拒）；steady：首连即
      // 长连保活零 display 事件（运行态种子形——状态行真相只走清单键）
      sseConnections += 1;
      if (script.sse === 'drop-then-401' && sseConnections > 1) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ping\n\n');
      if (sseConnections === 1 && script.sse !== 'steady') {
        setTimeout(() => res.socket?.destroy(), script.sse === 'drop-then-401' ? 600 : 200);
        return;
      }
      const keepalive = setInterval(() => res.write(': ping\n\n'), 500);
      res.on('close', () => clearInterval(keepalive));
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

describe('attach 连接面真 pty 锁（首连静默 / 401 退出码 / repull 代际——盲区 3 刀三）', () => {
  /** 起 attach 子进程：python3 pty 中继 → tsx 起真 attachMain，输出全收 */
  function spawnAttach(script: FakeDaemonScript): Promise<{
    output: () => string;
    exited: Promise<number | null>;
    done: Promise<void>;
  }> {
    return (async () => {
      const port = await startFakeDaemon(script);
      const dataRoot = makeTmpDir('attach-pty-root-');
      const cwd = makeTmpDir('attach-pty-cwd-');
      writeDaemonState(dataRoot, port);
      const scriptDir = makeTmpDir('attach-pty-script-');
      const scriptPath = join(scriptDir, 'child.mts');
      const relayPath = join(scriptDir, 'pty-relay.py');
      writeFileSync(scriptPath, ATTACH_CHILD_SCRIPT);
      writeFileSync(relayPath, PTY_RELAY_PY);
      const cfg = { attachMainPath: ATTACH_MAIN_TS, dataRoot, cwd, port };
      const child = spawn('python3', [relayPath, process.execPath, TSX_CLI, scriptPath, JSON.stringify(cfg)], {
        // APP_DATA_DIR 钉扎（G1：绝不污染真 ~/.berry——闸后段纵深 import 的兜底）
        env: { ...process.env, APP_DATA_DIR: join(scriptDir, 'app-data'), APP_LOG_LEVEL: 'error' },
        cwd: scriptDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      children.push(child);
      const chunks: string[] = [];
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => chunks.push(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => chunks.push(chunk)); // tsx 报错混收——诊断现场
      // 起屏就绪 = 横幅已出（握手腿达成——三腿共用的前置判据）
      const ready = waitFor(
        'attach 起屏横幅',
        60_000,
        () => chunks.join('').includes('已接上 daemon'),
        () => chunks.join(''),
      );
      return { output: () => chunks.join(''), exited: waitExit(child), done: ready };
    })();
  }

  it.skipIf(!hasPtyRelay())(
    '②首连静默修前红：SSE 帽满（恒 503）时「流未接通」警示必须在场（修前零反馈空白屏）',
    async () => {
      const lock = await spawnAttach({ sse: '503' });
      await lock.done; // 横幅已出——静默缺陷的现场前置
      // 修前红位：connectedOnce 门吞掉首连失败通知——等待超时即红
      await waitFor('SSE 流未接通警示', 20_000, () => lock.output().includes('SSE 流未接通'), lock.output);
    },
    180_000,
  );

  it.skipIf(!hasPtyRelay())(
    '⑥会话中 401 修前红：退出码 1 + 停屏后 stderr 警示（修前恒 0 且零可见面）',
    async () => {
      // 真世界形状：首连 200 起屏、600ms 后真断线、重连撞 401（token 轮换竞窗）。
      // 屏内警示行与收尾渲染竞速（quitResolve 微任务先于渲染 tick——结构性必丢），
      // 断言面 = 停屏后 stderr 的确定性警示行 + 退出码
      const lock = await spawnAttach({ sse: 'drop-then-401' });
      await lock.done;
      await waitFor('token 不符警示', 30_000, () => lock.output().includes('token 不符'), lock.output);
      const code = await exitWithTimeout(lock.exited, 30_000, lock.output);
      expect(code).toBe(1); // 修前红位：signals.exitCode 无信号即 0
    },
    180_000,
  );

  it.skipIf(!hasPtyRelay())(
    '⑦repull 代际修前红：旧代迟到投影不得覆盖新代（修前旧画面回潮——lastIndexOf 判序）',
    async () => {
      const lock = await spawnAttach({ sse: 'drop-once', messages: 'delayed-old' });
      await lock.done;
      // 新代投影先上屏（重连后 repull#2 即答）；旧代请求 1200ms 才放行
      await waitFor('新代投影上屏', 30_000, () => lock.output().includes('REPL_NEW 答复正文'), lock.output);
      // 等过旧代放行点（1200ms 挂起 + 余量）——修前旧投影 repaint 回潮
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const out = lock.output();
      // 判序：新代必须是最后一次投影绘制——修前红位 = REPL_OLD 后绘（lastIndexOf 反超）
      expect(out.lastIndexOf('REPL_NEW 答复正文')).toBeGreaterThan(out.lastIndexOf('REPL_OLD 答复正文'));
    },
    180_000,
  );

  it.skipIf(!hasPtyRelay())(
    '刀三运行态种子修前红：清单 running:true + SSE 零 display 事件 → 状态行「工作中」（修前恒空——entryStatus 误报 idle）',
    async () => {
      // 重连错过形的纯化形态：驱动在飞（清单 running 键 = 唯一真相源）、SSE 长连
      // 但不发任何 agent_start——修前 runningBySession 登记簿空，repaint 时
      // entryStatus 返回 idle、状态行不显示「工作中」（waitFor 超时即红）
      const lock = await spawnAttach({ sse: 'steady', running: true });
      await lock.done; // 横幅已出 + 首连 repull 已触发（repaint 消费种子）
      await waitFor('状态行 工作中', 30_000, () => lock.output().includes(' 工作中'), lock.output);
    },
    180_000,
  );
});
