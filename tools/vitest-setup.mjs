/**
 * vitest setupFiles（20260901-d #2 同类收口——测试面数据目录钉扎）。
 *
 * 背景：13 个测试文件的 createRuntime 只钉 dbPath/workspace/compositionDir，
 * 而 assembly 一批 dataDir() 调用点只认 APP_DATA_DIR env——不钉则测试对真实
 * ~/.berry 动手（磁盘实证两写点：obs 件 apply 期即开 ~/.berry/apps/obs/
 * rollup.db；self-build-loop 的 my-tool-app fixture 装进 ~/.berry/apps/）。
 *
 * 修法取「统一模型」而非 13 处逐文件补：每 worker 启动时强制钉扎缺省数据目录
 * 到临时根——单点让「测试忘了钉」这一特殊情况结构性消失。显式自钉的测试
 * （assembly.test.ts 等 set/restore 对）不受影响：其 set 晚于本 setup 生效；
 * 其 restore 回到的 prev 也从「undefined（回落真实 ~/.berry）」变为本临时根。
 * 子进程测试（spawnSync 继承 env）自动同隔离。
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 强制覆写而非 ??=：测试套件永不依赖机器本机数据目录状态（外层 env 一并隔离，
// 确定性优先——与 tools/smoke-replay.mjs 的钉扎取向同律）
process.env['APP_DATA_DIR'] = mkdtempSync(join(realpathSync(tmpdir()), 'berry-vitest-data-'));
