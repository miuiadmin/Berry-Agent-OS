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
import type { PluginContext } from '../contracts/plugin.js';
import { JobsStore } from '../scheduler/store.js';
import { createSchedulerPlugin } from '../scheduler/plugin.js';
import { openStore } from '../persist/index.js';
import { collectBuiltinMigrations } from './builtins.js';
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

/**
 * 假 OS 注册器（K2-d——注册器边界注入：记录三面调用 + 受控回执；
 * 真注册器的平台/文件/系统命令面在 tick-register.test.ts 独立覆盖，
 * 此处只测件面转发、回执拼接与缺席降级）。
 */
function fakeOsRegistrar() {
  const calls: { op: 'register' | 'unregister' | 'isRegistered'; name: string }[] = [];
  const registered = new Set<string>();
  /** 受控槽：非空时 register 用此人读回执（测失败转发） */
  let nextRegisterResult: { ok: boolean; message: string } | null = null;
  const registrar = {
    async register(job: { name: string }) {
      calls.push({ op: 'register', name: job.name });
      if (nextRegisterResult !== null) {
        const result = nextRegisterResult;
        nextRegisterResult = null;
        return result;
      }
      registered.add(job.name);
      return { ok: true, message: `已注册 OS 定时（launchd）：/LaunchAgents/tick.${job.name}.plist` };
    },
    async unregister(name: string) {
      calls.push({ op: 'unregister', name });
      registered.delete(name);
      return { ok: true, message: `已注销 OS 定时并删除 /LaunchAgents/tick.${name}.plist` };
    },
    async isRegistered(name: string) {
      calls.push({ op: 'isRegistered', name });
      return registered.has(name);
    },
    /** 测试侧控制面（非 TickOsRegistrar 面——注入失败回执） */
    __failNextRegister(result: { ok: boolean; message: string }) {
      nextRegisterResult = result;
    },
  };
  return { registrar, calls };
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

  it('add 带合法 schedule：原样串落库 + 回执含触发行 + list 可见（K2-b）', async () => {
    const runtime = await assemble();
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    expect(await runtime.channels.commands.dispatch('/tick add morning daily@08:30 早间简报')).toBe('ok');
    expect(notifies.at(-1)).toContain('任务已新增：morning');
    expect(notifies.at(-1)).toContain('触发：daily@08:30');
    // 行级断言：jobs 表真库原样串
    const row = runtime
      .persistence!.store.connection.prepare(`SELECT schedule FROM jobs WHERE name = 'morning'`)
      .get() as { schedule: string | null };
    expect(row.schedule).toBe('daily@08:30');

    expect(await runtime.channels.commands.dispatch('/tick list')).toBe('ok');
    expect(notifies.at(-1)).toContain('morning');
    expect(notifies.at(-1)).toContain('daily@08:30');
  });

  it('add 带坏 schedule：当场拒（词法执法——坏串不入库）', async () => {
    const runtime = await assemble();
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    expect(await runtime.channels.commands.dispatch('/tick add bad daily@25:00 指令')).toBe('ok');
    expect(notifies.at(-1)).toContain('schedule 不合法');
    // 无 schedule 前缀的第二词是普通 prompt——不误吃
    expect(await runtime.channels.commands.dispatch('/tick add ok 正常指令')).toBe('ok');
    expect(notifies.at(-1)).toContain('prompt：正常指令');

    // schedule 在场但 prompt 缺席 → 用法回执（schedule 被吃掉后 prompt 为空）
    expect(await runtime.channels.commands.dispatch('/tick add nope daily@08:30')).toBe('ok');
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

describe('scheduler 官方件全栈：OS 定时注册命令链（K2-d enable|disable）', () => {
  it('enable：任务行读出 → 注册器收 job → 成功回执附注册器 message', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({ osTickRegistrar: os.registrar });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    await runtime.channels.commands.dispatch('/tick add morning daily@08:30 早间简报');
    expect(await runtime.channels.commands.dispatch('/tick enable morning')).toBe('ok');
    expect(notifies.at(-1)).toContain('已注册 OS 定时（morning）');
    expect(notifies.at(-1)).toContain('/LaunchAgents/tick.morning.plist'); // 注册器回执人读直用
    // 注册器收到的是真任务行（name + schedule 原样串）
    expect(os.calls).toContainEqual({ op: 'register', name: 'morning' });
  });

  it('enable 注册器失败回执：转发「注册失败」前缀（如 schedule 不支持当前平台）', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({ osTickRegistrar: os.registrar });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    await runtime.channels.commands.dispatch('/tick add poll every@2h 轮询');
    os.registrar.__failNextRegister({ ok: false, message: 'cron 形态暂只支持 daily@HH:MM（当前 every@2h）' });
    expect(await runtime.channels.commands.dispatch('/tick enable poll')).toBe('ok');
    expect(notifies.at(-1)).toContain('注册失败（poll）');
    expect(notifies.at(-1)).toContain('daily@HH:MM');
  });

  it('enable 不存在任务：missing 回执（不到注册器）', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({ osTickRegistrar: os.registrar });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);
    expect(await runtime.channels.commands.dispatch('/tick enable ghost')).toBe('ok');
    expect(notifies.at(-1)).toContain('任务不存在：ghost');
    expect(os.calls).toEqual([]); // 注册器未被触
  });

  it('disable：注销回执；空名用法回执', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({ osTickRegistrar: os.registrar });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    expect(await runtime.channels.commands.dispatch('/tick disable morning')).toBe('ok');
    expect(notifies.at(-1)).toContain('已注销（morning）');
    expect(os.calls).toContainEqual({ op: 'unregister', name: 'morning' });

    expect(await runtime.channels.commands.dispatch('/tick enable')).toBe('ok');
    expect(notifies.at(-1)).toContain('用法：/tick enable <name>');
  });

  it('rm 联动注销：删到时注册器收 unregister（防幽灵行——行没了 OS 还在到点白触发）', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({ osTickRegistrar: os.registrar });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    await runtime.channels.commands.dispatch('/tick add morning daily@08:30 简报');
    expect(await runtime.channels.commands.dispatch('/tick rm morning')).toBe('ok');
    expect(notifies.at(-1)).toContain('任务已删除：morning');
    expect(notifies.at(-1)).toContain('OS 定时：已注销'); // 联动回执附行
    expect(os.calls).toContainEqual({ op: 'unregister', name: 'morning' });
  });

  it('list：OS 注册态逐行探测（已注册/未注册两态）', async () => {
    const os = fakeOsRegistrar();
    const runtime = await assemble({ osTickRegistrar: os.registrar });
    const { backend, notifies } = recordingBackend();
    runtime.ui.attach(backend);

    await runtime.channels.commands.dispatch('/tick add a daily@08:00 任务甲');
    await runtime.channels.commands.dispatch('/tick add b daily@09:00 任务乙');
    await runtime.channels.commands.dispatch('/tick enable a');
    expect(await runtime.channels.commands.dispatch('/tick list')).toBe('ok');
    const listing = notifies.at(-1)!;
    expect(listing).toContain('OS 定时注册 /tick enable');
    expect(listing).toContain('a  daily@08:00  OS 已注册');
    expect(listing).toContain('b  daily@09:00  未注册');
  });
});

describe('scheduler 件级：osRegistrar 缺席防御面（诊断形态）', () => {
  // 组合根恒构造真注册器（与缺省真 runner 先例同构）——缺席面只在件级出现
  //（未来诊断装配形态）；「单元模块测试 → 组合根全栈」分层的单元侧，假 ctx
  // 停在件边界（logger/effect/get 三面），jobs 表仍真库。
  it('enable/disable 报不可用；list 示「－」；rm 无联动行', async () => {
    const store = openStore({ path: ':memory:', migrations: collectBuiltinMigrations() });
    try {
      const jobs = new JobsStore(store.connection);
      jobs.add('a', '任务', Date.now(), 'daily@08:00');
      const notifies: string[] = [];
      const commands: { name: string; handler: (args: string) => void | Promise<void> }[] = [];
      // 最小假 ctx：三面（logger 空转 / effect 即装 / get 按 services 名分派）
      const ctx = {
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        effect: (dispose: () => void) => {
          dispose();
          return () => {};
        },
        get: (key: string) =>
          key === 'channels'
            ? {
                registerCommand: (cmd: { name: string; handler: (args: string) => void | Promise<void> }) => {
                  commands.push(cmd);
                  return () => {};
                },
              }
            : { notify: (text: string) => notifies.push(text) },
      } as unknown as PluginContext;
      const plugin = createSchedulerPlugin({
        connection: store.connection,
        turnDepth: () => 0,
        lastUserMessageAt: () => null,
        backgroundAffordable: () => true,
        // osRegistrar 故意缺席——防御面：其余子命令不受影响
      });
      await plugin.apply(ctx);
      const tick = commands.find((cmd) => cmd.name === 'tick')!;

      await tick.handler('enable a');
      expect(notifies.at(-1)).toContain('OS 注册面未装配');
      await tick.handler('disable a');
      expect(notifies.at(-1)).toContain('OS 注册面未装配');

      await tick.handler('list');
      expect(notifies.at(-1)).toContain('a  daily@08:00  －');

      await tick.handler('rm a');
      expect(notifies.at(-1)).toBe('任务已删除：a'); // 无 OS 联动行
    } finally {
      store.close();
    }
  });
});
