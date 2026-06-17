/**
 * 16.0 重构——mission file I/O 辅助（从 mission-manager.ts 提取）。
 *
 * 文件路径计算 + JSON 安全读写。纯函数无状态，供 mission-manager + squad 管理共用。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAppHome } from '../../utils/paths.js';

/** 获取 missions 根目录 */
export function getMissionsDir(): string {
  return join(getAppHome(), 'missions');
}

/** 获取某个 mission 的目录 */
export function getMissionDir(missionId: string): string {
  return join(getMissionsDir(), missionId);
}

/** plan.json 路径 */
export function getPlanPath(missionId: string): string {
  return join(getMissionDir(missionId), 'plan.json');
}

/** squad.json 路径 */
export function getSquadPath(missionId: string): string {
  return join(getMissionDir(missionId), 'squad.json');
}

/** 模板目录路径 */
export function getTemplatesDir(): string {
  return join(getAppHome(), 'templates', 'mission');
}

/** JSON 文件安全读取 */
export function readJsonFile<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** JSON 文件安全写入（创建目录） */
export function writeJsonFile(path: string, data: unknown): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/** ISO 时间戳 */
export function isoNow(): string {
  return new Date().toISOString();
}
