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

import { createTickRunner, TICK_TIMEOUT_MS } from './scheduler-runner.js';

beforeEach(() => {
  runArgvMock.mockClear();
});

describe('createTickRunner：argv 公式（宿主即主入口进程假设）', () => {
  it('基座 argv + [run, --read-only, prompt] 拼尾——两形态同式', async () => {
    // 装包（dist）形态：argv = [node, main.js]
    const distRunner = createTickRunner({
      dataDir: '/data',
      dbPath: '/data/sessions.db',
      baseArgv: ['/usr/bin/node', '/opt/berry/dist/app/main.js'],
      env: {},
    });
    await distRunner('巡检仓库状态');
    expect(runArgvMock).toHaveBeenCalledWith(
      ['/usr/bin/node', '/opt/berry/dist/app/main.js', 'run', '--read-only', '巡检仓库状态'],
      expect.objectContaining({ timeoutMs: TICK_TIMEOUT_MS }),
    );

    // dev（tsx）形态：argv = [node, tsx-cli, main.ts]——slice(1) 重放同样成立
    const devRunner = createTickRunner({
      dataDir: '/data',
      dbPath: '/data/sessions.db',
      baseArgv: ['/usr/bin/node', '/repo/node_modules/tsx/dist/cli.mjs', '/repo/src/app/main.ts'],
      env: {},
    });
    await devRunner('hi');
    const argv = runArgvMock.mock.calls.at(-1)![0]!;
    expect(argv).toEqual([
      '/usr/bin/node',
      '/repo/node_modules/tsx/dist/cli.mjs',
      '/repo/src/app/main.ts',
      'run',
      '--read-only',
      'hi',
    ]);
  });

  it('缺省基座 = [process.execPath, ...process.argv.slice(1)]（宿主主入口直读）', async () => {
    const runner = createTickRunner({ dataDir: '/d', dbPath: '/d/x.db', env: {} });
    await runner('p');
    const argv = runArgvMock.mock.calls[0]![0]!;
    expect(argv[0]).toBe(process.execPath);
    // 去掉尾三段（run/--read-only/prompt）后，[1:] 段 = 当下 process.argv.slice(1)
    expect(argv.slice(1, -3)).toEqual(process.argv.slice(1));
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
});
