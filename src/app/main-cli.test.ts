/**
 * L5 app — CLI 分派面回归锁（遗漏大扫 20260901-c 刀三：#1/#2/#13/#14）。
 *
 * 测法 = 真入口动态 import：main.ts 顶层 `main(process.argv.slice(2))` 在
 * import 时跑真分派——测试前置改写 process.argv、六命令主流程与 wrapper/
 * 检测面全部 vi.mock（mock 停在被测单元〔分派与解析〕的边界，非中间层），
 * 用法错路径在触达任何主流程前返回，断言退出码与 stderr 文案。
 *
 * 覆盖四修死：#1 未识别 `--` 词全入口退 2 + `--` 终结符保真 / #2 tick×
 * --sandbox-host wrapper 档位恒 read-only / #13 upgrade 互斥面（appFile 入列、
 * standalone 退役）/ #14 --app-file 空串占位两入口退 2。
 */

import { describe, expect, it, vi } from 'vitest';

/* ---------------- 六命令主流程 + wrapper/检测面全 mock（单元边界） ---------------- */

vi.mock('./tui-main.js', () => ({ tuiMain: vi.fn(async () => 0) }));
vi.mock('./run-main.js', () => ({ runOnceMain: vi.fn(async () => 0) }));
vi.mock('./tick-main.js', () => ({ tickMain: vi.fn(async () => 0) }));
vi.mock('./dump-config.js', () => ({ dumpConfigMain: vi.fn(async () => 0) }));
vi.mock('./host-sandbox.js', () => ({ relaunchUnderHostSandbox: vi.fn(async () => 0) }));
vi.mock('./daemon.js', () => ({
  daemonCommandMain: vi.fn(async () => 0),
  daemonDoctorMain: vi.fn(async () => 0),
  daemonForegroundMain: vi.fn(async () => 0),
  detectDaemonHandshake: vi.fn(async () => undefined),
}));
vi.mock('./attach-main.js', () => ({ attachMain: vi.fn(async () => 0) }));
vi.mock('./upgrade.js', () => ({ upgradeMain: vi.fn(async () => 0) }));

/** 一次真分派：改 argv → 动态 import（顶层跑 main）→ 等异步退出码落定 */
async function dispatch(argv: readonly string[]): Promise<{ code: number | null | undefined; stderr: string }> {
  vi.clearAllMocks(); // 清跨用例调用史（resetModules 不清 mock 历史——断言只看本次分派）
  vi.resetModules();
  const origArgv = process.argv;
  const origCode = process.exitCode;
  const errChunks: string[] = [];
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    errChunks.push(String(chunk));
    return true;
  });
  process.argv = ['node', '/berry', ...argv];
  try {
    await import('./main.js');
    // 分派是 run().then 异步落 exitCode——一个宏任务足够（用法错分支同步返回）
    await new Promise((resolve) => setTimeout(resolve, 0));
    const code = process.exitCode; // Node 类型面含 string 形——本分派只落 number
    return { code: typeof code === 'number' ? code : undefined, stderr: errChunks.join('') };
  } finally {
    process.argv = origArgv;
    process.exitCode = origCode;
    errSpy.mockRestore();
  }
}

/* ---------------- #1：未识别 -- 词 + 终结符 ---------------- */

describe('CLI 分派：未识别 `--` 旗标与终结符（20260901-c #1）', () => {
  it('run 收未识别 = 取值形（--app=chat）→ 用法错退 2（旧形静默并进消息送 LLM）', async () => {
    const { code, stderr } = await dispatch(['run', '--app=chat', 'hi']);
    expect(code).toBe(2);
    expect(stderr).toContain('未识别旗标');
    expect(stderr).toContain('--app=chat');
  });

  it('run 收拼写错写（--readnly）→ 用法错退 2', async () => {
    const { code } = await dispatch(['run', '--readnly', 'hi']);
    expect(code).toBe(2);
  });

  it('`--` 终结符：其后 argv 全字面——以 -- 起头的消息内容保真送达 runOnceMain', async () => {
    const { runOnceMain } = await import('./run-main.js');
    const { code } = await dispatch(['run', '--', '--app=chat', 'hi']);
    expect(code).toBe(0); // 无用法错（终结符后不再按旗标解析）
    expect(vi.mocked(runOnceMain)).toHaveBeenCalledTimes(1);
    // 消息 = 终结符后词原样拼接（旧形裸 '--' 与 '--app=chat' 一并混进消息）
    expect(vi.mocked(runOnceMain).mock.calls[0]![0]).toBe('--app=chat hi');
  });

  it('未识别闸全入口一致：裸 berry（TUI）与 upgrade 同退 2', async () => {
    expect((await dispatch(['--app=chat'])).code).toBe(2);
    expect((await dispatch(['upgrade', '--verbose'])).code).toBe(2);
  });

  it('已知旗标与命令位词不受闸影响：--version / -v / --help 照常', async () => {
    expect((await dispatch(['--version'])).code).toBe(0);
    expect((await dispatch(['-v'])).code).toBe(0);
    expect((await dispatch(['--help'])).code).toBe(0);
  });
});

/* ---------------- #2：tick wrapper 档位同源 ---------------- */

describe('CLI 分派：tick×--sandbox-host wrapper 档位（20260901-c #2）', () => {
  it('tick 形态 wrapper 档恒 read-only（旧形缺席 --read-only 时给 workspace-write——硬墙宽于进程档）', async () => {
    const { relaunchUnderHostSandbox } = await import('./host-sandbox.js');
    const { code } = await dispatch(['run', '--tick', 'job1', '--sandbox-host']);
    expect(code).toBe(0);
    expect(vi.mocked(relaunchUnderHostSandbox)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(relaunchUnderHostSandbox).mock.calls[0]![2]).toBe('read-only');
  });

  it('普通单发 wrapper 档维持两档：缺省 workspace-write / --read-only 给 read-only（不随本修窄化）', async () => {
    await dispatch(['run', 'hi', '--sandbox-host']);
    // resetModules 换代后须重取同代 mock 引用（模块缓存已指向新一代实例）
    let relaunch = (await import('./host-sandbox.js')).relaunchUnderHostSandbox;
    expect(vi.mocked(relaunch).mock.calls[0]![2]).toBe('workspace-write');
    await dispatch(['run', 'hi', '--read-only', '--sandbox-host']);
    relaunch = (await import('./host-sandbox.js')).relaunchUnderHostSandbox;
    expect(vi.mocked(relaunch).mock.calls[0]![2]).toBe('read-only');
  });
});

/* ---------------- #13：upgrade 互斥面 ---------------- */

describe('CLI 分派：upgrade 互斥面修订（20260901-c #13）', () => {
  it('--app-file 并给 upgrade → 用法错退 2（旧形静默吞、spawn npm i -g 会真跑）', async () => {
    const { upgradeMain } = await import('./upgrade.js');
    const { code, stderr } = await dispatch(['upgrade', '--app-file', 'x.ts']);
    expect(code).toBe(2);
    expect(stderr).toContain('用法：berry upgrade');
    expect(vi.mocked(upgradeMain)).not.toHaveBeenCalled();
  });

  it('--standalone 并给 upgrade → 无害忽略照常执行（旧形误拒——偏离无害忽略律的码面孤例）', async () => {
    const { upgradeMain } = await import('./upgrade.js');
    const { code } = await dispatch(['--standalone', 'upgrade']);
    expect(code).toBe(0);
    expect(vi.mocked(upgradeMain)).toHaveBeenCalledTimes(1);
  });
});

/* ---------------- #14：--app-file 空串占位执法 ---------------- */

describe('CLI 分派：--app-file 缺值空串占位（20260901-c #14）', () => {
  it('TUI 入口缺值 → 用法错退 2（旧形直传装配层 APP_ENTRY_UNRESOLVED 退 1）', async () => {
    const { tuiMain } = await import('./tui-main.js');
    const { code, stderr } = await dispatch(['--app-file']);
    expect(code).toBe(2);
    expect(stderr).toContain('用法：berry --app-file');
    expect(vi.mocked(tuiMain)).not.toHaveBeenCalled();
  });

  it('run 入口缺值 → 用法错退 2（同律）', async () => {
    const { runOnceMain } = await import('./run-main.js');
    const { code, stderr } = await dispatch(['run', 'hi', '--app-file']);
    expect(code).toBe(2);
    expect(stderr).toContain('用法：berry run --app-file');
    expect(vi.mocked(runOnceMain)).not.toHaveBeenCalled();
  });
});

/* ---------------- #31：未知 APP_ 环境变量提示（基建大扫） ---------------- */

describe('CLI 入口：未知 APP_ 环境变量提示（基建大扫 #31）', () => {
  /** 纯函数直调断言（词表/告警文案面）——不依赖分派 */
  it('拼错键点名告警；词表内与宿主注入 APP_SESSION_ID 零告警', async () => {
    const { warnUnknownAppEnvVars } = await import('./main.js');
    // 拼错键（APP_DAT_DIR ≠ APP_DATA_DIR）+ 无关键混排 → 一行点名
    const lines: string[] = [];
    warnUnknownAppEnvVars(
      { APP_DAT_DIR: '/x', APP_MODEL: 'm', APP_SESSION_ID: 's1', PATH: '/bin' } as NodeJS.ProcessEnv,
      (l) => lines.push(l),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('APP_DAT_DIR');
    expect(lines[0]).not.toContain('APP_MODEL');
    expect(lines[0]).not.toContain('APP_SESSION_ID');
    // 词表全键 + 宿主注入位 → 零输出
    const quiet: string[] = [];
    warnUnknownAppEnvVars(
      {
        APP_MODEL: 'm',
        APP_DATA_DIR: '/d',
        APP_DB_PATH: '/d/s.db',
        APP_LOG_LEVEL: 'info,session:debug',
        APP_FD_PATH: '/fd',
        APP_BASH_PATH: '/bash',
        APP_BROWSER_PATH: '/chrome',
        APP_SESSION_ID: 's1',
      } as NodeJS.ProcessEnv,
      (l) => quiet.push(l),
    );
    expect(quiet).toHaveLength(0);
  });

  it('真分派织入：boot 期告警达 stderr 且不拦启动（退出码不受影响）', async () => {
    process.env['APP_DAT_DIR'] = '/typo'; // 拼错键——分派前置注入
    try {
      const { code, stderr } = await dispatch(['run', 'hi']);
      expect(code).toBe(0); // 不硬拒：前向兼容，行为照常
      expect(stderr).toContain('APP_DAT_DIR');
      expect(stderr).toContain('berry --help');
    } finally {
      delete process.env['APP_DAT_DIR'];
    }
  });
});
