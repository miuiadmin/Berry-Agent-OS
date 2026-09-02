/**
 * check-tense 机器闸回归锁（复盘 20260901 T-3）：spawn 真脚本双向断言——
 * 本仓净树 exit 0（汇总锚在）+ 已知违规夹具 exit 1（三规则各一条：hash 幻引 /
 * 完成时态幽灵路径 / 退役词）。
 *
 * 锁的失效形态：三规则的提取正则或扫描面枚举静默退化 → exit 0 假绿（本器占
 * 四门禁链尾却零回归锁——正则漏形态两周内两起同族故障）。
 *
 * 夹具经 CHECK_ROOT env 根缝注入（见 check-tense.mjs 头注）：夹具是含 ≥1 笔
 * commit 的 git 仓（规则 1 hash 对照 git log 锚 ROOT）；AGENTS.md 三行各踩一规。
 *
 * 落位注记：与 check-events.test.mjs 同为 vitest 窄面收编的 tools/*.mjs 测试
 * （vitest.config include 显式列举）——tsc 视门外纯 node 语义直跑。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 被测脚本（cwd=ROOT 相对路径——与本仓门禁同一调用形态） */
const SCRIPT = join('tools', 'check-tense.mjs');

/** 夹具树根（beforeAll 建） */
let fixtureRoot = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'berry-check-tense-fix-'));
  // 三行各踩一规：退役词（规则 3）/ 完成时态 × 幽灵路径（规则 2）/ hash 幻引（规则 1）。
  // 幻引选 11 位 hex——与夹具仓真实 commit 前缀碰撞概率天文级为零
  writeFileSync(
    join(fixtureRoot, 'AGENTS.md'),
    [
      '# 夹具',
      '',
      '旧机制曾名插件（规则 3：退役词）。',
      '',
      // #3 锚（遗漏大扫 20260902）：退役应用 id 子表——独立成词的旧 id 被点名，
      // 同行的 encoder/decoder 含 coder 子串但非独立词不被误伤（边界正则退化回
      // 子串匹配时 encoder 先误报、断言「不含」必红；子表整体被拆掉时 coder 行
      // 点名缺席、下断言必红）
      '旧应用 id 是 coder，新 id 是 berrycode（规则 3：退役应用 id——词边界形态）。',
      'encoder 与 decoder 是普通英文词（规则 3 负例：含 coder 子串不误伤）。',
      '',
      '已落码 `src/ghost.ts`（规则 2：完成时态引用不存在路径）。',
      '',
      // #16 锚（遗漏大扫 20260901-c）：中文命名路径此前被 \w 字符类排除在
      // docs/ 白名单段外——正则退化回 [\w./-] 时本行不再被点名，断言必红
      '已落码 `docs/中文幽灵.md`（规则 2：中文命名路径同受门禁管辖）。',
      '',
      '另见幻引 c0ffee12345（规则 1：非本仓 hash 前缀）。',
      '',
    ].join('\n'),
  );
  // O-4③ 锚负例（遗漏大扫 20260901）：README.md 与 README.en.md 各踩规则 2——
  // 后者只有 glob 展开（README*.md，复盘 G-2）在岗才被点名：glob 被拆回单文件
  // 硬编码时本断言必红（实证法：临时把 glob 收敛为只读 README.md → 本测红）
  writeFileSync(join(fixtureRoot, 'README.md'), ['# 夹具', '', '已落码 `src/never-zh.md`。', ''].join('\n'));
  writeFileSync(join(fixtureRoot, 'README.en.md'), ['# fixture', '', '已落码 `src/never-en.ts`。', ''].join('\n'));
  // 规则 1 对照锚 ROOT 上的 git log——夹具需 ≥1 笔 commit（无 commit 时 git log
  // 非零退出使 execFileSync 抛错，夹具即废）；-c 注入身份防全局配置缺省拦截。
  // env 密封：`git commit -- <pathspec>` 给 pre-commit 钩子导出 GIT_INDEX_FILE=
  // 临时索引（绝对路径）等 git 定位变量——泄漏进夹具会让夹具的 git 读写真仓
  // 索引（tree 构建混两仓对象库 → invalid object 崩夹具，本测文件级红）。
  // 夹具仓自足，一律剥净 git 定位变量（第五十三批刀五提交链实证）。
  const fixtureEnv = { ...process.env };
  delete fixtureEnv.GIT_DIR;
  delete fixtureEnv.GIT_INDEX_FILE;
  delete fixtureEnv.GIT_WORK_TREE;
  delete fixtureEnv.GIT_OBJECT_DIRECTORY;
  delete fixtureEnv.GIT_CEILING_DIRECTORIES;
  const git = (args) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: fixtureRoot,
      env: fixtureEnv,
    });
  git(['init', '-q']);
  git(['add', 'AGENTS.md']);
  git(['commit', '-qm', 'fixture']);
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('check-tense 机器闸（复盘 20260901 T-3）', () => {
  it('净树全绿：exit 0（execFileSync 非零即抛）+ 汇总行锚（三规则计数面在）', () => {
    const stdout = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    // 汇总锚：三规则对照计数缺一即汇总行变样——扫描面被静默拆掉先在此红
    expect(stdout).toMatch(/check-tense: hash \d+ 对照、时态路径 \d+ 对照、退役词 \d+ 行扫描/);
    expect(stdout).toContain('—— 绿');
  });

  it('违规夹具 exit 1：三规则各一条被 stderr 点名（CHECK_ROOT 根缝）', () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, CHECK_ROOT: fixtureRoot },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    // 规则 1：hash 幻引
    expect(run.stderr).toContain('非 hash 幻引「c0ffee12345」');
    // 规则 2：完成时态 × 幽灵路径
    expect(run.stderr).toContain('完成时态引用路径不存在「src/ghost.ts」');
    // 规则 2（#16）：中文命名路径进 docs/ 白名单段——字符类退化时本断言先红
    expect(run.stderr).toContain('完成时态引用路径不存在「docs/中文幽灵.md」');
    // 规则 3：退役词
    expect(run.stderr).toContain('退役词「插件」');
    // 规则 3（#3 锚）：退役应用 id 被点名（子表被拆掉时缺席先红）；
    // 同夹具 encoder/decoder 行未被误伤（边界正则退化回子串时「不含」先红）
    expect(run.stderr).toContain('退役应用 id「coder」');
    expect(run.stderr).not.toContain('退役应用 id「encoder」');
    expect(run.stderr).not.toContain('退役应用 id「decoder」');
    // O-4③：README glob 展开在岗——外国语镜像（README.en.md）与中文同查，
    // 各自的规则 2 违规都被点名（glob 退化时 en 断言先红——G-2 锚）
    expect(run.stderr).toContain('README.md:3 完成时态引用路径不存在「src/never-zh.md」');
    expect(run.stderr).toContain('README.en.md:3 完成时态引用路径不存在「src/never-en.ts」');
  });
});
