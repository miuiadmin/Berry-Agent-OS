/**
 * L0 contracts — 通道命令公共类型（骨架篇 §9.3；2026-08-27 第三十三批 P2-1
 * M4 + 类型同律下沉：CommandDefinition/CommandCompletionItem 自 channels 模块
 * 迁入——插件面（ctx.channels.registerCommand 的参数类型）引用的类型住
 * contracts，与 SkillsProvider 五符号下沉同病同修；channels/types.ts 改再
 * 导出，旧消费面零改动）。
 */

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
  /** 来源标记（'builtin' | 'skill' | 'plugin'；缺省 'builtin'） */
  readonly source?: string;
  /** 命令体（args 为命令名后的剩余文本；抛错由通道壳兜底为通知） */
  handler(args: string): void | Promise<void>;
}
