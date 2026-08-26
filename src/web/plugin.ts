/**
 * L3 web — 官方件 `builtin:web`（契约篇 §1.5.2 一批三件，默认层第八行，
 * Ring 2 真·可卸库角色行）。
 *
 * apply 两件事（模型面可关、服务面恒在）：
 * 1. **fetch 工具**（config.fetch !== false 时注册）：模型面动词——单参数
 *    url、effect:'read'（网络守门 = SSRF fence 非审批域）；
 * 2. **ctx.fetch 服务**（恒 provide）：插件面原语——同一 execute 同一卫生件，
 *    内部合成 def（不注册不进模型词汇表）经 ToolsService.executor 走同一条
 *    三段管道（守门/落账不旁路，ctx.exec 先例同构）。
 */

import { randomUUID } from 'node:crypto';
import { Type } from '../contracts/typebox.js';
import { AppError, CONTEXT_SERVICE_NOT_FOUND } from '../contracts/errors.js';
import type { AgentToolResult, ToolDefinition, ToolsService } from '../contracts/tools.js';
import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import { performFetch, runWebFetch, type WebFetchDeps } from './fetch-core.js';
import { InflightGates } from './hygiene.js';
import {
  WEB_FETCH_TIMEOUT_MS,
  WEB_PLUGIN_CONFIG_SCHEMA,
  type WebFetchOptions,
  type WebFetchResult,
  type WebService,
} from './types.js';

/** 模型面 fetch 工具的参数 schema（v1 单参数 url——契约篇 §1.5.2 ①） */
const FETCH_TOOL_PARAMETERS = Type.Object({
  url: Type.String({ description: '完整 http(s) URL（私网/保留地址会被拒绝）' }),
});

/** 服务面合成 def 的参数 schema（与工具面同形——管道载荷，非模型可见） */
const INTERNAL_FETCH_PARAMETERS = FETCH_TOOL_PARAMETERS;

/** 件构造依赖覆盖缝（生产零参——builtins.ts 直调；测试注入 fetchImpl/lookup） */
export type WebPluginOverrides = Partial<WebFetchDeps>;

/**
 * 构造 web 官方件（builtins 注册表 `builtin:web` 行）。
 * 零宿主资源闭包（fetch 是全局函数、无限流配置面）——web 是最简官方件形态。
 */
export function createWebPlugin(overrides: WebPluginOverrides = {}): BuiltinPluginModule {
  return {
    name: 'web',
    // 硬依赖：tools 服务面（工具注册 + executor 管道取用——装载轮次保证在场）
    inject: ['tools'],
    config: WEB_PLUGIN_CONFIG_SCHEMA,
    apply: (ctx: PluginContext, config?: Readonly<Record<string, unknown>>) => applyWebPlugin(ctx, config, overrides),
  };
}

/** 件 apply 本体（异常上抛走加载器统一回卷 PLUGIN_APPLY_FAILED） */
function applyWebPlugin(
  ctx: PluginContext,
  config: Readonly<Record<string, unknown>> | undefined,
  overrides: WebPluginOverrides,
): void {
  const tools = ctx.get<ToolsService>('tools');
  // 件级共享依赖束：限流信号量单例 + 测试注入缝（两消费面同一限流同一实现）
  const deps: WebFetchDeps = { gates: new InflightGates(), ...overrides };

  /* ---- 服务面：ctx.get('fetch')（恒 provide——config.fetch:false 只关模型面） ---- */
  const service: WebService = {
    async fetch(url: string, opts: WebFetchOptions = {}): Promise<WebFetchResult> {
      // 真值捕获口：execute 内写入——管道后处理段可改写 result，但服务面返回值
      // 以本闭包捕获为准（exec 服务先例同构）
      let captured: WebFetchResult | undefined;
      const def: ToolDefinition = {
        name: 'fetch', // 内部名：不注册进注册表——模型词汇表不可见
        label: '（内部）出网抓取',
        effect: 'read',
        timeoutMs: 0, // 0 = 管道不设限（取消由调用方 signal 自治——原语侧宽）
        description: '内部合成：ctx.fetch 服务原语（不进模型词汇表）',
        parameters: INTERNAL_FETCH_PARAMETERS,
        execute: async (input): Promise<AgentToolResult> => {
          // 真值层直取（performFetch——与工具面同一卫生件同一实现）；
          // 服务面返回九字段真值（caller 归因只进 durable details，不进返回值）
          const { result, binary } = await performFetch(input as { url: string; caller?: string }, opts.signal, deps);
          captured = result;
          // 管道结果面（文本形态供落账/监听者看；结构化真值走闭包捕获）
          return {
            content: [{ type: 'text', text: binary ? `（非文本响应：${result.contentType}）` : result.text }],
            ...(binary ? { isError: true } : {}),
            details: { ...result, ...(opts.caller ? { caller: opts.caller } : {}) },
          };
        },
      };
      // 管道取用：ToolsService.executor（Ring 1 行树化批机制——替换件换管道两层同换）。
      // undefined = 无管道诊断形态（dump-config :memory:）——响亮失败不静默
      const executor = tools.executor;
      if (executor === undefined) {
        throw new AppError(
          CONTEXT_SERVICE_NOT_FOUND,
          '[CONTEXT_SERVICE_NOT_FOUND] 工具管道未装配（tools 服务缺 executor——诊断形态不可出网）',
        );
      }
      // 内部 toolCallId（durable gate/decision 落账关联键）+ caller 归因入管道载荷
      const toolCallId = `fetch-${randomUUID()}`;
      // origin='service'（P1-2 增补 7③）：宿主服务面复入的显式判别词（同 exec 服务）
      await executor(
        def,
        toolCallId,
        { url, ...(opts.caller ? { caller: opts.caller } : {}) },
        opts.signal,
        undefined,
        'service',
      );
      return captured!; // execute 已跑即必写（异常路径走 throw 不会到这）
    },
  };
  ctx.provide('fetch', service);
  // 服务随件作用域生命周期——/reload 回卷重装（provide 无 Disposer 面，LIFO 回卷由加载器统一处理）

  /* ---- 模型面：fetch 工具（「有但省」变体二——config.fetch:false 不注册） ---- */
  if (config?.fetch === false) {
    ctx.logger.debug('web 件 fetch 工具已按行配置关闭（ctx.fetch 服务不受影响）');
    return;
  }
  ctx.effect(() => {
    const def: ToolDefinition = {
      name: 'fetch',
      description:
        '抓取 http(s) URL 内容并返回处理后的纯文本（HTML 剥标签）与元数据（最终 URL、状态码、字节数、是否截断）。目标解析到私网/保留地址会被拒绝；重定向最多跟随 5 跳；产出超 60KiB 保头截断',
      parameters: FETCH_TOOL_PARAMETERS,
      effect: 'read', // 网络守门 = SSRF fence 本身（非审批域——沙箱三档网络域显式排除在词汇外）
      timeoutMs: WEB_FETCH_TIMEOUT_MS,
      execute: (input, tctx): Promise<AgentToolResult> => runWebFetch(input as { url: string }, tctx.signal, deps),
    };
    return tools.register(def);
  });
}
