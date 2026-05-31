/**
 * 原子文件写入
 *
 * 使用 write-to-temp + rename 模式，防止崩溃时写入半截文件。
 * rename() 在 POSIX 上是原子操作，Windows 上近似原子。
 */

import { writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

/** 原子写入 YAML 配置文件 */
export function atomicWriteYaml(
  filePath: string,
  data: Record<string, unknown>,
): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.config.tmp.${process.pid}`);
  const content = stringifyYaml(data, { lineWidth: 120 });
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

/** 深合并两个配置对象（source 覆盖 target） */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
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

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}
