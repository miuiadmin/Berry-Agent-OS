/**
 * L5 app — OS 定时注册器测试（席 13 第二刀 K2-d）。
 *
 * mock 只停在系统命令边界：launchctl/crontab 注入临时假脚本（记录调用 +
 * 假 crontab 模拟 -l/装载两态），plist 写入/删除/探测全真（临时 LaunchAgents
 * 目录）。纯函数翻译（三形状 → launchd/cron 字段）冻结时钟逐点断言。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobsStore } from '../scheduler/store.js';
import type { JobRecord } from '../scheduler/types.js';
import { openStore } from '../persist/index.js';
import { collectBuiltinMigrations } from './builtins.js';
import { createTickOsRegistrar, scheduleToLaunchd, scheduleToCronFields } from './tick-register.js';
import type { TickOsOptions } from './tick-register.js';
import { tickRelaunchBaseArgv } from './scheduler-runner.js';

/* ---------------- 基建 ---------------- */

/** 临时目录（realpath 归一） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/**
 * 假 launchctl 脚本：调用参数逐行记录到固定 log 文件，恒 exit 0。
 * （失败分支注入 failLaunchctl 变体：恒 exit 1 带 stderr）
 */
function makeFakeLaunchctl(fail = false): { bin: string; logFile: string } {
  const dir = makeTempDir('tick-launchctl-');
  const logFile = join(dir, 'calls.log');
  const bin = join(dir, 'launchctl');
  writeFileSync(
    bin,
    fail
      ? `#!/bin/sh\necho "$@" >> ${JSON.stringify(logFile)}\necho "launchctl: could not load" >&2\nexit 1\n`
      : `#!/bin/sh\necho "$@" >> ${JSON.stringify(logFile)}\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, logFile };
}

/**
 * 假 crontab 脚本：状态文件模拟表内容——`-l` 打印（无表 exit 1）、
 * `<file>` 拷贝装载。脚本内容内插固定状态路径（经 buildChildEnv 的自定义
 * env 会被白名单剥掉，不走 env 通道）。
 */
function makeFakeCrontab(): { bin: string; stateFile: string } {
  const dir = makeTempDir('tick-crontab-');
  const stateFile = join(dir, 'crontab-state');
  const bin = join(dir, 'crontab');
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "-l" ]; then
  if [ -f ${JSON.stringify(stateFile)} ]; then cat ${JSON.stringify(stateFile)}; exit 0; fi
  exit 1
fi
cp "$1" ${JSON.stringify(stateFile)}
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return { bin, stateFile };
}

/** 注册器构造帮手（每用例独立目录树：dataDir + LaunchAgents） */
function makeSetup(platform: NodeJS.Platform) {
  const root = makeTempDir('tick-reg-');
  const dataDir = join(root, 'data');
  const launchAgentsDir = join(root, 'LaunchAgents');
  mkdirSync(dataDir, { recursive: true });
  const launchctl = makeFakeLaunchctl();
  const crontab = makeFakeCrontab();
  const opts: TickOsOptions = {
    dataDir,
    dbPath: join(dataDir, 'db.sqlite'),
    platform,
    launchAgentsDir,
    baseArgv: ['/usr/bin/node', '/opt/dist/main.js'],
    launchctlBin: launchctl.bin,
    crontabBin: crontab.bin,
  };
  return {
    registrar: createTickOsRegistrar(opts),
    opts,
    dataDir,
    launchAgentsDir,
    launchctl,
    crontab,
  };
}

/** 真库种子一行任务（:memory: + collectBuiltinMigrations——行读全真） */
function makeJob(name: string, schedule: string | null, createdAt = Date.now()): JobRecord {
  const store = openStore({ path: ':memory:', migrations: collectBuiltinMigrations() });
  try {
    new JobsStore(store.connection).add(name, '指令', createdAt, schedule);
    const job = new JobsStore(store.connection).get(name);
    if (job === undefined) throw new Error('种子失败');
    return job;
  } finally {
    store.close();
  }
}

/* ---------------- 纯函数：三形状翻译 ---------------- */

describe('scheduleToLaunchd（三形状 → launchd 调度形状）', () => {
  it('daily@HH:MM → 日历字段（无年月日 = 每日）', () => {
    expect(scheduleToLaunchd('daily@08:30', 1)).toEqual({
      kind: 'calendar',
      fields: { Hour: 8, Minute: 30 },
    });
  });

  it('every@<n>[mhd] → 秒数间隔', () => {
    expect(scheduleToLaunchd('every@2h', 1)).toEqual({ kind: 'interval', seconds: 7200 });
    expect(scheduleToLaunchd('every@1m', 1)).toEqual({ kind: 'interval', seconds: 60 });
  });

  it('once@<ISO> → 全字段单点（本地投影——launchd 本地钟语义）', () => {
    // 本地时区 ISO（无后缀）→ 本地日历字段
    const iso = '2026-09-01T09:05';
    const result = scheduleToLaunchd(`once@${iso}`, Date.parse('2026-08-26T12:00:00'));
    expect(result).toEqual({
      kind: 'calendar',
      fields: { Year: 2026, Month: 9, Day: 1, Hour: 9, Minute: 5 },
    });
    // 显式 Z 时刻也投影到本地钟（与 daily 同律——Year 与时区偏移无关，
    // 月/日在极端偏移（±14h）下可能跨日，不作脆断言）
    const z = scheduleToLaunchd('once@2026-09-01T09:00:00Z', Date.parse('2026-08-26T12:00:00Z'));
    if ('error' in z || z.kind !== 'calendar') {
      expect.unreachable('once 应翻为全字段日历');
    } else {
      expect(z.fields.Year).toBe(2026);
    }
  });

  it('坏串 → 人读错误', () => {
    const result = scheduleToLaunchd('weekly@mon', 1);
    expect('error' in result).toBe(true);
  });
});

describe('scheduleToCronFields（cron v1 只 daily）', () => {
  it('daily@HH:MM → `分 时 * * *`', () => {
    expect(scheduleToCronFields('daily@08:30', 1)).toBe('30 8 * * *');
    expect(scheduleToCronFields('daily@00:00', 1)).toBe('0 0 * * *');
  });

  it('every/once → 披露不支持（错位支持会与库内 due 复闸打架）', () => {
    const every = scheduleToCronFields('every@2h', 1);
    expect(typeof every === 'object' && 'error' in every && every.error.includes('daily')).toBe(true);
    const once = scheduleToCronFields('once@2099-01-01T09:00', 1);
    expect(typeof once === 'object' && 'error' in once).toBe(true);
  });
});

/* ---------------- darwin：launchd 全链 ---------------- */

describe('OS 注册器 darwin：launchd plist 面', () => {
  it('daily 任务 enable → plist 落盘（ProgramArguments + 定位变量 + 日历字段）+ launchctl load', async () => {
    const setup = makeSetup('darwin');
    const job = makeJob('morning', 'daily@08:30');
    const result = await setup.registrar.register(job);
    expect(result.ok).toBe(true);
    const plist = join(setup.launchAgentsDir, 'tick.morning.plist');
    expect(existsSync(plist)).toBe(true);
    const content = readFileSync(plist, 'utf8');
    // 唤起命令 = K2-c 入口 + 任务面旗标（runner 公式同源）
    expect(content).toContain('<string>run</string>');
    expect(content).toContain('<string>--tick</string>');
    expect(content).toContain('<string>morning</string>');
    expect(content).toContain('<string>--read-only</string>');
    expect(content).toContain('<string>--background</string>');
    // 定位双变量（凭证不落系统注册面——数据目录凭证库正路）
    expect(content).toContain('APP_DATA_DIR');
    expect(content).not.toContain('ANTHROPIC_API_KEY');
    // 日历字段（每日 08:30）
    expect(content).toContain('<key>StartCalendarInterval</key>');
    expect(content).toContain('<key>Hour</key>');
    expect(content).toContain('<integer>8</integer>');
    // launchctl 两步：unload 旧 + load 新
    const calls = readFileSync(setup.launchctl.logFile, 'utf8');
    expect(calls).toContain('load');
    expect(await setup.registrar.isRegistered('morning')).toBe(true);
  });

  it('缺省基座 = 重放三律公式（20260901-d #6）——plist ProgramArguments 逐词恰合、宿主旗标不落 OS 注册面', async () => {
    // 不注 baseArgv——走缺省 tickRelaunchBaseArgv()；vitest 宿主 argv[2:] 常带
    // runner 旗标（真实「带形态旗标的宿主」形态），原公式会全数写进 plist
    const root = makeTempDir('tick-reg-def-');
    const dataDir = join(root, 'data');
    const launchAgentsDir = join(root, 'LaunchAgents');
    mkdirSync(dataDir, { recursive: true });
    const launchctl = makeFakeLaunchctl();
    const registrar = createTickOsRegistrar({
      dataDir,
      dbPath: join(dataDir, 'db.sqlite'),
      platform: 'darwin',
      launchAgentsDir,
      launchctlBin: launchctl.bin,
      crontabBin: makeFakeCrontab().bin,
    });
    const result = await registrar.register(makeJob('default-base', 'daily@08:30'));
    expect(result.ok).toBe(true);
    const content = readFileSync(join(launchAgentsDir, 'tick.default-base.plist'), 'utf8');
    // ProgramArguments 段内 <string> 段序 = argv 序（逐词断言——含 execArgv 段、剔净
    // argv[2:]；截到下一 <key> 止——Label/EnvironmentVariables/日志路径段不混入）
    const start = content.indexOf('<key>ProgramArguments</key>');
    const end = content.indexOf('<key>', start + 1);
    const argsSection = content.slice(start, end);
    const args = [...argsSection.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
    expect(args).toEqual([...tickRelaunchBaseArgv(), 'run', '--tick', 'default-base', '--read-only', '--background']);
    for (const hostFlag of process.argv.slice(2)) {
      expect(args).not.toContain(hostFlag); // 宿主形态旗标永不落 OS 注册面
    }
  });

  it('every 任务 → StartInterval 秒数', async () => {
    const setup = makeSetup('darwin');
    const job = makeJob('poll', 'every@2h');
    const result = await setup.registrar.register(job);
    expect(result.ok).toBe(true);
    const content = readFileSync(join(setup.launchAgentsDir, 'tick.poll.plist'), 'utf8');
    expect(content).toContain('<key>StartInterval</key>');
    expect(content).toContain('<integer>7200</integer>');
  });

  it('schedule 缺席（仅手动）→ 概念错配拒', async () => {
    const setup = makeSetup('darwin');
    const result = await setup.registrar.register(makeJob('manual', null));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('仅手动');
  });

  it('once 已跑（生命周期已终）→ 诚实拒', async () => {
    const setup = makeSetup('darwin');
    const store = openStore({ path: ':memory:', migrations: collectBuiltinMigrations() });
    try {
      const jobs = new JobsStore(store.connection);
      jobs.add('ran', '指令', Date.now() - 3_600_000, 'once@2099-01-01T09:00');
      jobs.reserveRun('ran', Date.now(), 'scheduled');
      const job = jobs.get('ran')!;
      const result = await setup.registrar.register(job);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('生命周期已终');
    } finally {
      store.close();
    }
  });

  it('launchctl load 失败 → 注册失败回执带 stderr', async () => {
    const root = makeTempDir('tick-reg-');
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const launchctl = makeFakeLaunchctl(true);
    const registrar = createTickOsRegistrar({
      dataDir,
      dbPath: join(dataDir, 'db.sqlite'),
      platform: 'darwin',
      launchAgentsDir: join(root, 'LaunchAgents'),
      baseArgv: ['/usr/bin/node', '/opt/dist/main.js'],
      launchctlBin: launchctl.bin,
      crontabBin: makeFakeCrontab().bin,
    });
    const result = await registrar.register(makeJob('x', 'daily@08:30'));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('launchctl load 失败');
    expect(result.message).toContain('could not load');
  });

  it('disable → unload + 删 plist；未注册 disable → 幂等回执', async () => {
    const setup = makeSetup('darwin');
    await setup.registrar.register(makeJob('nightly', 'daily@23:00'));
    const result = await setup.registrar.unregister('nightly');
    expect(result.ok).toBe(true);
    expect(existsSync(join(setup.launchAgentsDir, 'tick.nightly.plist'))).toBe(false);
    expect(await setup.registrar.isRegistered('nightly')).toBe(false);
    const again = await setup.registrar.unregister('nightly');
    expect(again.ok).toBe(true);
    expect(again.message).toContain('未注册');
  });
});

/* ---------------- Linux：crontab 标记行面 ---------------- */

describe('OS 注册器 linux：crontab 标记行面', () => {
  it('daily 任务 enable → `分 时 * * * <命令> # tick:<名>` 标记行装载', async () => {
    const setup = makeSetup('linux');
    const result = await setup.registrar.register(makeJob('morning', 'daily@08:30'));
    expect(result.ok).toBe(true);
    const state = readFileSync(setup.crontab.stateFile, 'utf8');
    expect(state).toContain('30 8 * * *');
    expect(state).toContain('--tick');
    expect(state).toContain('morning');
    expect(state.trimEnd().endsWith('# tick:morning')).toBe(true);
    expect(await setup.registrar.isRegistered('morning')).toBe(true);
  });

  it('覆盖注册去旧行（不重复）+ 保留他行', async () => {
    const setup = makeSetup('linux');
    // 预置他行（用户既有 crontab 不被吃——只动自己的标记行）
    writeFileSync(setup.crontab.stateFile, '0 6 * * * /usr/bin/backup\n');
    await setup.registrar.register(makeJob('a', 'daily@08:30'));
    await setup.registrar.register(makeJob('a', 'daily@09:45'));
    const state = readFileSync(setup.crontab.stateFile, 'utf8');
    expect(state).toContain('/usr/bin/backup'); // 他行保留
    expect(state).toContain('45 9 * * *'); // 新行
    expect(state).not.toContain('30 8 * * *'); // 旧行已替换
    expect(state.match(/# tick:a$/gm)?.length).toBe(1); // 去重
  });

  it('every 任务 → cron 不支持披露', async () => {
    const setup = makeSetup('linux');
    const result = await setup.registrar.register(makeJob('poll', 'every@2h'));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('daily');
  });

  it('disable → 标记行过滤移除（他行保留）', async () => {
    const setup = makeSetup('linux');
    writeFileSync(setup.crontab.stateFile, '0 6 * * * /usr/bin/backup\n');
    await setup.registrar.register(makeJob('a', 'daily@08:30'));
    const result = await setup.registrar.unregister('a');
    expect(result.ok).toBe(true);
    const state = readFileSync(setup.crontab.stateFile, 'utf8');
    expect(state).toContain('/usr/bin/backup');
    expect(state).not.toContain('# tick:a');
    expect(await setup.registrar.isRegistered('a')).toBe(false);
  });
});

/* ---------------- 平台不支持 ---------------- */

describe('OS 注册器平台门控', () => {
  it('win32 → 三面全披露不支持（注册/注销拒、探测恒 false）', async () => {
    const setup = makeSetup('win32');
    const result = await setup.registrar.register(makeJob('x', 'daily@08:30'));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('不支持');
    const off = await setup.registrar.unregister('x');
    expect(off.ok).toBe(false);
    expect(await setup.registrar.isRegistered('x')).toBe(false);
  });
});
