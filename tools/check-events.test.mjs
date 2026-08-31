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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 仓库根（本文件在 tools/ 下） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('check-events 机器闸（含应用声明层，第四十六批）', () => {
  it('全绿：五族双向一致 + 汇总行报应用声明计数（exit 0 由 execFileSync 非零即抛保证）', () => {
    const stdout = execFileSync(process.execPath, [join('tools', 'check-events.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    // 声明层计数锚：obs/alert 在册即 ≥1；并集被拆掉则脚本已红（到不了断言）
    expect(stdout).toMatch(/另应用声明 \d+ 词/);
  });
});
