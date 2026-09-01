/**
 * 门禁基建自测（基建大扫 20260901 #19/#20）——CI 远端执法 + pre-commit 钩子面。
 *
 * 锁三件：
 * 1. .github/workflows/ci.yml 在场且四门禁全数出现 + fetch-depth: 0
 *    （check-tense 规则 1 hash 对照吃 git log 全史——浅克隆会让文档里的
 *    hash 引用全数误红，此细节必须钉死防「优化」掉）；
 * 2. .githooks/pre-commit 在场、可执行、四门禁全数出现（提交时刻执法面）；
 * 3. tools/install-hooks.mjs 真跑：git 仓内设 core.hooksPath=.githooks、
 *    非 git 目录静默退出 0（消费者环境无 git 不炸 npm install）。
 *
 * 这是基建面的形态锁（同 release.test.mjs 锁 package.json 字段的先例）——
 * 文件缺席/门禁漏项即红。
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 四门禁 npm script 名（与 package.json / AGENTS 工程纪律同源） */
const FOUR_GATES = ['typecheck', 'lint:topology', 'format:check'];

test('CI 工作流在场：四门禁全数执法 + fetch-depth 0（#19）', () => {
  const yml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  // 测试门以 npm test 形态出现（script 名）；其余三门 run 行直呼其名
  for (const gate of FOUR_GATES) {
    assert.ok(yml.includes(`npm run ${gate}`), `ci.yml 缺门禁 ${gate}`);
  }
  assert.ok(yml.includes('npm test') || yml.includes('npm run test'), 'ci.yml 缺测试门');
  // 全史拉取：hash 对照（check-tense 规则 1）在浅克隆下全数误红——钉死
  assert.ok(/fetch-depth:\s*0/.test(yml), 'ci.yml 必须 fetch-depth: 0（check-tense hash 对照需全史）');
  // push 与 PR 双触发（外部贡献走 PR 面）
  assert.ok(/(^|\s)push:/.test(yml) && /pull_request:/.test(yml), 'ci.yml 须 push + pull_request 双触发');
});

test('pre-commit 钩子在场：可执行 + 四门禁全数出现（#20）', () => {
  const hookPath = join(repoRoot, '.githooks/pre-commit');
  const mode = statSync(hookPath).mode;
  assert.ok(mode & 0o111, '.githooks/pre-commit 必须可执行（git 拒跑无执行位钩子）');
  const hook = readFileSync(hookPath, 'utf8');
  assert.ok(hook.includes('npm run typecheck'), '钩子缺 typecheck');
  assert.ok(hook.includes('vitest run') || hook.includes('npm test'), '钩子缺 test');
  assert.ok(hook.includes('npm run lint:topology'), '钩子缺 lint:topology');
  assert.ok(hook.includes('npm run format:check'), '钩子缺 format:check');
});

test('install-hooks：git 仓内设 core.hooksPath，非 git 目录静默 0（#20）', () => {
  const script = join(repoRoot, 'tools/install-hooks.mjs');
  // 场景一：临时 git 仓——core.hooksPath 被指向 .githooks
  const repoDir = mkdtempSync(join(tmpdir(), 'hooks-repo-'));
  const plainDir = mkdtempSync(join(tmpdir(), 'hooks-plain-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    const r1 = spawnSync(process.execPath, [script], { cwd: repoDir, encoding: 'utf8' });
    assert.equal(r1.status, 0, `git 仓内应退出 0（stderr: ${r1.stderr}）`);
    const cfg = execFileSync('git', ['config', 'core.hooksPath'], { cwd: repoDir, encoding: 'utf8' }).trim();
    assert.equal(cfg, '.githooks', 'core.hooksPath 应指向仓库内 .githooks');
    // 场景二：非 git 目录（消费者装包环境形态）——静默退出 0 不炸
    const r2 = spawnSync(process.execPath, [script], { cwd: plainDir, encoding: 'utf8' });
    assert.equal(r2.status, 0, `非 git 目录应静默 0（stderr: ${r2.stderr}）`);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test('format 射界含公开文档面：README 四语 + docs 全纳（#22）', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const scope = String(pkg.scripts?.['format:check'] ?? '');
  assert.ok(scope.includes('README*.md'), 'format:check 射界缺 README*.md');
  assert.ok(scope.includes('docs/**/*.md'), 'format:check 射界缺 docs/**/*.md');
  // format 与 format:check 两 glob 必须同射界（写面漏纳 = 检出面永久红）
  assert.equal(
    pkg.scripts?.['format:check']?.replace('--check', '--write'),
    pkg.scripts?.['format'],
    'format 与 format:check 射界不同步',
  );
});
