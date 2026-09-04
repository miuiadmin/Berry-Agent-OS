/**
 * L0 contracts — 通道命令公共类型（骨架篇 §9.3；2026-08-27 第三十三批 P2-1
 * M4 + 类型同律下沉：CommandDefinition/CommandCompletionItem 自 channels 模块
 * 迁入——装载面（ctx.channels.registerCommand 的参数类型）引用的类型住
 * contracts，与 SkillsProvider 五符号下沉同病同修；channels/types.ts 改再
 * 导出，旧消费面零改动）。
 *
 * DeliverChannel 自 chat/conversation.ts 下沉（2026-09-04 TUI 强化批 4 刀 1：
 * ChannelHost.submit 返回投递通道——channels 不能 import chat〔拓扑 DAG〕，
 * 联盟单源驻本模块，chat 侧改再导出旧消费面路径不变——同 P2-1 M4 迁移形）。
 */

/**
 * 三通道（骨架篇 §4.1 投递通道可观测）：steer（run 中入队）/ followUp（闲时
 * 唤醒开轮）/ inject（只落日志不唤醒）。deliver/submit 返回实际选定值——路由
 * 按目标当下状态瞬时裁定，发送方是唯一拿得到路由结果的位。
 */
export type DeliverChannel = 'steer' | 'followUp' | 'inject';

/**
 * 命令参数补全候选项（getArgumentCompletions 的返回元素；镜像 pi-tui
 * AutocompleteItem——value 是补入文本、label 是展示行、description 单行说明）。
 */
export interface CommandCompletionItem {
  /** 补入编辑器的文本（如技能名/会话 id 片段） */
  readonly value: string;
  /** 候选清单展示名 */
  readonly label: string;
  /** 单行说明（候选清单右侧展示；可省） */
  readonly description?: string;
}

/** 斜杠命令定义（骨架篇 §9.3 ctx.channels.registerCommand） */
export interface CommandDefinition {
  /** 命令名（不含 '/'；技能命令用 'skill:<name>' 形态，契约篇 §4.5） */
  readonly name: string;
  /** 一句话说明（/help 清单展示） */
  readonly description: string;
  /**
   * 参数提示（命令名补全清单里 description 前缀展示，如 '<技能名>'）。
   * 纯静态提示面（M4，2026-08-27 第三十三批）；与 getArgumentCompletions
   * 独立——只给 hint 不给补全、或反之，均合法。
   */
  readonly argumentHint?: string;
  /**
   * 参数补全回调（M4）：命令名后已输入参数前缀 → 候选清单；返回 null/空数组
   * = 无候选。TUI 经 pi-tui CombinedAutocompleteProvider 接线（回调闭包内
   * 实时读注册表——/reload 后重注册的命令无需重建通道）。
   */
  getArgumentCompletions?(
    argumentPrefix: string,
  ): readonly CommandCompletionItem[] | null | Promise<readonly CommandCompletionItem[] | null>;
  /** 来源标记（'builtin' | 'skill' | 'app'；缺省 'builtin'） */
  readonly source?: string;
  /** 命令体（args 为命令名后的剩余文本；抛错由通道壳兜底为通知） */
  handler(args: string): void | Promise<void>;
}
