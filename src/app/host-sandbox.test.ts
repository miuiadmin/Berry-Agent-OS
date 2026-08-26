/**
 * L5 app — e1 宿主沙箱包裹测试（技术栈篇 §5 第二十八批题 3A 落码）。
 *
 * 纯函数面（hostWritableRoots / relaunchArgv）直测；重 exec 面拦
 * node:child_process 的 spawnSync——不真起 wrapper 进程，只断言：
 * ①wrapper argv 走后端 wrap（runner 前缀 + 剥旗标内层）；②退出码透传；
 * ③空链 fail-closed 绝不 spawn 裸跑（Windows 无后端形态的执法回归锁）。
 * 环境面用 vi.stubEnv 注入 APP_DATA_DIR/APP_DB_PATH（与生产路径同构——
 * paths.ts 三函数的测试注入首选）。
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 拦 spawnSync（host-sandbox 件唯一的进程副作用）：模块加载序无碍——vi.mock 提升
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});

import { HOST_SANDBOX_FLAG, hostWritableRoots, relaunchArgv, relaunchUnderHostSandbox } from './host-sandbox.js';
import type { RelaunchOptions } from './host-sandbox.js';

/** 临时目录（realpath 归一——canonicalPath 幂等，比较稳） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/** 假后端类型（经 RelaunchOptions 注入面取型——测试不跨模块引 safety） */
type FakeBackend = NonNullable<RelaunchOptions['backends']>[number];

/** 假后端：wrap 前缀 runner 名（成功路径断言锚点）；无 probe——单候选链不预探测同律 */
const fakeBackend = (runner: string): FakeBackend => ({
  id: 'fake',
  enforcement: 'full',
  denialSignatures: [],
  runnerFailureRules: [],
  wrap: (argv) => [runner, ...argv],
});

afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.unstubAllEnvs();
});

describe('e1 宿主沙箱（host-sandbox 件）', () => {
  it('hostWritableRoots：read-only 档推导根为空，但数据目录/库父目录恒放行（durable 承诺须写库）', () => {
    const data = makeTempDir('e1-data-');
    const db = join(makeTempDir('e1-db-'), 'x.db'); // 库显式指到别处（APP_DB_PATH 形态）
    vi.stubEnv('APP_DATA_DIR', data);
    vi.stubEnv('APP_DB_PATH', db);
    // read-only 档 deriveWritableRoots 为空——宿主版差异即此两根刚需追加
    expect(hostWritableRoots(makeTempDir('e1-ws-'), 'read-only')).toEqual([data, dirname(db)]);
  });

  it('hostWritableRoots：workspace-write 档 = 档位推导根 ∪ 数据目录 ∪ 库父目录（去重不膨胀）', () => {
    const data = makeTempDir('e1-data-');
    vi.stubEnv('APP_DATA_DIR', data);
    // 缺省形态：库在数据目录内——dirname(dbPath) 与 dataDir 同目录，Set 归并一份
    vi.stubEnv('APP_DB_PATH', join(data, 'sessions.db'));
    const ws = makeTempDir('e1-ws-');
    const roots = hostWritableRoots(ws, 'workspace-write');
    expect(roots).toContain(ws); // 工作区档位根（官方件主线程写工作面的执法锚）
    expect(roots).toContain(data); // 数据目录（库 + 凭证）
    expect(new Set(roots).size).toBe(roots.length); // 去重执法（同目录不双计）
    // read-only 档对照：工作区根不在（只读档不获得工作区写面）
    expect(hostWritableRoots(ws, 'read-only')).not.toContain(ws);
  });

  it('relaunchArgv：剥旗标防递归；argv[0]/[1] 原样保留（node 直跑与 bin shim 两形态统一）', () => {
    // node 直跑形态：argv[0]=node 路径、argv[1]=脚本绝对路径
    expect(relaunchArgv(['/usr/bin/node', '/x/dist/app/main.js', 'run', HOST_SANDBOX_FLAG, 'hi'])).toEqual([
      '/usr/bin/node',
      '/x/dist/app/main.js',
      'run',
      'hi',
    ]);
    // 重复传入剥净（防递归兜底——首层出现全数滤除）
    expect(relaunchArgv(['node', 'main.js', HOST_SANDBOX_FLAG, 'run', HOST_SANDBOX_FLAG, 'hi'])).toEqual([
      'node',
      'main.js',
      'run',
      'hi',
    ]);
    // 其他旗标原样透传（内层 argv 完整保真——--read-only/--app 等继续生效）
    expect(relaunchArgv(['node', 'main.js', 'run', '--read-only', '--app', 'code', HOST_SANDBOX_FLAG, 'hi'])).toEqual([
      'node',
      'main.js',
      'run',
      '--read-only',
      '--app',
      'code',
      'hi',
    ]);
  });

  it('relaunchArgv：execArgv 随行——tsx dev 形态的 loader 链插在 node 与脚本之间（真机冒烟实证回归锁）', () => {
    // 丢了 execArgv 即内层 ERR_MODULE_NOT_FOUND（.ts 源文件无人解释）——
    // 旗标序法：[node, ...execArgv, script, ...rest]，node CLI 本征序
    expect(
      relaunchArgv(
        ['node', '/x/src/app/main.ts', 'run', HOST_SANDBOX_FLAG, 'hi'],
        ['--require', '/tsx/preflight.cjs', '--import', '/tsx/loader.mjs'],
      ),
    ).toEqual([
      'node',
      '--require',
      '/tsx/preflight.cjs',
      '--import',
      '/tsx/loader.mjs',
      '/x/src/app/main.ts',
      'run',
      'hi',
    ]);
  });

  it('fail-closed 回归锁：无后端平台（空链）响亮拒退出码 1，绝不 spawn 裸跑', () => {
    // Windows 形态等价物（createDefaultBackends 空链）→ SANDBOX_UNAVAILABLE 拒
    const code = relaunchUnderHostSandbox(
      ['node', 'main.js', 'run', HOST_SANDBOX_FLAG, 'hi'],
      '/ws',
      'workspace-write',
      {
        backends: [],
      },
    );
    expect(code).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled(); // 绝不静默裸跑——执法面即此断言
  });

  it('重 exec 成功路径：spawn 收到后端 wrap 产物（runner 前缀 + 剥旗标内层 argv）；退出码透传', () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 7 } as ReturnType<typeof spawnSync>);
    const code = relaunchUnderHostSandbox(
      ['/usr/bin/node', '/x/dist/app/main.js', 'run', HOST_SANDBOX_FLAG, 'hi'],
      '/ws',
      'workspace-write',
      { backends: [fakeBackend('/wrapper/bin')], execArgv: [] },
    );
    expect(code).toBe(7); // 子进程退出码透传（run 单发形态的退出码即结果契约）
    const [runner, innerArgv] = vi.mocked(spawnSync).mock.calls[0]!;
    // command = runner（wrap 前缀）；args = 剥旗标的原 argv 全序（node + 脚本 + run …）
    expect(runner).toBe('/wrapper/bin');
    expect(innerArgv).toEqual(['/usr/bin/node', '/x/dist/app/main.js', 'run', 'hi']);
    expect(innerArgv).not.toContain(HOST_SANDBOX_FLAG); // 剥净执法（漏剥即无限递归 exec）
  });

  it('wrapper 启动失败（runner 缺失/异常终止）= 退出码 1 响亮，不伪造成功', () => {
    vi.mocked(spawnSync).mockReturnValue({ error: new Error('runner 缺失'), status: null } as ReturnType<
      typeof spawnSync
    >);
    const code = relaunchUnderHostSandbox(['node', 'main.js', 'run', HOST_SANDBOX_FLAG, 'hi'], '/ws', 'read-only', {
      backends: [fakeBackend('/wrapper/bin')],
      execArgv: [],
    });
    expect(code).toBe(1);
  });
});
