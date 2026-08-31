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

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'berry-check-topo-fix-'));
  // 边表全席空目录：席缺失本身是「无对应模块目录」违规（口径③）——全席在场让
  // 夹具红聚焦在目标越边上（死边违规是空档的自然产物，见头注）
  const modules = [
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
  for (const mod of modules) {
    const dir = join(fixtureRoot, 'src', mod);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.ts'), '');
  }
  // 目标违规：agent → session 不在 agent 白名单边（agent 仅许 contracts）
  writeFileSync(join(fixtureRoot, 'src', 'agent', 'index.ts'), "import type { X } from '../session/index.js';\n");
  // 组合根纪律段可读即可（空档两道正则皆不匹配）
  writeFileSync(join(fixtureRoot, 'src', 'app', 'assembly.ts'), '');
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
});
