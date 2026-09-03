/**
 * L5 app — git 探测闭包单元测试（遗漏大扫 20260903 fresh D1-1 红锁）。
 *
 * 真临时 git 仓（无 mock——execFile/git 全真）：CJK 路径 commit 两轮后
 * delta() 必须回原生 UTF-8 文件名。修前红语义：git 缺省 core.quotepath=true
 * 把非 ASCII 路径输出成带引号八进制转义串（`"\350\256\276…"`）——durable
 * git/range files 落的全是转义垃圾（本仓 设计文档/ CJK 路径即主形态）。
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitProbe } from './git-probe.js';

/** git 可执行缺席（最小容器环境）时整文件跳过——探测件以 git 在场为前提 */
const hasGit = await new Promise<boolean>((resolve) => {
  execFile('git', ['--version'], (err) => resolve(err === null));
});
const describeGit = hasGit ? describe : describe.skip;

/** 临时仓根（afterAll 整树清理） */
let repoRoot: string | undefined;

/** execFile promise 化（测试侧脚手架——失败响亮抛） */
function run(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd }, (err, stdout) => {
      if (err === null) resolve(stdout);
      else reject(err);
    });
  });
}

afterAll(() => {
  if (repoRoot !== undefined) rmSync(repoRoot, { recursive: true, force: true });
});

describeGit('git 探测闭包', () => {
  it('delta() CJK 路径 = 原生 UTF-8（修前：带引号八进制转义串落账）', async () => {
    // 建临时仓：init + 本地身份配置（无全局配置环境也能 commit）
    repoRoot = mkdtempSync(join(tmpdir(), 'git-probe-cjk-'));
    await run(repoRoot, ['init', '-q']);
    await run(repoRoot, ['config', 'user.email', 'probe@test.local']);
    await run(repoRoot, ['config', 'user.name', 'probe']);

    // 首 commit（干净基线）——HEAD 短哈希即 before 锚
    writeFileSync(join(repoRoot, 'readme.md'), 'base\n');
    await run(repoRoot, ['add', '.']);
    await run(repoRoot, ['commit', '-q', '-m', 'base']);
    const before = (await run(repoRoot, ['rev-parse', '--short=12', 'HEAD'])).trim();

    // 第二 commit 带纯 CJK 目录文件名（主受害形态——本仓设计文档/ 同形）
    const cjkDir = join(repoRoot, '设计文档');
    mkdirSync(cjkDir);
    writeFileSync(join(cjkDir, '中文规范.md'), 'cjk content\n');
    await run(repoRoot, ['add', '.']);
    await run(repoRoot, ['commit', '-q', '-m', 'cjk path']);
    const after = (await run(repoRoot, ['rev-parse', '--short=12', 'HEAD'])).trim();

    const probe = createGitProbe();
    const delta = await probe.delta(repoRoot, before, after);

    expect(delta).toBeDefined();
    expect(delta!.commits).toBe(1);
    // 修前红位：quotepath=true 缺省输出 '"\350\256\276\350\256\241\346\226\207\346\241\243/..."'
    // （带字面双引号 + 八进制转义）——既不等于原生路径，也不含中文字符
    expect(delta!.files).toContain('设计文档/中文规范.md');
    expect(delta!.files.some((f) => f.includes('设计文档'))).toBe(true);
    expect(delta!.files.some((f) => f.startsWith('"'))).toBe(false); // 无引号转义形
  });

  it('state() 基线：head 短哈希 + dirtyCount 含未跟踪', async () => {
    if (repoRoot === undefined) return; // 上一测已建仓（skip 场景防御）
    writeFileSync(join(repoRoot, 'untracked.txt'), 'dirty\n');
    const probe = createGitProbe();
    const state = await probe.state(repoRoot);
    expect(state).toBeDefined();
    expect(state!.head).toMatch(/^[0-9a-f]{7,12}$/);
    expect(state!.dirtyCount).toBe(1); // 未跟踪文件计入
  });
});
