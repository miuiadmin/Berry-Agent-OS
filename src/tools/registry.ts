/**
 * L2 tools — 工具注册表（ctx.tools 服务；插件契约篇 §3.2 动态注册）。
 *
 * 职责：
 * - register(ToolDefinition, opts?) → Disposer：即时生效（刷新注册表 → 广播
 *   tools_change → 下次模型请求即见新工具；无需 reload）；
 * - 把 ToolDefinition 适配成 loop 面的 AgentTool（execute = 三段管道）；
 * - defineTool 类型 helper（插件侧获得参数/结果类型推断）。
 *
 * 两层注册表（S2 契约篇 §3.2，2026-08-26）：
 * - 全局层：单表 Map（缺省注册面——全部会话可见）；
 * - 域层：`Map<域键, Map<name, def>>`（携带 `domain` 键注册——组合域 = 应用
 *   清单声明的工具面运行时投影；v1 域键 = sessionId interim）。
 * - 查重**双向对称**：域层注册查「全局层 ∪ 本域」；全局层注册查「全局层 ∪
 *   全部活域」——防 mcp 后台异步落全局层与已注册域层同名，listFor 面出双名。
 * - 注册表本体**随组合根构造存续**（本服务挂 ring1 锚，/reload 不回卷）；
 *   域层条目生死挂调用方（chat 件 DriverEntry——open 注册、retire 回卷）。
 * - tools_change 载荷 `{ kind, name, domain? }`：带键 = 域层变更（只影响该域
 *   的 listFor 面）；缺省 = 全局层变更（影响全部域的 listFor 面）。
 *
 * 注册经 ctx.provide('tools', …) 挂进服务注册表，随作用域 LIFO 回卷；
 * 注销器同时撤注册表条目（幂等）。
 */

import {
  AppError,
  CONTEXT_SERVICE_NOT_FOUND,
  TOOL_DESCRIPTION_REJECTED,
  TOOL_DUPLICATE,
  TOOL_REGISTRY_LIMIT,
  TOOL_REGISTRY_RATE,
  TOOL_TIMEOUT_INVALID,
} from '../contracts/errors.js';
import type { AgentTool, ToolDefinition, ToolsService } from '../contracts/tools.js';
import { TOOLS_CHANGE_EVENT } from '../contracts/tools.js';
import { RateLimiter } from '../context/rate-limit.js';
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
 * 插件面注册 timeoutMs 下限（毫秒——契约篇 §1.6 注册预算下限，2026-08-27 刀〇a）：
 * 正数过小钳至此值（存归一副本），<= 0 拒绝（TOOL_TIMEOUT_INVALID）。
 * 「0 = 自管取消」语义保留给宿主内部合成 def（exec 内部 def 不经注册面——
 * 事实豁免通道，冷读 CR-2-F9 裁决）。
 */
export const TOOL_TIMEOUT_FLOOR_MS = 1000;

/**
 * 两层注册表合计件数帽（契约篇 §1.6 资源护栏族 #10①，2026-08-27 刀〇b）：
 * 全局层 + 全部域层求和。良性行为距阈值两个数量级（官方全家桶 ~10¹ 量级），
 * 超限 = 失控或泄漏，fail-loud 拒绝而非静默顶住。
 */
const REGISTRY_TOTAL_LIMIT = 1_000;
/**
 * register/unregister 变更频率桶（#10②）：容量 120 吃下单次 /reload 全量重注册
 * 突发（MCP 在场 ~60-80 op）；回填 600/min = 10 op/s 持续供给，热迭代
 * （30-40s 一 reload + 会话开关注册）不触顶，武器化（>10/s 持续）容量耗尽即拦。
 * 全局键——registry 无 scope 概念（冷读确认，不为频率帽引入 scope）。
 */
const REGISTRY_RATE: Readonly<{ capacity: number; perMinute: number }> = { capacity: 120, perMinute: 600 };

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
  /** 全局层：name → 定义（Map 保注册序——全部会话可见的注册面） */
  const tools = new Map<string, ToolDefinition>();
  /** 域层：域键 → (name → 定义)（组合域分片——仅该域 listFor 面可见；Map 保注册序） */
  const domains = new Map<string, Map<string, ToolDefinition>>();
  /** 注册面打点（B2 P5）：开机以来累计注册/注销次数（高频注册武器化监控数据源） */
  let totalAdds = 0;
  let totalRemoves = 0;
  /** 变更频率桶（#10②）：register 侧 fail-loud 先于变更；unregister 侧见注销器内注 */
  const changeRate = new RateLimiter(REGISTRY_RATE);

  const service: ToolsService = {
    // 管道执行器随服务携带（Ring 1 行树化批）：bash 工具与 ctx.exec 两层并存
    // 时经它同源——无管道诊断形态为 undefined（toAgentTool 执行响亮失败）
    executor: opts.pipeline,
    register(def, registerOpts) {
      // 描述扫描（契约篇 §3.2，2026-08-26）：任何来源的工具同一防线——
      // 第三方插件与 MCP 外部工具的风险同源，防线在树上不在枝上
      const injectionHit = scanToolDescription(def.description);
      if (injectionHit !== undefined) {
        throw new AppError(
          TOOL_DESCRIPTION_REJECTED,
          `工具描述命中注入模式（/${injectionHit}/）：${def.name}——描述是进模型上下文的文本，拒绝注册`,
        );
      }
      // 注册面预算下限执法（§1.6 时钟族之四，2026-08-27 刀〇a）：<= 0 拒绝——
      // 拒绝式而非钳到 0：钳制会静默改变行为（插件以为 0 = 无预算，长任务被杀
      // 还以为自管取消有效）。0 的自管取消语义保留给宿主内部合成 def（不经本面）
      if (def.timeoutMs !== undefined && def.timeoutMs <= 0) {
        throw new AppError(
          TOOL_TIMEOUT_INVALID,
          `工具 ${def.name} timeoutMs <= 0（${def.timeoutMs}）——插件面注册不许自管取消语义；` +
            `不设预算请省略该字段（走管道缺省 60s），正数过小将钳至 ${TOOL_TIMEOUT_FLOOR_MS}ms 下限`,
        );
      }
      // 读写性归一（契约篇 §3.1，2026-08-24 第十一批）：未声明 effect 按 'write'
      // 保守处理——只读类守门策略不放过未声明工具（fail-closed 方向）。存归一副本，
      // 注销身份护栏随迁到副本（对调用方原对象零改动）；timeoutMs 正数过小同副
      // 本钳至下限（§1.6：500ms 类微小预算 = 变相自杀钟，钳而非拒——值仍合法）。
      const normalized: ToolDefinition = {
        ...def,
        effect: def.effect ?? 'write',
        ...(def.timeoutMs !== undefined ? { timeoutMs: Math.max(def.timeoutMs, TOOL_TIMEOUT_FLOOR_MS) } : {}),
      };
      const domainKey = registerOpts?.domain;
      let layer: Map<string, ToolDefinition>;
      if (domainKey !== undefined) {
        // 域层注册：查重 = 全局层 ∪ 本域（双向对称的域侧半边）
        const existing = domains.get(domainKey);
        layer = existing !== undefined ? existing : new Map();
        if (existing === undefined) domains.set(domainKey, layer);
        if (tools.has(def.name) || layer.has(def.name)) {
          throw new AppError(
            TOOL_DUPLICATE,
            `工具重复注册：${def.name}（域 ${domainKey}；与全局层或本域已有工具同名）`,
          );
        }
      } else {
        // 全局层注册：查重 = 全局层 ∪ **全部活域**（双向对称的全局侧半边——mcp
        // 后台异步落全局层晚于驱动域注册是真实时序，单向查重会在 listFor 面出双名）
        for (const [key, layerTools] of domains) {
          if (layerTools.has(def.name)) {
            throw new AppError(
              TOOL_DUPLICATE,
              `工具重复注册：${def.name}（与活域 ${key} 的域层工具同名——全局层注册须避开全部活域）`,
            );
          }
        }
        if (tools.has(def.name)) {
          throw new AppError(TOOL_DUPLICATE, `工具重复注册：${def.name}`);
        }
        layer = tools;
      }
      /* ---- 资源护栏族 #10 双帽（契约篇 §1.6，2026-08-27 刀〇b）----
       * 查重等既有拒绝先过（不消耗频率配额——拼错重试不被限流噪音掩盖），
       * 双帽随后、layer.set 之前：任一拒绝都不留半套注册状态。 */
      // ①总量帽：两层注册表合计（失控或泄漏——良性行为距阈值两个数量级）
      let registered = tools.size;
      for (const domainLayer of domains.values()) registered += domainLayer.size;
      if (registered >= REGISTRY_TOTAL_LIMIT) {
        throw new AppError(
          TOOL_REGISTRY_LIMIT,
          `工具注册表合计已达上限 ${REGISTRY_TOTAL_LIMIT}（全局层 ${tools.size} + 域层 ${registered - tools.size}；契约篇 §1.6 资源护栏族 #10）`,
        );
      }
      // ②变更频率帽：register/unregister 合计令牌桶（R4 高频注册武器化 header 快照）
      if (!changeRate.tryCharge('registry')) {
        throw new AppError(
          TOOL_REGISTRY_RATE,
          `工具注册/注销变更超频：${def.name}（令牌桶：突发上限 ${REGISTRY_RATE.capacity}、回填 ${REGISTRY_RATE.perMinute}/min；` +
            `每次变更触 tools_change 快照广播，fail-loud 拒绝非静默丢弃——热迭代节奏不受影响，契约篇 §1.6 #10）`,
        );
      }
      layer.set(def.name, normalized);
      totalAdds += 1;
      // 载荷带域键 = 域层变更（装配层只刷该域的面）；缺省 = 全局层变更（刷全部）
      ctx.emit(TOOLS_CHANGE_EVENT, {
        kind: 'add',
        name: def.name,
        ...(domainKey !== undefined ? { domain: domainKey } : {}),
      });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        // 仅当仍是本定义时删除（防误撤他者后来的同位注册——与 provide 同款护栏）
        if (layer.get(def.name) === normalized) {
          layer.delete(def.name);
          totalRemoves += 1;
          // 域层清空即拆层（活域集合收缩——全局层查重的遍历面随之收窄）
          if (layer !== tools && layer.size === 0 && domains.get(domainKey!) === layer) {
            domains.delete(domainKey!);
          }
          ctx.emit(TOOLS_CHANGE_EVENT, {
            kind: 'remove',
            name: def.name,
            ...(domainKey !== undefined ? { domain: domainKey } : {}),
          });
          /* 变更频率帽 unregister 侧计费（#10②）：删除与广播先行、计费殿后——
           * 注销器可能在作用域回卷路径跑（dispose 内同步循环），此处抛错会被
           * 回卷异常隔离吞成日志，若计费在先则「删除没做成但配额已耗」留下
           * 半套状态；殿后则不变式完整（集变更即快照），桶满仅记 error。 */
          if (!changeRate.tryCharge('registry')) {
            ctx.logger.error(
              `工具注册/注销变更超频（unregister 侧：${def.name}）——桶容量 ${REGISTRY_RATE.capacity}/回填 ${REGISTRY_RATE.perMinute} 每 min，` +
                `本次已照常删除广播（回卷路径计费只记不阻）；后续 register 将被 fail-loud 拒绝（契约篇 §1.6 #10）`,
            );
          }
        }
      };
    },

    get(name) {
      // 全局层同口径：只查全局层（域层工具按名直达 = 绕过组合域投影，不开此面）
      return tools.get(name);
    },

    list() {
      return [...tools.values()];
    },

    listFor(domainKey) {
      // 域视角 = 全局层 ∪ 该域层（未知域键 = 空域层，只返回全局层——合法形态）
      const layer = domains.get(domainKey);
      return layer === undefined ? [...tools.values()] : [...tools.values(), ...layer.values()];
    },

    toAgentTool(def, bindOpts) {
      // 执行绑定面（S5 冷读闸 F2）：显式注入优先（驱动 fresh 作用域管道），
      // 缺省回落服务构造时的全局管道——既有调用点（子工厂/诊断面）零改动
      const pipeline = bindOpts?.pipeline ?? opts.pipeline;
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

    stats() {
      // 现存件数 = 全局层 + 全部域层求和（不缓存——查询低频且各层 Map 已是常量级遍历）
      let registered = tools.size;
      for (const layer of domains.values()) registered += layer.size;
      return { registered, totalAdds, totalRemoves };
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
