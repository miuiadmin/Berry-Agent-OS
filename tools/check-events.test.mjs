/**
 * check-events 机器闸回归锁（第四十六批）：spawn 真脚本断言全绿。
 *
 * 锁的失效形态：应用声明层并集被后续改动静默拆掉（如导入清单丢行、并集 map
 * 被换回目录单源）→ obs/alert 立即回红 exit 1——本测试先于 lint:topology 链
 * 在常规测试面变红，且汇总行「应用声明 N 词」锚缺失同样红（防并集还在但
 * 计数面漂移）。
 *
 * 修复前必红已实证（2026-08-31 落码前基线）：obs/alert 误报「目录外事件」
 * exit 1——机器闸滞后于 §1.1 逃生口运行时语义的缺口。
 *
 * 落位注记：与 tools/release.test.mjs 同为 vitest 窄面收编的 tools/*.mjs
 * 测试（vitest.config include 显式列举）——tsc 视门外纯 node 语义直跑。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 代码真值链尾（动态推导——与 check-events.mjs 同法扫 src 非测试面的
 * MigrationSpec 声明取最大 version）。硬编码「当前 vN」会随每次新增迁移
 * 漂移假红（v16 落地即实证一次）；推导后夹具随身带锚、永续免滚。
 */
function scanModuleVersions() {
  const map = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const text = readFileSync(p, 'utf8');
      const mod = /\/src\/([^/]+)\//.exec(p)?.[1];
      for (const m of text.matchAll(/: MigrationSpec = \{/g)) {
        const vm = /version:\s*(\d+)/.exec(text.slice(m.index, m.index + 400));
        if (vm && mod) {
          const bucket = map.get(mod) ?? [];
          bucket.push(Number(vm[1]));
          map.set(mod, bucket);
        }
      }
    }
  };
  walk(join(ROOT, 'src'));
  return map;
}

function deriveMigrationTail() {
  const all = [...scanModuleVersions().values()].flat();
  return Math.max(0, ...all);
}

/**
 * 模块行版本集合锚真值（遗漏大扫 20260902-c U1——与 check-events.mjs 族 7 下半
 * 同法按模块桶装）：同 deriveMigrationTail 动态推导不硬编码——新迁移落地夹具
 * 期望自动跟锚（滚表日不假红）。
 */
function deriveModuleNeedle(mod) {
  const versions = scanModuleVersions().get(mod);
  if (versions === undefined || versions.length === 0) throw new Error(`src/${mod}/ 下零 MigrationSpec 声明`);
  return `v${[...new Set(versions)].sort((a, b) => a - b).join('/')}`;
}

describe('check-events 机器闸（含应用声明层，第四十六批）', () => {
  it('全绿：七族双向一致 + 汇总行报应用声明计数、错误码册数与迁移末行锚（exit 0 由 execFileSync 非零即抛保证）', () => {
    const stdout = execFileSync(process.execPath, [join('tools', 'check-events.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    // 声明层计数锚：obs/alert 在册即 ≥1；并集被拆掉则脚本已红（到不了断言）
    expect(stdout).toMatch(/另应用声明 \d+ 词/);
    // 族 6 锚（基建大扫 #46）：错误码册数 + 七族字样在场——族 6 被整块删除时
    // 汇总行回六族形态，此断言先红（闸的闸）
    expect(stdout).toMatch(/错误码 \d+ 册，七族双向一致/);
    // 族 7 锚（全面复盘 20260902 G-1/G-3① + 遗漏大扫 20260902-c U1 模块集合锚）：
    // 迁移末行 + 模块集合锚两锚在场——族 7 被整块删除（或集合锚半块被拆）时此断言先红
    expect(stdout).toMatch(/迁移末行 v\d+ 锚 \+ 模块集合锚 memory\/goal\/scheduler/);
  });
});

/** O-4② 锚负例夹具树根（遗漏大扫 20260901）——beforeAll 建 */
let fixtureRoot = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'berry-check-events-fix-'));
  // 两数皆错位 + 各恰一次命中（锚正则要求恰一次——结构漂移会另红，本测锁计数漂移）。
  // 真值 = 本器 jiti 实导的目录实数（真仓 src——事件目录真相不随夹具变），99/98
  // 对任意真值必错。src 扫描面/目录真源恒读真仓 → 夹具模式其余规则全绿，红聚焦锚面。
  // 全家桶锚（L-1）：统计行写 99、表实列 2 行——同文档两基互斥位 + 节头锚均在场
  writeFileSync(
    join(fixtureRoot, 'README.md'),
    [
      '# 夹具 README',
      '',
      '**99** 生命周期钩子 · **98** 类 durable 事件（两数皆错位）',
      '',
      '**99** 件官方全家桶（件数错位）',
      '',
      '### 官方全家桶（Ring 2，件件可卸）',
      '',
      '| 件 | 职能 |',
      '| --- | --- |',
      '| `a` | 甲 |',
      '| `b` | 乙 |',
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('check-events 锚负例（遗漏大扫 20260901 O-4②）', () => {
  it('夹具 README 两数错位 → exit 1 点名计数漂移——第五族③整块删除后本测必红', () => {
    const run = spawnSync(process.execPath, [join('tools', 'check-events.mjs')], {
      cwd: ROOT,
      env: { ...process.env, CHECK_ROOT: fixtureRoot },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    // 锚面随 CHECK_ROOT 随移（第五族镜像读面）——夹具两锚写 99/98 必被逐一点名；
    // 锚规则（或镜像面根缝）被静默删除/退化时此断言先红
    expect(run.stderr).toContain('README.md 头部统计「生命周期钩子」写 99');
    expect(run.stderr).toContain('README.md 头部统计「durable 事件类」写 98');
  });

  it('夹具全家桶计数 99 ≠ 表行数 2 → exit 1 点名两基互斥——族 5③ 锚整块删除后本测必红（L-1）', () => {
    const run = spawnSync(process.execPath, [join('tools', 'check-events.mjs')], {
      cwd: ROOT,
      env: { ...process.env, CHECK_ROOT: fixtureRoot },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    // 同文档互证锚（头部统计行 vs 全家桶表行数）——O-2 事故型（统计行换基表未跟）
    expect(run.stderr).toContain('README.md 头部全家桶计数 99 ≠ 表行数 2');
  });
});

describe('check-events 迁移版本锚负例（全面复盘 20260902 G-1/G-3①）', () => {
  /**
   * 夹具树只造 docs/ 两锚面（迁移表止于 v14 + 运维手册标题写 14），真值恒读真仓
   * src（链尾动态推导，见 deriveMigrationTail——滚表日夹具自动跟锚不再假红）→
   * 三路漂移逐一点名（readMirrorFile 以 relPath 含 docs/ 前缀拼 MIRROR_ROOT，
   * 故夹具文件须落 docs/ 子目录）。族 7 被整块删除（或镜像面根缝被静默退化）时
   * 本测必红——闸的闸。
   */
  it('夹具两表止于 v14 / 标题写 14 → exit 1 三路点名末行与标题漂移', () => {
    const fixRoot = mkdtempSync(join(tmpdir(), 'berry-check-events-mig-'));
    try {
      mkdirSync(join(fixRoot, 'docs'), { recursive: true });
      writeFileSync(
        join(fixRoot, 'docs', '架构总览.md'),
        [
          '# 夹具架构总览',
          '',
          '## 8. 存储布局（SQLite 单库 + 统一迁移）',
          '',
          '| user_version | 内容 |',
          '| --- | --- |',
          '| 1（基线） | 基线 |',
          '| 14 | stale 末行 |',
          '',
          '## 9. 下一节',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(fixRoot, 'docs', '运维手册.md'),
        [
          '# 夹具运维手册',
          '',
          '## 2. 库内表清单（user_version = 14）',
          '',
          '| user_version | 表 | 内容 |',
          '| --- | --- | --- |',
          '| 1（基线） | x | y |',
          '| 14 | jobs | stale 末行 |',
          '',
          '## 3. 备份',
          '',
        ].join('\n'),
      );
      const run = spawnSync(process.execPath, [join('tools', 'check-events.mjs')], {
        cwd: ROOT,
        env: { ...process.env, CHECK_ROOT: fixRoot },
        encoding: 'utf8',
      });
      expect(run.status).toBe(1);
      // 真值侧不硬编码（v16 滚表日实证过漂移假红）——推导链尾拼进期望串
      expect(run.stderr).toContain(`迁移表末行 v14 ≠ 代码真值 v${deriveMigrationTail()}`);
      expect(run.stderr).toContain(`标题 user_version = 14 ≠ 代码真值 v${deriveMigrationTail()}`);
    } finally {
      rmSync(fixRoot, { recursive: true, force: true });
    }
  });
});

describe('check-events 模块行版本集合锚负例（遗漏大扫 20260902-c U1+活漂移）', () => {
  /**
   * 夹具树只造 AGENTS.md + docs/架构总览.md 两模块行锚面（三模块全写漂移旧值
   * ——AGENTS「v2-v11/jobs 表 v7」与总览「v2-v11/jobs 表 v9」互矛盾即批判抓到的
   * 第五起标本原形），真值恒读真仓 src（按模块桶装动态推导，见
   * deriveModuleNeedle——新迁移落地夹具期望自动跟锚不假红）→ 三模块 × 两文档
   * 逐一点名。集合锚半块被整块删除（或镜像面根缝被静默退化）时本测必红——闸的闸。
   */
  it('夹具两文档三模块行全写漂移旧值 → exit 1 六路点名集合锚滞后', () => {
    const fixRoot = mkdtempSync(join(tmpdir(), 'berry-check-events-mod-'));
    try {
      // 三行旧值（恰好复刻批判抓到的漂移原形：区间锚 v2-v11 + 两文档 jobs 各取一值）
      const staleLines = [
        'memory 官方件：表族 v2-v11（漂移旧值）',
        'goal 官方件：goals 表 v13（漂移旧值）',
        'scheduler 官方件：jobs 表 v7（漂移旧值）',
        '',
      ].join('\n');
      writeFileSync(join(fixRoot, 'AGENTS.md'), `# 夹具 AGENTS\n\n${staleLines}`);
      mkdirSync(join(fixRoot, 'docs'), { recursive: true });
      writeFileSync(join(fixRoot, 'docs', '架构总览.md'), `# 夹具架构总览\n\n${staleLines}`);
      const run = spawnSync(process.execPath, [join('tools', 'check-events.mjs')], {
        cwd: ROOT,
        env: { ...process.env, CHECK_ROOT: fixRoot },
        encoding: 'utf8',
      });
      expect(run.status).toBe(1);
      // 真值动态推导（硬编码集合会在滚表日假红）——三模块 × 两文档逐一点名
      expect(run.stderr).toContain(`AGENTS.md memory 模块行版本锚 ≠ 代码真值 ${deriveModuleNeedle('memory')}`);
      expect(run.stderr).toContain(`docs/架构总览.md memory 模块行版本锚 ≠ 代码真值 ${deriveModuleNeedle('memory')}`);
      expect(run.stderr).toContain(`AGENTS.md scheduler 模块行版本锚 ≠ 代码真值 ${deriveModuleNeedle('scheduler')}`);
      expect(run.stderr).toContain(`docs/架构总览.md goal 模块行版本锚 ≠ 代码真值 ${deriveModuleNeedle('goal')}`);
    } finally {
      rmSync(fixRoot, { recursive: true, force: true });
    }
  });
});
