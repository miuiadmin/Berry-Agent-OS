import type { LearningSignal } from './types.js';

export function parseLearningSignalsFromText(text: string): LearningSignal[] {
  const parsed = parseJsonArray(text);
  if (!parsed) return [];
  return parsed
    .map((item): LearningSignal | null => {
      if (item.kind !== 'skill' && item.kind !== 'plugin') return null;
      if (typeof item.targetName !== 'string' || !item.targetName) return null;
      if (typeof item.description !== 'string' || !item.description) return null;
      const riskLevel = item.riskLevel === 'low' || item.riskLevel === 'medium' || item.riskLevel === 'high'
        ? item.riskLevel
        : item.kind === 'skill' ? 'low' : 'medium';
      return {
        kind: item.kind,
        targetName: makeSafeTargetName(item.targetName, item.kind),
        description: item.description.slice(0, 240),
        observations: Array.isArray(item.observations)
          ? item.observations.filter((value): value is string => typeof value === 'string').slice(0, 5)
          : ['LLM 提出自进化信号。'],
        riskLevel,
      };
    })
    .filter((signal): signal is LearningSignal => Boolean(signal));
}

function parseJsonArray(text: string): Array<Record<string, unknown>> | null {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function makeSafeTargetName(name: string, kind: LearningSignal['kind']): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9一-龥_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  const suffix = kind === 'skill' ? 'skill' : 'plugin';
  if (!cleaned) return kind === 'skill' ? 'generated-skill' : 'generated-plugin';
  return cleaned.endsWith(`-${suffix}`) ? cleaned : `${cleaned}-${suffix}`;
}
