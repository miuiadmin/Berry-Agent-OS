/**
 * L2 tools — 官方件 `builtin:tools`（Ring 1 行树化第一刀，契约篇 §5.1 节奏表：
 * tools 行起算，「装什么/在哪」进组合树，「怎么装」仍是本模块机制）。
 *
 * 件本体 = 原组合根 ⑤ 硬装配整体入列：三段管道构造 + ctx.tools 服务注册 +
 * 检索族 find/grep 注册（无状态——dsh-10 边界三判①「无会话状态的机制」走全局
 * 层共享）。宿主消费方（⑥b exec 服务、⑧ 工具快照接线、chat 件 writeHeader/
 * toolView 首帧）一律经 ctx 取服务面——服务携带 executor（管道执行器），行替换
 * 件换了管道则 bash 工具与 ctx.exec 两层一起换（同源同过守门，拍板 16「两层
 * 并存同源」的落码形态）。
 *
 * fs 族迁域（S2 契约篇 §3.2 / 骨架篇 §7.5，2026-08-26）：read/write/edit/ls
 **有观察态**（per-driver 语义——每个驱动的「读过什么」互不可见），不再由本行
 * 全局注册，改随 chat 件每驱动 open() 带本会话域键注册（域层）——可写根推导
 * 器/workspace 随迁 chat 件 deps。本行只剩无状态面。
 *
 * 装载结构（契约篇 §5.1 /reload 语义钉死）：本行挂宿主装配期专用锚
 * （ring1Anchor，与插件锚分离）——/reload 只 dispose 插件锚，Ring 1 行不回
 * 卷不重装载，仅 boot 生效；合成结果变化由组合根在 composition/reloaded
 * 载荷报告「需重启生效」。工具注册表两层本体（全局层 + 域层）随本服务构造
 * 存续：/reload 只回卷插件锚上的全局层条目（memory/exec/web 等行重注册），
 * 域层 fs 条目挂 chat 件 DriverEntry 不受影响（活驱动工具面跨 /reload 存续）。
 */

import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import type { GateDecisionSink } from '../contracts/tools.js';
import type { Context } from '../context/types.js';
import { createToolPipeline } from './pipeline.js';
import { registerToolsService } from './registry.js';
import { createSearchTools } from './search.js';

/** 件构造依赖（装配期活闭包——官方件 = 宿主装配特权，不新开 ctx 服务名） */
export interface ToolsPluginDeps {
  /** gate/decision durable 落点（组合根转发壳 .gate——会话绑定随壳热切换，件绑定后落账生效） */
  readonly gateSink: GateDecisionSink;
  /** 工作区根活取值（检索族 find/grep 路径锚） */
  readonly workspace: () => string;
}

/**
 * 构造 tools 官方件模块引用（builtins 注册表 `builtin:tools` 行——Ring 1
 * 必备行，overlay 禁用即启动断言拒启）。apply 在行作用域（ring1Anchor 派生）
 * 执行一次：构造管道 → 注册服务 → 注册检索族（fs 族已迁域，见件头注）。
 */
export function createToolsPlugin(deps: ToolsPluginDeps): BuiltinPluginModule {
  return {
    name: 'tools',
    apply: (ctx: PluginContext) => {
      // PluginContext 是第三方零信任窄面；装载器实参是完整 fork 作用域（ContextScope
      // ——Context 真子类型）。件内构造内核机制（管道/服务注册）按内核签名要完整
      // Context——宿主自家件拿到的是宿主自己的作用域，此处断言是「窄面 → 实参真身」
      // 的还原，非跨信任边界的外部输入断言
      const scope = ctx as Context;
      // 三段管道（工具执行唯一合法路径）：守门段监听挂行作用域（ring1Anchor
      // boot 期装载、随 ctx 关停 LIFO 回卷）；安全栈守门行在组合根 ⑥ 经根
      // ctx prepend 占守门段首位——与本处互不相扰
      const pipeline = createToolPipeline(scope, { onGateDecision: deps.gateSink });
      // ctx.tools 服务（executor 携带管道——服务注册表同根共享，ring1 锚
      // provide 对后续装载行与宿主装配段全局可见）
      const tools = registerToolsService(scope, { pipeline });
      // 检索族 find/grep（只读无 fence 需求——读任意位置允许，与 read 工具同
      // 口径；无会话状态，全局层注册共享）
      const searchTools = createSearchTools({ workspace: deps.workspace });
      for (const def of searchTools.tools) tools.register(def);
    },
  };
}
