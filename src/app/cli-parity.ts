/**
 * L5 app — CLI 对等律的执法面（第八十五批批 F，技术栈篇 §5 对等律③「TUI 能做
 * 的 CLI 一致可做」）。
 *
 * **形态裁决**：不新建 check-*.mjs 门禁脚本——对等律的机器执法以「静态对等
 * 注册表 + vitest 交叉核对」最小形态落位：
 * - 桌面侧真相源 = `DESKTOP_COMMANDS`（desktop-shell 导出——/store //sessions
 *   等桌面命令面全集）；
 * - CLI 侧真相源 = `APPS_CLI_SUBCOMMANDS` / `SESSIONS_CLI_SUBCOMMANDS`
 *   （apps-cli 导出——CLI 子命令定稿表）+ 主命令位词；
 * - 本文件持有**对等规则表**（每条桌面命令 → CLI 对等 argv 或显式「TUI 专属」
 *   裁决与理由），`checkCliParity` 三向核对（规则表 ⊇ 桌面命令全集防漂移 /
 *   规则表 CLI 侧动词真实存在于分派表 / TUI 专属项必有理由）。
 *
 * 桌面新增命令不加对等裁决 → 交叉核对测试即红（规则表缺项）；CLI 子命令改名
 * → 规则表引用落空即红。两侧漂移都在测试面被拦下。
 */

/** 单条对等规则（desktop = 桌面命令；cli = 对等 argv 形〔不含 berry 前缀〕） */
export interface CliParityRule {
  /** 桌面命令（DESKTOP_COMMANDS 成员） */
  readonly desktop: string;
  /** CLI 对等 argv（首词 = 主命令位，次词 = 子命令位）；空 = TUI 专属（对等义务豁免——note 必填） */
  readonly cli: readonly string[];
  /** 裁决理由（对等语义说明或 TUI 专属豁免依据） */
  readonly note: string;
}

/**
 * 对等规则表（批 F 定稿面）。TUI 专属三词的豁免依据：
 * - /exit：进程退出动词——headless 形态进程自然结束即对等（无「退出 UI」语义）；
 * - /desktop：视图导航动词——回桌面视图，headless 无视图栈；
 * - /guide：首启凭证引导视图——知识面 docs/使用指南 恒在，交互引导无 headless 面。
 */
export const CLI_PARITY_RULES: readonly CliParityRule[] = [
  {
    desktop: '/exit',
    cli: [],
    note: 'TUI 专属：进程退出动词——headless 一发进程自然结束即语义对等',
  },
  {
    desktop: '/shutdown',
    cli: ['shutdown'],
    note: '恒杀全家关停——host-power 单源编舞的 CLI 腿（--yes 对位桌面 confirm）',
  },
  {
    desktop: '/reboot',
    cli: ['reboot'],
    note: '恒杀全家重启——同 shutdown 腿（--yes 对位桌面 confirm）',
  },
  {
    desktop: '/guide',
    cli: [],
    note: 'TUI 专属：首启凭证引导视图——知识面 docs/使用指南 恒在可查',
  },
  {
    desktop: '/desktop',
    cli: [],
    note: 'TUI 专属：视图导航动词（回桌面）——headless 无视图栈',
  },
  {
    desktop: '/store',
    cli: ['apps', 'skill-install'],
    note: '商店三市场动作面全对等：apps skill-* 四刀 + mcp-add/mcp-remove + install/mount/uninstall（浏览呈现面 TUI，动作面 CLI 全覆盖——同一 store 服务面单源）',
  },
  {
    desktop: '/sessions',
    cli: ['sessions', 'list'],
    note: '切换器五件面的可 headless 化半边对等：list 清单 + search 检索（续接/开新/关闭是进程内交互形态动词——live registry 才有五件面，存档进程外无此语义）',
  },
  {
    desktop: '/monitor',
    cli: [],
    note: '管理器三页签动词面分账（骨架篇 §1.2）：tick 族（e/d/n）对等 = 会话内 /tick 命令面（berry run 单发同参可执行）；Job cancel/全量 reload = 进程内交互态动词显式豁免（live 进程视角 headless 无语义）；memory 族 CLI 对等挂账二期 berry memory 命令族',
  },
];

/**
 * 三向核对（对等门禁本体——vitest 消费，红即两侧漂移）：
 * 1. 桌面命令全集 ⊆ 规则表（新桌面命令未裁决即红）；
 * 2. 规则表 ⊆ 桌面命令全集（命令退役规则表未清即红）；
 * 3. 规则表 CLI 侧动词真实存在（argv 首词按主命令分派、次词须在对应子命令表）；
 * 4. TUI 专属项（cli 空）必带非空理由。
 * @param desktopCommands 桌面侧真相源（DESKTOP_COMMANDS）
 * @param appsSubs apps 族子命令表（APPS_CLI_SUBCOMMANDS）
 * @param sessionsSubs sessions 族子命令表（SESSIONS_CLI_SUBCOMMANDS）
 * @param mainCommands 主命令位词全集（main.ts 分派 switch 的 case 词）
 */
export function checkCliParity(
  desktopCommands: readonly string[],
  appsSubs: readonly string[],
  sessionsSubs: readonly string[],
  mainCommands: readonly string[],
): { ok: true } | { ok: false; errors: readonly string[] } {
  const errors: string[] = [];
  const rules = new Map(CLI_PARITY_RULES.map((rule) => [rule.desktop, rule]));
  // ① 桌面命令全集 ⊆ 规则表
  for (const command of desktopCommands) {
    if (!rules.has(command)) {
      errors.push(`桌面命令 ${command} 无对等裁决——CLI_PARITY_RULES 补条目（TUI 专属须注理由）`);
    }
  }
  // ② 规则表 ⊆ 桌面命令全集
  for (const rule of CLI_PARITY_RULES) {
    if (!desktopCommands.includes(rule.desktop)) {
      errors.push(`对等规则 ${rule.desktop} 不在 DESKTOP_COMMANDS——命令已退役则规则同笔清`);
    }
    // ④ TUI 专属豁免必带理由
    if (rule.cli.length === 0 && rule.note.trim() === '') {
      errors.push(`对等规则 ${rule.desktop} 豁免无理由（note 必填）`);
    }
  }
  // ③ CLI 侧动词真实存在
  for (const rule of CLI_PARITY_RULES) {
    const [mainWord, subWord] = rule.cli;
    if (mainWord === undefined) continue;
    if (!mainCommands.includes(mainWord)) {
      errors.push(`对等规则 ${rule.desktop} 的 CLI 主命令 ${mainWord} 不在 main.ts 分派面`);
      continue;
    }
    const subs = mainWord === 'apps' ? appsSubs : mainWord === 'sessions' ? sessionsSubs : undefined;
    if (subs !== undefined) {
      if (subWord === undefined || !subs.includes(subWord)) {
        errors.push(`对等规则 ${rule.desktop} 的 CLI 子命令 ${subWord ?? '(缺)'} 不在 ${mainWord} 族子命令表`);
      }
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
