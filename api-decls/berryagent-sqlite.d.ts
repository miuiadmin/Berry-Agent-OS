/**
 * 虚拟模块 `berryagent/sqlite` 的类型面（第六虚拟键——宿主同实例 better-sqlite3）。
 * 运行时注入物 = persist 模块 createAppSqliteFace() 产物（主库拒开包装）；
 * 类型面以 indexed access 从 AppSqliteFace 派生——单源不重抄签名。
 *
 * 本文件由 tools/generate-api-decls.mjs 生成（declare 行从面快照 Face 键集派生）——勿手编。
 */
import type { AppSqliteFace } from '../persist/app-sqlite.js';

export declare const openDatabase: AppSqliteFace['openDatabase'];
