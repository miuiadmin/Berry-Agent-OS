import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type SkillSourceType = 'bundled' | 'user' | 'project' | 'url';

export interface SkillSource {
  type: SkillSourceType;
  directory: string;
  priority: number;
}

export interface DiscoveredSkill {
  name: string;
  filePath: string;
  skillDir: string;
  source: SkillSourceType;
  priority: number;
  mtime: number;
  size: number;
}

export function createSources(opts: {
  bundledDir: string;
  userDir: string;
  projectDir?: string;
}): SkillSource[] {
  const sources: SkillSource[] = [];

  if (existsSync(opts.bundledDir)) {
    sources.push({ type: 'bundled', directory: opts.bundledDir, priority: 1 });
  }
  if (existsSync(opts.userDir)) {
    sources.push({ type: 'user', directory: opts.userDir, priority: 2 });
  }
  if (opts.projectDir && existsSync(opts.projectDir)) {
    sources.push({ type: 'project', directory: opts.projectDir, priority: 3 });
  }

  return sources;
}

export function scanSource(source: SkillSource): DiscoveredSkill[] {
  const results: DiscoveredSkill[] = [];

  if (!existsSync(source.directory)) return results;

  let entries: string[];
  try {
    entries = readdirSync(source.directory);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const skillDir = join(source.directory, entry);
    const filePath = join(skillDir, 'SKILL.md');

    try {
      const dirStat = statSync(skillDir);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }

    if (!existsSync(filePath)) continue;

    try {
      const fileStat = statSync(filePath);
      results.push({
        name: entry,
        filePath,
        skillDir,
        source: source.type,
        priority: source.priority,
        mtime: fileStat.mtimeMs,
        size: fileStat.size,
      });
    } catch {
      continue;
    }
  }

  return results;
}
