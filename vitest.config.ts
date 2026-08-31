import { defineConfig } from 'vitest/config';

/**
 * 1.0 测试配置（技术栈篇 §2.3：CI 门禁四件之一）。
 * 测试文件与被测模块同目录（src/<模块>/*.test.ts），只覆盖本模块与跨 contract 的公开面。
 */
export default defineConfig({
  test: {
    // 金样回放轨（tools/golden/*.test.mjs）与发布机器（tools/release.test.mjs）
    // 窄面收进常规测试：.mjs 在 tsc 视野外——tsconfig include 只有 src/，typecheck
    // 不覆盖此处；回放双闸出口 process.exit 的语义靠子进程隔离完整保留，发布
    // 机器则以 io 注入缝全脚本化驱动（无真实 npm/git 调用）。
    // check-events 机器闸回归锁（第四十六批）同款收编：spawn 真脚本断言全绿
    // + 应用声明层计数锚——并集被静默拆掉先在此红。
    // client 子树显式排除（CR-7）：SPA 测试若引入需 jsdom 环境，node 环境的
    // 常规轨不收（域不同不静默跑红）
    include: [
      'src/**/*.test.ts',
      '!src/webui/client/**',
      'tools/golden/*.test.mjs',
      'tools/release.test.mjs',
      'tools/check-events.test.mjs',
    ],
    environment: 'node',
    // per-test 时限 5s → 15s（2026-09-01 存量负载 flake 勘正）：全量 16 worker
    // 并行下重载全栈用例（webui-fullstack / chat 打断族）壁钟可超 5s——HEAD
    // stash 对照实证存量（无改动同红 5007ms 级）；上限放大只影响真挂死的报红
    // 时延，不动任何行为断言。内层等待（waitFor/spin）各自的窄帽先红，外层
    // 15s 是兜底不是常态路径。
    testTimeout: 15_000,
  },
});
