/**
 * L5 app — 官方件 `builtin:desktop`（Ring 1 第三行，第八十五批批 C「系统桌面
 * TUI」——契约篇 §6.11 换防机制 + 骨架篇 boot 序）。
 *
 * 件本体 = 桌面服务面（ctx 键 `desktop`）的构造 + provide。**与 channels 行同款
 * 律：树化的是「桌面服务面」不是「桌面后端」**——桌面壳后端（desktop-shell.ts，
 * 持引擎与渲染树）由宿主入口（desktop-main.ts）持有与起停，不入行；服务消费者
 * （通道 Esc 回桌面 / /desktop 命令）只认 ctx 键，后端 attach 时点由入口编排。
 *
 * 本文件**零引擎 import**（不 import src/desktop/ 任何件）——Ring 1 行装载不
 * 依赖渲染引擎在场。「桌面引擎两连崩熔断回锁内核 shell 后，行与服务面仍活着、
 * /desktop 重试动词仍可达」是熔断语义的结构前提：回锁锁的是**起屏**不是**装载**。
 */

import type { BuiltinAppModule, AppContext } from '../contracts/app.js';
import type { Context } from '../context/types.js';

/**
 * 桌面应用清单条目（壳层投影——装载面的只读投影视图，非第二真相源）。
 * 生产方 = 宿主入口（desktop-main）从 runtime.apps / appGaps / appsService
 * 组合投影；消费方 = 桌面壳渲染树与内核 shell /apps 命令。
 */
export interface DesktopAppEntry {
  /** 应用 id（清单/装机 id 同源） */
  readonly id: string;
  /** 人读名（清单 label；装机行无 label 时回落 id） */
  readonly label: string;
  /** 分组：official = 官方随包 / thirdparty = 第三方装机 */
  readonly group: 'official' | 'thirdparty';
  /** 可进入（false = 只读展示：组件缺场 / 已装未挂载等） */
  readonly openable: boolean;
  /** 不可进入/特殊态的一行说明（缺省无） */
  readonly note?: string;
  /** 当前默认解析位标记（无 app 会话打开的目标域——清单面即见默认落谁家） */
  readonly isDefault?: boolean;
}

/** 桌面回接结果（应用视图 → 桌面换防的执行回执） */
export type DesktopBackResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * 桌面回接面（壳 backend 挂进服务的实现面）：应用视图态下「回桌面」的换防
 * 编舞入口——pi-tui 停屏（preserveScreen）→ 引擎复位全量重绘。消费者（通道
 * Esc 钩子 / /desktop 命令）只调服务，不持壳引用。
 */
export interface DesktopFace {
  /** 回桌面（换防序：先还屏再复位引擎——序在壳内单源） */
  backToDesktop(): DesktopBackResult;
}

/**
 * ctx `desktop` 服务面（Ring 1 行 provide——命令面与通道的公共路由点）。
 * holder 形态：行 apply 期构造空壳，宿主入口起屏后 attach 真身；两连崩熔断
 * 回锁期无 attach（backToDesktop 诚实报错，不静默）。
 */
export interface DesktopService {
  /** 挂回接面（宿主入口起屏后调；重复 attach 后者胜） */
  attach(face: DesktopFace): void;
  /** 摘回接面（壳终退时调——此后 backToDesktop 报「桌面不在场」） */
  detach(): void;
  /** 回桌面路由（无 attach = 桌面不在场，ok:false 诚实告知） */
  backToDesktop(): DesktopBackResult;
}

/** 构造桌面服务 holder（行 apply 期调用——真身晚挂） */
export function createDesktopService(): DesktopService {
  let face: DesktopFace | undefined;
  return {
    attach(next: DesktopFace): void {
      face = next;
    },
    detach(): void {
      face = undefined;
    },
    backToDesktop(): DesktopBackResult {
      if (face === undefined) {
        return { ok: false, error: '桌面不在场（未起屏或已熔断回锁）——/desktop 在桌面形态下才有意义' };
      }
      return face.backToDesktop();
    },
  };
}

/**
 * 构造 desktop 官方件模块引用（builtins 注册表 `builtin:desktop` 行——Ring 1
 * 必备行，overlay 禁用即启动断言拒启）。apply 在行作用域（ring1Anchor 派生）
 * 执行一次：构造服务 holder 并 provide 进系统区表（boot 后对根与全部装载行
 * 经系统区表读链可见）。零闭包依赖（BuiltinRegistryOptions 零新字段——obs 件
 * 之后的第二个零 deps 官方行）。
 */
export function createDesktopApp(): BuiltinAppModule {
  return {
    name: 'desktop',
    apply: (ctx: AppContext) => {
      // AppContext 是第三方零信任窄面；宿主件实参是完整 fork 作用域（tools/
      // channels 行同款还原断言——窄面 → 实参真身，非跨信任边界断言）
      const scope = ctx as Context;
      scope.provide('desktop', createDesktopService());
    },
  };
}
