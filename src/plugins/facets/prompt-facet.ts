import type { Database } from 'better-sqlite3';
import type { PluginRecord, PromptInjectionContext } from '../../contracts/plugins-v2.js';

interface PromptItem {
  name: string;
  content: string;
  scope: string;
  priority: number;
  pinned: boolean;
}

export class PromptFacet {
  constructor(private readonly db: Database) {}

  buildPromptBlock(plugins: PluginRecord[], context: PromptInjectionContext): string {
    const { taskTags, tokenBudget } = context;

    let candidates = plugins.filter(p => p.hasPrompt && p.promptContent);

    candidates = candidates.filter(p => {
      const rules = p.promptActivationRules;
      if (!rules || rules.always) return true;
      if (!taskTags?.length || !rules.taskTags?.length) return false;
      return rules.taskTags.some(tag => taskTags.includes(tag));
    });

    candidates.sort((a, b) => {
      if (a.promptPriority !== b.promptPriority) return b.promptPriority - a.promptPriority;
      if (a.useCount !== b.useCount) return b.useCount - a.useCount;
      const scopeOrder: Record<string, number> = { private: 0, workspace: 1, global: 2 };
      return (scopeOrder[a.scope] ?? 2) - (scopeOrder[b.scope] ?? 2);
    });

    const items: PromptItem[] = [];
    let usedTokens = 0;

    for (const plugin of candidates) {
      const content = plugin.promptContent!;
      const estimatedTokens = Math.ceil(content.length / 3.5);
      if (usedTokens + estimatedTokens > tokenBudget && items.length > 0) break;
      items.push({
        name: plugin.name,
        content,
        scope: plugin.scope,
        priority: plugin.promptPriority,
        pinned: false,
      });
      usedTokens += estimatedTokens;
    }

    if (items.length === 0) return '';

    const scopeIcon: Record<string, string> = {
      private: '🔌 private',
      workspace: '🏢 workspace',
      global: '🌍 global',
    };

    const sections = items.map(item =>
      `### [${scopeIcon[item.scope] ?? item.scope}] ${item.name}\n${item.content}`
    );

    return `---\n## 可用能力\n\n${sections.join('\n\n')}\n---`;
  }
}
