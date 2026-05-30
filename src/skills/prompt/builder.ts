import type { LoadedSkill } from '../loader/loader.js';
import { FULL_GUIDANCE, SUMMARY_GUIDANCE, NAMES_ONLY_GUIDANCE } from './guidance.js';

export interface PromptBuildOptions {
  contextTokens?: number;
  maxDescriptionChars?: number;
}

export type PromptTier = 'full' | 'hybrid' | 'summary' | 'names-only';

export class SkillPromptBuilder {
  private maxDescChars: number;

  constructor(opts?: { maxDescriptionChars?: number }) {
    this.maxDescChars = opts?.maxDescriptionChars ?? 512;
  }

  buildBlock(skills: LoadedSkill[], opts?: PromptBuildOptions): string {
    if (skills.length === 0) return '';

    const budget = this.calculateBudget(opts?.contextTokens);
    const sorted = [...skills].sort((a, b) =>
      (b.frontmatter.prompt_priority ?? 0) - (a.frontmatter.prompt_priority ?? 0),
    );

    const autoLoad = sorted.filter(s => s.frontmatter.auto_load);
    const normal = sorted.filter(s => !s.frontmatter.auto_load);

    const fullBlock = this.renderFull([...autoLoad, ...normal]);
    if (fullBlock.length <= budget) return this.wrap(fullBlock, 'full');

    const hybridBlock = this.renderHybrid(autoLoad, normal);
    if (hybridBlock.length <= budget) return this.wrap(hybridBlock, 'hybrid');

    const summaryBlock = this.renderSummary([...autoLoad, ...normal]);
    if (summaryBlock.length <= budget) return this.wrap(summaryBlock, 'summary');

    return this.wrap(this.renderNamesOnly([...autoLoad, ...normal]), 'names-only');
  }

  getTier(skills: LoadedSkill[], opts?: PromptBuildOptions): PromptTier {
    if (skills.length === 0) return 'names-only';
    const budget = this.calculateBudget(opts?.contextTokens);
    const sorted = [...skills].sort((a, b) =>
      (b.frontmatter.prompt_priority ?? 0) - (a.frontmatter.prompt_priority ?? 0),
    );
    const autoLoad = sorted.filter(s => s.frontmatter.auto_load);
    const normal = sorted.filter(s => !s.frontmatter.auto_load);

    if (this.renderFull([...autoLoad, ...normal]).length <= budget) return 'full';
    if (this.renderHybrid(autoLoad, normal).length <= budget) return 'hybrid';
    if (this.renderSummary([...autoLoad, ...normal]).length <= budget) return 'summary';
    return 'names-only';
  }

  private calculateBudget(contextTokens = 200_000): number {
    return Math.floor(contextTokens * 4 * 0.01);
  }

  private renderFull(skills: LoadedSkill[]): string {
    const blocks = skills.map(s => `<skill name="${s.name}">\n${s.rawContent}\n</skill>`);
    return `${FULL_GUIDANCE}\n\n${blocks.join('\n\n')}`;
  }

  private renderHybrid(autoLoad: LoadedSkill[], normal: LoadedSkill[]): string {
    const parts: string[] = [];

    if (autoLoad.length > 0) {
      parts.push(FULL_GUIDANCE);
      parts.push('');
      for (const s of autoLoad) {
        parts.push(`<skill name="${s.name}">\n${s.rawContent}\n</skill>`);
      }
    }

    if (normal.length > 0) {
      parts.push('');
      parts.push(SUMMARY_GUIDANCE);
      parts.push('');
      for (const s of normal) {
        parts.push(this.formatSummaryLine(s));
      }
    }

    return parts.join('\n');
  }

  private renderSummary(skills: LoadedSkill[]): string {
    const lines = skills.map(s => this.formatSummaryLine(s)).join('\n');
    return `${SUMMARY_GUIDANCE}\n\n${lines}`;
  }

  private renderNamesOnly(skills: LoadedSkill[]): string {
    const lines = skills.map(s => `- ${s.name}`).join('\n');
    return `${NAMES_ONLY_GUIDANCE}\n\n${lines}`;
  }

  private formatSummaryLine(skill: LoadedSkill): string {
    const fm = skill.frontmatter;
    if (fm.description_hidden) return `- **${skill.name}**`;
    const raw = fm.when_to_use
      ? `${fm.description}（${fm.when_to_use}）`
      : fm.description;
    return `- **${skill.name}** — ${this.truncate(raw)}`;
  }

  private truncate(text: string): string {
    if (text.length <= this.maxDescChars) return text;
    return text.slice(0, this.maxDescChars - 3) + '...';
  }

  private wrap(inner: string, _tier: PromptTier): string {
    return `<berry-skills>\n${inner}\n</berry-skills>`;
  }
}
