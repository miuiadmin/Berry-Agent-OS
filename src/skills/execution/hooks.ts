import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SkillFrontmatter } from '../loader/frontmatter.js';
import { getLogger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = getLogger('skill-hooks');

export type HookName = 'before_execution' | 'after_execution' | 'on_error';

export interface HookResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runHook(
  hookName: HookName,
  frontmatter: SkillFrontmatter,
  skillDir: string,
): Promise<HookResult | null> {
  const hook = frontmatter.hooks?.[hookName];
  if (!hook) return null;

  const start = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', hook.command], {
      cwd: skillDir,
      timeout: hook.timeout,
      maxBuffer: 64 * 1024,
    });

    const durationMs = Date.now() - start;
    logger.debug({ hookName, skillName: frontmatter.name, durationMs }, 'Hook 执行成功');
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.warn({ hookName, skillName: frontmatter.name, err, durationMs }, 'Hook 执行失败');
    return { ok: false, stdout: '', stderr: (err as Error).message, durationMs };
  }
}

export function hasHook(hookName: HookName, frontmatter: SkillFrontmatter): boolean {
  return !!frontmatter.hooks?.[hookName];
}
