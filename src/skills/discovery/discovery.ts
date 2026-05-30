import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MtimeCache } from '../storage/mtime-cache.js';
import { type DiscoveredSkill, type SkillSource, scanSource } from './sources.js';
import { validateSkillMarkdown } from '../registry.js';

export class SkillDiscovery {
  constructor(
    private readonly sources: SkillSource[],
    private readonly mtimeCache: MtimeCache,
  ) {}

  scanAll(): DiscoveredSkill[] {
    const byName = new Map<string, DiscoveredSkill>();

    for (const source of this.sources) {
      const discovered = scanSource(source);
      for (const skill of discovered) {
        const existing = byName.get(skill.name);
        if (!existing || skill.priority > existing.priority) {
          byName.set(skill.name, skill);
        }
      }
    }

    const results = [...byName.values()];
    for (const skill of results) {
      this.mtimeCache.update(skill.filePath);
    }
    this.mtimeCache.save();

    return results;
  }

  scanIncremental(): { changed: DiscoveredSkill[]; removed: string[] } {
    const all = new Map<string, DiscoveredSkill>();

    for (const source of this.sources) {
      const discovered = scanSource(source);
      for (const skill of discovered) {
        const existing = all.get(skill.name);
        if (!existing || skill.priority > existing.priority) {
          all.set(skill.name, skill);
        }
      }
    }

    const changed: DiscoveredSkill[] = [];
    for (const skill of all.values()) {
      if (this.mtimeCache.isChanged(skill.filePath)) {
        changed.push(skill);
        this.mtimeCache.update(skill.filePath);
      }
    }

    const currentPaths = new Set([...all.values()].map(s => s.filePath));
    const removed: string[] = [];
    for (const [path] of Object.entries(this.mtimeCache.getAll())) {
      if (!currentPaths.has(path)) {
        removed.push(path);
        this.mtimeCache.remove(path);
      }
    }

    if (changed.length > 0 || removed.length > 0) {
      this.mtimeCache.save();
    }

    return { changed, removed };
  }

  async importFromUrl(url: string, targetDir: string, overrideName?: string): Promise<DiscoveredSkill> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`获取远程技能失败: ${response.status} ${response.statusText}`);
    }

    const content = await response.text();
    const validation = validateSkillMarkdown(content);
    if (!validation.ok) {
      throw new Error(`远程技能验证失败: ${validation.errors.join('; ')}`);
    }

    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const name = overrideName ?? nameMatch?.[1]?.trim() ?? 'imported-skill';
    const skillDir = join(targetDir, name);
    const filePath = join(skillDir, 'SKILL.md');

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');

    const { statSync } = await import('node:fs');
    const stat = statSync(filePath);
    this.mtimeCache.update(filePath);
    this.mtimeCache.save();

    return {
      name,
      filePath,
      skillDir,
      source: 'url',
      priority: 4,
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  }

  getSourceDirs(): string[] {
    return this.sources.map(s => s.directory).filter(d => existsSync(d));
  }
}
