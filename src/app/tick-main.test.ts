/**
 * L5 app — `run --tick <名>` 到点编排全栈测试（席 13 第二刀 K2-c）。
 *
 * mock 只停在模型层（scripted streamFn）与 stdout/stderr 捕获，其余全真：
 * 真文件库（临时目录 + collectBuiltinMigrations 迁移——:memory: 每连接各一
 * 库，跨 withJobsStore/整机装配两连接不共享，必须落文件）、真装配（tick-main
 * 内部 createRuntime + boot resumeSession 注入）、真 jobs 表读写、真
 * 事件账（turn/start 孤儿行造 busy 判据、llm/usage 优先道断言）。
 *
 * 覆盖：退出码全谱（missing 2 / wait·done·missed·让路 0 / 失败 1 / 正常 0）+
 * 投递二值（子进程单发路新会话 + 会话投递路 resume 目标开轮）+ 归属回写
 * last_session_id + 后台道记账（K2-a 链尾回归锁）+ 不造空会话回归锁。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '../contracts/llm.js';
import { openStore } from '../persist/index.js';
import { JobsStore } from '../scheduler/store.js';
import { GoalStore } from '../goal/index.js';
import { createRuntime } from './assembly.js';
import type { AppRuntime } from './assembly.js';
import { collectBuiltinMigrations } from './builtins.js';
import { daemonDirOf, daemonStatePath, defaultProcessProbe } from './daemon-state.js';
import { tickMain } from './tick-main.js';

/* ---------------- 测试基建（scheduler-plugin.test 同款） ---------------- */

/** 文本终值（零工具调用的合成 assistant 消息） */
const textMessage = (text: string): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
  stopReason: 'stop',
  timestamp: 1,
});

/** 合成流（start → done） */
function syntheticStream(message: AssistantMessage) {
  const events = [
    { type: 'start' as const, partial: { ...message, content: [] } },
    { type: 'done' as const, reason: 'stop' as const, message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: () =>
          index < events.length
            ? Promise.resolve({ value: events[index++]!, done: false as const })
            : Promise.resolve({ value: undefined, done: true as const }),
      };
    },
    result: async () => message,
  };
}

/** 单响应 StreamFn（不涉工具——本测只验证编排链不验证 loop 细节） */
function scriptedStream(message: AssistantMessage) {
  return async () => syntheticStream(message);
}

/** 临时目录（realpath 归一——workspace 注入用） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/**
 * 每用例独立文件库 + 种子帮手。
 * 文件库（非 :memory:）：tick-main 内部有两条连接（withJobsStore 短连接 +
 * 整机装配），:memory: 各连接各一库不共享——文件库才测得了「预读→整机」同库。
 */
function makeDbFile(): string {
  return join(makeTempDir('app-tickmain-'), 'tick.db');
}

/** 短连接种子（与 tick-main withJobsStore 同链同库——直接复用其构造参数） */
function seed(dbFile: string, fn: (jobs: JobsStore) => void): void {
  const store = openStore({ path: dbFile, migrations: collectBuiltinMigrations() });
  try {
    fn(new JobsStore(store.connection));
  } finally {
    store.close();
  }
}

/** 行查询帮手（断言面：v9 三列 + last_run_at 原样读） */
function jobRow(dbFile: string, name: string): Record<string, unknown> {
  const store = openStore({ path: dbFile, migrations: collectBuiltinMigrations() });
  try {
    return store.connection
      .prepare(
        `SELECT schedule, last_run_at, last_run_reason, session_id, last_session_id, enabled
         FROM jobs WHERE name = ?`,
      )
      .get(name) as Record<string, unknown>;
  } finally {
    store.close();
  }
}

/** 标量查询帮手（sessions 数 / 事件计数等断言面） */
function scalar(dbFile: string, sql: string, ...params: unknown[]): number {
  const store = openStore({ path: dbFile, migrations: collectBuiltinMigrations() });
  try {
    const row = store.connection.prepare(sql).get(...params) as { value: number };
    return row.value;
  } finally {
    store.close();
  }
}

/** stdout/stderr 捕获（退出码文案断言面） */
function captureStderr(): { texts: string[]; restore: () => void } {
  const texts: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    texts.push(String(chunk));
    return true;
  });
  return { texts, restore: () => spy.mockRestore() };
}

function captureStdout(): { texts: string[]; restore: () => void } {
  const texts: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    texts.push(String(chunk));
    return true;
  });
  return { texts, restore: () => spy.mockRestore() };
}

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏——种子用的整机装配） */
const runtimes: AppRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
  vi.restoreAllMocks();
});

/** 本测固定答复（scripted 流——所有跑通用例同一答复） */
const REPLY = textMessage('tick 答复');

/* ---------------- 用例 ---------------- */

describe('run --tick 编排：due 判定与退出码', () => {
  it('任务不存在 → 2（快败——不整机装配）', async () => {
    const dbFile = makeDbFile();
    const err = captureStderr();
    try {
      expect(await tickMain('ghost', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(2);
      expect(err.texts.join('')).toContain('任务不存在：ghost');
    } finally {
      err.restore();
    }
  });

  it('未到点（wait）→ 0 且零动作（不抢占不跑）', async () => {
    const dbFile = makeDbFile();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    seed(dbFile, (jobs) => jobs.add('later', '指令', Date.now(), `once@${future}`));
    expect(await tickMain('later', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
    const row = jobRow(dbFile, 'later');
    expect(row['last_run_at']).toBeNull();
    expect(row['last_run_reason']).toBeNull();
    // 零动作含零会话：boot 都没发生（due 在装配前判）
    expect(scalar(dbFile, 'SELECT COUNT(*) AS value FROM sessions')).toBe(0);
  });

  it('once 已跑（done）→ 0 不再触发', async () => {
    const dbFile = makeDbFile();
    const past = new Date(Date.now() - 1_800_000).toISOString();
    seed(dbFile, (jobs) => {
      jobs.add('ran', '指令', Date.now() - 3_600_000, `once@${past}`);
      // 已跑态：last_run_at 有值（simulate 上次触发）
      jobs.reserveRun('ran', Date.now() - 1_700_000, 'scheduled');
    });
    expect(await tickMain('ran', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
    const row = jobRow(dbFile, 'ran');
    expect(row['last_run_at']).not.toBeNull();
    expect(scalar(dbFile, 'SELECT COUNT(*) AS value FROM sessions')).toBe(0);
  });

  it('once 迟到超窗（missed）→ 0 + 记因不跑（last_run_at 不动）', async () => {
    const dbFile = makeDbFile();
    const past = new Date(Date.now() - 20 * 60_000).toISOString(); // 超过 grace 窗
    seed(dbFile, (jobs) => jobs.add('late', '指令', Date.now() - 30 * 60_000, `once@${past}`));
    const err = captureStderr();
    try {
      expect(await tickMain('late', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(err.texts.join('')).toContain('迟到超窗');
    } finally {
      err.restore();
    }
    const row = jobRow(dbFile, 'late');
    expect(row['last_run_reason']).toBe('missed');
    expect(row['last_run_at']).toBeNull(); // 记因不推进触发时刻
    expect(scalar(dbFile, 'SELECT COUNT(*) AS value FROM sessions')).toBe(0);
  });

  it('once 迟到窗内（grace）→ 照跑（迟到一次性任务补拍）', async () => {
    const dbFile = makeDbFile();
    const recent = new Date(Date.now() - 5 * 60_000).toISOString(); // grace 窗内
    seed(dbFile, (jobs) => jobs.add('soon-late', '指令', Date.now() - 6 * 60_000, `once@${recent}`));
    const out = captureStdout();
    try {
      expect(await tickMain('soon-late', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(out.texts.join('')).toContain('tick 答复');
    } finally {
      out.restore();
    }
    const row = jobRow(dbFile, 'soon-late');
    expect(row['last_run_reason']).toBe('scheduled');
    expect(row['last_run_at']).not.toBeNull();
  });

  it('手编库坏串 → 2 诚实拒（add 面已执法，行内坏串只可能来自手编）', async () => {
    const dbFile = makeDbFile();
    seed(dbFile, (jobs) => jobs.add('bad', '指令', Date.now(), 'weekly@mon'));
    const err = captureStderr();
    try {
      expect(await tickMain('bad', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(2);
      expect(err.texts.join('')).toContain('坏串');
    } finally {
      err.restore();
    }
  });

  it('统一闸 busy（孤儿 turn/start = 有轮在跑）→ 让路 0 不抢占', async () => {
    const dbFile = makeDbFile();
    seed(dbFile, (jobs) => jobs.add('busy', '指令', Date.now() - 2 * 60_000, 'every@1m'));
    // 造 busy 判据：events 表孤儿 turn/start（openTurnDepth 全库配对投影 +1）
    const store = openStore({ path: dbFile, migrations: collectBuiltinMigrations() });
    try {
      store.connection
        .prepare(`INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)`)
        .run('busy-synthetic', 1, 'turn/start', Date.now(), '{}');
    } finally {
      store.close();
    }
    const err = captureStderr();
    try {
      expect(await tickMain('busy', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(err.texts.join('')).toContain('让路');
      expect(err.texts.join('')).toContain('agent_busy');
    } finally {
      err.restore();
    }
    // 让路不抢占：last_run_at 原样 null
    expect(jobRow(dbFile, 'busy')['last_run_at']).toBeNull();
  });
});

describe('run --tick 编排：子进程单发路（session_id 空）', () => {
  it('every 到点 → 跑通全链：stdout 答复 + reserve(scheduled) + 新会话 + 归属回写', async () => {
    const dbFile = makeDbFile();
    // 建行于 2 分钟前 + every@1m → 基点+间隔已过 = fire
    seed(dbFile, (jobs) => jobs.add('news', '早间简报', Date.now() - 2 * 60_000, 'every@1m'));
    const out = captureStdout();
    try {
      expect(await tickMain('news', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(out.texts.join('')).toContain('tick 答复');
    } finally {
      out.restore();
    }
    const row = jobRow(dbFile, 'news');
    expect(row['last_run_reason']).toBe('scheduled');
    expect(row['last_run_at']).not.toBeNull();
    // 单发路：无归属声明 + 事实回写指向新会话
    expect(row['session_id']).toBeNull();
    expect(row['last_session_id']).toBeTruthy();
    // 新会话真实在场（boot 新建 + 一轮对话落账）
    expect(scalar(dbFile, 'SELECT COUNT(*) AS value FROM sessions')).toBe(1);
  });

  it('跑通后 llm/usage 落 background 道（K2-a 链尾回归锁——argv 缺省也进后台账）', async () => {
    const dbFile = makeDbFile();
    seed(dbFile, (jobs) => jobs.add('bg', '指令', Date.now() - 2 * 60_000, 'every@1m'));
    const out = captureStdout();
    try {
      expect(await tickMain('bg', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
    } finally {
      out.restore();
    }
    // 缺省即 background（tick-main 兜底——canAfford 读的账）：事件账查证
    const store = openStore({ path: dbFile, migrations: collectBuiltinMigrations() });
    try {
      const row = store.connection
        .prepare(
          `SELECT COUNT(*) AS value FROM events WHERE type = 'llm/usage' AND data LIKE '%"priority":"background"%'`,
        )
        .get() as { value: number };
      expect(row.value).toBeGreaterThanOrEqual(1);
    } finally {
      store.close();
    }
  });
});

describe('run --tick 编排：会话投递路（session_id 非空）', () => {
  it('到点 → resume 目标会话开轮 + 不造空会话 + 归属双列一致', async () => {
    const dbFile = makeDbFile();
    // 先整机装配造一个真会话（boot 新建）作为投递目标
    const runtime = await createRuntime({
      dbPath: dbFile,
      workspace: makeTempDir('app-tickmain-ws-'),
      streamFn: scriptedStream(REPLY),
    });
    runtimes.push(runtime);
    const target = runtime.drivers.focused()!.session.header.sessionId;
    await runtime.shutdown();
    runtimes.pop();
    // 种子：due 任务 + 会话归属声明
    seed(dbFile, (jobs) => {
      jobs.add('attach', '晚班总结', Date.now() - 2 * 60_000, 'every@1m');
      jobs.setSessionTarget('attach', target, Date.now());
    });
    const before = scalar(dbFile, 'SELECT COUNT(*) AS value FROM sessions');
    expect(before).toBe(1); // 只有目标会话——投递后不得再多（不造空会话）

    const out = captureStdout();
    try {
      expect(await tickMain('attach', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(out.texts.join('')).toContain('tick 答复');
    } finally {
      out.restore();
    }
    // 不造空会话回归锁：boot resumeSession 直达目标，无弃置空会话
    expect(scalar(dbFile, 'SELECT COUNT(*) AS value FROM sessions')).toBe(1);
    // 目标会话真收到投递（user/message 落账）
    expect(
      scalar(dbFile, `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'user/message'`, target),
    ).toBeGreaterThanOrEqual(1);
    // 归属双列：声明列原样 + 事实列同值
    const row = jobRow(dbFile, 'attach');
    expect(row['session_id']).toBe(target);
    expect(row['last_session_id']).toBe(target);
  });

  it('目标会话不存在 → 1 诚实错（boot 回落新建在 tick 语境 = 归属失真，拒投）', async () => {
    const dbFile = makeDbFile();
    seed(dbFile, (jobs) => {
      jobs.add('dead', '指令', Date.now() - 2 * 60_000, 'every@1m');
      jobs.setSessionTarget('dead', 'sid-nonexistent', Date.now());
    });
    const err = captureStderr();
    try {
      expect(await tickMain('dead', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(1);
      expect(err.texts.join('')).toContain('目标会话不存在');
    } finally {
      err.restore();
    }
    // 拒投不烧抢占（校验在 reserve 前）
    expect(jobRow(dbFile, 'dead')['last_run_at']).toBeNull();
  });

  // 【回归锁·2026-09-01 全面复盘 C-2】busy 让路零写入不变式：宿主在跑（目标
  // 会话 durable 敞开 turn）时到点——修前整机装配先于闸：boot 的 registry.open
  // 恢复合成 turn/end 假终态已写进宿主在跑的会话（闸读数被自身恢复清零 →
  // 下一跳盲闸放行双跑；宿主下批落库撞 cursor 护栏）。
  it('busy 让路零写入：目标会话敞开 turn → 让路 0 且目标会话 durable 事件数不变', async () => {
    const dbFile = makeDbFile();
    // 真会话作投递目标（boot 造 + 优雅关停落盘）
    const runtime = await createRuntime({
      dbPath: dbFile,
      workspace: makeTempDir('app-tickmain-ws-'),
      streamFn: scriptedStream(REPLY),
    });
    runtimes.push(runtime);
    const target = runtime.drivers.focused()!.session.header.sessionId;
    await runtime.shutdown();
    runtimes.pop();
    // 造宿主在跑判据：目标会话 durable 敞开 turn/start（续尾插一行——模拟
    // 宿主 TUI 在轮中、turn/start 已过 flush 屏障）
    const store = openStore({ path: dbFile, migrations: collectBuiltinMigrations() });
    try {
      const tail = store.connection
        .prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM events WHERE session_id = ?')
        .get(target) as { m: number };
      store.connection
        .prepare(`INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, 'turn/start', ?, '{}')`)
        .run(target, tail.m + 1, Date.now());
    } finally {
      store.close();
    }
    const eventsBefore = scalar(dbFile, 'SELECT COUNT(*) AS value FROM events WHERE session_id = ?', target);
    seed(dbFile, (jobs) => {
      jobs.add('busy-target', '晚班总结', Date.now() - 2 * 60_000, 'every@1m');
      jobs.setSessionTarget('busy-target', target, Date.now());
    });
    const err = captureStderr();
    try {
      expect(await tickMain('busy-target', { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(err.texts.join('')).toContain('让路');
    } finally {
      err.restore();
    }
    // 零写入不变式：让路路径对目标会话 durable 日志零新增（修前恢复合成 +1
    // 条 turn/end 假终态、且闸读数归零放行整轮双跑）
    expect(scalar(dbFile, 'SELECT COUNT(*) AS value FROM events WHERE session_id = ?', target)).toBe(eventsBefore);
    // 让路不抢占：last_run_at 原样 null
    expect(jobRow(dbFile, 'busy-target')['last_run_at']).toBeNull();
  });

  it('P3 触达面①：目标会话被活 daemon 持有 → 1 + attach/submit 改道指引（拒投不烧抢占）', async () => {
    const dbFile = makeDbFile();
    const workspace = makeTempDir('app-tickmain-ws-');
    // 先整机装配造真会话 S（同 cwd 最新 = boot 续接候选）
    const runtime = await createRuntime({ dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) });
    runtimes.push(runtime);
    const target = runtime.drivers.focused()!.session.header.sessionId;
    await runtime.shutdown();
    runtimes.pop();
    // 真活持有者子进程 + 其真实 processStartId（判活判据源——不猜 pid）
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    // daemon.json 落默认数据根（readDaemonState/isDaemonAlive 与 assembly
    // heldElsewhere 同走 dataDir()——APP_DATA_DIR 钉临时目录，测后还原）
    const prevDataDir = process.env['APP_DATA_DIR'];
    const dataRoot = makeTempDir('app-tickmain-data-');
    mkdirSync(daemonDirOf(dataRoot), { recursive: true });
    writeFileSync(
      daemonStatePath(dataRoot),
      JSON.stringify({
        pid: holder.pid,
        processStartId: defaultProcessProbe.startId(holder.pid!),
        bootId: 'tick-held-boot',
        port: 7860,
        heldSessions: [target],
      }),
    );
    process.env['APP_DATA_DIR'] = dataRoot;
    seed(dbFile, (jobs) => {
      jobs.add('held', '指令', Date.now() - 2 * 60_000, 'every@1m');
      jobs.setSessionTarget('held', target, Date.now());
    });
    const err = captureStderr();
    try {
      // boot resume 撞 heldElsewhere 拒开（无聚焦条目）→ 先判 held 报改道指引
      expect(await tickMain('held', { dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) })).toBe(1);
      expect(err.texts.join('')).toContain('berry attach');
      expect(err.texts.join('')).toContain('submit');
    } finally {
      err.restore();
      // 收尾三步：还原 env → 杀持有者 → 等尸收（防 pid 复用窗影响后续用例）
      if (prevDataDir === undefined) delete process.env['APP_DATA_DIR'];
      else process.env['APP_DATA_DIR'] = prevDataDir;
      holder.kill('SIGKILL');
      await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
      rmSync(dataRoot, { recursive: true, force: true });
    }
    // 拒投不烧抢占（held 校验在 reserve 前——OS 钟下一跳重撞同墙是预期态）
    expect(jobRow(dbFile, 'held')['last_run_at']).toBeNull();
  });
});

/* ---------------- 用例：goal 挂钟分支（刀四 K2-c ⑤b 投递前执法） ---------------- */

/** goal 行种子帮手（与 jobs 种子同库同迁移链——GoalStore 直操作） */
function seedGoal(dbFile: string, fn: (goal: GoalStore) => void): void {
  const store = openStore({ path: dbFile, migrations: collectBuiltinMigrations() });
  try {
    fn(new GoalStore(store.connection));
  } finally {
    store.close();
  }
}

/**
 * goal 挂钟三件套种子（目标行 + 挂钟行）——go钟行走真生产路径 putOwned。
 * @returns goalId（挂钟行名 = goal-<goalId>）
 */
function seedGoalClock(
  dbFile: string,
  sessionId: string,
  over: Partial<{ enabled: boolean; needsWrite: boolean; objective: string }> = {},
): string {
  let goalId = '';
  seedGoal(dbFile, (goal) => {
    const row = goal.setActive(
      sessionId,
      over.objective ?? '挂钟到点续跑的长目标',
      50_000,
      over.needsWrite ?? false,
      1,
    );
    goalId = row.goalId;
  });
  seed(dbFile, (jobs) => {
    jobs.putOwned({
      name: `goal-${goalId}`,
      prompt: over.objective ?? '挂钟到点续跑的长目标',
      schedule: 'every@1m',
      sessionId,
      owner: 'builtin:goal',
      ownerKey: goalId,
      now: Date.now() - 2 * 60_000,
    });
    if (over.enabled === false) jobs.setOwnedEnabled('builtin:goal', goalId, false, Date.now());
  });
  return goalId;
}

describe('run --tick goal 挂钟分支：pre-boot 让路 + 投递前执法 + 到点投递', () => {
  it('挂钟停摆（enabled=0）→ pre-boot 廉价让路 0：不判 due 不整机装配', async () => {
    const dbFile = makeDbFile();
    const goalId = seedGoalClock(dbFile, 's-never-boots', { enabled: false });
    const err = captureStderr();
    try {
      expect(await tickMain(`goal-${goalId}`, { dbPath: dbFile, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(err.texts.join('')).toContain('停摆');
    } finally {
      err.restore();
    }
    // 零动作自证：无 boot（sessions 零行）+ 无抢占（last_run_at 零值）
    expect(scalar(dbFile, 'SELECT COUNT(*) AS value FROM sessions')).toBe(0);
    expect(jobRow(dbFile, `goal-${goalId}`)['last_run_at']).toBeNull();
  });

  it('goal 行缺席（inactive 兜底）→ 让路 0 + goal/evidence reason=inactive 落目标会话', async () => {
    const dbFile = makeDbFile();
    const workspace = makeTempDir('app-tickmain-ws-');
    // 造真目标会话（boot 新建后关停——tick resume 的落点）
    const runtime = await createRuntime({ dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) });
    runtimes.push(runtime);
    const target = runtime.drivers.focused()!.session.header.sessionId;
    await runtime.shutdown();
    runtimes.pop();
    // 只种挂钟行、不种 goal 行（行缺席 = inactive 兜底路的命中形态）
    let goalId = '';
    seed(dbFile, (jobs) => {
      goalId = '01JDGOALGHOSTGOALGHOSTGOALG0';
      jobs.putOwned({
        name: `goal-${goalId}`,
        prompt: '目标',
        schedule: 'every@1m',
        sessionId: target,
        owner: 'builtin:goal',
        ownerKey: goalId,
        now: Date.now() - 2 * 60_000,
      });
    });
    const err = captureStderr();
    try {
      expect(await tickMain(`goal-${goalId}`, { dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(err.texts.join('')).toContain('非 active');
    } finally {
      err.restore();
    }
    // 记因落目标会话 + 让路不烧抢占
    expect(
      scalar(
        dbFile,
        `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'goal/evidence' AND data LIKE '%"reason":"inactive"%'`,
        target,
      ),
    ).toBe(1);
    expect(jobRow(dbFile, `goal-${goalId}`)['last_run_at']).toBeNull();
  });

  it('【回归锁 #53】行缺席兜底防无界残响：首跳记因 + 同笔自愈停摆（enabled=0），次跳 pre-boot 廉价让路零新事件', async () => {
    const dbFile = makeDbFile();
    const workspace = makeTempDir('app-tickmain-ws-');
    // 造真目标会话（boot 新建后关停——tick resume 的落点）
    const runtime = await createRuntime({ dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) });
    runtimes.push(runtime);
    const target = runtime.drivers.focused()!.session.header.sessionId;
    await runtime.shutdown();
    runtimes.pop();
    // 只种挂钟行、不种 goal 行（行缺席 = 幽灵钟——修复前每跳整机装配 + 一条
    // inactive durable 事件，every@1m 即日增 1440 条账本无界增长）
    const goalId = '01JDGHOSTLOOPGHOSTLOOPGHOST0';
    seed(dbFile, (jobs) => {
      jobs.putOwned({
        name: `goal-${goalId}`,
        prompt: '目标',
        schedule: 'every@1m',
        sessionId: target,
        owner: 'builtin:goal',
        ownerKey: goalId,
        now: Date.now() - 2 * 60_000,
      });
    });
    // 首跳：记因一条 + 同笔自愈停摆（钟行 enabled 翻 0）
    const err1 = captureStderr();
    try {
      expect(await tickMain(`goal-${goalId}`, { dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) })).toBe(0);
    } finally {
      err1.restore();
    }
    expect(jobRow(dbFile, `goal-${goalId}`)['enabled']).toBe(0);
    // 次跳（OS 钟照跳）：pre-boot 廉价让路——零整机装配、零新 inactive 事件
    const err2 = captureStderr();
    try {
      expect(await tickMain(`goal-${goalId}`, { dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(err2.texts.join('')).toContain('停摆');
    } finally {
      err2.restore();
    }
    expect(
      scalar(
        dbFile,
        `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'goal/evidence' AND data LIKE '%"reason":"inactive"%'`,
        target,
      ),
    ).toBe(1);
  });

  it('唤醒帽拒（连续 3 self）→ 让路 0 + reason=capped（willRetry）+ 零投递', async () => {
    const dbFile = makeDbFile();
    const workspace = makeTempDir('app-tickmain-ws-');
    const runtime = await createRuntime({ dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) });
    runtimes.push(runtime);
    const target = runtime.drivers.focused()!.session.header.sessionId;
    // 3 条 self 归因投递落目标会话日志（goal 行此时尚未种——③ 续跑对无行
    // 归因诚实让位，不链发；事件面只留下帽投影要数的 user/message）
    const goalId = '01JDCAPPEDGHOSTGHOSTGHOSTG0';
    for (let i = 0; i < 3; i++) {
      await runtime.conversation!.submitOnce(`自激 ${i}`, {
        source: 'app:goal',
        attribution: { goalId, wakePath: 'self' },
        backgroundWake: true,
      });
      await runtime.conversation!.settle();
    }
    await runtime.shutdown();
    runtimes.pop();
    // goal 行 raw SQL 直插固定 id（与上方归因同 id——setActive 自造随机 id 对不上；
    // 列形对齐 GoalStore.setActive 的 INSERT，status=active）
    {
      const store = openStore({ path: dbFile, migrations: collectBuiltinMigrations() });
      try {
        store.connection
          .prepare(
            `INSERT INTO goals (goal_id, session_id, objective, token_budget, tokens_used, status, stop_reason,
                                evidence, needs_write, wake_schedule, activated_seq, summary, summary_seq,
                                created_at, updated_at, settled_at)
             VALUES (?, ?, '挂钟到点续跑的长目标', 50000, 0, 'active', NULL, NULL, 0, NULL, NULL, NULL, NULL, 1, 1, NULL)`,
          )
          .run(goalId, target);
      } finally {
        store.close();
      }
    }
    seed(dbFile, (jobs) => {
      jobs.putOwned({
        name: `goal-${goalId}`,
        prompt: '挂钟到点续跑的长目标',
        schedule: 'every@1m',
        sessionId: target,
        owner: 'builtin:goal',
        ownerKey: goalId,
        now: Date.now() - 2 * 60_000,
      });
    });
    const err = captureStderr();
    try {
      expect(await tickMain(`goal-${goalId}`, { dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(err.texts.join('')).toContain('唤醒帽');
    } finally {
      err.restore();
    }
    expect(
      scalar(
        dbFile,
        `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'goal/evidence' AND data LIKE '%"reason":"capped"%'`,
        target,
      ),
    ).toBe(1);
    // 零投递：目标会话无 tick 归因的 user/message + 不烧抢占
    expect(
      scalar(
        dbFile,
        `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'user/message' AND data LIKE '%"wakePath":"tick"%'`,
        target,
      ),
    ).toBe(0);
    expect(jobRow(dbFile, `goal-${goalId}`)['last_run_at']).toBeNull();
  });

  it('active 到点 → 动态渲染投递：objective 在场 + tick 归因落账 + 抢占回写', async () => {
    const dbFile = makeDbFile();
    const workspace = makeTempDir('app-tickmain-ws-');
    const runtime = await createRuntime({ dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) });
    runtimes.push(runtime);
    const target = runtime.drivers.focused()!.session.header.sessionId;
    await runtime.shutdown();
    runtimes.pop();
    const goalId = seedGoalClock(dbFile, target, { objective: '把挂钟到点续跑链路验完' });
    const out = captureStdout();
    try {
      expect(await tickMain(`goal-${goalId}`, { dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) })).toBe(0);
      expect(out.texts.join('')).toContain('tick 答复');
    } finally {
      out.restore();
    }
    // tick 归因的投递落目标会话（wakePath=tick——durable 帽投影与结算归因扫的面）
    expect(
      scalar(
        dbFile,
        `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'user/message' AND data LIKE '%"wakePath":"tick"%'`,
        target,
      ),
    ).toBeGreaterThanOrEqual(1);
    // 动态渲染（非行内静态 prompt 快照）：objective 原文 + 续跑纪律在场
    expect(
      scalar(
        dbFile,
        `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'user/message' AND data LIKE '%把挂钟到点续跑链路验完%'`,
        target,
      ),
    ).toBeGreaterThanOrEqual(1);
    // 抢占已烧 + 归属回写
    const row = jobRow(dbFile, `goal-${goalId}`);
    expect(row['last_run_at']).not.toBeNull();
    expect(row['last_session_id']).toBe(target);
  });

  it('【回归锁 20260902-c #5】tick 形态结算不自激：到点投递结算后零 self 续跑投递（接力 = 下一跳 OS 钟）', async () => {
    const dbFile = makeDbFile();
    const workspace = makeTempDir('app-tickmain-ws-');
    const runtime = await createRuntime({ dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) });
    runtimes.push(runtime);
    const target = runtime.drivers.focused()!.session.header.sessionId;
    await runtime.shutdown();
    runtimes.pop();
    const goalId = seedGoalClock(dbFile, target, { objective: '挂钟结算不自激验证' });
    const out = captureStdout();
    try {
      expect(await tickMain(`goal-${goalId}`, { dbPath: dbFile, workspace, streamFn: scriptedStream(REPLY) })).toBe(0);
    } finally {
      out.restore();
    }
    // tick 路投递照常（挂钟本体——每跳一轮的语义不变）
    expect(
      scalar(
        dbFile,
        `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'user/message' AND data LIKE '%"wakePath":"tick"%'`,
        target,
      ),
    ).toBeGreaterThanOrEqual(1);
    // 结算回调零自激（修前红：续跑投递 durable 落账 1 条 wakePath=self——该
    // 投递开的新 run 在 tick 收口序里被 shutdown retire 掐死在出生点）
    expect(
      scalar(
        dbFile,
        `SELECT COUNT(*) AS value FROM events WHERE session_id = ? AND type = 'user/message' AND data LIKE '%"wakePath":"self"%'`,
        target,
      ),
    ).toBe(0);
    // 行保持 active（豁免非终态停——挂钟语义跨 tick 存活，下一跳照常投递）
    expect(scalar(dbFile, `SELECT COUNT(*) AS value FROM goals WHERE goal_id = ? AND status = 'active'`, goalId)).toBe(
      1,
    );
  });
});
