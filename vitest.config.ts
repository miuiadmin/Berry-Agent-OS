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
    // check-topology / check-tense 两闸自测（复盘 20260901 T-3）再同款收编：
    // 净树 exit 0 + CHECK_ROOT 夹具 exit 1——侦测能力回归锁，扫描静默退化
    // （假绿）先在测试面红。
    // 门禁基建自测（基建大扫 20260901 #19/#20）同款收编：CI 工作流四门禁 +
    // fetch-depth 0 锚 / pre-commit 钩子四门 + 可执行位 / install-hooks 真跑
    // 双场景——基建面的形态锁（缺席即红，同 release.test.mjs 锁 package.json
    // 字段先例）。
    // client 子树显式排除（CR-7）：SPA 测试若引入需 jsdom 环境，node 环境的
    // 常规轨不收（域不同不静默跑红）
    include: [
      'src/**/*.test.ts',
      '!src/webui/client/**',
      'tools/golden/*.test.mjs',
      'tools/release.test.mjs',
      'tools/check-events.test.mjs',
      'tools/check-topology.test.mjs',
      'tools/check-tense.test.mjs',
      'tools/gates-infra.test.mjs',
      // vitest setup 密封面锁（基建大扫 #16/#47）：双身份探针——spawn 单文件
      // vitest 执法（哨兵外层值须被 delete + 临时根随 afterAll 清）
      'tools/vitest-setup.test.mjs',
      // 冒烟代理 provider 共享层回归锁（基建大扫 #34）：两炮样板收编单点后的
      // 构造面形态锁——真模型炮 CI 无 key 跑不了，漂移先在此红
      'tools/smoke-provider.test.mjs',
    ],
    environment: 'node',
    // 每测试文件数据目录钉扎（20260901-d #2 同类；基建大扫 #16 勘正：setupFiles
    // 每测试文件执行一次——isolate 缺省真，非每 worker）：setupFiles 强制
    // APP_DATA_DIR 到临时根——13 个未自钉的 createRuntime 测试文件不再对真实
    // ~/.berry 写（obs rollup.db / my-tool-app fixture 两写点磁盘实证）；显式
    // 自钉的测试 set 晚于 setup 生效、restore 落回临时根，行为不变；
    // #16/#47 密封面锁 = tools/vitest-setup.test.mjs（清理 + env delete）。
    setupFiles: ['tools/vitest-setup.mjs'],
    // per-test 时限 5s → 15s（2026-09-01 存量负载 flake 勘正）：全量 16 worker
    // 并行下重载全栈用例（webui-fullstack / chat 打断族）壁钟可超 5s——HEAD
    // stash 对照实证存量（无改动同红 5007ms 级）；上限放大只影响真挂死的报红
    // 时延，不动任何行为断言。内层等待（waitFor/spin）各自的窄帽先红，外层
    // 15s 是兜底不是常态路径。
    testTimeout: 15_000,
  },
});
