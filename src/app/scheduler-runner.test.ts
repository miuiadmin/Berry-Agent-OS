/**
 * L5 app — tick runner 组装单测（argv 公式 + env 合成 + 超时）。
 *
 * runArgv mock（只停在 spawn 边界——本测锁的是「怎么拼」，不是「怎么跑」；
 * spawn 本体由 exec 模块自测护航）。buildChildEnv 不 mock（纯函数真跑——
 * 白名单与 set 层语义恰是本测要断言的执法面）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** spawn 边界 mock（捕获 argv 与 opts——断言面；buildChildEnv 保真跑：白名单与 set 层语义恰是本测要断言的执法面） */
const runArgvMock = vi.fn(
  async (
    _argv: readonly string[],
    _opts?: object,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean; durationMs: number }> => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 1,
  }),
);
vi.mock('../exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec/index.js')>();
  return { ...actual, runArgv: (...args: unknown[]) => runArgvMock(...(args as [readonly string[], object?])) };
});

import { createTickRunner, TICK_TIMEOUT_MS, tickRelaunchBaseArgv } from './scheduler-runner.js';

beforeEach(() => {
  runArgvMock.mockClear();
});

describe('tickRelaunchBaseArgv：重放基座公式（20260901-d #6 勘正——三律单源）', () => {
  it('tsx dev 宿主形态：execArgv loader 随行（丢了裸 node 跑 .ts 必死 ERR_MODULE_NOT_FOUND）', () => {
    // 真实 tsx 形状（tsx 4 实测，非旧测试的 tsx-cli 假想）：argv=[node, main.ts]、
    // loader 两旗标挂 execArgv——原公式 argv.slice(1) 产物不带 loader，加载即死
    const base = tickRelaunchBaseArgv(
      ['/usr/bin/node', '/repo/src/app/main.ts'],
      ['--require', 'tsx/dist/preflight.cjs', '--import', 'tsx/dist/loader.mjs'],
    );
    expect(base).toEqual([
      '/usr/bin/node',
      '--require',
      'tsx/dist/preflight.cjs',
      '--import',
      'tsx/dist/loader.mjs',
      '/repo/src/app/main.ts',
    ]);
  });

  it('--port TUI 宿主形态：宿主旗标剔净（重放必撞 WEBUI_PORT_INUSE 拒启的修死）', () => {
    const base = tickRelaunchBaseArgv(['/usr/bin/node', '/opt/berry/dist/app/main.js', '--port', '7860'], []);
    // argv[2:] 一律不带——tick 子进程是全新单发，不继承宿主监听面/形态旗标
    expect(base).toEqual(['/usr/bin/node', '/opt/berry/dist/app/main.js']);
  });
});

describe('createTickRunner：argv 公式（重放基座三律）', () => {
  it('基座 argv + [run, --read-only, --background, prompt] 拼尾（注入基座=公式产物形态）', async () => {
    // 装包（dist）形态基座：宿主 argv=[node, main.js]、无 execArgv
    const distRunner = createTickRunner({
      dataDir: '/data',
      dbPath: '/data/sessions.db',
      baseArgv: ['/usr/bin/node', '/opt/berry/dist/app/main.js'],
      env: {},
    });
    await distRunner('巡检仓库状态');
    expect(runArgvMock).toHaveBeenCalledWith(
      // --background：tick 轮记账入后台道（席 13 第二刀 blocker 修——canAfford 读的账）
      ['/usr/bin/node', '/opt/berry/dist/app/main.js', 'run', '--read-only', '--background', '巡检仓库状态'],
      expect.objectContaining({ timeoutMs: TICK_TIMEOUT_MS }),
    );

    // dev（tsx）形态基座 = 公式产物（loader 随行 + 只取入口脚本）
    const devBase = tickRelaunchBaseArgv(
      ['/usr/bin/node', '/repo/src/app/main.ts'],
      ['--require', 'tsx/dist/preflight.cjs', '--import', 'tsx/dist/loader.mjs'],
    );
    const devRunner = createTickRunner({
      dataDir: '/data',
      dbPath: '/data/sessions.db',
      baseArgv: devBase,
      env: {},
    });
    await devRunner('hi');
    const argv = runArgvMock.mock.calls.at(-1)![0]!;
    expect(argv).toEqual([...devBase, 'run', '--read-only', '--background', 'hi']);
  });

  it('缺省基座 = [execPath, ...execArgv, argv[1]]（宿主重放三律直读——旗标不随行）', async () => {
    const runner = createTickRunner({ dataDir: '/d', dbPath: '/d/x.db', env: {} });
    await runner('p');
    const argv = runArgvMock.mock.calls[0]![0]!;
    expect(argv[0]).toBe(process.execPath);
    // 去掉尾四段（run/--read-only/--background/prompt）后恰 = [...execArgv, argv[1]]
    expect(argv.slice(1, -4)).toEqual([...process.execArgv, process.argv[1]!]);
  });

  it('timeoutMs 显式覆盖（缺省 10 分钟——模型流挂死护栏）', async () => {
    expect(TICK_TIMEOUT_MS).toBe(10 * 60_000);
    const runner = createTickRunner({ dataDir: '/d', dbPath: '/d/x.db', env: {}, timeoutMs: 1500 });
    await runner('p');
    expect(runArgvMock.mock.calls[0]![1]).toMatchObject({ timeoutMs: 1500 });
  });
});

describe('createTickRunner：env 合成（白名单 + set 显式层）', () => {
  it('set 显式注入数据目录定位 + 凭证族（宿主 env 有值才传）', async () => {
    const runner = createTickRunner({
      dataDir: '/data',
      dbPath: '/data/sessions.db',
      env: {
        PATH: '/usr/bin',
        ANTHROPIC_AUTH_TOKEN: 'tok-x',
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        ANTHROPIC_API_KEY: '', // 空串 = 无值，不造空串进子进程
      },
    });
    await runner('p');
    const env = (runArgvMock.mock.calls[0]![1] as { env: Record<string, string> }).env;
    expect(env['APP_DATA_DIR']).toBe('/data');
    expect(env['APP_DB_PATH']).toBe('/data/sessions.db');
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBe('tok-x');
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://proxy.example');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    // 白名单基础变量透传（deny-by-default 的另一半）
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('白名单外变量不透传（禁运族即使宿主有值也只经名单传递——不在名单即不出现）', async () => {
    const runner = createTickRunner({
      dataDir: '/d',
      dbPath: '/d/x.db',
      env: { PATH: '/bin', MY_SERVICE_SECRET: 'leak?', RANDOM_TOKEN: 'x' },
    });
    await runner('p');
    const env = (runArgvMock.mock.calls[0]![1] as { env: Record<string, string> }).env;
    expect(env['MY_SERVICE_SECRET']).toBeUndefined();
    expect(env['RANDOM_TOKEN']).toBeUndefined();
  });

  it('宿主覆盖类同路透传（基建大扫 #29）：APP_MODEL/APP_BASH_PATH/APP_LOG_LEVEL 有值才传——凭证到模型也到', async () => {
    const runner = createTickRunner({
      dataDir: '/data',
      dbPath: '/data/sessions.db',
      env: {
        PATH: '/usr/bin',
        APP_MODEL: 'anthropic/claude-sonnet-5', // 模型覆盖——修前被白名单剥掉：凭证到了模型没到
        APP_BASH_PATH: '/custom/bin/bash', // bash 工具显式覆盖——丢失则重走四级发现序（win32 失效）
        APP_LOG_LEVEL: 'debug', // 子进程日志级别随宿主（轮账排障面）
      },
    });
    await runner('p');
    const env = (runArgvMock.mock.calls[0]![1] as { env: Record<string, string> }).env;
    expect(env['APP_MODEL']).toBe('anthropic/claude-sonnet-5');
    expect(env['APP_BASH_PATH']).toBe('/custom/bin/bash');
    expect(env['APP_LOG_LEVEL']).toBe('debug');
  });

  it('宿主覆盖类缺席不造面（#29 同款不造空串：宿主无值/空串 = 子进程同键缺席）', async () => {
    const runner = createTickRunner({
      dataDir: '/d',
      dbPath: '/d/x.db',
      env: { PATH: '/bin', APP_MODEL: '', APP_FD_PATH: '/fd' }, // 空串 MODEL + 名单外 FD 路径
    });
    await runner('p');
    const env = (runArgvMock.mock.calls[0]![1] as { env: Record<string, string> }).env;
    expect(env['APP_MODEL']).toBeUndefined(); // 空串不传
    expect(env['APP_BASH_PATH']).toBeUndefined(); // 宿主无值不传
    expect(env['APP_FD_PATH']).toBeUndefined(); // 名单外 APP_* 保留前缀不隐式扩面（tick 子进程无 TUI 面）
  });
});
