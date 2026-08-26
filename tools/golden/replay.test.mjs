/**
 * 金样回放轨回归测试（2026-08-24 演进史读码行动 5 的 vitest 永久化落点）。
 *
 * 把「一次性真模型端到端冒烟」变成无 key 可重复回归：spawn 子进程跑
 * tools/smoke-replay.mjs，断言双闸出口 exit 0（流程判定 ok 且金样恰好消费尽）。
 *
 * 为什么 spawn 子进程而不是 import：smoke-replay 是脚本形态——顶层
 * process.exit 双闸出口是它语义的一部分（exit 码即回放裁决），import 即执行
 * 会把测试进程一起带走；子进程跑法完整保留双闸语义。
 *
 * 为什么是 .mjs 且在 tools/golden/：tsconfig include 只有 src/，本文件在
 * tsc 视野外（typecheck 不覆盖）；vitest include 窄面收『tools/golden/*.test.mjs』
 * 一条——只收金样回归，不把 dev 工具族整体拉进测试面。
 */

import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓根（tools/golden/ 上两级） */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('金样回放轨：无 key 确定性回归（record-once / replay-deterministic）', () => {
  const proc = spawnSync('npx', ['tsx', 'tools/smoke-replay.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // 回放本体约 1-2s + tsx 启动开销；120s 上限给慢机留足裕度
    timeout: 120_000,
  });
  // 失败时把子进程输出拼进断言消息——回放日志自带逐轮判定，红时直接可读
  const output = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  expect(proc.status, `回放退出码非 0（金样发散或流程红）\n${output}`).toBe(0);
}, 180_000);
