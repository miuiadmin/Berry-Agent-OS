/**
 * L3 goal — goal↔chat↔lsp↔scheduler 组合根闭包注入通道（骨架篇 §6.8 计划态
 * 跨轮条 / gates 条 / 刀四挂钟条，冷读 CR-11 / CR-12 / CR-7 裁定的落码面）。
 *
 * 为什么需要它：goal-scoped fold 住 chat 件（§6.7 落码面）、激活锚与
 * needsWrite 住 goals 表（goal 件私有）、LSP 诊断查询住 lsp 件 apply 闭包
 * （实例簿私有）、挂钟任务面住 scheduler 件 apply 闭包（JobsStore 私有）
 * ——四件两两之间**零拓扑边零服务面**，唯一通道 = 组合根创建本对象、闭包
 * 注入各件 deps（DiscoveryGates 数据面闭包注入同构先例）。
 *
 * 生命周期：goal 件 apply 期注册 goalScopeFor（随 ctx.effect 锚回卷摘除）；
 * chat 件 apply 期注册 todoFold 查询；lsp 件 apply 期注册诊断查询、scheduler
 * 件 apply 期挂 goal 挂钟面（两者皆迟到注入——行装载后回填）。/reload 重
 * 装载 = 锚回卷后 re-apply 重注册，通道对象本体由组合根持有跨重装载存续。
 * 任一侧缺席 = 查询恒 miss（undefined），消费方各自诚实降级：
 *   - goalScopeFor miss → fold 退化 run-scoped 现行为、gates 判 goal 段缺席；
 *   - todoFoldFor miss → goal 计划态投影 / open 项否决降级跳过；
 *   - diagnosticsFor miss → gate kind='diagnostics' 申报即拒（fail-closed）；
 *   - schedulerFaceFor miss → /goal wake 响亮拒绝「scheduler 未装载」。
 */

import type { Disposer } from '../context/types.js';

/**
 * goal 段信息（goal 件 → chat 件：fold 边界与 gates 判段的数据面）。
 * 仅 active 行在场时返回（undefined = 非 goal 段——goal 件未装载/已卸/无
 * active 行三态同面）；activatedSeq NULL（存量行不可考）= 消费方诚实降级
 * run-scoped（拍板形态）。
 */
export interface GoalScopeInfo {
  /** 恒 true——字段保留为窄面自文档（查询返回即 active 行在场） */
  readonly active: true;
  /** 激活锚（激活/resume 重绑时的会话日志长度——seq 连续性契约下 = 位置） */
  readonly activatedSeq: number | null;
  /** 写面开洞申报（command gate 准入判据——申请→批准→守门同构） */
  readonly needsWrite: boolean;
}

/**
 * todo fold 条目（chat 件 → goal 件的计数面结构子集）：goal 只消费 status /
 * gate 在场性 / 复活条件，不依赖 chat 的完整 TodoItem 形状（结构兼容——两件
 * 各持词面，组合根接线点编译期即验）。
 */
export interface TodoFoldItem {
  /** 条目状态四值（pending / in_progress / completed / deferred） */
  readonly status: string;
  /** 复活条件原文（deferred 项必携——刀三到窗复评的判据面） */
  readonly resumeWhen?: string;
  /** 完成判据声明在场性（kind 词面仅计数用——验证执法在 chat 执行段） */
  readonly gate?: { readonly kind: string };
  /** 条目写入时刻（fold 投影字段——相对形 resumeWhen 的判窗锚；缺席 = 相对形不可判） */
  readonly writtenAt?: number;
}

/**
 * LSP 诊断查询单文件结果（lsp 件 → chat gates 的原始数据面——分类判断在
 * gates 验证器，件零表知识纪律）：
 * - 'ok'：诊断已回流（errors = error 级〔severity 1〕条目，空 = 绿）；
 * - 'missing'：文件不在盘上；
 * - 'malformed'：路由外 / 根外 / 服务器不可用 / 诊断未及回流（判据面不可用族）。
 */
export interface GateDiagnosticsFile {
  /** 工作区相对路径（原样回显） */
  readonly path: string;
  readonly outcome: 'ok' | 'missing' | 'malformed';
  /** 失败说明（outcome ≠ 'ok' 时的人读细节） */
  readonly note?: string;
  /** error 级诊断条目（1-based 行号 + 消息） */
  readonly errors: readonly { readonly line?: number; readonly message: string }[];
}

/**
 * goal 挂钟任务面（scheduler 件 → goal 件的消费面，刀四 CR-7 结构同形窄化
 * ——真身在 scheduler/app.ts GoalJobsFace，此处词面独立、零 import，接线点
 * 在组合根 builtins.ts 编译期即验结构兼容）。
 */
export interface GoalSchedulerFace {
  /** 挂钟/重挂（schedule 坏串 → {ok:false, message} 响亮拒绝） */
  register(input: {
    readonly goalId: string;
    readonly sessionId: string;
    readonly schedule: string;
    readonly promptSnapshot: string;
  }): Promise<{ readonly ok: boolean; readonly message: string }>;
  /** 终态/降级同笔停摆（行留史 OS 保留；无行 = 静默 no-op） */
  disable(goalId: string): Promise<void>;
  /** resume/重挂复活（无行 = 静默 no-op） */
  enable(goalId: string): Promise<void>;
  /** 摘钟（删行 + OS 注销；无行 = 静默 no-op） */
  remove(goalId: string): Promise<void>;
}

/**
 * goal↔chat↔lsp↔scheduler 四方通道（组合根创建、闭包注入——见文件头注记）。
 * 全部方法同步注册异步查询；注册返回摘除器（幂等——同函数重复摘除 no-op）。
 */
export class GoalChannel {
  /** goal 件注册的 goal 段查询（apply 挂 / 锚回卷摘） */
  private goalScopeQuery?: (sessionId: string) => GoalScopeInfo | undefined;
  /** chat 件注册的 todo fold 查询（apply 挂 / 锚回卷摘） */
  private todoFoldQuery?: (sessionId: string) => readonly TodoFoldItem[] | null | undefined;
  /** chat 件注册的 wake 归因查询（apply 挂 / 锚回卷摘——刀三轮身份反向腿） */
  private wakeLookupQuery?: (sessionId: string) => Readonly<Record<string, string>> | undefined;
  /** lsp 件注册的诊断查询（apply 挂 / 锚回卷摘——迟到注入） */
  private diagnosticsQuery?: (paths: readonly string[]) => Promise<readonly GateDiagnosticsFile[]>;
  /** scheduler 件挂的 goal 挂钟面（apply 挂 / 行回卷摘——刀四迟到注入） */
  private schedulerFace?: GoalSchedulerFace;

  /** goal 件 apply 期注册 goal 段查询（返回摘除器——挂 ctx.effect） */
  registerGoalScope(query: (sessionId: string) => GoalScopeInfo | undefined): Disposer {
    this.goalScopeQuery = query;
    return () => {
      if (this.goalScopeQuery === query) this.goalScopeQuery = undefined;
    };
  }

  /** chat 件 apply 期注册 todo fold 查询（返回摘除器——挂 ctx.effect） */
  registerTodoFold(query: (sessionId: string) => readonly TodoFoldItem[] | null | undefined): Disposer {
    this.todoFoldQuery = query;
    return () => {
      if (this.todoFoldQuery === query) this.todoFoldQuery = undefined;
    };
  }

  /** chat 件 apply 期注册 wake 归因查询（返回摘除器——挂 ctx.effect；刀三） */
  registerWakeLookup(query: (sessionId: string) => Readonly<Record<string, string>> | undefined): Disposer {
    this.wakeLookupQuery = query;
    return () => {
      if (this.wakeLookupQuery === query) this.wakeLookupQuery = undefined;
    };
  }

  /** lsp 件 apply 期注册诊断查询（返回摘除器——挂 ctx.effect） */
  registerDiagnostics(query: (paths: readonly string[]) => Promise<readonly GateDiagnosticsFile[]>): Disposer {
    this.diagnosticsQuery = query;
    return () => {
      if (this.diagnosticsQuery === query) this.diagnosticsQuery = undefined;
    };
  }

  /**
   * scheduler 件 apply 期挂 goal 挂钟面（返回摘除器——行回卷摘；刀四迟到
   * 注入：goal 行第四行先装载、scheduler 行第五行装载完成时回填）。
   */
  mountSchedulerFace(face: GoalSchedulerFace): Disposer {
    this.schedulerFace = face;
    return () => {
      if (this.schedulerFace === face) this.schedulerFace = undefined;
    };
  }

  /** goal 段查询（消费方：chat fold 边界 / gates 判段；miss = 非 goal 段） */
  goalScopeFor(sessionId: string): GoalScopeInfo | undefined {
    return this.goalScopeQuery?.(sessionId);
  }

  /**
   * todo fold 查询（消费方：goal 计划态投影 / open 项否决 / 刀三到窗复评）：
   * undefined = chat 件未注册（面缺席）；null = goal-scoped fold 无表（合法空）。
   */
  todoFoldFor(sessionId: string): readonly TodoFoldItem[] | null | undefined {
    return this.todoFoldQuery?.(sessionId);
  }

  /**
   * wake 归因查询（消费方：goal 件工具 currentWakeId / 续跑判定 attribution
   * 直查；刀三轮身份）：sessionId → 刚结算/在跑 run 的归因键值对。undefined =
   * chat 件未注册 / 会话无本件驱动 / 该 run 无归因（非 goal 唤醒轮）。
   */
  wakeAttributionFor(sessionId: string): Readonly<Record<string, string>> | undefined {
    return this.wakeLookupQuery?.(sessionId);
  }

  /** 诊断查询（消费方：chat gates diagnostics 验证器；miss = 申报即拒） */
  diagnosticsFor(paths: readonly string[]): Promise<readonly GateDiagnosticsFile[] | undefined> {
    return this.diagnosticsQuery === undefined ? Promise.resolve(undefined) : this.diagnosticsQuery(paths);
  }

  /**
   * goal 挂钟面查询（消费方：goal 件 /goal wake 命令 + 终态/降级停摆接线；
   * 刀四）：miss = scheduler 件未装载（或已卸）——命令面响亮拒绝，停摆接线
   * 静默跳过（行状态已是终态，钟行不翻转不构成正确性缺口——至多 OS 空跳
   * 一拍，投递前查行兜底让路）。
   */
  schedulerFaceFor(): GoalSchedulerFace | undefined {
    return this.schedulerFace;
  }
}
