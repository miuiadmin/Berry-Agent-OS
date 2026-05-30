import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MtimeEntry {
  path: string;
  mtime: number;
  size: number;
}

export interface MtimeManifest {
  entries: Record<string, MtimeEntry>;
  savedAt: number;
}

export class MtimeCache {
  private manifest: MtimeManifest = { entries: {}, savedAt: 0 };

  constructor(private readonly cachePath: string) {}

  load(): MtimeManifest {
    if (existsSync(this.cachePath)) {
      try {
        const raw = readFileSync(this.cachePath, 'utf-8');
        this.manifest = JSON.parse(raw) as MtimeManifest;
      } catch {
        this.manifest = { entries: {}, savedAt: 0 };
      }
    }
    return this.manifest;
  }

  save(): void {
    this.manifest.savedAt = Date.now();
    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(this.manifest), 'utf-8');
  }

  isChanged(filePath: string): boolean {
    const cached = this.manifest.entries[filePath];
    if (!cached) return true;
    try {
      const stat = statSync(filePath);
      return stat.mtimeMs !== cached.mtime || stat.size !== cached.size;
    } catch {
      return true;
    }
  }

  update(filePath: string): void {
    try {
      const stat = statSync(filePath);
      this.manifest.entries[filePath] = {
        path: filePath,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
    } catch {
      delete this.manifest.entries[filePath];
    }
  }

  remove(filePath: string): void {
    delete this.manifest.entries[filePath];
  }

  getAll(): Record<string, MtimeEntry> {
    return this.manifest.entries;
  }

  clear(): void {
    this.manifest = { entries: {}, savedAt: 0 };
  }
}
