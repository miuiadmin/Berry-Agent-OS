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
import { chmodSync, realpathSync } from 'node:fs';
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
 * WAL 连接编舞共享件（主库 openStore 与官方件自管库开库同源——探矿轮八
 * #25 铁律；2026-09-01 复盘 T-2 抽取）。顺序三拍：
 * ① busy_timeout 最先——后续一切写操作（含 BEGIN IMMEDIATE）的锁等待才有界；
 * ② WAL 幂等探测——读 journal_mode 不加锁，已是 wal 跳过设置（幂等路径零锁需求）；
 * ③ 真切换短退避重试（5→15→45→135ms 同步退避，≤5 次）：WAL 切换需独占访问
 *   且其锁通道不吃 busy_timeout（SQLite 固有），双开冷启动后到者可能撞先到者
 *   微秒级切换窗——退避覆盖之；对方长持锁（非切换窗）最终仍响亮抛 BUSY，
 *   不做无限等待。
 *
 * @param db 待编舞的连接（调用方自 new；synchronous 等连接级强度设置归调用方）
 * @param opts.busyTimeoutMs 锁等待上限（缺省 5000ms——与主库同拍）
 */
export function prepareWalConnection(db: Database.Database, opts?: { busyTimeoutMs?: number }): void {
  db.pragma(`busy_timeout = ${opts?.busyTimeoutMs ?? 5000}`);
  if ((db.pragma('journal_mode', { simple: true }) as string) !== 'wal') {
    for (let attempt = 0; ; attempt++) {
      try {
        db.pragma('journal_mode = WAL');
        break;
      } catch (err) {
        if (attempt >= 4 || !String((err as Error).message).includes('database is locked')) throw err;
        // 同步退避（openStore/开库面是同步 API——Atomics.wait 不让出事件循环）
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * 3 ** attempt);
      }
    }
  }
}

/**
 * 创建第六键注入物（或官方件直连开库面）。mainDbPath 在场时必须与宿主
 * Persistence 开库路径**同源解析**（组合根传装配序 ③ 的 resolvedDbPath——
 * APP_DB_PATH 覆盖已计入其中），realpath 归一后作为拒开比对基准：symlink
 * 别名指向主库同样命中；**缺省 = 官方件直连形态**（obs 等宿主侧编译件开
 * 自管库——编译期信任边界内，拒开基准不适用；契约篇 §6.9 自管库段）。
 * 文件库开库即追打 0600（宿主主库三件 0600 同律——自管库同是私有数据面）。
 */
export function createAppSqliteFace(mainDbPath?: string): AppSqliteFace {
  // 内存主库（测试/:memory: 装配）无文件身份——基准为字面 ':memory:'，
  // 只拦文件路径撞名；应用开 :memory: 在下方恒放行分支，逻辑自洽。
  // 缺省形态（官方件直连）无拒开基准——guard 恒跳过
  const mainAbs =
    mainDbPath === undefined
      ? undefined
      : mainDbPath === ':memory:'
        ? ':memory:'
        : realpathIfPossible(resolve(mainDbPath));
  return {
    openDatabase(path: string, options?: Database.Options): Database.Database {
      // 内存库不落盘——与文件主库无碰撞可能，恒放行（含主库本身是 :memory: 的装配形态）
      if (path === ':memory:') return new Database(':memory:', options);
      // realpath 归一后比对：字面相等或 symlink 归一相等都算命中主库
      const target = realpathIfPossible(resolve(path));
      if (mainAbs !== undefined && target === mainAbs) {
        throw new AppError(
          APP_MAIN_DB_FORBIDDEN,
          `拒开宿主主库（${mainAbs}）——会话/凭证/模型目录是宿主私有面；` +
            `应用自管库请用自身数据目录内的路径（ctx.paths.appDataDir），或 ':memory:'`,
        );
      }
      const db = new Database(target, options);
      // 0600 追打（best-effort：Windows/特殊文件系统语义差异不炸开库——
      // 权限收紧是卫生件不是开工前提）
      try {
        chmodSync(target, 0o600);
      } catch {
        // 平台不支持 chmod——放行（与主库三件 0600 追打的容错口径一致）
      }
      return db;
    },
  };
}
