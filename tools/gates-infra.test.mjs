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
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
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

test('npm 身份零残留：旧包名/旧私有仓 URL 不入公开安装面（成熟度扫描 20260901 P0-1/P0-4）', () => {
  // npm 身份（包名 berry-agent-os）与虚拟模块名（berryagent 六键——含 /llm /sqlite
  // 两子键）分立：后者是 loader 注入的 API 标识符，src/ 与 docs 合法在场。故按
  // 「npm 身份形态」断言而非裸词清零——本测试管的是安装命令/徽章/装机路径/仓 URL
  // 四类形态，恰好是改名批曾漏扫的面（三语镜像 + examples README + Release 模板）
  const faces = [
    // 根 README 族（glob 展开——与 check-tense ROOT_FILES 同射界，新语种自动纳管）
    ...readdirSync(repoRoot)
      .filter((f) => /^README.*\.md$/.test(f))
      .map((f) => join(repoRoot, f)),
    // docs 公开文档面 + examples 教学例 + scripts 安装链 + .github 仓配套
    ...readdirSync(join(repoRoot, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(repoRoot, 'docs', f)),
    ...readdirSync(join(repoRoot, 'examples'), { recursive: true })
      .map((f) => String(f))
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(repoRoot, 'examples', f)),
    ...readdirSync(join(repoRoot, 'scripts'))
      .filter((f) => f.endsWith('.sh'))
      .map((f) => join(repoRoot, 'scripts', f)),
    ...readdirSync(join(repoRoot, '.github'), { recursive: true })
      .map((f) => String(f))
      .filter((f) => /\.(md|yml)$/.test(f))
      .map((f) => join(repoRoot, '.github', f)),
  ];
  const bad = [];
  for (const abs of faces) {
    const rel = relative(repoRoot, abs);
    const text = readFileSync(abs, 'utf8');
    // 形态一：npm 安装命令 / npmjs 徽章链接 / 装机路径 指旧包名 berryagent
    if (/npm\s+(i|install)\s+(-g\s+)?berryagent/.test(text)) bad.push(`${rel}: 安装命令指旧包名`);
    if (/package\/berryagent/.test(text)) bad.push(`${rel}: npmjs 链接指旧包名`);
    if (/npm root[^`\n]*berryagent\//.test(text)) bad.push(`${rel}: 装机路径指旧包名`);
    // 形态二：旧私有仓 URL（现仓 = Berry-Agent-OS 大写 B；小写带斜杠形态即旧仓残留）
    if (/miuiadmin\/berry-agent\//.test(text)) bad.push(`${rel}: 旧私有仓 URL 残留`);
    // 形态三：克隆指引进错目录（仓目录名已是 Berry-Agent-OS）
    if (/\bcd berry\b/.test(text)) bad.push(`${rel}: 克隆指引目录名漂移`);
  }
  assert.deepEqual(bad, [], `npm 身份残留（应改 berry-agent-os / Berry-Agent-OS）:\n${bad.join('\n')}`);
});

test('安装指引两段式：公开面禁 pipe 直灌形态（成熟度扫描 20260901 快赢#5）', () => {
  // 管道直灌（curl ... | sh）在连接中段断裂时会让 sh 执行半截脚本——官方安装
  // 指引恒两段式（curl -o 落盘后再 sh）；install.sh 头注释同律。扫描面与 npm
  // 身份锁同构：根 README 族 + 使用指南 + 安装脚本本体
  const faces = [
    ...readdirSync(repoRoot)
      .filter((f) => /^README.*\.md$/.test(f))
      .map((f) => join(repoRoot, f)),
    join(repoRoot, 'docs', '使用指南.md'),
    join(repoRoot, 'scripts', 'install.sh'),
  ];
  const bad = [];
  for (const abs of faces) {
    if (/install\.sh\s*\|\s*sh/.test(readFileSync(abs, 'utf8'))) {
      bad.push(`${relative(repoRoot, abs)}: 管道直灌形态`);
    }
  }
  assert.deepEqual(bad, [], '安装指引须两段式（先下载再执行）——防半截脚本执行');
});

test('package-lock 与 package.json 名字同步（成熟度扫描 20260901 P0-1）', () => {
  // 改名批曾漏 lockfile 顶层 name——npm ci 不炸但工作树常驻非己所改 diff，且违
  // 「破坏性变更一笔原子化」纪律。锁两处：顶层 name 与 packages[""] name 同源。
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  assert.equal(lock.name, pkg.name, 'lockfile 顶层 name 与 package.json 漂移');
  assert.equal(lock.packages?.['']?.name, pkg.name, 'lockfile packages[""].name 与 package.json 漂移');
});

test('build 链 bin 执行位：copy-app-assets 尾步对 bin 入口 chmod 0755（成熟度扫描 20260901 快赢#4）', () => {
  // npm 安装期自动修 bin 权限，但手动解包 tarball 形态无人修——build 时打进
  // 产物使 tarball 自含执行位。形态锁（先例同本文件其余）：chmod 步或 bin 路径
  // 构造被误删即红。
  const script = readFileSync(join(repoRoot, 'tools', 'copy-app-assets.mjs'), 'utf8');
  assert.ok(/chmodSync\(\s*\w+,\s*0o755\s*\)/.test(script), 'copy-app-assets 须含 chmodSync(<bin>, 0o755)');
  assert.ok(
    /join\(distRoot,\s*'app',\s*'main\.js'\)/.test(script),
    'bin 入口路径须锚 dist/app/main.js（package.json bin 同源）',
  );
});

test('AGENTS.md 行数预算棘轮：≤175 行（工程纪律「并发协作与本文档治理」——先例 dsh verify-doc-budgets）', () => {
  // 预算棘轮只减不增（基线 175，含治理节本身）；事故追加新规则须同次修订合并
  // 或删减等量旧内容——本闸防无声超支。口径与 wc -l 一致（换行计数，尾部空行不计）。
  const text = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const lines = (text.match(/\n/g) ?? []).length;
  assert.ok(
    lines <= 175,
    `AGENTS.md 行数 ${lines} 超预算基线 175——棘轮只减不增：追加规则须同次删减等量旧内容，或先修订预算拍板`,
  );
});

test('公开仓配套面三件在场（成熟度扫描 20260901 P0-2）', () => {
  // SECURITY.md：披露唯一渠道 = GitHub private vulnerability reporting，不设公开
  // 邮箱（防捏造/失效——渠道单源 GitHub 后台功能，转公开后在后台开启）
  const security = readFileSync(join(repoRoot, 'SECURITY.md'), 'utf8');
  assert.ok(
    /[Pp]rivate vulnerability reporting/.test(security),
    'SECURITY.md 须指明 GitHub private vulnerability reporting 披露渠道',
  );
  assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(security), 'SECURITY.md 不设公开邮箱（渠道单源 GitHub，防捏造/失效）');
  // CODEOWNERS：单维护者档
  const owners = readFileSync(join(repoRoot, 'CODEOWNERS'), 'utf8');
  assert.ok(/^\* @miuiadmin\s*$/m.test(owners), 'CODEOWNERS 须为「* @miuiadmin」单维护者档');
  // bug report 模板：复现段 + doctor 诊断指引
  const template = readFileSync(join(repoRoot, '.github/ISSUE_TEMPLATE/bug_report.md'), 'utf8');
  assert.ok(template.includes('复现'), 'bug_report 模板须含复现步骤段');
  assert.ok(template.includes('doctor'), 'bug_report 模板须引导附 doctor 诊断输出');
});

test('build 链尾步写 dist/.build-meta.json：真跑两腿 + 接线形态锁（成熟度扫描 20260901 P1-13）', () => {
  const script = join(repoRoot, 'tools', 'write-build-meta.mjs');
  const distTmp = mkdtempSync(join(tmpdir(), 'build-meta-dist-'));
  try {
    // 场景一：真仓形态——DIST_ROOT 根缝注入临时目录，commit 位 = 本仓 HEAD 40 位哈希
    const r1 = spawnSync(process.execPath, [script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, DIST_ROOT: distTmp },
    });
    assert.equal(r1.status, 0, `write-build-meta 应退出 0（stderr: ${r1.stderr}）`);
    const meta = JSON.parse(readFileSync(join(distTmp, '.build-meta.json'), 'utf8'));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    assert.match(meta.commit, /^[0-9a-f]{40}$/, 'commit 位须为 40 位十六进制哈希');
    assert.equal(meta.commit, head, 'commit 位须等于本仓 HEAD（build 溯源面失真即红）');
    // 场景二：git 缺席形态（PATH 掏空）——写 null 不炸 build
    const r2 = spawnSync(process.execPath, [script], {
      cwd: distTmp, // 非 git 目录 + PATH 空——git 探针双重必败
      encoding: 'utf8',
      env: { ...process.env, PATH: '', DIST_ROOT: distTmp },
    });
    assert.equal(r2.status, 0, `git 缺席形态应退出 0 不炸 build（stderr: ${r2.stderr}）`);
    const metaNull = JSON.parse(readFileSync(join(distTmp, '.build-meta.json'), 'utf8'));
    assert.equal(metaNull.commit, null, 'git 缺席时 commit 位须为 null（best-effort 溯源）');
  } finally {
    rmSync(distTmp, { recursive: true, force: true });
  }
  // 接线形态锁：build 链含尾步 + 运行入口 boot 期接线——任一被「优化」掉即红
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.ok(
    String(pkg.scripts?.build ?? '').includes('node tools/write-build-meta.mjs'),
    'package.json build 链缺 write-build-meta 尾步（dist 溯源面断供）',
  );
  const mainTs = readFileSync(join(repoRoot, 'src', 'app', 'main.ts'), 'utf8');
  assert.ok(
    mainTs.includes('warnIfStaleDist(import.meta.url)'),
    'src/app/main.ts 缺 warnIfStaleDist(import.meta.url) boot 接线（陈旧告警断供）',
  );
});
