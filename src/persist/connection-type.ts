/**
 * L1 persist — better-sqlite3 连接类型的模块内出口。
 * better-sqlite3 裸导入仅 persist 白名单（拓扑门禁）；业务模块（memory 等）对自带
 * 表族的 DAO 需要 Connection 类型，经本文件 + index.ts 再导出取用——不引入裸依赖。
 */
export type { Database as DatabaseConnection } from 'better-sqlite3';
