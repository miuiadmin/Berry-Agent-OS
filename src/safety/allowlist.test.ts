/**
 * L3 safety 测试 — allowlist 匹配引擎（第二十四批题1a：三族匹配器 + TTL +
 * 剥壳语义全集）。纯函数表驱动——storage/命令面/装配接线随接线批，本文件
 * 锁判定语义（含保守边界：不可判定即 miss）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandStem, matchAllowlist, type AllowlistEntry, type AllowlistInput } from './allowlist.js';
import { canonicalPath } from './roots.js';

/** 真临时工作区（canonical 前缀判定用真路径——macOS /var→/private/var 符号链归一） */
const ws = canonicalPath(mkdtempSync(join(tmpdir(), 'allowlist-')));
const NOW = 1_000_000;

function fsInput(paths: readonly string[]): AllowlistInput {
  return { tool: 'write', writePaths: paths, workspace: ws };
}

function bashInput(command: string): AllowlistInput {
  return { tool: 'bash', bashCommand: command, workspace: ws };
}

describe('fs 路径前缀族（write / edit）', () => {
  const dataDir = join(ws, 'data');

  it('绝对/相对 pattern 等价（相对锚 workspace）；前缀到路径分隔边界', () => {
    const abs: AllowlistEntry = { tool: 'write', pattern: dataDir };
    const rel: AllowlistEntry = { tool: 'write', pattern: 'data' };
    const target = canonicalPath(join(dataDir, 'a.txt'));
    expect(matchAllowlist([abs], fsInput([target]), NOW)?.index).toBe(0);
    expect(matchAllowlist([rel], fsInput([target]), NOW)?.index).toBe(0);
    // /app 不匹配 /apple——前缀必须落在分隔边界
    expect(
      matchAllowlist(
        [{ tool: 'write', pattern: join(ws, 'app') }],
        fsInput([canonicalPath(join(ws, 'apple/x.txt'))]),
        NOW,
      ),
    ).toBeUndefined();
  });

  it('全部写目标都在前缀内才命中（all-or-nothing——多路径一漏即 miss）', () => {
    const entry: AllowlistEntry = { tool: 'write', pattern: dataDir };
    const inside = canonicalPath(join(dataDir, 'a.txt'));
    const outside = canonicalPath(join(ws, 'out.txt'));
    expect(matchAllowlist([entry], fsInput([inside]), NOW)).toBeDefined();
    expect(matchAllowlist([entry], fsInput([inside, outside]), NOW)).toBeUndefined();
  });

  it('无写意图 / 空 pattern 不命中；工具名不匹配的同族条目跳过', () => {
    expect(
      matchAllowlist([{ tool: 'write', pattern: dataDir }], { tool: 'write', writePaths: [], workspace: ws }, NOW),
    ).toBeUndefined();
    expect(
      matchAllowlist([{ tool: 'write', pattern: '' }], fsInput([canonicalPath(join(dataDir, 'a'))]), NOW),
    ).toBeUndefined();
    expect(
      matchAllowlist([{ tool: 'edit', pattern: dataDir }], fsInput([canonicalPath(join(dataDir, 'a'))]), NOW),
    ).toBeUndefined();
  });
});

describe('bash 命令词干族（剥壳语义全集 v1）', () => {
  const entry = (pattern: string): AllowlistEntry => ({ tool: 'bash', pattern });

  it('主命令与子命令对齐：命中与不命中', () => {
    expect(matchAllowlist([entry('git status')], bashInput('git status'), NOW)).toBeDefined();
    expect(matchAllowlist([entry('git')], bashInput('git status'), NOW)).toBeDefined(); // 无子命令 pattern 放行任意子命令
    expect(matchAllowlist([entry('git status')], bashInput('git log'), NOW)).toBeUndefined();
    expect(matchAllowlist([entry('npm test')], bashInput('npm run build'), NOW)).toBeUndefined();
  });

  it('剥壳：环境变量前缀赋值剥除；shell 包装穿透一层；绝对路径主命令取 basename', () => {
    expect(matchAllowlist([entry('git status')], bashInput('FOO=1 BAR=x git status'), NOW)).toBeDefined();
    expect(matchAllowlist([entry('git status')], bashInput("sh -c 'git status'"), NOW)).toBeDefined();
    expect(matchAllowlist([entry('git status')], bashInput('bash -lc "git status"'), NOW)).toBeDefined();
    expect(matchAllowlist([entry('git status')], bashInput('/usr/bin/git status'), NOW)).toBeDefined();
  });

  it('不可判定即 miss：管道 / 串接 / 重定向 / 命令替换 / 换行 / 残留引号', () => {
    const e = entry('echo');
    expect(matchAllowlist([e], bashInput('echo hi && rm -rf /'), NOW)).toBeUndefined();
    expect(matchAllowlist([e], bashInput('echo hi | tee x'), NOW)).toBeUndefined();
    expect(matchAllowlist([e], bashInput('echo hi > /etc/passwd'), NOW)).toBeUndefined();
    expect(matchAllowlist([e], bashInput('echo $(rm -rf /)'), NOW)).toBeUndefined();
    expect(matchAllowlist([e], bashInput('echo hi\nrm -rf /'), NOW)).toBeUndefined();
    expect(matchAllowlist([e], bashInput('echo "two words"'), NOW)).toBeUndefined(); // 残留引号（非包装层）
  });

  it('flag 保守判定：任何 flag 即 miss（--help/-h/--version 三件除外）——git 换仓走私自然覆盖', () => {
    const e = entry('git status');
    expect(matchAllowlist([e], bashInput('git status'), NOW)).toBeDefined();
    expect(matchAllowlist([e], bashInput('git status --help'), NOW)).toBeDefined();
    expect(matchAllowlist([e], bashInput('git -C /other status'), NOW)).toBeUndefined(); // 换仓走私
    expect(matchAllowlist([e], bashInput('git --git-dir=/x status'), NOW)).toBeUndefined();
    expect(matchAllowlist([e], bashInput('git status --porcelain'), NOW)).toBeUndefined(); // v1 无 flag 白名单——照问
    // 非旗标参数（路径/值）放行
    expect(matchAllowlist([entry('ls')], bashInput('ls src/lib'), NOW)).toBeDefined();
  });

  it('pattern 形状执法：空 / 超两词 = 条目无效不命中', () => {
    expect(matchAllowlist([entry('')], bashInput('git status'), NOW)).toBeUndefined();
    expect(matchAllowlist([entry('git status --porcelain')], bashInput('git status'), NOW)).toBeUndefined();
  });
});

describe('commandStem 草案生成器（§8.4 增补 2——与判定同源同实现）', () => {
  it('干净命令 → 词干 ≤2 词（主命令 [子命令]；形参不进词干）', () => {
    expect(commandStem('git status')).toBe('git status');
    expect(commandStem('git')).toBe('git');
    expect(commandStem('git status --porcelain')).toBeUndefined(); // flag 即无词干（无害三件除外）
    expect(commandStem('git status --help')).toBe('git status');
    expect(commandStem('ls src/lib')).toBe('ls src/lib'); // 第二词非 flag 即纳入词干（v1 词法面不分子命令/形参——草案即从命令剥出，判定对齐自然命中）
    expect(commandStem('/usr/bin/git status')).toBe('git status'); // 绝对路径取 basename
  });

  it('剥壳：环境变量前缀 / shell 包装穿透一层（与判定面同源）', () => {
    expect(commandStem('FOO=1 git status')).toBe('git status');
    expect(commandStem("sh -c 'git status'")).toBe('git status');
    expect(commandStem('bash -lc "git status"')).toBe('git status');
  });

  it('不可判定 → undefined：剥不出干净词干即无草案（「始终允许」选项不呈现）', () => {
    expect(commandStem('echo hi && rm -rf /')).toBeUndefined();
    expect(commandStem('echo hi | tee x')).toBeUndefined();
    expect(commandStem('echo $(rm -rf /)')).toBeUndefined();
    expect(commandStem('echo "two words"')).toBeUndefined();
    expect(commandStem('git -C /other status')).toBeUndefined();
    expect(commandStem('')).toBeUndefined();
  });
});

describe('其余工具整名族 + TTL', () => {
  it('整名族：工具名相等即命中（pattern 忽略）', () => {
    expect(matchAllowlist([{ tool: 'web_fetch', pattern: 'unused' }], { tool: 'web_fetch' }, NOW)).toBeDefined();
    expect(matchAllowlist([{ tool: 'web_fetch', pattern: 'unused' }], { tool: 'web_search' }, NOW)).toBeUndefined();
  });

  it('TTL：过期 = 未命中回落 ask；未过期命中；缺省 = 永久', () => {
    const expired: AllowlistEntry = { tool: 'web_fetch', pattern: '', expiresAt: NOW - 1 };
    const alive: AllowlistEntry = { tool: 'web_fetch', pattern: '', expiresAt: NOW + 1 };
    expect(matchAllowlist([expired], { tool: 'web_fetch' }, NOW)).toBeUndefined();
    expect(matchAllowlist([alive], { tool: 'web_fetch' }, NOW)?.index).toBe(0);
    expect(matchAllowlist([{ tool: 'web_fetch', pattern: '' }], { tool: 'web_fetch' }, NOW)).toBeDefined();
  });

  it('序即优先级：多条目取首个命中（命中条目的 index 可供 reason 标注）', () => {
    const entries: AllowlistEntry[] = [
      { tool: 'web_search', pattern: '' },
      { tool: 'web_fetch', pattern: '' },
    ];
    expect(matchAllowlist(entries, { tool: 'web_fetch' }, NOW)?.index).toBe(1);
  });
});
