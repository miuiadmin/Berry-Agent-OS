/**
 * 原子文件写入器
 *
 * 使用 write-to-temp + rename 模式，防止崩溃时写入半截文件。
 */

import { writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { getLogger } from '../observability/logger.js';

const logger = getLogger('config-writer');

/**
 * 原子写入 YAML 配置文件
 *
 * 1. 写入临时文件
 * 2. rename 到目标路径（POSIX 上是原子操作）
 */
export function atomicWriteYaml(
  filePath: string,
  data: Record<string, unknown>,
): void {
  const tmpPath = join(dirname(filePath), `.config.tmp.${process.pid}`);
  const content = stringifyYaml(data, { lineWidth: 120 });

  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    // 清理临时文件
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/** 深度合并两个对象（source 覆盖 target） */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (isObject(srcVal) && isObject(tgtVal)) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}
