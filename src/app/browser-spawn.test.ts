/**
 * L3 browser 组合根 spawn 闭包失败腿红锁（遗漏大扫 20260904 #1，契约篇
 * §6.10 ⑧ 两真形态收口；测试文件豁免模块 DAG）。
 *
 * Node spawn 失败有两条真实形态，此前闭包两腿皆漏：
 * - **异步腿**（命令不存在/权限类 ENOENT/EACCES——发现序过检后的 TOCTOU 窗
 *   内同样可达）：Node 在 child 上**异步发 'error' 事件**（无进程即无 exit）。
 *   闭包不挂吸收监听则 unhandled 'error' = uncaughtException 直接杀宿主进程
 *   （六入口无一幸免——TUI/daemon/webui/run/check/upgrade 同体）。失败可观察
 *   性由 `pid === undefined` 承担（启动等待超帽走 BROWSER_CONNECT_FAILED 干净
 *   失败路），不靠进程崩溃。锁法 = 真子进程探针：node 起 tsx 装载**真闭包**
 *   spawn 不存在命令——退出码必须 0（修前 = 1「Unhandled 'error' event」）。
 * - **同步腿**（ENOEXEC——文件过 X_OK 但非可执行格式：截断二进制/垃圾内容）：
 *   本仓目标平台（macOS / Node 24）实测 spawn 调用位**同步抛**。闭包真身 +
 *   真引擎接线断言：bringUp 必捕获清算（状态回放入口值不谎报 starting、登记
 *   簿不入册、不树杀、失败原样上抛），不能裸抛出调用位把引擎 status 钉死
 *   'starting'（五十三批 #9 状态不谎报的反面形态）。
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { JsonRpcConnection } from '../mcp/index.js';
import { BrowserEngine } from '../browser/engine.js';
import { spawnEngineProcess } from './browser-spawn.js';

/** 本文件路径锚（探针脚本里的真模块绝对路径 + 子进程 cwd 仓根推导） */
const here = dirname(fileURLToPath(import.meta.url));
/** 仓根（子进程 cwd——tsx 与依赖解析锚） */
const repoRoot = resolve(here, '..', '..');
/** 真闭包绝对路径（.ts 形态——探针子进程经 tsx loader 直载） */
const moduleAbsPath = join(here, 'browser-spawn.ts');

/** 本用例临时目录登记（afterAll 全清——cdp.test.ts 同款纪律） */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('browser 引擎 spawn 闭包失败腿（遗漏大扫 20260904 #1）', () => {
  it('异步腿：spawn 不存在命令——error 事件被吸收，宿主进程活着退 0（修前 = unhandled error 崩溃退 1）', async () => {
    // 探针脚本（子进程内执行）：dynamic import 装真闭包（node -e 缺省 CJS 里
    // 合法），spawn 一个必然不存在的命令，等 500ms 让异步 'error' 事件落地，
    // 再打 SURVIVED——修前 unhandled 'error' 在等待窗内就把进程崩死（连
    // SURVIVED 都打不出，退出码 1）；修后监听吸收 + pid undefined，跑完退 0。
    const probe = [
      `import(${JSON.stringify(moduleAbsPath)}).then(async ({ spawnEngineProcess }) => {`,
      `  const child = spawnEngineProcess({ command: '/nonexistent/browsers-xyz-probe', args: [] });`,
      `  console.log('PID ' + JSON.stringify(child.pid));`,
      `  await new Promise((resolve) => setTimeout(resolve, 500));`,
      `  console.log('SURVIVED');`,
      `});`,
    ].join('\n');

    const child = spawn(process.execPath, ['--import', 'tsx', '-e', probe], {
      cwd: repoRoot, // tsx/依赖解析锚（仓根 node_modules）
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const code = await new Promise<number | null>((resolveExit) => {
      child.on('exit', (c) => resolveExit(c));
    });
    // 失败可观察性走 pid undefined（探针面）+ 进程零崩溃（主体断言）
    expect(stdout).toContain('PID undefined');
    expect(stdout).toContain('SURVIVED');
    expect(code).toBe(0);
    // 诊断辅助：崩溃形态的 stderr 原文（修前红跑时可见 Unhandled 'error' event）
    expect(stderr).not.toContain("Unhandled 'error' event");
  }, 30_000);

  it('同步腿：ENOEXEC（过 X_OK 的垃圾可执行文件）——真闭包真引擎，bringUp 捕获清算不谎报 starting 不入册不树杀', async () => {
    const dataDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'berry-browser-spawn-')));
    dirs.push(dataDir);
    // 垃圾「引擎」：内容非可执行格式（无 shebang——有 shebang 会被 shell 解释
    // 执行不产 ENOEXEC）+ 0o755 过发现序 X_OK 检——discover 放行后 spawn 即抛
    const garbage = join(dataDir, 'fake-engine');
    writeFileSync(garbage, 'not an executable binary — ENOEXEC probe\n');
    chmodSync(garbage, 0o755);

    const killTree = vi.fn();
    const registry = {
      add: vi.fn(),
      remove: vi.fn(),
      sweep: vi.fn(async () => ({ killed: [] as number[] })),
    };
    const engine = new BrowserEngine({
      dataDir,
      config: { executablePath: garbage }, // 显式路径命中发现序①——垃圾文件原样透传
      spawnEngine: spawnEngineProcess, // 真闭包（组合根同款——被测对象本体）
      killTree,
      registry,
      newConnection: (o) => new JsonRpcConnection(o),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      notify: vi.fn(),
      idleMs: 60_000,
      startupTimeoutMs: 300, // 非 darwin 异步形态腿的等待帽（本平台同步抛用不到）
    });

    // 失败原样上抛（两形态合同：干净失败路）——修前修后都 rejects
    await expect(engine.acquireContext('sess-A')).rejects.toThrow();
    // 修前红位：spawn 调用位在 bringUp try 之外，ENOEXEC 同步抛裸穿——
    // status 钉死 'starting'（#17 状态不谎报的反面）+ 清算零执行。修后：
    // 调用位并入 try，catch 清算 + 入口状态回放（'idle'）+ rethrow
    expect(engine.getStatus().state).not.toBe('starting');
    // 失败腿零登记零树杀（无进程可杀——pid 缺席不入册，收场不树杀空气）
    expect(registry.add).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();

    await engine.dispose(); // 失败后引擎可弃置（收场面不再二次爆炸）
  });
});
