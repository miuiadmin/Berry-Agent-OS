/**
 * L1 persist — 第六键 `berryagent/sqlite` 注入物工厂（契约篇 §1.2 注记①，
 * 2026-08-26 挖矿批 P0-2）。
 *
 * 应用自管持久化的正路（对比三家生态读码反模式「直读宿主私有库」）：宿主
 * **同实例** better-sqlite3 + 主库路径 fail-loud 拒开——应用拿到的 openDatabase
 * 与宿主 Persistence 是同一份 better-sqlite3 模块实例（版本/行为一致），但永远
 * 开不出宿主主库的句柄（会话/凭证/模型目录是宿主私有面，读 = 越权）。
 *
 * 拓扑护栏：本工厂由组合根创建后经参数注入加载器（context 模块）——persist
 * 不被 context 依赖，模块 DAG 不变。
 */

import Database from 'better-sqlite3';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError, APP_MAIN_DB_FORBIDDEN } from '../contracts/errors.js';

/** 第六键面：应用经 `berryagent/sqlite` 虚拟面取到的对象形（openDatabase 即其成员） */
export interface AppSqliteFace {
  /**
   * 打开应用自管库（better-sqlite3 全量 Database 实例——自管库不强制 readonly，
   * 读写权限是应用自己的领地；主库路径命中即抛 APP_MAIN_DB_FORBIDDEN）。
   * 路径解析相对进程 cwd（与 better-sqlite3 直用同语义）；':memory:' 恒放行
   * （内存库不落盘，与主库文件路径无碰撞可能）。
   */
  openDatabase(path: string, options?: Database.Options): Database.Database;
}

/** realpath 容错：目标不存在（尚未创建的新库）或不可达时回退字面 resolve 结果 */
function realpathIfPossible(absolutePath: string): string {
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * 创建第六键注入物。mainDbPath 必须与宿主 Persistence 开库路径**同源解析**
 * （组合根传装配序 ③ 的 resolvedDbPath——APP_DB_PATH 覆盖已计入其中），
 * realpath 归一后作为拒开比对基准：symlink 别名指向主库同样命中。
 */
export function createAppSqliteFace(mainDbPath: string): AppSqliteFace {
  // 内存主库（测试/:memory: 装配）无文件身份——基准为字面 ':memory:'，
  // 只拦文件路径撞名；应用开 :memory: 在下方恒放行分支，逻辑自洽
  const mainAbs = mainDbPath === ':memory:' ? mainDbPath : realpathIfPossible(resolve(mainDbPath));
  return {
    openDatabase(path: string, options?: Database.Options): Database.Database {
      // 内存库不落盘——与文件主库无碰撞可能，恒放行（含主库本身是 :memory: 的装配形态）
      if (path === ':memory:') return new Database(':memory:', options);
      // realpath 归一后比对：字面相等或 symlink 归一相等都算命中主库
      const target = realpathIfPossible(resolve(path));
      if (target === mainAbs) {
        throw new AppError(
          APP_MAIN_DB_FORBIDDEN,
          `拒开宿主主库（${mainAbs}）——会话/凭证/模型目录是宿主私有面；` +
            `应用自管库请用自身数据目录内的路径（ctx.paths.appDataDir），或 ':memory:'`,
        );
      }
      return new Database(target, options);
    },
  };
}
