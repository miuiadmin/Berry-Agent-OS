import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredSkill } from '../discovery/sources.js';
import type { SkillFrontmatter } from './frontmatter.js';
import { parseFrontmatter, stripFrontmatter } from './frontmatter.js';
import { scanContextFile } from '../../safety/context-file-scanner.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('skill-loader');

export interface SkillLinkedFiles {
  references: string[];
  templates: string[];
  scripts: string[];
  assets: string[];
}

export interface LoadedSkill {
  name: string;
  frontmatter: SkillFrontmatter;
  rawContent: string;
  filePath: string;
  skillDir: string;
  origin: SkillFrontmatter['origin'];
  source: DiscoveredSkill['source'];
  priority: number;
  linkedFiles: SkillLinkedFiles;
  charCount: number;
  mtime: number;
}

export class SkillContentLoader {
  private cache = new Map<string, LoadedSkill>();

  loadAll(discovered: DiscoveredSkill[]): void {
    for (const item of discovered) {
      const loaded = this.loadSingle(item);
      if (loaded) {
        this.cache.set(loaded.name, loaded);
      }
    }
  }

  loadSingle(discovered: DiscoveredSkill): LoadedSkill | null {
    try {
      const content = readFileSync(discovered.filePath, 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm) return null;

      // §9.0 M11: Scan for prompt injection before loading
      const scan = scanContextFile(content);
      if (!scan.safe) {
        logger.warn({ skill: fm.name ?? discovered.name, threats: scan.threats, path: discovered.filePath }, 'Skill blocked: injection patterns detected');
        return null;
      }

      const name = fm.name || discovered.name;
      const rawContent = stripFrontmatter(content);
      const linkedFiles = scanLinkedFiles(discovered.skillDir);

      const loaded: LoadedSkill = {
        name,
        frontmatter: fm,
        rawContent,
        filePath: discovered.filePath,
        skillDir: discovered.skillDir,
        origin: fm.origin,
        source: discovered.source,
        priority: discovered.priority,
        linkedFiles,
        charCount: rawContent.length,
        mtime: discovered.mtime,
      };

      this.cache.set(name, loaded);
      return loaded;
    } catch {
      return null;
    }
  }

  get(name: string): LoadedSkill | undefined {
    return this.cache.get(name);
  }

  getAll(): LoadedSkill[] {
    return [...this.cache.values()];
  }

  invalidate(name: string): void {
    this.cache.delete(name);
  }

  invalidateByPath(filePath: string): string | undefined {
    for (const [name, skill] of this.cache) {
      if (skill.filePath === filePath) {
        this.cache.delete(name);
        return name;
      }
    }
    return undefined;
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  has(name: string): boolean {
    return this.cache.has(name);
  }

  size(): number {
    return this.cache.size;
  }
}

function scanLinkedFiles(skillDir: string): SkillLinkedFiles {
  const result: SkillLinkedFiles = { references: [], templates: [], scripts: [], assets: [] };
  const dirs: Array<{ key: keyof SkillLinkedFiles; name: string }> = [
    { key: 'references', name: 'references' },
    { key: 'templates', name: 'templates' },
    { key: 'scripts', name: 'scripts' },
    { key: 'assets', name: 'assets' },
  ];

  for (const { key, name } of dirs) {
    const dir = join(skillDir, name);
    if (existsSync(dir)) {
      try {
        result[key] = readdirSync(dir).filter(f => !f.startsWith('.'));
      } catch { /* ignore */ }
    }
  }

  return result;
}
