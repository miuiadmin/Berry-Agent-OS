/**
 * subagent 模块单元测试 — Job 注册表（骨架篇 §6.2 落码注记，纵切一）。
 *
 * 全真件：真 createContext + 真注册表，零 mock（纯逻辑层，无模型面）。
 * 锁行为面：kind 词汇纪律 / run 糖结算映射 / cancel=请求非结算 /
 * first-wins / done 永不 reject / owner 围栏 / drain 排空 / job_settled 载荷 /
 * 作用域回卷兜底。
 */
import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import type { ContextScope } from '../context/types.js';
import {
  CONTEXT_DISPOSED,
  JOB_CONCURRENCY_LIMIT,
  JOB_KIND_DUPLICATE,
  JOB_KIND_UNKNOWN,
  JOB_NOT_FOUND,
  JOB_OWNER_MISMATCH,
} from '../contracts/errors.js';
import type { JobsServiceFace } from '../contracts/jobs.js';
import { createJobsService } from './jobs.js';

/** 建根作用域 + 注册表（silent logger——测试不产日志噪声） */
function setup(): { ctx: ContextScope; jobs: JobsServiceFace } {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const jobs = createJobsService(ctx);
  return { ctx, jobs };
}

/** 断言某调用抛出指定码的 AppError（同步 throw 与异步 reject 两形态通吃） */
async function expectCode(code: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    expect.unreachable(`预期抛出 ${code}，实际正常返回`);
  } catch (err) {
    expect(err).toMatchObject({ code });
  }
}

describe('Job 注册表 — kind 词汇纪律', () => {
  it('内置 kind（subagent/process）开箱即用', () => {
    const { jobs } = setup();
    expect(jobs.create({ kind: 'subagent' }).handle.kind).toBe('subagent');
    expect(jobs.create({ kind: 'process' }).handle.kind).toBe('process');
  });

  it('未注册 kind 创建即 JOB_KIND_UNKNOWN（create 与 run 两入口同拒）', async () => {
    const { jobs } = setup();
    await expectCode(JOB_KIND_UNKNOWN, () => jobs.create({ kind: 'custom' }));
    await expectCode(JOB_KIND_UNKNOWN, () => jobs.run({ kind: 'custom' }, async () => undefined));
  });

  it('registerKind 显式注册后可用；注销 Disposer 调后回到拒绝', async () => {
    const { jobs } = setup();
    const unregister = jobs.registerKind('worker');
    expect(jobs.create({ kind: 'worker' }).handle.kind).toBe('worker');
    unregister();
    await expectCode(JOB_KIND_UNKNOWN, () => jobs.create({ kind: 'worker' }));
  });

  it('registerKind 撞名（内置/已注册）即 JOB_KIND_DUPLICATE', async () => {
    const { jobs } = setup();
    await expectCode(JOB_KIND_DUPLICATE, () => jobs.registerKind('subagent'));
    jobs.registerKind('worker');
    await expectCode(JOB_KIND_DUPLICATE, () => jobs.registerKind('worker'));
  });
});

describe('Job 注册表 — run 糖结算映射', () => {
  it('resolve 字符串 → completed 携 output；resolve void → completed 无 output', async () => {
    const { jobs } = setup();
    const a = jobs.run({ kind: 'process' }, async () => '产出摘要');
    await expect(a.done).resolves.toBe('completed');
    expect(a.settled).toMatchObject({ terminal: 'completed', output: '产出摘要' });

    const b = jobs.run({ kind: 'process' }, async () => undefined);
    await expect(b.done).resolves.toBe('completed');
    expect(b.settled?.output).toBeUndefined();
  });

  it('reject → failed（describeError 口径：非 AppError 也不裸抛）——done 永不 reject', async () => {
    const { jobs } = setup();
    const h = jobs.run({ kind: 'process' }, async () => {
      throw new Error('进程崩了');
    });
    await expect(h.done).resolves.toBe('failed');
    expect(h.settled?.error).toContain('进程崩了');
  });

  it('cancel 先于 fn 收工 → killed 胜出（取消意图赢赛跑，即使 fn 正常 resolve）', async () => {
    const { jobs } = setup();
    const h = jobs.run({ kind: 'process' }, async (signal) => {
      // 模拟 executor：收到取消请求才收工（signal 观察 → 提前返回正常值）
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return '取消前后的残值';
    });
    h.cancel();
    await expect(h.done).resolves.toBe('killed');
    expect(h.settled).toMatchObject({ terminal: 'killed' });
  });

  it('reject 时 signal 已 abort → 同样落 killed', async () => {
    const { jobs } = setup();
    const h = jobs.run({ kind: 'process' }, async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('收工时才炸');
    });
    h.cancel();
    await expect(h.done).resolves.toBe('killed');
  });
});

describe('Job 注册表 — 状态机与 first-wins', () => {
  it('cancel 是请求非结算：running→stopping，终态仍由 executor 落', async () => {
    const { jobs } = setup();
    const c = jobs.create({ kind: 'subagent' });
    expect(c.handle.status).toBe('running');
    c.handle.cancel();
    expect(c.handle.status).toBe('stopping');
    expect(c.handle.settled).toBeUndefined(); // 尚未结算
    expect(c.signal.aborted).toBe(true); // 取消信号已发
    c.settle('killed');
    await expect(c.handle.done).resolves.toBe('killed');
    expect(c.handle.status).toBe('killed');
  });

  it('first-wins：首次 settle 胜出，后续 settle 无效（状态不变）', () => {
    const { jobs } = setup();
    const c = jobs.create({ kind: 'subagent' });
    c.settle('completed', { output: '第一落定' });
    c.settle('failed', { error: '迟到的失败' });
    expect(c.handle.settled).toMatchObject({ terminal: 'completed', output: '第一落定' });
    expect(c.handle.status).toBe('completed');
  });

  it('终态后再 cancel = 幂等 no-op（不回退 stopping、不重发 abort）', () => {
    const { jobs } = setup();
    const c = jobs.create({ kind: 'subagent' });
    c.settle('completed');
    c.handle.cancel();
    expect(c.handle.status).toBe('completed');
  });

  it('同一 Job 只广播一次 job_settled（迟到的 settle 不重发事件）', async () => {
    const settled: unknown[] = [];
    const { ctx, jobs } = setup();
    ctx.on('job_settled', (payload) => settled.push(payload));
    const c = jobs.create({ kind: 'subagent' });
    c.settle('completed', { output: '唯一' });
    c.settle('failed', { error: '让位' });
    await c.handle.done;
    // 微任务排空后仍只有一次结算事件
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ terminal: 'completed', output: '唯一' });
  });
});

describe('Job 注册表 — owner 围栏', () => {
  it('带主 Job：异 session 视角 cancel/get 即 JOB_OWNER_MISMATCH', async () => {
    const { jobs } = setup();
    const c = jobs.create({ kind: 'subagent', ownerSessionId: 'sess-a' });
    await expectCode(JOB_OWNER_MISMATCH, () => jobs.cancel(c.handle.id, { sessionId: 'sess-b' }));
    await expectCode(JOB_OWNER_MISMATCH, () => jobs.get(c.handle.id, { sessionId: 'sess-b' }));
  });

  it('同 session 视角放行；无 as 视角（operator 面）全放行', async () => {
    const { jobs } = setup();
    const c = jobs.create({ kind: 'subagent', ownerSessionId: 'sess-a' });
    expect(() => jobs.cancel(c.handle.id, { sessionId: 'sess-a' })).not.toThrow();
    expect(jobs.get(c.handle.id, { sessionId: 'sess-a' })?.id).toBe(c.handle.id);
    const d = jobs.create({ kind: 'subagent', ownerSessionId: 'sess-x' });
    expect(() => jobs.cancel(d.handle.id)).not.toThrow(); // operator 直控
  });

  it('无主 Job：任何视角可查可杀（operator 直控面）', () => {
    const { jobs } = setup();
    const c = jobs.create({ kind: 'process' });
    expect(() => jobs.cancel(c.handle.id, { sessionId: '任意' })).not.toThrow();
  });

  it('cancel 不存在的 id 即 JOB_NOT_FOUND', async () => {
    const { jobs } = setup();
    await expectCode(JOB_NOT_FOUND, () => jobs.cancel('no-such-id'));
  });

  it('list：缺省全量（operator 视角）；ownerSessionId 过滤 = 会话视角', () => {
    const { jobs } = setup();
    jobs.create({ kind: 'subagent', ownerSessionId: 'sess-a' });
    jobs.create({ kind: 'subagent', ownerSessionId: 'sess-b' });
    jobs.create({ kind: 'process' });
    expect(jobs.list()).toHaveLength(3);
    expect(jobs.list({ ownerSessionId: 'sess-a' })).toHaveLength(1);
    expect(jobs.list({ ownerSessionId: 'sess-a' })[0]?.ownerSessionId).toBe('sess-a');
  });

  it('已结算条目不删除：get 仍可查、list 仍在列（终态后不可再变）', async () => {
    const { jobs } = setup();
    const c = jobs.create({ kind: 'subagent' });
    c.settle('completed');
    expect(jobs.get(c.handle.id)?.status).toBe('completed');
    expect(jobs.list()).toHaveLength(1);
  });
});

describe('Job 注册表 — per-owner 并发帽（契约篇 §1.6 资源护栏族 #12，刀〇b）', () => {
  it('同 owner 16 并发为帽：第 17 个响亮拒绝；结算释放槽位后可再造', async () => {
    const { jobs } = setup();
    // 16 个挂起 Job（create 手动持有结算权——不落终态即占槽）
    const controllers = Array.from({ length: 16 }, () => jobs.create({ kind: 'subagent', ownerSessionId: 's-owner' }));
    await expectCode(JOB_CONCURRENCY_LIMIT, () => jobs.create({ kind: 'subagent', ownerSessionId: 's-owner' }));
    // run 入口同规（帽在 createEntry 单点执法罩两入口）
    await expectCode(JOB_CONCURRENCY_LIMIT, () =>
      jobs.run({ kind: 'process', ownerSessionId: 's-owner' }, async () => undefined),
    );
    // 另一 owner 互不影响（per-owner 隔离——失控舰队只困自己会话）
    jobs.create({ kind: 'subagent', ownerSessionId: 's-other' });
    // 结算释放槽位（帽限并发不限总量）：settle 一个后可再造一个
    controllers[0]!.settle('completed');
    const refill = jobs.create({ kind: 'subagent', ownerSessionId: 's-owner' });
    expect(refill.handle.status).toBe('running');
    // 复用后再次满员：继续拒绝
    await expectCode(JOB_CONCURRENCY_LIMIT, () => jobs.create({ kind: 'subagent', ownerSessionId: 's-owner' }));
  });

  it('operator 直控面（无 owner）同规共桶：16 个第 17 拒，有主面不受 operator 桶影响', async () => {
    const { jobs } = setup();
    for (let i = 0; i < 16; i++) {
      jobs.create({ kind: 'process' }); // 无 ownerSessionId = operator 直控面
    }
    await expectCode(JOB_CONCURRENCY_LIMIT, () => jobs.create({ kind: 'process' }));
    // 有主面走自己的桶（单一规则无特权分支，但桶按 owner 分键）
    jobs.create({ kind: 'process', ownerSessionId: 's-x' });
  });
});

describe('Job 注册表 — job_settled 事件', () => {
  it('结算即广播：载荷五段形状 {id, kind, terminal, label?, output?, error?}', async () => {
    const { ctx, jobs } = setup();
    const seen: Record<string, unknown>[] = [];
    ctx.on('job_settled', (payload) => seen.push(payload as Record<string, unknown>));
    const c = jobs.create({ kind: 'subagent', label: '委派-读码', ownerSessionId: 'sess-a' });
    c.settle('completed', { output: '产物' });
    await c.handle.done;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: c.handle.id,
      kind: 'subagent',
      terminal: 'completed',
      label: '委派-读码',
      output: '产物',
    });
    // 缺省字段不占位：error / ownerSessionId 不进载荷
    expect(seen[0]).not.toHaveProperty('error');
    expect(seen[0]).not.toHaveProperty('ownerSessionId');
  });

  it('failed 结算携带 error 段', async () => {
    const { ctx, jobs } = setup();
    const seen: Record<string, unknown>[] = [];
    ctx.on('job_settled', (p) => seen.push(p as Record<string, unknown>));
    const h = jobs.run({ kind: 'process' }, async () => {
      throw new Error('炸了');
    });
    await h.done;
    expect(seen[0]).toMatchObject({ kind: 'process', terminal: 'failed' });
    expect(typeof seen[0]?.['error']).toBe('string');
  });
});

describe('Job 注册表 — drain 排空', () => {
  it('drain()：全量 cancel + await 全部结算（含无主）', async () => {
    const { jobs } = setup();
    const handles = [0, 1, 2].map((i) =>
      jobs.run({ kind: 'process', label: `p${i}` }, (signal) => {
        // 每个 executor 都观察 signal 才收工——drain 的 cancel 驱动它们落 killed
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }).then(() => undefined);
      }),
    );
    await jobs.drain();
    for (const h of handles) {
      expect(h.status).toBe('killed');
      await expect(h.done).resolves.toBe('killed');
    }
  });

  it('drain(ownerSessionId)：只取消该 owner 的，他人 Job 不受牵连', async () => {
    const { jobs } = setup();
    const mine = jobs.run({ kind: 'subagent', ownerSessionId: 'sess-a' }, (signal) => {
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }).then(() => undefined);
    });
    // 他人 Job 永不观察 signal（模拟长跑）——drain('sess-a') 不碰它；
    // 测试收尾手动落终态防泄漏（executor 缺席场景，终态语义归 executor 侧）
    const other = jobs.create({ kind: 'subagent', ownerSessionId: 'sess-b' });
    await jobs.drain('sess-a');
    expect(mine.status).toBe('killed');
    expect(other.handle.status).toBe('running');
    other.settle('completed');
    await other.handle.done;
  });
});

describe('Job 注册表 — 作用域回卷兜底', () => {
  it('作用域 dispose → 全量 cancel + 尽力排空（fire-and-forget 最终收敛）', async () => {
    const { ctx, jobs } = setup();
    const h = jobs.run({ kind: 'subagent' }, (signal) => {
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }).then(() => undefined);
    });
    await ctx.dispose();
    // 兜底 drain 是 fire-and-forget——await done 即等到它收敛
    await expect(h.done).resolves.toBe('killed');
  });

  it('回卷后 create/registerKind 即 CONTEXT_DISPOSED（stale 注册表护栏）', async () => {
    const { ctx, jobs } = setup();
    await ctx.dispose();
    await expectCode(CONTEXT_DISPOSED, () => jobs.create({ kind: 'subagent' }));
    await expectCode(CONTEXT_DISPOSED, () => jobs.registerKind('late'));
  });
});
