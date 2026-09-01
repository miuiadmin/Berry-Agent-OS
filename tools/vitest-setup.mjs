/**
 * vitest setupFiles（20260901-d #2 同类收口——测试面数据目录钉扎；
 * 基建大扫 20260901 #16/#47 卫生收口）。
 *
 * 背景一（钉扎）：13 个测试文件的 createRuntime 只钉 dbPath/workspace/
 * compositionDir，而 assembly 一批 dataDir() 调用点只认 APP_DATA_DIR env——
 * 不钉则测试对真实 ~/.berry 动手（磁盘实证两写点：obs 件 apply 期即开
 * ~/.berry/apps/obs/rollup.db；self-build-loop 的 my-tool-app fixture 装进
 * ~/.berry/apps/）。修法取「统一模型」而非 13 处逐文件补：每测试文件启动时
 * 强制钉扎缺省数据目录到临时根——单点让「测试忘了钉」这一特殊情况结构性
 * 消失。显式自钉的测试（assembly.test.ts 等 set/restore 对）不受影响：其 set
 * 晚于本 setup 生效；其 restore 回到的 prev 也从「undefined（回落真实
 * ~/.berry）」变为本临时根。子进程测试（spawnSync 继承 env）自动同隔离。
 *
 * 背景二（#16 清理）：本文件每个测试文件执行一次（isolate 缺省真——非每
 * worker，vitest.config.ts 注释同笔勘正），每次 mkdtemp 一个 berry-vitest-data-*
 * 根。曾长期零清理——本机磁盘实证累积 4211 个目录（2026-09-02 刀九当夜实测
 * 恶化到 16976 个并把盘写满，ENOSPC 卡死全部命令）。修法：per-file 目录
 * per-file 清——afterAll 注册 rmSync，文件收场即清（同文件 spawn 的子进程
 * 此时已退出无占用）。行为锁 = tools/vitest-setup.test.mjs（双身份探针）。
 *
 * 背景三（#47 密封半面）：dbPath() 先认 APP_DB_PATH（优先级高于本文件的
 * APP_DATA_DIR 钉扎）——外层一旦导出该变量，任何忘传 dbPath 的测试（含
 * spawn 子进程测试继承 env）会直写操作者真库，「外层 env 一并隔离」的承诺
 * 只兑现了一半。修法同统一模型：无条件 delete（delete 而非覆写——显式
 * set/restore 测试对的 prev=undefined、restore 即 delete，语义更干净）。
 * GIT_INDEX_FILE 同笔（第五十三批 pathspec 提交向钩子导出的夹具泄漏事故族——
 * 局部密封已有，全局 delete 把事故面收死）。
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

// 强制覆写而非 ??=：测试套件永不依赖机器本机数据目录状态（外层 env 一并隔离，
// 确定性优先——与 tools/smoke-replay.mjs 的钉扎取向同律）
process.env['APP_DATA_DIR'] = mkdtempSync(join(realpathSync(tmpdir()), 'berry-vitest-data-'));

// #47 密封另一半：优先级更高的直通车与钩子夹具泄漏源无条件 delete——
// 外层残留即测试写真库/真 git 索引，与「确定性优先」承诺补齐
delete process.env['APP_DB_PATH'];
delete process.env['GIT_INDEX_FILE'];

// #16 per-file 清理：本文件收场（该测试文件全部用例结束）即删自己的临时根。
// force 容忍「测试把目录内文件还开着」的边缘形态；同文件 spawn 的子进程测试
// 在用例体内已 waitFor 退出，无占用窗口
afterAll(() => {
  rmSync(process.env['APP_DATA_DIR'] ?? '', { recursive: true, force: true });
});
