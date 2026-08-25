/**
 * L2 tools — 工具注册表（ctx.tools 服务；插件契约篇 §3.2 动态注册）。
 *
 * 职责：
 * - register(ToolDefinition) → Disposer：即时生效（刷新注册表 → 广播
 *   tools_change → 下次模型请求即见新工具；无需 reload）；
 * - 把 ToolDefinition 适配成 loop 面的 AgentTool（execute = 三段管道）；
 * - defineTool 类型 helper（插件侧获得参数/结果类型推断）。
 *
 * 注册经 ctx.provide('tools', …) 挂进服务注册表，随作用域 LIFO 回卷；
 * 注销器同时撤注册表条目（幂等）。
 */

import { AppError, CONTEXT_SERVICE_NOT_FOUND, TOOL_DESCRIPTION_REJECTED, TOOL_DUPLICATE } from '../contracts/errors.js';
import type { AgentTool, ToolDefinition, ToolsService } from '../contracts/tools.js';
import { TOOLS_CHANGE_EVENT } from '../contracts/tools.js';
import type { Disposer } from '../context/types.js';
import type { Context } from '../context/types.js';
import type { ToolPipelineExecutor } from './pipeline.js';

/** ctx.tools 服务面（契约篇 §1.5 服务行；接口单一来源在 contracts——本文件实现） */
export type { ToolsService } from '../contracts/tools.js';

/** 注册表选项 */
export interface ToolRegistryOptions {
  /** 工具执行管道（缺省不接——注册出的 AgentTool 执行会响亮失败，装配层必须接） */
  pipeline?: ToolPipelineExecutor;
}

/**
 * v1 注入模式最小词表（契约篇 §3.2 描述扫描——2026-08-26 轮九 #27 修法）。
 * 描述是进模型上下文的文本：`curl … | sh` 形态 = 让模型照描述执行任意下载，
 * 是描述面执行漏洞（轮九实证：外部服务器描述原样注册即可被调）。
 * 词表随真实生态扩充——规范只钉「注册面扫描」这个位置，不在此堆正则。
 */
const DESCRIPTION_INJECTION_PATTERNS: readonly RegExp[] = [/\b(curl|wget)\b[^\n|]*\|[^\n]*\b(ba|z|da)?sh\b/i];

/**
 * 扫描工具描述是否命中注入模式（注册面统一防线——任何来源的工具同一执法）。
 * @returns 命中的模式串（用于错误归因）；干净描述返回 undefined
 */
export function scanToolDescription(description: string): string | undefined {
  for (const pattern of DESCRIPTION_INJECTION_PATTERNS) {
    if (pattern.test(description)) return pattern.source;
  }
  return undefined;
}

/**
 * 组装工具注册表并挂进 ctx（provide('tools')，随作用域回卷）。
 * app 装配层调用一次；插件作用域经 ctx.get 共享同一注册表。
 */
export function registerToolsService(ctx: Context, opts: ToolRegistryOptions = {}): ToolsService {
  /** 工具表：name → 定义（Map 保注册序） */
  const tools = new Map<string, ToolDefinition>();

  const service: ToolsService = {
    register(def) {
      if (tools.has(def.name)) {
        // 同名重复注册 = 装配冲突（两行注册同一工具），响亮失败不静默覆盖
        throw new AppError(TOOL_DUPLICATE, `工具重复注册：${def.name}`);
      }
      // 描述扫描（契约篇 §3.2，2026-08-26）：任何来源的工具同一防线——
      // 第三方插件与 MCP 外部工具的风险同源，防线在树上不在枝上
      const injectionHit = scanToolDescription(def.description);
      if (injectionHit !== undefined) {
        throw new AppError(
          TOOL_DESCRIPTION_REJECTED,
          `工具描述命中注入模式（/${injectionHit}/）：${def.name}——描述是进模型上下文的文本，拒绝注册`,
        );
      }
      // 读写性归一（契约篇 §3.1，2026-08-24 第十一批）：未声明 effect 按 'write'
      // 保守处理——只读类守门策略不放过未声明工具（fail-closed 方向）。存归一副本，
      // 注销身份护栏随迁到副本（对调用方原对象零改动）。
      const normalized: ToolDefinition = { ...def, effect: def.effect ?? 'write' };
      tools.set(def.name, normalized);
      ctx.emit(TOOLS_CHANGE_EVENT, { kind: 'add', name: def.name });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        // 仅当仍是本定义时删除（防误撤他者后来的同位注册——与 provide 同款护栏）
        if (tools.get(def.name) === normalized) {
          tools.delete(def.name);
          ctx.emit(TOOLS_CHANGE_EVENT, { kind: 'remove', name: def.name });
        }
      };
    },

    get(name) {
      return tools.get(name);
    },

    list() {
      return [...tools.values()];
    },

    toAgentTool(def) {
      const pipeline = opts.pipeline;
      return {
        name: def.name,
        description: def.description,
        label: def.label,
        parameters: def.parameters,
        // 执行全走三段管道（工具执行唯一合法路径——绕管道直调 execute 即违规）
        execute: async (toolCallId, args, signal, onUpdate) => {
          if (!pipeline) {
            // 管道是执行唯一合法路径：未装配即调 = 装配层缺陷，响亮失败
            throw new AppError(
              CONTEXT_SERVICE_NOT_FOUND,
              `[CONTEXT_SERVICE_NOT_FOUND] 工具管道未装配（registerToolsService 缺 pipeline 选项）`,
            );
          }
          return pipeline(def, toolCallId, args, signal, onUpdate);
        },
      };
    },
  };

  ctx.provide('tools', service);
  return service;
}

/**
 * defineTool 类型 helper（插件契约篇 §3.1：ctx.tools.defineTool 定义工具）。
 * identity 函数——只为让插件侧书写时获得 parameters/execute 的完整类型检查。
 */
export function defineTool<T extends ToolDefinition>(def: T): T {
  return def;
}
