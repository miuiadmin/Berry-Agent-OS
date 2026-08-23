/**
 * L3 memory 集成测试（官方内置件 apply 接线全栈）——真 Context + 真库 + 宿主
 * 服务最小面（tools/prompts 注册表真件；llm 走结构性替身——模型层是 mock 停靠站）。
 *
 * 锁纵切五接线序：工具五件 / 简报段 / 跨会话索引对账+镜像 / memory-recall 角色
 * 注册 + context_transform 按需检索注入（防注入句式 + kind 优先 + 空手放行）。
 * persist:false 降级（warn 空转零注册）单列。
 */

import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import type { ContextScope } from '../context/types.js';
import { openStore, type Store } from '../persist/index.js';
import { MEMORY_MIGRATION, SESSION_FTS_MIGRATION, MemoryStore, SessionFtsIndex, createMemoryPlugin } from './index.js';
import type { MemoryPluginStoreFace } from './index.js';
import { getMessageRoleDefinition } from '../agent/messages.js';
import type { BuiltinPluginModule } from '../contracts/plugin.js';
import type { SessionEvent } from '../contracts/events.js';

/* ---------------- 测试基建：宿主服务最小面 ---------------- */

/** 组装产物：tools/prompts 注册表记录面 + llm 替身 + 真库 */
interface Harness {
  /** 根作用域（dispose 回卷验证需要 ContextScope 面） */
  ctx: ContextScope;
  /** 已注册工具名集（apply 经 ctx.get('tools').register 真注册） */
  toolNames: () => string[];
  /** 已注册段 id → render（apply 经 ctx.get('prompts').registerSection 真注册） */
  sectionIds: () => string[];
  /** ctx.llm.complete 调用计数（canAfford 恒 false → 周期路闸门关闭） */
  llmCalls: () => number;
  store: Store;
  source: MemoryPluginStoreFace;
}

/** 建 ctx + 三服务面 + 真库（memory 表族 + session_fts 同链迁移） */
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
  // llm 服务结构性替身（ReviewLlmFace/complete 面的最小满足）：complete 记调用，
  // canAfford 恒 false——周期 review 在闸门处短路，测试不进后台补全
  ctx.provide('llm', {
    complete: async () => {
      llm.calls += 1;
      return { message: { content: '' } };
    },
    canAfford: () => false,
  });
  const store: Store = openStore({ path: ':memory:', migrations: [MEMORY_MIGRATION, SESSION_FTS_MIGRATION] });
  const source: MemoryPluginStoreFace = {
    connection: store.connection,
    listSessionIds: () => Object.keys(logs),
    loadEvents: (id) => logs[id] ?? [],
  };
  return {
    ctx,
    toolNames: () => [...registeredTools],
    sectionIds: () => [...sections.keys()],
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

describe('memory 内置件 apply（persist:false 降级）', () => {
  it('无 store：warn 空转——零注册零抛（dump-config 诊断面诚实）', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    const plugin = createMemoryPlugin({ workspace: () => '/w' });
    await expect(applyPlugin(plugin, ctx)).resolves.toBeUndefined(); // 不抛
    expect(ctx.tryGet('tools')).toBeUndefined(); // 未触任何 get（服务可缺位）
  });
});

/* ---------------- 全栈接线 ---------------- */

describe('memory 内置件 apply（全栈接线序）', () => {
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

  it('按需检索：命中注入 memory-recall（防注入句式 + kind 优先），空手放行', async () => {
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
});
