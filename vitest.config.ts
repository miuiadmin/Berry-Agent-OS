import { defineConfig, configDefaults } from 'vitest/config';

/**
 * 1.0 测试配置（技术栈篇 §2.3：CI 门禁四件之一）——projects 双轨
 * （2026-09-02 成熟度扫描 20260901 P1-3，契约篇 §6.8 CR-7 落轨）：
 * - node 轨（常规）：测试文件与被测模块同目录（src/<模块>/*.test.ts），只覆盖
 *   本模块与跨 contract 的公开面；client 子树本轨排除（node environment 对
 *   DOM 测试必炸——排除理由自 CR-7 起不变，只是排除形态从 include 否定条目
 *   收敛为 exclude 显式条目，见下方「coverage 相容性」注记）。
 * - webui-client 轨：SPA 组件测试（.test.tsx，environment jsdom +
 *   @testing-library/react）——投影→组件数据流回归锁；include 只收 client
 *   子树，与 node 轨互不收对方文件；不挂 setupFiles（零宿主运行时依赖）。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
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
          include: [
            'src/**/*.test.ts',
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
          // client 子树本轨排除（CR-7 落轨——jsdom 轨收编后排除仍在：域不同不混跑）。
          // coverage 相容性（基建大扫 #18）：排除形态必须走 exclude 显式条目，
          // 禁 include 内否定条目（'!src/webui/client/**'）——该形态与 v8 coverage
          // 收集判定相互作用把全部文件的应收集位翻掉（vitest 4 实证：include 带
          // 否定条目时 --coverage 全仓 0/0，exclude 写法收集正常）。二分定位
          // 2026-09-02，字面 include 对照 100% 复现。
          exclude: [...configDefaults.exclude, 'src/webui/client/**'],
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
          // 覆盖率测量面（基建大扫 #18，非门禁诊断）：npm run test:coverage——
          // 给扫雷指路（按未覆盖分支切入）不执法（不设阈值红线）。vitest projects
          // 模式 coverage 配置入 project 才生效（顶层配置不向 projects 传导——
          // 实证顶层配 0/0）；include 显式钉 src 产码面（.ts/.tsx），测试文件由
          // provider 默认排除面覆盖（*.test.* 自带排除）。jsdom 轨不配——本轨
          // include 已含 client 子树产物，两轨各自 --coverage 时同源合并单报告。
          coverage: {
            provider: 'v8',
            include: ['src/**/*.ts', 'src/webui/client/**/*.tsx'],
            // 诊断报告本地产物——禁入库（.gitignore 已收 coverage/）
            reportsDirectory: 'coverage',
            reporter: ['text', 'text-summary'],
          },
        },
      },
      {
        test: {
          name: 'webui-client',
          // SPA 组件测试轨（P1-3）：只收 client 子树 .test.tsx；环境 jsdom（DOM 面）
          // 不挂 setupFiles——jsdom 轨零宿主运行时依赖，数据目录钉扎与本轨无关
          include: ['src/webui/client/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
