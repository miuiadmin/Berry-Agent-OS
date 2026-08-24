/**
 * L5 app — 数据目录与路径解析（技术栈篇 §8 六件套之 5/6：`~/.berry` + `APP_*` 前缀）。
 *
 * 唯一入口三函数：数据目录、库文件路径、建档。测试注入首选 `APP_DATA_DIR` /
 * `APP_DB_PATH` 环境变量（与生产路径完全同构）；内存库直接传 `:memory:`。
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 数据目录（`APP_DATA_DIR` env 覆盖 → 缺省 `~/.berry`） */
export function dataDir(): string {
  return process.env['APP_DATA_DIR'] ?? join(homedir(), '.berry');
}

/** 会话库文件路径（`APP_DB_PATH` env 覆盖 → 缺省 `<数据目录>/sessions.db`） */
export function dbPath(): string {
  return process.env['APP_DB_PATH'] ?? join(dataDir(), 'sessions.db');
}

/** 确保库文件父目录存在（幂等 recursive mkdir；库文件由 SQLite 自建，此处只管目录）。
 * 建档点定死「库文件父目录」而非数据目录：缺省路径下二者同一目录，显式
 * APP_DB_PATH / 测试注入路径同样覆盖到位（2026-08-25 修——原 ensureDataDir
 * 只建数据目录，显式库路径父目录不存在仍 ENOENT；深读 workflow 实证缺口）。
 * 三入口共用的唯一建档点，经组合根 ③ 落地。 */
export function ensureDbDir(file: string): string {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  return dir;
}
