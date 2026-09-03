/**
 * vitest setup 密封面回归锁（基建大扫 20260901 #16/#47——tools/vitest-setup.mjs
 * 的行为锁；gates-infra.test.mjs「spawn 真脚本」同款形态）。
 *
 * 锁两件：
 * 1. #47 密封半面：外层（开发者 shell / CI matrix）导出 APP_DB_PATH（优先级
 *    高于 APP_DATA_DIR 的库路径直通车——外层一旦设置，任何忘传 dbPath 的测试
 *    直写真库）或 GIT_* 全家（第五十三批 pathspec 提交向钩子导出的夹具泄漏
 *    事故族——GIT_DIR/GIT_WORK_TREE/GIT_AUTHOR_* 等任一残留都会劫持测试内
 *    spawn 的 git 错写宿主仓）时，setup 必须无条件 delete。执法形态：带哨兵
 *    外层值 spawn 单文件 vitest，子进程里本文件以第二身份再跑一遍——
 *    「干净断言」即锁；
 * 2. #16 临时目录清理：setup 每测试文件建的 berry-vitest-data-* 根须随该文件
 *    afterAll 清（本机实证曾累积 4211 个目录/13MB）。子身份经 RECORD_FILE 把
 *    自己的 APP_DATA_DIR 报给父，子进程退出后父断言该路径已不存在。
 *
 * 双身份设计：本文件被直接 vitest 跑（无哨兵/无 RECORD_FILE——断言自然绿）
 * 与被父测试 spawn 跑（外层带哨兵 + RECORD_FILE——执法形态）走同一份断言，
 * 不为测试面维护第二套探针。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// —— 子身份断言（父身份直接跑时同样成立——无哨兵即环境本就干净）——

test('#47 setup 密封：APP_DB_PATH 直通车与 GIT_* 全家外层值被无条件 delete', () => {
  assert.equal(
    process.env['APP_DB_PATH'],
    undefined,
    'APP_DB_PATH 须被 setup delete（dbPath() 优先级最高的直通车——外层残留即测试写真库）',
  );
  // 全家泛化锁（刀二）：点名断言只护 GIT_INDEX_FILE 一键——git 钩子导出键族
  // （GIT_DIR/GIT_AUTHOR_*…）任一残留都是泄漏面（劫持测试内 spawn 的 git 错写
  // 宿主仓），前缀式全收后此处恒空
  const leaked = Object.keys(process.env).filter((k) => k.startsWith('GIT_'));
  assert.deepEqual(
    leaked,
    [],
    `GIT_* 前缀键须被 setup 全家 delete（pathspec 钩子泄漏事故族——泄漏键：${leaked.join(',')}）`,
  );
});

// 子身份报备面：RECORD_FILE 在场（被 spawn）时记录本文件的数据目录——
// 父身份在子进程退出后断言其已被 afterAll 清除
test('#16 数据目录报备：RECORD_FILE 在场时记录本文件 APP_DATA_DIR', () => {
  const record = process.env['RECORD_FILE'];
  if (record !== undefined && process.env['APP_DATA_DIR'] !== undefined) {
    appendFileSync(record, `${process.env['APP_DATA_DIR']}\n`);
  }
});

// —— 父身份执法：哨兵外层值下 spawn 单文件 vitest，子进程全绿 + 目录已清 ——

// 身份闸（防递归 spawn）：RECORD_FILE 在场 = 本进程已是探针子身份——
// 跳过本测试，否则子进程再 spawn 孙进程、指数级嵌套（150s timeout 全层皆红）
test.skipIf(process.env['RECORD_FILE'] !== undefined)(
  '#47/#16 执法：哨兵外层值下子进程探针全绿 + berry-vitest-data 根已清',
  { timeout: 120_000 },
  () => {
    const record = join(mkdtempSync(join(tmpdir(), 'vitest-setup-lock-')), 'dirs.txt');
    const child = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        join(repoRoot, 'vitest.config.ts'),
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 100_000,
        env: {
          ...process.env,
          // 四哨兵：setup 修偏前会直通子进程——子身份断言即红（修前必红取证面）。
          // GIT_* 三键跨键族（索引夹具/仓定位/身份注入）证「全家前缀剥」而非点名剥
          APP_DB_PATH: join(tmpdir(), 'sentinel-not-real.db'),
          GIT_INDEX_FILE: '/sentinel/index',
          GIT_DIR: '/sentinel/repo.git',
          GIT_AUTHOR_NAME: 'sentinel-author',
          RECORD_FILE: record,
        },
      },
    );
    assert.equal(
      child.status,
      0,
      `子进程探针非零退（#47 密封失效或探针红）：\n${(child.stdout ?? '').slice(-2000)}\n${(child.stderr ?? '').slice(-2000)}`,
    );
    // #16：子进程 afterAll 已清其数据目录（spawnSync 返回即子进程完全退出——
    // afterAll 的 rmSync 必已执行，不存在时序窗）
    const dirs = readFileSync(record, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    assert.ok(dirs.length > 0, '探针未报备任何数据目录（RECORD_FILE 链路断——锁自身失效先红）');
    for (const dir of dirs) {
      assert.equal(existsSync(dir), false, `berry-vitest-data 根未随 afterAll 清（#16）：${dir}`);
    }
    rmSync(dirname(record), { recursive: true, force: true });
  },
);
