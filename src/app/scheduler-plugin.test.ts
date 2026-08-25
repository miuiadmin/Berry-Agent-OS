/**
 * L5 app — scheduler 官方件全栈测试（tick 第一刀：默认层第五行 + /tick 命令
 * 四子命令 + gate → 抢占 → runner 触发链）。
 *
 * mock 只停在边界两处：模型层（scripted streamFn）+ spawn 边界（注入假
 * tickRunner 记 prompt——RuntimeOptions.tickRunner 注入面），其余全真：
 * 真装配（默认层 scheduler 行 + builtins 注册表 + gate 判据闭包）、真 jobs
 * 表（:memory: 真库经 collectBuiltinMigrations 迁移）、真命令注册面
 *（channels.commands.dispatch）、真会话活对象（recent 判据内存直读）。
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../contracts/llm.js';
import type { UiBackend } from '../channels/types.js';
import { createBerryRuntime } from './assembly.js';
import type { BerryRuntime } from './assembly.js';

/* ---------------- 测试基建（goal-plugin.test 同款） ---------------- */

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

/** 单响应 StreamFn（不涉工具——本测只建会话语境） */
function scriptedStream(message: AssistantMessage) {
  return async () => syntheticStream(message);
}

/** 临时目录（realpath 归一——workspace 注入用） */
const makeTempDir = (prefix: string): string => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));

/** 通知录制后端（/tick 命令回执捕获） */
function recordingBackend() {
  const notifies: string[] = [];
  const backend: UiBackend = {
    id: 'rec',
    notify: (text) => notifies.push(text),
    setStatus: () => {},
    confirm: async () => true,
  };
  return { backend, notifies };
}

/** 假 runner：记录 prompt + 受控结果（spawn 边界注入——不真起子进程） */
function fakeRunner() {
  const prompts: string[] = [];
  const runJob = async (prompt: string) => {
    prompts.push(prompt);
    return { exitCode: 0, stdout: '第 1 行\n第 2 行\n结果一切正常', stderr: '', durationMs: 1200 };
  };
  return { runJob, prompts };
}

/** 本用例运行时登记（afterEach 统一关停防句柄泄漏） */
const runtimes: BerryRuntime[] = [];
afterEach(async () => {
  while (runtimes.length > 0) {
    const runtime = runtimes.pop()!;
    await runtime.shutdown().catch(() => undefined);
  }
});

/** 装配 + 登记（默认装假 runner；:memory: 库经 collectBuiltinMigrations 迁出 jobs 表） */
async function assemble(overrides: Parameters<typeof createBerryRuntime>[0] = {}): Promise<BerryRuntime> {
  const runtime = await createBerryRuntime({
    dbPath: ':memory:',
    workspace: makeTempDir('app-tick-'),
    streamFn: scriptedStream(textMessage('答')),
    ...overrides,
  });
  runtimes.push(runtime);
  return runtime;
}

/** 通知断言便利（等 fire-and-forget 的完成回执落地） */
async function spinUntil(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect.unreachable(`等待超时：${what}`);
}

/* ---------------- 用例 ---------------- */

describe('scheduler 官方件全栈：装载与命令面', () => {
  it('默认层第五行激活 + /tick 命令进面（/help 可见）', async () => {
    const runtime = await assemble();
    expect(runtime.plugins.list().map((r) => [r.id, r.status])).toContainEqual(['scheduler', 'activated']);
    expect(await runtime.channels.commands.dispatch('/tick')).toBe('ok');
  });

  it('add → 同名拒 → list → rm 命令流（回执逐态）', async () => {
    const runtime = await assemble();
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    expect(await runtime.channels.commands.dispatch('/tick add daily 汇总今日改动')).toBe('ok');
    expect(notifies.at(-1)).toContain('任务已新增：daily');
    expect(notifies.at(-1)).toContain('汇总今日改动');

    // 同名拒：主键即身份，改错走 rm + add
    expect(await runtime.channels.commands.dispatch('/tick add daily 另一份指令')).toBe('ok');
    expect(notifies.at(-1)).toContain('任务已存在：daily');

    expect(await runtime.channels.commands.dispatch('/tick list')).toBe('ok');
    expect(notifies.at(-1)).toContain('daily');
    expect(notifies.at(-1)).toContain('汇总今日改动');
    expect(notifies.at(-1)).toContain('未跑过');

    expect(await runtime.channels.commands.dispatch('/tick rm daily')).toBe('ok');
    expect(notifies.at(-1)).toContain('任务已删除：daily');
    expect(await runtime.channels.commands.dispatch('/tick rm daily')).toBe('ok');
    expect(notifies.at(-1)).toContain('任务不存在：daily');
  });

  it('add 词法执法：前导连字符名拒（用法回执）', async () => {
    const runtime = await assemble();
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    expect(await runtime.channels.commands.dispatch('/tick add -bad 指令')).toBe('ok');
    expect(notifies.at(-1)).toContain('用法：/tick add');
  });

  it('空 add（无 prompt）拒——首空白分界后两段皆需在场', async () => {
    const runtime = await assemble();
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    expect(await runtime.channels.commands.dispatch('/tick add onlyname')).toBe('ok');
    expect(notifies.at(-1)).toContain('用法：/tick add');
  });
});

describe('scheduler 官方件全栈：触发链（gate → 抢占 → runner）', () => {
  it('空闲会话手动触发：gate 过 → 抢占 → 假 runner 收 prompt → 完成回执', async () => {
    const runner = fakeRunner();
    const runtime = await assemble({ tickRunner: runner.runJob });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    await runtime.channels.commands.dispatch('/tick add daily 巡检并汇报');
    expect(await runtime.channels.commands.dispatch('/tick run daily')).toBe('ok');
    // 触发回执在场（fake runner 同步即完——回执序不保证触发行居尾，只证在场）
    expect(notifies.some((n) => n.includes('任务 daily 触发'))).toBe(true);

    // fire-and-forget 完成回执（微任务级自旋）
    await spinUntil(() => notifies.some((n) => n.includes('tick daily 完成')), '完成回执');
    expect(runner.prompts).toEqual(['巡检并汇报']);
    const receipt = notifies.find((n) => n.includes('tick daily 完成'))!;
    expect(receipt).toContain('exit 0');
    expect(receipt).toContain('结果一切正常'); // stdout 尾部行进回执
  });

  it('recent_user_msg 拒：用户刚发过消息（30 秒窗）触发让路', async () => {
    const runner = fakeRunner();
    const runtime = await assemble({ tickRunner: runner.runJob });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    await runtime.channels.commands.dispatch('/tick add daily 巡检');
    // 真跑一轮对话——user/message 进会话活对象（time=当下，窗口内）
    expect(await runtime.conversation!.submitOnce('你好')).toMatchObject({ status: 'completed' });

    expect(await runtime.channels.commands.dispatch('/tick run daily')).toBe('ok');
    expect(notifies.at(-1)).toContain('刚发过消息');
    expect(runner.prompts).toEqual([]); // 让路——runner 未被调用（token 未花）
  });

  it('run 不存在任务：missing 回执', async () => {
    const runtime = await assemble();
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    expect(await runtime.channels.commands.dispatch('/tick run ghost')).toBe('ok');
    expect(notifies.at(-1)).toContain('任务不存在：ghost');
  });

  it('抢占推进落库：触发后 last_run_at 从 NULL 前进（jobs 表真库）', async () => {
    const runner = fakeRunner();
    const runtime = await assemble({ tickRunner: runner.runJob });
    await runtime.channels.commands.dispatch('/tick add once 跑一次');
    await runtime.channels.commands.dispatch('/tick run once');
    const row = runtime
      .persistence!.store.connection.prepare(`SELECT last_run_at FROM jobs WHERE name = 'once'`)
      .get() as { last_run_at: number | null };
    expect(row.last_run_at).toBeGreaterThan(0);
  });
});
