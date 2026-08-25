/**
 * L3 web 件级测试 — `builtin:web` apply 双面接线（模型面 fetch 工具 + 服务面
 * ctx.fetch），契约篇 §1.5.2「同一 execute 同一卫生件」的件层回归锁。
 *
 * 真 Context + 宿主服务最小面（tools 服务假件——注册表/管道执行器记录器）；
 * 外部边界注入：fetchImpl/lookup 假实现（mock 只停在这一层）。
 */

import { describe, expect, it } from 'vitest';
import { createContext } from '../context/context.js';
import { createLogger } from '../context/logger.js';
import { AppError, CONTEXT_SERVICE_NOT_FOUND, WEB_PRIVATE_TARGET } from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition, ToolPipelineExecutor } from '../contracts/tools.js';
import { createWebPlugin } from './plugin.js';
import type { WebService } from './types.js';

/* ---------------- 测试基建：宿主 tools 服务最小面 ---------------- */

/** 管道调用记录（executor 被调 = 服务面走了三段管道——守门/落账不旁路的件层证据） */
interface PipelineCall {
  readonly def: ToolDefinition;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
}

/**
 * 假 tools 服务：register 记录 def 并返回注销器；executor 记录调用后直转
 * def.execute（管道三段的件层替身——真管道形态在组合根全栈测试锁）。
 */
function fakeTools(withExecutor = true) {
  const registered = new Map<string, ToolDefinition>();
  const disposed: string[] = [];
  const pipeline: PipelineCall[] = [];
  const executor: ToolPipelineExecutor | undefined = withExecutor
    ? async (def, toolCallId, input, signal): Promise<AgentToolResult> => {
        pipeline.push({ def, toolCallId, input });
        return def.execute(input, { toolCallId, signal });
      }
    : undefined;
  const service = {
    executor,
    register: (def: ToolDefinition) => {
      registered.set(def.name, def);
      return () => {
        registered.delete(def.name);
        disposed.push(def.name);
      };
    },
    get: (name: string) => registered.get(name),
    list: () => [...registered.values()],
  };
  return { service, registered, disposed, pipeline };
}

/** 200 文本应答的假 fetch（外部边界注入） */
const okFetch = async () => new Response('服务面正文', { status: 200, headers: { 'content-type': 'text/plain' } });

/** 假 lookup：全公网放行 */
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

/* ---------------- 模型面与服务面 ---------------- */

describe('web 官方件 apply 双面接线', () => {
  it('模型面：fetch 工具注册（effect 可逆——dispose 回卷即注销），effect read', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    const tools = fakeTools();
    ctx.provide('tools', tools.service);
    const plugin = createWebPlugin({ fetchImpl: okFetch, lookup: publicLookup });
    plugin.apply(ctx as never, undefined);

    const def = tools.registered.get('fetch');
    expect(def).toBeDefined();
    expect(def!.effect).toBe('read'); // 网络守门 = SSRF fence 本身，非审批域
    expect(def!.timeoutMs).toBe(60_000); // 管道执行预算

    ctx.dispose(); // 回卷 effect → 注销器被调
    expect(tools.disposed).toEqual(['fetch']);
  });

  it('服务面：ctx.fetch 恒 provide——经 executor 走三段管道（不旁路）+ 九字段真值返回 + caller 归因入管道载荷', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    const tools = fakeTools();
    ctx.provide('tools', tools.service);
    createWebPlugin({ fetchImpl: okFetch, lookup: publicLookup }).apply(ctx as never, undefined);

    const service = ctx.get<WebService>('fetch');
    const result = await service.fetch('https://ok.example/doc', { caller: 'memory-plugin' });

    // 管道被调（服务面不旁路守门/落账）；toolCallId 是内部合成键形态
    expect(tools.pipeline).toHaveLength(1);
    expect(tools.pipeline[0]!.input).toEqual({ url: 'https://ok.example/doc', caller: 'memory-plugin' });
    expect(tools.pipeline[0]!.toolCallId).toMatch(/^fetch-/);
    // 管道里跑的是**内部合成 def**（非注册面模型工具的复用——两 def 不同物；
    // 「服务面关模型面照跑」的可分离性由 config.fetch:false 变体测试锁）
    expect(tools.pipeline[0]!.def).not.toBe(tools.registered.get('fetch'));
    // 返回九字段真值（服务面拿到的是结构化结果，非文本组装面）
    expect(result).toMatchObject({ url: 'https://ok.example/doc', status: 200, text: '服务面正文', redirects: 0 });
  });

  it('同一 execute 同一卫生件：服务面对私网目标同样 WEB_PRIVATE_TARGET（两消费面一底座）', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    const tools = fakeTools();
    ctx.provide('tools', tools.service);
    createWebPlugin({ fetchImpl: okFetch, lookup: async () => [{ address: '10.0.0.9', family: 4 }] }).apply(
      ctx as never,
      undefined,
    );
    const service = ctx.get<WebService>('fetch');
    await service.fetch('https://internal.example/').then(
      () => {
        throw new Error('期望 WEB_PRIVATE_TARGET');
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe(WEB_PRIVATE_TARGET);
      },
    );
  });

  it('config.fetch:false = 「有但省」变体二：模型面不注册、服务面不受影响', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    const tools = fakeTools();
    ctx.provide('tools', tools.service);
    createWebPlugin({ fetchImpl: okFetch, lookup: publicLookup }).apply(ctx as never, { fetch: false });

    expect(tools.registered.has('fetch')).toBe(false); // 模型面关
    const result = await ctx.get<WebService>('fetch').fetch('https://ok.example/');
    expect(result.status).toBe(200); // 服务面照常
  });

  it('executor undefined（无管道诊断形态）：响亮失败不静默——CONTEXT_SERVICE_NOT_FOUND', async () => {
    const ctx = createContext({ logger: createLogger({ module: 'test', level: 'silent' }) });
    ctx.provide('tools', fakeTools(false).service); // executor 缺位形态
    createWebPlugin({ fetchImpl: okFetch, lookup: publicLookup }).apply(ctx as never, undefined);

    await expect(ctx.get<WebService>('fetch').fetch('https://ok.example/')).rejects.toMatchObject({
      code: CONTEXT_SERVICE_NOT_FOUND,
    });
  });
});
