/**
 * L4 channels — 官方件 `builtin:channels`（Ring 1 第二行树化，契约篇 §6.8
 * Web 通道第一刀；tools 行先例同构）。
 *
 * 件本体 = 原组合根 ② 硬装配整体入列：ctx.channels / ctx.ui 两服务构造 +
 * provide。**树化的是「通道服务面」不是「终端后端」**——TUI 后端（pi-tui
 * 实例）本体不入行：宿主入口（tui-main）持终端与进程生命周期，attach 时点
 * 与形态不变（服务消费者只认 ctx 键，行 provide 后入口零改动）。
 *
 * /reload 语义（Ring 1 行既有律）：本行挂宿主装配期专用锚（ring1Anchor），
 * /reload 不回卷不重装载仅 boot 生效。前锚消费者（chat 件 confirm/select
 * 装配闭包）经组合根 let 实体延迟绑定（M4 勘正——chatBundle 构造点早于
 * ring1 装载锚，闭包体引用后赋值变量，调用时点恒在装载后）。
 */

import type { BuiltinAppModule, AppContext, RowAppProbe } from '../contracts/app.js';
import type { Context } from '../context/types.js';
import { registerChannelServices } from './service.js';

/** 件构造依赖（装配期活闭包——官方件 = 宿主装配特权，不开新 ctx 服务名；ToolsAppDeps 先例同型） */
export interface ChannelsAppDeps {
  /**
   * UI 广播异常诊断回调（组合根接 ctx.logger——坏后端异常「有信号」不静默
   * 吞；隔离案一第一刀 #3）。缺省不传 = 无诊断面（纯测试形态）
   */
  readonly onUiError?: (err: unknown, op: 'notify' | 'setStatus') => void;
  /**
   * 行挂载目标投影（D1 应用行命令拒载执法探针，契约篇 §5.1 注册面路由）：
   * 组合根维护的活闭包，构造时点先于组合树合成无碍。**缺省不传 = D1 执法
   * 静默回归**（冷读 M2 勘正——真装配恒传）
   */
  readonly rowApp?: RowAppProbe;
}

/**
 * 构造 channels 官方件模块引用（builtins 注册表 `builtin:channels` 行——
 * Ring 1 必备行，overlay 禁用即启动断言拒启）。apply 在行作用域
 * （ring1Anchor 派生）执行一次：构造两服务并 provide 进系统区表。
 */
export function createChannelsApp(deps: ChannelsAppDeps): BuiltinAppModule {
  return {
    name: 'channels',
    apply: (ctx: AppContext) => {
      // AppContext 是第三方零信任窄面；宿主件实参是完整 fork 作用域（tools 行
      // 同款还原断言——窄面 → 实参真身，非跨信任边界断言）
      const scope = ctx as Context;
      // 两服务构造 + provide（service.ts 便捷装配单入口——onUiError 诊断 +
      // rowApp 探针两 deps 原样透传；provide 随行作用域 LIFO 回卷，boot 后
      // 对根与全部装载行经系统区表读链可见）
      registerChannelServices(scope, {
        ...(deps.onUiError !== undefined ? { onUiError: deps.onUiError } : {}),
        ...(deps.rowApp !== undefined ? { rowApp: deps.rowApp } : {}),
      });
    },
  };
}
