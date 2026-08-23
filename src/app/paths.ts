/**
 * L5 app — 数据目录与路径解析（技术栈篇 §8 六件套之 5/6：`~/.berry` + `APP_*` 前缀）。
 *
 * 唯一入口三函数：数据目录、库文件路径、建档。测试注入首选 `APP_DATA_DIR` /
 * `APP_DB_PATH` 环境变量（与生产路径完全同构）；内存库直接传 `:memory:`。
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 数据目录（`APP_DATA_DIR` env 覆盖 → 缺省 `~/.berry`） */
export function dataDir(): string {
  return process.env['APP_DATA_DIR'] ?? join(homedir(), '.berry');
}

/** 会话库文件路径（`APP_DB_PATH` env 覆盖 → 缺省 `<数据目录>/sessions.db`） */
export function dbPath(): string {
  return process.env['APP_DB_PATH'] ?? join(dataDir(), 'sessions.db');
}

/** 确保数据目录存在（幂等；首次启动建档——库文件由 SQLite 自建，此处只管目录） */
export function ensureDataDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
