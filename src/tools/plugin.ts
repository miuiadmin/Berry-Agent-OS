/**
 * L2 tools — 官方件 `builtin:tools`（Ring 1 行树化第一刀，契约篇 §5.1 节奏表：
 * tools 行起算，「装什么/在哪」进组合树，「怎么装」仍是本模块机制）。
 *
 * 件本体 = 原组合根 ⑤ 硬装配整体入列：三段管道构造 + ctx.tools 服务注册 +
 * fs 工具族/检索族注册。宿主消费方（⑥b exec 服务、⑧ 工具快照接线、chat 件
 * writeHeader/toolView 首帧）一律经 ctx 取服务面——服务携带 executor（管道
 * 执行器），行替换件换了管道则 bash 工具与 ctx.exec 两层一起换（同源同过
 * 守门，拍板 16「两层并存同源」的落码形态）。
 *
 * 装载结构（契约篇 §5.1 /reload 语义钉死）：本行挂宿主装配期专用锚
 * （ring1Anchor，与插件锚分离）——/reload 只 dispose 插件锚，Ring 1 行不回
 * 卷不重装载，仅 boot 生效；合成结果变化由组合根在 composition/reloaded
 * 载荷报告「需重启生效」。
 */

import type { BuiltinPluginModule, PluginContext } from '../contracts/plugin.js';
import type { GateDecisionSink } from '../contracts/tools.js';
import type { Context } from '../context/types.js';
import { createToolPipeline } from './pipeline.js';
import { registerToolsService } from './registry.js';
import { createFsTools } from './fs.js';
import { createSearchTools } from './search.js';

/** 件构造依赖（装配期活闭包——官方件 = 宿主装配特权，不新开 ctx 服务名） */
export interface ToolsPluginDeps {
  /** gate/decision durable 落点（组合根转发壳 .gate——会话绑定随壳热切换，件绑定后落账生效） */
  readonly gateSink: GateDecisionSink;
  /**
   * 可写根推导器（safety/roots 同源产物——宿主构造注入。tools 不 import
   * safety：拓扑单向 safety→tools，反向即环；fence 与守门行两层正交同源
   * 〔根推导函数〕由宿主单点接线）
   */
  readonly writableRoots: () => string[];
  /** 工作区根活取值（fs 工具族路径锚） */
  readonly workspace: () => string;
}

/**
 * 构造 tools 官方件模块引用（builtins 注册表 `builtin:tools` 行——Ring 1
 * 必备行，overlay 禁用即启动断言拒启）。apply 在行作用域（ring1Anchor 派生）
 * 执行一次：构造管道 → 注册服务 → 注册工具族。
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
      // fs 工具族（fence 走注入的可写根推导器——与守门行同源）+ 检索族
      // find/grep（只读无 fence 需求——读任意位置允许，与 read 工具同口径）
      const fsTools = createFsTools({ writableRoots: deps.writableRoots, workspace: deps.workspace });
      const searchTools = createSearchTools({ workspace: deps.workspace });
      for (const def of [...fsTools.tools, ...searchTools.tools]) tools.register(def);
    },
  };
}
