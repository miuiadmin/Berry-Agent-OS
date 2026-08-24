/**
 * L3 memory 集成测试（官方件 apply 接线全栈）——真 Context + 真库 + 宿主
 * 服务最小面（tools/prompts/sessions 注册表真件；llm 走结构性替身——模型层是
 * mock 停靠站）。
 *
 * 锁纵切五接线序：工具五件 / 简报段 / 跨会话索引对账+镜像 / memory-recall 角色
 * 注册 + context_transform 按需检索注入（防注入句式 + kind 优先 + 空手放行）。
 * 差分追注（第十二批题二）：memory-diff 角色 + 基线纪元冻结 / 分叉落账 /
 * 收敛清账 / 重启撞指纹自愈 / 重放派生不变式。persist:false 降级单列。
 */

import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import type { ContextScope } from '../context/types.js';
import { openStore, type Store } from '../persist/index.js';
import { Session } from '../session/session.js';
import {
  MEMORY_MIGRATION,
  MEMORY_UTILITY_MIGRATION,
  SESSION_FTS_MIGRATION,
  MemoryStore,
  SessionFtsIndex,
  createMemoryPlugin,
} from './index.js';
import type { MemoryPluginStoreFace } from './index.js';
import { getMessageRoleDefinition } from '../agent/messages.js';
import type { BuiltinPluginModule } from '../contracts/plugin.js';
import type { SessionEvent } from '../contracts/events.js';
import { deriveDiffView, faceFingerprint } from './diff.js';

/* ---------------- 测试基建：宿主服务最小面 ---------------- */

/**
 * 组装产物：tools/prompts/sessions 注册面 + llm 替身 + 真库。
 * sessions 面 = 宿主 ④f 的测试侧形态：活引用绑定真 Session（appendEvent 落
 * 真事件日志，差分 handler 的懒初始化/清账断言直接读 session.events）。
 */
interface Harness {
  /** 根作用域（dispose 回卷验证需要 ContextScope 面） */
  ctx: ContextScope;
  /** 已注册工具名集（apply 经 ctx.get('tools').register 真注册） */
  toolNames: () => string[];
  /** 已注册段 id → render（apply 经 ctx.get('prompts').registerSection 真注册） */
  sectionIds: () => string[];
  /** 物化某段内容（装配侧 materialize 的测试等价物——基线纪元在此冻结） */
  renderSection: (id: string) => string;
  /** 绑定活跃会话（appendEvent 活引用目标——/new 热切换的测试等价物） */
  bindSession: (session: Session) => void;
  /** ctx.llm.complete 调用计数（canAfford 恒 false → 周期路闸门关闭） */
  llmCalls: () => number;
  store: Store;
  source: MemoryPluginStoreFace;
}

/** 建 ctx + 四服务面 + 真库（memory 表族 + session_fts 同链迁移） */
function setup(logs: Record<string, SessionEvent[]> = {}): Harness {
  const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
  const registeredTools = new Set<string>();
  const sections = new Map<string, () => string>();
  const llm = { calls: 0 };
  ctx.provide('tools', {
    register: (def: { name: string }) => {
      registeredTools.add(def.name);
      return () => registeredTools.delete(def.name);
    },
  });
  ctx.provide('prompts', {
    registerSection: (section: { id: string; render(): string }) => {
      sections.set(section.id, section.render);
      return () => sections.delete(section.id);
    },
  });
  // 活跃会话活引用（appendEvent 目标 + loadEvents 路由——差分懒初始化读它）
  let live: Session | undefined;
  ctx.provide('sessions', {
    appendEvent: (type: string, data: unknown): SessionEvent | undefined => live?.append(type, data),
  });
  // llm 服务结构性替身（ReviewLlmFace/complete 面的最小满足）：complete 记调用，
  // canAfford 恒 false——周期 review 在闸门处短路，测试不进后台补全
  ctx.provide('llm', {
    complete: async () => {
      llm.calls += 1;
      return { message: { content: '' } };
    },
    canAfford: () => false,
  });
  const store: Store = openStore({
    path: ':memory:',
    migrations: [MEMORY_MIGRATION, SESSION_FTS_MIGRATION, MEMORY_UTILITY_MIGRATION],
  });
  const source: MemoryPluginStoreFace = {
    connection: store.connection,
    listSessionIds: () => Object.keys(logs),
    // 活跃会话读活日志（write-behind 已 flush 的测试等价），其余读预置卷
    loadEvents: (id) => (live?.header.sessionId === id ? [...live.events] : (logs[id] ?? [])),
  };
  return {
    ctx,
    toolNames: () => [...registeredTools],
    sectionIds: () => [...sections.keys()],
    renderSection: (id) => sections.get(id)!(),
    bindSession: (session) => {
      live = session;
    },
    llmCalls: () => llm.calls,
    store,
    source,
  };
}

/* ---------------- persist:false 降级 ---------------- */

/**
 * apply 直调桥：契约面 PluginApply 的 ctx 形参是 never 占位（L0 contracts 不能
 * 引用 L1 的 Context 类型——加载器内部同款重定型），测试经此恢复真实签名。
 */
function applyPlugin(
  plugin: BuiltinPluginModule,
  ctx: ContextScope,
  config?: Readonly<Record<string, unknown>>,
): Promise<void> {
  return plugin.apply(ctx as never, config) as Promise<void>;
}

describe('memory 官方件 apply（persist:false 降级）', () => {
  it('无 store：warn 空转——零注册零抛（dump-config 诊断面诚实）', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    const plugin = createMemoryPlugin({ workspace: () => '/w' });
    await expect(applyPlugin(plugin, ctx)).resolves.toBeUndefined(); // 不抛
    expect(ctx.tryGet('tools')).toBeUndefined(); // 未触任何 get（服务可缺位）
  });
});

/* ---------------- 全栈接线 ---------------- */

describe('memory 官方件 apply（全栈接线序）', () => {
  it('工具五件 + 简报段真注册；dispose 回卷整体注销（effect LIFO）', async () => {
    const h = setup();
    const plugin = createMemoryPlugin({ store: h.source, workspace: () => '/w' });
    await applyPlugin(plugin, h.ctx);

    expect(h.toolNames()).toEqual(['memory_write', 'memory_forget', 'memory_restore', 'memory_read', 'memory_search']);
    expect(h.sectionIds()).toEqual(['memory/core']);
    // 周期路闸门关闭（canAfford false）：不触 complete
    expect(h.llmCalls()).toBe(0);

    // dispose 回卷：全部注册注销（/reload 卸载半边的本模块证据）
    await h.ctx.dispose();
    expect(h.toolNames()).toEqual([]);
    expect(h.sectionIds()).toEqual([]);
  });

  it('跨会话索引：激活对账全量建 + session/event 镜像增量进检索面', async () => {
    const logs: Record<string, SessionEvent[]> = {
      s1: [
        { type: 'user/message', seq: 0, time: 1, data: { content: '部署用 vercel 才对' } },
        { type: 'assistant/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '好的 vercel' }] } },
      ],
    };
    const h = setup(logs);
    const plugin = createMemoryPlugin({ store: h.source, workspace: () => '/w' });
    await applyPlugin(plugin, h.ctx);

    // 激活期对账已建索引（历史会话检索面就位）
    const fts = new SessionFtsIndex(h.store.connection);
    expect(fts.search('vercel')).toHaveLength(2);

    // 活体镜像：emit session/event → 增量进索引
    h.ctx.emit('session/event', {
      sessionId: 's2',
      event: { type: 'user/message', seq: 0, time: 1, data: { content: '新会话讲 netlify' } },
    });
    expect(fts.search('netlify')).toHaveLength(1);

    await h.ctx.dispose();
  });

  it('按需检索：命中注入 memory-recall（防注入句式 + 引用标记 + kind 优先），空手放行', async () => {
    const h = setup();
    const plugin = createMemoryPlugin({ store: h.source, workspace: () => '/w' });
    await applyPlugin(plugin, h.ctx, { recallTopK: 1 });

    // 预置记忆：两条不同 kind 共享关键词「生产环境」（preference 与 failure——
    // failure 优先级 0 应胜过 preference 的 5，topK=1 只注入 failure）
    const memory = new MemoryStore(h.store.connection);
    memory.addMemory({
      ownerKey: 'global',
      kind: 'preference',
      summary: '偏好：生产环境统一用 pnpm',
      content: '包管理器偏好',
      confidence: 0.9,
    });
    memory.addMemory({
      ownerKey: 'global',
      kind: 'failure',
      summary: '曾误删生产环境数据库',
      content: '教训：删除前先备份',
      confidence: 0.8,
    });
    // 物化简报段 = 基线纪元冻结（装配侧 materialize 的测试等价物）——记忆先在
    // 库、基线含之，检索测试不再混入差分注入面
    h.renderSection('memory/core');

    // 手动驱动瀑布（loop transformContext 桥的同一路径）：命中查询
    // （trigram 整 token 子串语义：中文无分词，查询串须是目标词的连续子串——
    // 「生产环境」是两条记忆 summary 的公共子串，池含两条，排序见 kind）
    const out = (await h.ctx.waterfall(
      'context_transform',
      [{ role: 'user', content: '生产环境', timestamp: 1 }],
      (final: unknown) => final,
    )) as Array<{ role: string; content: unknown; timestamp: number }>;
    expect(out).toHaveLength(2); // 原消息 + 至多一条注入
    const injected = out.at(-1)!;
    expect(injected.role).toBe('memory-recall'); // 自定义角色已注册且生效
    expect(String(injected.content)).toContain('以下来自历史记忆检索'); // 防注入句式
    expect(String(injected.content)).toContain('[m:'); // 引用标记随注入行携带（§6 引用回写）
    expect(String(injected.content)).toContain('若使用上述记忆作答'); // 引用指令句
    expect(String(injected.content)).toContain('误删生产环境数据库'); // kind 优先：failure 胜出（topK=1）
    expect(String(injected.content)).not.toContain('统一用 pnpm'); // 落选条不进注入

    // 角色定义双面：toLlm → UserMessage（模型只见 user 消息）；render hidden（不进时间线）
    const definition = getMessageRoleDefinition('memory-recall')!;
    const llmMessage = definition.toLlm!(injected as never) as { role: string };
    expect(llmMessage.role).toBe('user');
    expect(definition.render).toMatchObject({ intent: 'hidden' });

    // 空手查询：原样放行（不产注入消息）
    const pass = (await h.ctx.waterfall(
      'context_transform',
      [{ role: 'user', content: '完全无关的天气问题', timestamp: 1 }],
      (final: unknown) => final,
    )) as unknown[];
    expect(pass).toHaveLength(1); // 无追加

    await h.ctx.dispose();
  });

  it('引用回写：assistant 消息携带 [m:短id] → usage_count 累加（session/event 消费侧）', async () => {
    const h = setup();
    const plugin = createMemoryPlugin({ store: h.source, workspace: () => '/w' });
    await applyPlugin(plugin, h.ctx);

    const memory = new MemoryStore(h.store.connection);
    const inserted = memory.addMemory({
      ownerKey: 'global',
      kind: 'fact',
      summary: '用户的项目代号是 berry',
      content: '2026-08-24 会话确认。',
      confidence: 0.9,
    });
    if (inserted.outcome !== 'inserted') throw new Error('前置失败');
    const { id } = inserted.memory;
    const short = id.slice(0, 8);
    expect(memory.get(id)!.usageCount).toBe(0);

    // 模型回答文本携带引用标记 → 活体事件流（与真实驱动 durable 接线同信封）
    h.ctx.emit('session/event', {
      sessionId: 's9',
      event: {
        type: 'assistant/message',
        seq: 3,
        time: 1,
        data: { content: [{ type: 'text', text: `根据历史记忆 [m:${short}]，项目代号确实是 berry。` }] },
      },
    });
    const used = memory.get(id)!;
    expect(used.usageCount).toBe(1); // 引用回写命中
    expect(used.lastUsedAt).not.toBeNull();

    // 未知短 id / 非 assistant 事件：零副作用；同条再引一次 = 2（跨消息累计）
    h.ctx.emit('session/event', {
      sessionId: 's9',
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 2,
        data: { content: [{ type: 'text', text: '参见 [m:00000000]' }] },
      },
    });
    expect(memory.get(id)!.usageCount).toBe(1); // 未知引用不误记
    h.ctx.emit('session/event', {
      sessionId: 's9',
      event: { type: 'user/message', seq: 5, time: 3, data: { content: `[m:${short}]` } },
    });
    expect(memory.get(id)!.usageCount).toBe(1); // user 消息不解析（只有模型引用计效用）
    h.ctx.emit('session/event', {
      sessionId: 's9',
      event: {
        type: 'assistant/message',
        seq: 6,
        time: 4,
        data: { content: [{ type: 'text', text: `再次确认 [m:${short}]。` }] },
      },
    });
    expect(memory.get(id)!.usageCount).toBe(2); // 第二条消息再引用 = 累加

    await h.ctx.dispose();
  });
});

/* ---------------- 简报差分追注（§6 完整差分版三件，第十二批题二） ---------------- */

/** 差分测试共件：apply + 真会话绑定 + 基线物化 + 闩就位（首 user 事件） */
async function setupDiffBaseline(h: Harness, preseed?: (memory: MemoryStore) => void) {
  const plugin = createMemoryPlugin({ store: h.source, workspace: () => '/w' });
  await applyPlugin(plugin, h.ctx);
  const memory = new MemoryStore(h.store.connection);
  preseed?.(memory);
  const session = new Session();
  h.bindSession(session);
  // 基线物化（render = 装配侧物化的等价物）+ 活跃会话闩（首事件先到）
  const sectionText = h.renderSection('memory/core');
  h.ctx.emit('session/event', {
    sessionId: session.header.sessionId,
    event: { type: 'user/message', seq: 0, time: 1, data: { content: '开始对话' } },
  });
  return { memory, session, sectionText };
}

/** 驱动一次 context_transform（loop transformContext 桥的同一路径） */
async function runTransform(h: Harness): Promise<Array<{ role: string; content: unknown }>> {
  return (await h.ctx.waterfall(
    'context_transform',
    [{ role: 'user', content: '继续', timestamp: 1 }],
    (final: unknown) => final,
  )) as Array<{ role: string; content: unknown }>;
}

describe('memory 官方件 apply（简报差分追注）', () => {
  it('分叉落账 + 注入：基线后新条目 → memory/diff 入真会话日志 + memory-diff 注入进请求尾', async () => {
    const h = setup();
    const { memory, session } = await setupDiffBaseline(h);

    // 基线后权威面漂移：新条目入库（下轮请求才看见差分）
    const inserted = memory.addMemory({
      ownerKey: 'global',
      kind: 'preference',
      summary: '新偏好：回答先给结论',
      content: '2026-08-24 会话确认。',
      confidence: 0.8,
    });
    if (inserted.outcome !== 'inserted') throw new Error('前置失败');

    const out = await runTransform(h);
    // 差分注入在尾部（本测试无检索命中——查询「继续」不中记忆词）
    const injected = out.at(-1)!;
    expect(out).toHaveLength(2);
    expect(injected.role).toBe('memory-diff');
    expect(String(injected.content)).toContain('以下为常驻记忆简报自本次基线后的变化'); // 防注入句式
    expect(String(injected.content)).toContain('+ [m:'); // 新增态 + 引用标记
    expect(String(injected.content)).toContain('新偏好：回答先给结论');

    // durable 落账（与检索即弃注入的分界）：真会话日志里有一条 memory/diff
    const diffs = session.events.filter((e) => e.type === 'memory/diff');
    expect(diffs).toHaveLength(1);
    expect((diffs[0]!.data as { entries: unknown[] }).entries).toHaveLength(1);

    // 角色定义双面：toLlm → user 消息；render hidden 不进时间线
    const definition = getMessageRoleDefinition('memory-diff')!;
    expect(definition.render).toMatchObject({ intent: 'hidden' });
    expect((definition.toLlm!(injected as never) as { role: string }).role).toBe('user');

    // 幂等：面未再变 → 同视图不追写、注入照常（每请求至多一条）
    const again = await runTransform(h);
    expect(session.events.filter((e) => e.type === 'memory/diff')).toHaveLength(1);
    expect(again.at(-1)!.role).toBe('memory-diff');

    await h.ctx.dispose();
  });

  it('收敛清账：漂移回基线 → 追写空差分事件（重放视图归零）、不再注入', async () => {
    const h = setup();
    const { memory, session } = await setupDiffBaseline(h);

    const inserted = memory.addMemory({
      ownerKey: 'global',
      kind: 'fact',
      summary: '临时事实',
      content: 'c',
    });
    if (inserted.outcome !== 'inserted') throw new Error('前置失败');
    await runTransform(h); // 落账 [+]
    expect(session.events.filter((e) => e.type === 'memory/diff')).toHaveLength(1);

    // 面漂移回基线（forget）→ 下一请求清账：entries=[] 追写、注入消失
    memory.forget(inserted.memory.id);
    const out = await runTransform(h);
    const diffs = session.events.filter((e) => e.type === 'memory/diff');
    expect(diffs).toHaveLength(2); // 清账事件已落
    expect((diffs[1]!.data as { entries: unknown[] }).entries).toEqual([]);
    expect(out).toHaveLength(1); // 无注入（原消息放行）
    // 重放派生与运行时一致（不变式：mirror == deriveDiffView）
    const view = deriveDiffView([...session.events], (diffs[0]!.data as { baseline: string }).baseline);
    expect(view).toEqual([]);

    await h.ctx.dispose();
  });

  it('重启撞指纹自愈：旧纪元残留事件与新基线同指纹 → 首请求落清账事件', async () => {
    // 预置库 = 恰好等于旧基线面（甲在库）；上进程未清账即退出，日志残留
    // 同面指纹的差分事件——新进程基线撞指纹，纯 mirror 初始化会漏账，懒初始化
    // 必须从日志派生才发现「日志视图非空 / 当前面零漂移」并自愈清账
    const h = setup();
    let seededId = '';
    const { session } = await setupDiffBaseline(h, (memory) => {
      const out = memory.addMemory({ ownerKey: 'global', kind: 'fact', summary: '条目甲', content: 'c' });
      if (out.outcome === 'inserted') seededId = out.memory.id;
    });
    // 基线 = {甲}；手工排进会话日志一条同指纹旧事件（模拟上进程残留）
    const baselineFp = faceFingerprint([{ id: seededId, kind: 'fact', summary: '条目甲' }]);
    session.append('memory/diff', {
      baseline: baselineFp,
      entries: [{ op: '+', id: 'bbbbbbbb', kind: 'fact', summary: '已消散的条目乙' }],
    });

    // 当前面 == 基线（无漂移）但日志视图非空 → 首请求自愈：清账事件落、无注入
    const out = await runTransform(h);
    const diffs = session.events.filter((e) => e.type === 'memory/diff');
    expect(diffs.at(-1)!.data).toMatchObject({ entries: [] });
    expect(out).toHaveLength(1);
    expect(deriveDiffView([...session.events], baselineFp)).toEqual([]); // 重放归零

    await h.ctx.dispose();
  });

  it('基线重物化 = 新纪元：旧差分指纹出局，注入随新基线重算', async () => {
    const h = setup();
    const { memory } = await setupDiffBaseline(h);

    const inserted = memory.addMemory({
      ownerKey: 'global',
      kind: 'fact',
      summary: '纪元一条',
      content: 'c',
    });
    if (inserted.outcome !== 'inserted') throw new Error('前置失败');
    await runTransform(h); // 旧纪元落账 [+] + 注入

    // /new 等价物：重新物化基线（面含新条目）→ 指纹换纪元、差分账清零
    h.renderSection('memory/core');
    const out = await runTransform(h);
    expect(out).toHaveLength(1); // 无注入：当前面 == 新基线

    await h.ctx.dispose();
  });
});
