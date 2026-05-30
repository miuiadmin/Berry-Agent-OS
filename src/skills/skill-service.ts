import type { Database } from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { MtimeCache } from './storage/mtime-cache.js';
import { SkillTelemetry } from './storage/telemetry.js';
import { SkillDiscovery } from './discovery/discovery.js';
import { createSources } from './discovery/sources.js';
import type { DiscoveredSkill } from './discovery/sources.js';
import { SkillContentLoader } from './loader/loader.js';
import type { LoadedSkill } from './loader/loader.js';
import { ActivationEngine } from './activation/activation.js';
import type { ActivationContext } from './activation/activation.js';
import { SkillExecutor } from './execution/executor.js';
import type { SkillExecuteArgs, SkillExecuteResult } from './execution/executor.js';
import { SkillPromptBuilder } from './prompt/builder.js';
import type { PromptBuildOptions } from './prompt/builder.js';
import { SkillWatcher } from './watcher.js';
import { SkillsRegistry } from './registry.js';
import type { SkillDraftInput, SkillManifest } from '../contracts/skills.js';
import type { ISkillLoader } from './contract.js';
import { getSkillsDir, getAppHome } from '../utils/paths.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('skill-service');
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SkillServiceDeps {
  db: Database;
  userSkillsDir?: string;
  projectSkillsDir?: string;
  activationContext?: Partial<ActivationContext>;
}

export interface SkillListOptions {
  includeDisabled?: boolean;
  origin?: string;
  tag?: string;
}

export class SkillService implements ISkillLoader {
  private discovery: SkillDiscovery;
  private contentLoader: SkillContentLoader;
  private activation: ActivationEngine;
  private executor: SkillExecutor;
  private promptBuilder: SkillPromptBuilder;
  private telemetry: SkillTelemetry;
  private mtimeCache: MtimeCache;
  private watcher: SkillWatcher;
  private registry: SkillsRegistry;
  private initialized = false;

  constructor(private readonly deps: SkillServiceDeps) {
    const userDir = deps.userSkillsDir ?? getSkillsDir();
    const bundledDir = join(__dirname, 'bundled');
    const cachePath = join(getAppHome(), 'cache', 'skills-mtime.json');

    this.mtimeCache = new MtimeCache(cachePath);
    this.mtimeCache.load();

    const sources = createSources({
      bundledDir,
      userDir,
      projectDir: deps.projectSkillsDir,
    });

    this.discovery = new SkillDiscovery(sources, this.mtimeCache);
    this.contentLoader = new SkillContentLoader();
    this.activation = new ActivationEngine(deps.activationContext);
    this.executor = new SkillExecutor();
    this.promptBuilder = new SkillPromptBuilder();
    this.telemetry = new SkillTelemetry(deps.db);
    this.registry = new SkillsRegistry(deps.db, userDir);

    this.watcher = new SkillWatcher(
      { initialize: () => {}, refresh: () => this.refresh(), buildPromptBlock: () => '', getLoaded: () => [], getContent: () => undefined },
      { onRefresh: () => logger.debug('技能文件变更已刷新') },
    );
  }

  initialize(): void {
    if (this.initialized) return;

    const discovered = this.discovery.scanAll();
    this.contentLoader.loadAll(discovered);
    this.syncTelemetryRows(discovered);

    const watchDirs = this.discovery.getSourceDirs();
    for (const dir of watchDirs) {
      this.watcher.watch(dir);
    }

    this.initialized = true;
    logger.info({ count: this.contentLoader.size() }, '技能系统初始化完成');
  }

  refresh(): void {
    const { changed, removed } = this.discovery.scanIncremental();

    for (const path of removed) {
      this.contentLoader.invalidateByPath(path);
    }

    if (changed.length > 0) {
      this.contentLoader.loadAll(changed);
      this.syncTelemetryRows(changed);
    }

    logger.debug({ changed: changed.length, removed: removed.length }, '增量刷新完成');
  }

  // === Query API ===

  list(opts?: SkillListOptions): LoadedSkill[] {
    let skills = this.contentLoader.getAll();

    if (!opts?.includeDisabled) {
      const disabledNames = this.getDbDisabledNames();
      skills = skills.filter(s => !s.frontmatter.disabled && !disabledNames.has(s.name));
    }
    if (opts?.origin) {
      skills = skills.filter(s => s.frontmatter.origin === opts.origin);
    }
    if (opts?.tag) {
      skills = skills.filter(s => s.frontmatter.tags?.includes(opts.tag!));
    }

    return skills;
  }

  listActive(): LoadedSkill[] {
    const disabledNames = this.getDbDisabledNames();
    const all = this.contentLoader.getAll().filter(s => !disabledNames.has(s.name));
    return this.activation.filter(all);
  }

  get(name: string): LoadedSkill | undefined {
    return this.contentLoader.get(name);
  }

  async executeContent(name: string, args?: SkillExecuteArgs): Promise<SkillExecuteResult | null> {
    const skill = this.contentLoader.get(name);
    if (!skill) return null;

    this.telemetry.bumpView(name);
    return this.executor.execute(skill, args);
  }

  // === Mutation API ===

  createGeneratedSkill(input: SkillDraftInput): SkillManifest {
    const manifest = this.registry.createOrUpdateGeneratedSkill(input);
    this.refreshSingle(manifest.name, manifest.filePath);
    this.telemetry.recordEvent(manifest.name, 'created', { origin: 'generated' });
    return manifest;
  }

  createUserSkill(input: { name: string; description: string; content?: string }): SkillManifest {
    const manifest = this.registry.createUserSkill(input);
    this.refreshSingle(manifest.name, manifest.filePath);
    this.telemetry.recordEvent(manifest.name, 'created', { origin: 'user' });
    return manifest;
  }

  async importFromUrl(url: string): Promise<SkillManifest> {
    const userDir = this.deps.userSkillsDir ?? getSkillsDir();
    const discovered = await this.discovery.importFromUrl(url, userDir);
    const loaded = this.contentLoader.loadSingle(discovered);
    if (!loaded) throw new Error('导入技能加载失败');

    this.telemetry.ensureRow(loaded.name);
    this.telemetry.updateManifestRow(loaded.name, {
      description: loaded.frontmatter.description,
      filePath: loaded.filePath,
      origin: 'user',
    });
    this.telemetry.recordEvent(loaded.name, 'imported', { url });

    return {
      id: loaded.name,
      name: loaded.name,
      version: loaded.frontmatter.version,
      description: loaded.frontmatter.description,
      origin: 'user',
      filePath: loaded.filePath,
      disabled: false,
      createdBy: 'user',
      state: 'active',
      modelInvocable: loaded.frontmatter.model_invocable,
      descriptionHidden: loaded.frontmatter.description_hidden,
    };
  }

  // === Prompt ===

  buildPromptBlock(mode?: string, maxChars?: number): string;
  buildPromptBlock(opts?: PromptBuildOptions): string;
  buildPromptBlock(modeOrOpts?: string | PromptBuildOptions, maxChars?: number): string {
    const active = this.listActive();
    if (typeof modeOrOpts === 'string' || modeOrOpts === undefined && maxChars !== undefined) {
      return this.promptBuilder.buildBlock(active, {
        maxDescriptionChars: maxChars,
      });
    }
    return this.promptBuilder.buildBlock(active, modeOrOpts as PromptBuildOptions | undefined);
  }

  // === ISkillLoader compatibility ===

  getLoaded(): Array<{ name: string; content: string }> {
    return this.listActive().map(s => ({ name: s.name, content: s.rawContent }));
  }

  getContent(name: string): string | undefined {
    const skill = this.contentLoader.get(name);
    return skill?.rawContent;
  }

  // === Telemetry ===

  recordView(name: string): void {
    this.telemetry.bumpView(name);
  }

  recordOutcome(name: string, success: boolean): void {
    this.telemetry.recordOutcome(name, success);
    this.telemetry.recordEvent(name, 'executed', { success });

    const skill = this.contentLoader.get(name);
    if (skill) {
      this.executor.onComplete(skill, success).catch(() => {});
    }
  }

  recordPatch(name: string): void {
    this.telemetry.bumpPatch(name);
  }

  // === Activation ===

  updateActivationContext(partial: Partial<ActivationContext>): void {
    this.activation.updateContext(partial);
  }

  // === Internals ===

  getRegistry(): SkillsRegistry {
    return this.registry;
  }

  dispose(): void {
    this.watcher.dispose();
  }

  private getDbDisabledNames(): Set<string> {
    const rows = this.deps.db.prepare(
      `SELECT name FROM skills_meta WHERE disabled = 1`,
    ).all() as Array<{ name: string }>;
    return new Set(rows.map(r => r.name));
  }

  private syncTelemetryRows(discovered: DiscoveredSkill[]): void {
    for (const item of discovered) {
      const loaded = this.contentLoader.get(item.name);
      if (loaded) {
        this.telemetry.ensureRow(loaded.name);
        this.telemetry.updateManifestRow(loaded.name, {
          version: loaded.frontmatter.version,
          description: loaded.frontmatter.description,
          filePath: loaded.filePath,
          origin: loaded.frontmatter.origin,
          disabled: loaded.frontmatter.disabled,
        });
      }
    }
  }

  private refreshSingle(name: string, filePath: string): void {
    try {
      const stat = statSync(filePath);
      const discovered: DiscoveredSkill = {
        name,
        filePath,
        skillDir: dirname(filePath),
        source: 'user',
        priority: 2,
        mtime: stat.mtimeMs,
        size: stat.size,
      };
      this.contentLoader.loadSingle(discovered);
      this.mtimeCache.update(filePath);
      this.mtimeCache.save();
    } catch {
      logger.warn({ name, filePath }, '单个技能刷新失败');
    }
  }
}
