/**
 * CLI 对等律交叉核对测试（OS 三大管理面研究刀四——checkCliParity 此前
 * 「法无测」（注释承诺不存在的东西——反模式），本件收口：对等门禁本体进
 * vitest 常规测试面）。
 *
 * 三真相源直读（零手工清单）：
 * - 桌面侧 = DESKTOP_COMMANDS（desktop-shell 导出）；
 * - CLI 子命令侧 = APPS_CLI_SUBCOMMANDS / SESSIONS_CLI_SUBCOMMANDS（apps-cli 导出）；
 * - 主命令位 = main.ts 分派 switch 的 case 词直读源码（分派面唯一真相源——
 *   该文件仅一个 switch，case 词即主命令全集）。
 *
 * 红即两侧漂移：桌面新命令未裁决 / 命令退役规则未清 / CLI 动词改名落空 /
 * TUI 专属豁免无理由。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkCliParity, CLI_PARITY_RULES } from './cli-parity.js';
import { DESKTOP_COMMANDS } from './desktop-shell.js';
import { APPS_CLI_SUBCOMMANDS, SESSIONS_CLI_SUBCOMMANDS } from './apps-cli.js';

/** main.ts 主命令位词全集（case 词直读——main.ts 全文件仅此一个 switch） */
const mainCommands: readonly string[] = (() => {
  const source = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
  const words = [...source.matchAll(/case '([^']*)':/g)].map((match) => match[1] as string);
  if (words.length === 0) throw new Error('main.ts 分派 case 词零命中——提取式失效须修测试');
  return words;
})();

describe('CLI 对等律三向核对', () => {
  it('对等门禁本体：桌面命令全集 ↔ 规则表 ↔ CLI 分派面三向零漂移', () => {
    const result = checkCliParity(DESKTOP_COMMANDS, APPS_CLI_SUBCOMMANDS, SESSIONS_CLI_SUBCOMMANDS, mainCommands);
    expect(result).toEqual({ ok: true });
  });

  it('新桌面命令未裁决即红（①向——缺条目）', () => {
    const result = checkCliParity(
      [...DESKTOP_COMMANDS, '/brand-new'],
      APPS_CLI_SUBCOMMANDS,
      SESSIONS_CLI_SUBCOMMANDS,
      mainCommands,
    );
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('/brand-new')] });
  });

  it('命令退役规则未清即红（②向——悬挂条目）', () => {
    const narrowed = DESKTOP_COMMANDS.filter((command) => command !== '/monitor');
    const result = checkCliParity(narrowed, APPS_CLI_SUBCOMMANDS, SESSIONS_CLI_SUBCOMMANDS, mainCommands);
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('/monitor')] });
  });

  it('CLI 子命令改名落空即红（③向——动词失存）', () => {
    const result = checkCliParity(
      DESKTOP_COMMANDS,
      APPS_CLI_SUBCOMMANDS.filter((word) => word !== 'skill-install'),
      SESSIONS_CLI_SUBCOMMANDS,
      mainCommands,
    );
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('skill-install')] });
  });

  it('TUI 专属豁免无理由即红（④向——note 必填的不变量直核）', () => {
    // ④ 向读模块级表不可注入——对真实表直核同一不变量：cli 空条目 note 非空白
    const exempt = CLI_PARITY_RULES.filter((rule) => rule.cli.length === 0);
    expect(exempt.length).toBeGreaterThan(0);
    for (const rule of exempt) {
      expect(rule.note.trim(), `${rule.desktop} 豁免须带理由`).not.toBe('');
    }
  });

  it('monitor 对等裁决在场（刀四——分账 note 三段）', () => {
    const rule = CLI_PARITY_RULES.find((entry) => entry.desktop === '/monitor');
    expect(rule).toBeDefined();
    expect(rule?.cli).toEqual([]);
    // 分账三段：tick 族对等 / 进程内动词豁免 / memory 族挂账
    expect(rule?.note).toContain('/tick');
    expect(rule?.note).toContain('豁免');
    expect(rule?.note).toContain('二期');
  });
});
