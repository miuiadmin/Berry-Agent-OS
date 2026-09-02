/**
 * check-topology 机器闸回归锁（复盘 20260901 T-3）：spawn 真脚本双向断言——
 * 净树 exit 0（汇总锚在）+ 已知违规夹具 exit 1（白名单边侦测不静默退化）。
 *
 * 锁的失效形态：扫描正则漏形态 / 枚举跳目录 → exit 0 假绿、CI 无红（batch43
 * NUL 误报风暴、R6 死边真阴性漏报两起同族故障——本器占四门禁之一却零回归锁）。
 *
 * 夹具经 CHECK_ROOT env 根缝注入（见 check-topology.mjs 头注）：全部模块席
 * 空目录 + app/assembly.ts 空档（组合根纪律段可读）+ 一条越边 import 即最小
 * 违规树。死边/占位清单等其余断言在空夹具上另产违规——只要目标违规在 stderr
 * 即证明「相对导入 DAG 侦测」在岗（多余红是夹具语义，不影响断言）。
 *
 * 落位注记：与 check-events.test.mjs 同为 vitest 窄面收编的 tools/*.mjs 测试
 * （vitest.config include 显式列举）——tsc 视门外纯 node 语义直跑。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 被测脚本（cwd=ROOT 相对路径——与本仓门禁同一调用形态） */
const SCRIPT = join('tools', 'check-topology.mjs');

/** 夹具树根（beforeAll 建）——模块席清单与边表同步维护（新席落码时同步补行） */
let fixtureRoot = '';

/** 边表全席清单（两夹具共用）：席缺失本身是「无对应模块目录」违规（口径③）——
 * 全席在场让夹具红聚焦在目标违规上（死边/死项违规是空档的自然产物，见头注） */
const SEATS = [
  'contracts',
  'context',
  'session',
  'agent',
  'persist',
  'llm',
  'tools',
  'safety',
  'skills',
  'subagent',
  'chat',
  'memory',
  'goal',
  'exec',
  'scheduler',
  'mcp',
  'lsp',
  'web',
  'bridge',
  'compaction',
  'checkpoint',
  'admin',
  'channels',
  'webui',
  'obs',
  'browser',
  'app',
];

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'berry-check-topo-fix-'));
  for (const mod of SEATS) {
    const dir = join(fixtureRoot, 'src', mod);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.ts'), '');
  }
  // 目标违规：agent → session 不在 agent 白名单边（agent 仅许 contracts）
  writeFileSync(join(fixtureRoot, 'src', 'agent', 'index.ts'), "import type { X } from '../session/index.js';\n");
  // 组合根纪律段可读即可（空档两道正则皆不匹配）
  writeFileSync(join(fixtureRoot, 'src', 'app', 'assembly.ts'), '');
  // O-4① 负例（遗漏大扫 20260901）：夹具 README 写错模块数——规则 3 锚面随
  // CHECK_ROOT 随移后在岗必红；锚规则整块删除（或锚面退回恒读真仓）则本测
  // stderr 无此违规必败——「锁的锁」缺位补齐（修复前实证红：锚面未随移时
  // exit 1 仅由越边构成，宣称 99 无人点名）
  writeFileSync(join(fixtureRoot, 'README.md'), '# 夹具\n\n共 **99** 模块（错位宣称）。\n');
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('check-topology 机器闸（复盘 20260901 T-3）', () => {
  it('净树全绿：exit 0（execFileSync 非零即抛）+ 汇总行锚（模块计数/死边零断言在）', () => {
    const stdout = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
    // 汇总锚：模块计数占位（真值由器内规则 3 对照 README 机器执法，此处不重复锚死）
    expect(stdout).toMatch(/拓扑检查通过：\d+ 个模块/);
    expect(stdout).toContain('死边零');
    expect(stdout).toContain('裸导入产码死项零'); // P1-8 汇总锚（真树产码账全对子有据）
  });

  it('违规夹具 exit 1：agent → session 越边 import 被 stderr 点名（CHECK_ROOT 根缝）', () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, CHECK_ROOT: fixtureRoot },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('agent/index.ts：agent → session 不在白名单边');
  });

  it('O-4① 锚负例：夹具 README 模块计数错位被 stderr 点名——规则 3 整块删除后本测必红', () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, CHECK_ROOT: fixtureRoot },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    // 锚面随 CHECK_ROOT 随移 + 计数对照真值恒为边表实数（内嵌脚本）——
    // 夹具宣称 99 ≠ 实数必被点名；锚规则被静默删除时此断言先红
    expect(run.stderr).toContain('README.md：模块计数宣称 99 ≠ 边表实数');
  });

  it('P1-8 裸导入死项断言在岗：空席夹具的产码死项被 stderr 点名（整块删除后本测必红）', () => {
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, CHECK_ROOT: fixtureRoot },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    // 空席夹具零产码 import → 产码账全对子皆死项；点名任一具体对子即证明断言在岗
    //（断言块被静默删除 / 证据口径误含测试文件时此断言先红——成熟度扫描 20260901 P1-8）
    expect(run.stderr).toContain('BARE_IMPORTS 产码死项：typebox → contracts');
  });

  it('P1-8 两账分离：测试账对子测试文件放行 + 产码文件拒收（typebox → app 形）', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'berry-check-topo-p18-'));
    try {
      for (const mod of SEATS) {
        const dir = join(root2, 'src', mod);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.ts'), '');
      }
      // 组合根纪律段读此文件——缺失会 ENOENT 崩脚本（空档即可）
      writeFileSync(join(root2, 'src', 'app', 'assembly.ts'), '');
      // 测试文件引用 typebox（测试账对子）——合法，stderr 不得点名本文件
      writeFileSync(join(root2, 'src', 'app', 'dogfood-fixture.test.ts'), "import { Type } from 'typebox';\n");
      // 产码文件引用同包——产码账已无 app 键（两账分离），必点名
      writeFileSync(join(root2, 'src', 'app', 'evil.ts'), "import { Type } from 'typebox';\n");
      const run = spawnSync(process.execPath, [SCRIPT], {
        cwd: ROOT,
        env: { ...process.env, CHECK_ROOT: root2 },
        encoding: 'utf8',
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('app/evil.ts：模块 app 不允许裸导入 typebox');
      // 反向锁：并查退化成只查产码账时，测试文件将被误点名——本行先红
      expect(run.stderr).not.toContain('dogfood-fixture');
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});
