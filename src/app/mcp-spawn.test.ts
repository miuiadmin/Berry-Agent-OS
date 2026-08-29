/**
 * L5 app — MCP spawner OS 沙箱升格测试（契约篇 §6.6 OS 沙箱层升格 /
 * 内核篇分层信任句式④兑现——2026-08-29）。
 *
 * 三面：
 *  1. confine 接线（fake sandbox 注入）：spawn 消费 confine 产物（argv 换轨
 *     ——裸 command 必 ENOENT，confine 产物可跑）+ 策略面（固定
 *     workspace-write + writableRoots=[dataDir, workspace] 归一形）+ cwd 钉
 *     dataDir + env 白名单 set 层保留（叠加执法）；
 *  2. probe fail-closed（fake sandbox）：空后端链 / probe 失败 → reject
 *     SANDBOX_UNAVAILABLE（服务器绝不裸起）；probe-once（连续 spawn 只探一次
 *     ——bridge-fleet ensureOsLayer 同形态）；
 *  3. darwin 真后端 e2e：真 seatbelt 链真跑——服务器写 dataDir 过、写根外
 *     EPERM 拒（workspace-write 档 OS 层真执法，非 mock）。
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpawnedChild } from '../mcp/index.js';
import type { SandboxBackend, SandboxPolicy, SandboxService } from '../safety/index.js';
import { createSandboxService } from '../safety/index.js';
import { SANDBOX_UNAVAILABLE } from '../contracts/errors.js';
import { createMcpSpawner } from './mcp-spawn.js';

/* ---------------- 测试基建 ---------------- */

/** 轮询直到谓词为真（异步到达面的确定性等待） */
async function until(predicate: () => boolean, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect.unreachable(`轮询超时（${ms}ms）——异步面未到达`);
}

/** 取 reject 的错误（code 面可判 AppError 词汇） */
async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const err = await promise.then(
    () => {
      throw new Error('预期 reject，实际 resolve');
    },
    (e: unknown) => e,
  );
  if (!(err instanceof Error)) throw err;
  const coded = err as { code?: string; message: string };
  if (typeof coded.code !== 'string') throw err;
  return coded as { code: string; message: string };
}

/** 测试根（dataDir/workspace 双目录——真实双根形态） */
let dataDir: string;
let workspace: string;

beforeAll(() => {
  dataDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mcp-spawn-data-')));
  workspace = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mcp-spawn-ws-')));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** 造假沙箱服务（接线断言面——confine 产物与调用记录全可控） */
function fakeSandbox(opts: {
  /** confine 产物 argv（消费方 spawn 它——marker 写入形态换轨证） */
  argv: string[];
  /** 后端链（空数组 = 空链 fail-closed 面；probe 可控；wrap 不被触达——confine 已覆写） */
  backends: Array<Pick<SandboxBackend, 'id'> & { probe?: () => boolean }>;
  /** confine 调用记录（注入侧收集） */
  calls?: Array<{ argv: string[]; policy: SandboxPolicy }>;
}): SandboxService {
  return {
    confine: (argv, policy) => {
      opts.calls?.push({ argv: [...argv], policy });
      return {
        argv: opts.argv,
        enforcement: 'full',
        denialSignatures: [],
        runnerFailureRules: [],
      };
    },
    registerBackend: () => () => undefined, // fake 面：注册/注销零行为
    // 后端链补全：用例只声明 id/probe 差异面，其余字段按「不被触达」补默认
    //（confine 已覆写、wrap 不被调）——补全后自然合法无 cast
    listBackends: () =>
      opts.backends.map((b) => ({
        enforcement: 'full' as const,
        denialSignatures: [],
        runnerFailureRules: [],
        wrap: (argv: readonly string[]) => [...argv],
        ...b,
      })),
  };
}

/** 探针脚本：node -e 源——把 {cwd, env, write 产物} 落 marker（一子进程吃三断言） */
const probeScript = (marker: string, target?: string) => `
const fs = require('fs');
const report = { cwd: process.cwd(), env: process.env.FX_MCP_ENV_KEY ?? null, wrote: null };
${target === undefined ? '' : `try { fs.writeFileSync(${JSON.stringify(target)}, 'ok'); report.wrote = true; } catch (err) { report.wrote = String(err.code); }`}
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(report));
`;

/* ---------------- 面 1：confine 接线（argv 换轨 + 策略面 + cwd/env 叠加层） ---------------- */

describe('createMcpSpawner — OS 沙箱升格接线', () => {
  it(
    'spawn 消费 confine 产物：argv 换轨（裸 command 不达 spawn）+ 策略面固定档 + cwd/env 叠加层保留',
    { timeout: 30_000 },
    async () => {
      const marker = join(dataDir, 'argv-track.json');
      const calls: Array<{ argv: string[]; policy: SandboxPolicy }> = [];
      // confine 产物 = 真可跑的 node 探针（marker 写入 = spawn 走了 confine 产物的
      // 字面证据）；裸 command 指向不存在路径——旧形态（无 confine）必 ENOENT
      // reject，本断言即升格回归锁（修前红锚：旧签名 spawn config.command 原样）
      const sandbox = fakeSandbox({
        argv: [process.execPath, '-e', probeScript(marker)],
        backends: [{ id: 'fake', probe: () => true }],
        calls,
      });
      const spawnServer = createMcpSpawner(dataDir, sandbox, workspace);
      const child = await spawnServer({
        command: '/nonexistent/mcp-server-binary',
        args: ['--flag', 'value'],
        env: { FX_MCP_ENV_KEY: 'set-layer' },
      });
      await until(() => existsSync(marker));
      // confine 调用面：原 argv 原序透传（command + args 拼装）+ 策略固定档
      expect(calls).toHaveLength(1);
      expect(calls[0]!.argv).toEqual(['/nonexistent/mcp-server-binary', '--flag', 'value']);
      expect(calls[0]!.policy.mode).toBe('workspace-write');
      // 可写根 = [dataDir, workspace] 归一形（realpath 防前缀漂移——fixture 已归一）
      expect(calls[0]!.policy.writableRoots).toEqual([dataDir, workspace]);
      expect(calls[0]!.policy.workspaceRoot).toBe(workspace);
      // cwd 钉 dataDir + env 白名单 set 层直传（叠加执法：OS 层之上 env 层仍在）
      const report = JSON.parse(readFileSync(marker, 'utf8')) as { cwd: string; env: string | null };
      expect(report.cwd).toBe(dataDir);
      expect(report.env).toBe('set-layer');
      // 子进程为短命 node -e（marker 落盘即全部断言完备），自退无泄漏——不等待不清扫
    },
  );

  /* ---------------- 面 2：probe fail-closed ---------------- */

  it('空后端链：reject SANDBOX_UNAVAILABLE——服务器绝不裸起（win32 现状同貌）', async () => {
    const sandbox = fakeSandbox({ argv: [], backends: [] });
    const err = await rejection(createMcpSpawner(dataDir, sandbox, workspace)({ command: '/nonexistent/x' }));
    expect(err.code).toBe(SANDBOX_UNAVAILABLE);
  });

  it('probe 失败：reject SANDBOX_UNAVAILABLE（后端在链但内核不执行 = 拒 spawn）', async () => {
    const sandbox = fakeSandbox({ argv: [], backends: [{ id: 'broken', probe: () => false }] });
    const err = await rejection(createMcpSpawner(dataDir, sandbox, workspace)({ command: '/nonexistent/x' }));
    expect(err.code).toBe(SANDBOX_UNAVAILABLE);
    expect(err.message).toContain('broken');
  });

  it('probe-once：连续两 spawn 只探测一次（bridge-fleet ensureOsLayer 同形态）', { timeout: 30_000 }, async () => {
    let probes = 0;
    const marker = join(dataDir, 'probe-once.json');
    const sandbox = fakeSandbox({
      argv: [process.execPath, '-e', probeScript(marker)],
      backends: [{ id: 'fake', probe: () => (probes++, true) }],
    });
    const spawnServer = createMcpSpawner(dataDir, sandbox, workspace);
    const child1 = await spawnServer({ command: '/nonexistent/a' });
    const child2 = await spawnServer({ command: '/nonexistent/b' });
    // probe 在每次 spawn 前同步发生——两连 spawn 后即完备（子进程短命自退）
    expect(probes).toBe(1); // 两次 spawn、一次探测——probe-once 语义
  });

  /* ---------------- 面 3：darwin 真后端 e2e（seatbelt 真跑） ---------------- */

  const itDarwin = process.platform === 'darwin' ? it : it.skip;

  itDarwin(
    '真 seatbelt 链真执法：服务器写 dataDir 过 / 写根外 EPERM 拒（workspace-write 档 OS 层非 mock）',
    { timeout: 60_000 },
    async () => {
      const sandbox = createSandboxService(); // darwin → seatbelt 真链
      const spawnServer = createMcpSpawner(dataDir, sandbox, workspace);
      // 根外靶：fixture 兄弟目录（不在 writableRoots=[dataDir, workspace] 内）
      const outside = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mcp-spawn-out-')));
      try {
        // 内写腿：dataDir 内 marker——seatbelt subpath 放行
        const insideMarker = join(dataDir, 'seatbelt-inside.json');
        const insideTarget = join(dataDir, 'inside-target.txt');
        const childIn = await spawnServer({
          command: process.execPath,
          args: ['-e', probeScript(insideMarker, insideTarget)],
        });
        await until(() => existsSync(insideMarker));
        const inReport = JSON.parse(readFileSync(insideMarker, 'utf8')) as { wrote: string | boolean | null };
        expect(inReport.wrote).toBe(true); // 根内写放行（dataDir 在 writableRoots）
        expect(existsSync(insideTarget)).toBe(true);

        // 外写腿：outside 靶——seatbelt file-write* 全拒（EPERM 直证）
        const outsideMarker = join(dataDir, 'seatbelt-outside.json');
        const outsideTarget = join(outside, 'must-not-exist.txt');
        const childOut = await spawnServer({
          command: process.execPath,
          args: ['-e', probeScript(outsideMarker, outsideTarget)],
        });
        await until(() => existsSync(outsideMarker));
        const outReport = JSON.parse(readFileSync(outsideMarker, 'utf8')) as { wrote: string | boolean | null };
        expect(outReport.wrote).toBe('EPERM'); // 根外写拒——OS 层真执法签名
        expect(existsSync(outsideTarget)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});
