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
        `SELECT schedule, last_run_at, last_run_reason, session_id, last_session_id
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
