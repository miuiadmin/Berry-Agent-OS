/**
 * L3 memory — 合并与冲突消解三分支（记忆与自进化篇 §5，Mercury 底座平移）。
 *
 * 全确定性纯函数（无 LLM、无 IO）：精确合并（同 summary）→ 模糊合并（token 集合
 * Jaccard ≥ 0.74，Mercury 阈值实证）→ 极性冲突裁决（极性对 + 否定词检测，去极性词后
 * overlap ≥ 0.5 判同主题冲突；高 confidence 胜、相等新胜）。old-v2 knowledge-merge.ts
 * 27 测形态直接平移（commit 7fb0d8f 实证零件）。
 */

/** 模糊合并阈值：token 集合 Jaccard 相似度下限（Mercury 实证值） */
export const FUZZY_THRESHOLD = 0.74;

/** 极性冲突阈值：去极性词后的 token 重叠率下限（同主题判定） */
export const POLARITY_OVERLAP_THRESHOLD = 0.5;

/**
 * 极性对：正向/负向标记词。英文四对为 Mercury 原案平移；中文三对为起草扩展
 * （中文摘要生态下英文标记几乎不命中——标记词表是数据不是结构，随实测调）。
 * 每对内先测负向（「不喜欢」含「喜欢」，负向优先防误判正向）。
 */
const POLARITY_PAIRS: ReadonlyArray<{ positive: RegExp; negative: RegExp }> = [
  { positive: /\b(?:prefers?)\b/i, negative: /\b(?:does not prefer|doesn't prefer|avoid)s?\b/i },
  { positive: /\b(?:likes?)\b/i, negative: /\b(?:dislikes?|hates?)\b/i },
  { positive: /\b(?:wants?)\b/i, negative: /\b(?:does not want|doesn't want)\b/i },
  { positive: /\benabled\b/i, negative: /\bdisabled\b/i },
  { positive: /喜欢/, negative: /不喜欢|讨厌/ },
  { positive: /想要|需要|要求/, negative: /不想要|不需要|不要求/ },
  { positive: /总是/, negative: /从不/ },
];

/** 否定词（去极性词比对时一并剔除——否定词本身不是主题词） */
const NEGATION_PATTERN = /\b(?:not|never|no longer|avoid)\b|不再|千万别|别再/gi;

/**
 * 文本 → 小写 token 集合（Unicode 字母/数字逐段切词——中英文同形处理：
 * 中文无空格，逐字成 token 由 Jaccard 天然吃掉共字噪声，实测可调粒度）。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    tokens.add(m[0]);
  }
  return tokens;
}

/** Jaccard 相似度：|A∩B| / |A∪B|（空集对空集 = 1——完全一致） */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 摘要 token 重叠率（模糊合并比较面） */
export function overlapScore(a: string, b: string): number {
  return jaccard(tokenize(a), tokenize(b));
}

/** 文本极性：命中某极性对返回 'positive' | 'negative'，全不命中返回 undefined */
export function detectPolarity(text: string): 'positive' | 'negative' | undefined {
  for (const pair of POLARITY_PAIRS) {
    // 同对内先测负向：「不喜欢」的负向标记含正向子串，负向优先即防误判
    if (pair.negative.test(text)) return 'negative';
    if (pair.positive.test(text)) return 'positive';
  }
  return undefined;
}

/** 剥离极性标记词与否定词后的 token 集合（同主题冲突判定的比较面） */
function strippedTokens(text: string): Set<string> {
  const stripped = text.replace(NEGATION_PATTERN, ' ');
  // 先剔除整段极性标记短语（成对剔除防残留半词），再常规切词
  let cleaned = stripped;
  for (const pair of POLARITY_PAIRS) {
    cleaned = cleaned.replace(pair.negative, ' ').replace(pair.positive, ' ');
  }
  return tokenize(cleaned);
}

/**
 * 同主题极性冲突判定：两摘要极性相反（均能判定且不同）+ 去极性词后
 * token 重叠 ≥ 0.5（同主题）→ true。
 */
export function isPolarityConflict(a: string, b: string): boolean {
  const pa = detectPolarity(a);
  const pb = detectPolarity(b);
  if (pa === undefined || pb === undefined || pa === pb) return false;
  return jaccard(strippedTokens(a), strippedTokens(b)) >= POLARITY_OVERLAP_THRESHOLD;
}

/** 三分支裁决结果（addMemory 单事务内逐候选跑本判定，取首个命中分支） */
export type MergeDecision =
  /** 精确合并：同 kind + summary 全等 */
  | { readonly type: 'exact' }
  /** 模糊合并：同 kind + Jaccard ≥ 0.74 */
  | { readonly type: 'fuzzy' }
  /** 极性冲突：新条胜出（高 confidence 胜、相等新胜由调用方裁决），旧条 dismissed */
  | { readonly type: 'polarity' }
  /** 无匹配：全新条目 */
  | { readonly type: 'new' };

/**
 * 候选条目对三分支的裁决（分支顺序 = 优先级：精确 → 模糊 → 极性）。
 * @param existing 库内同 owner + kind 的 active 条目（summary/confidence）
 * @param candidate 待插入条目（summary/confidence）
 */
export function classifyMerge(
  existing: { readonly summary: string; readonly confidence: number },
  candidate: { readonly summary: string; readonly confidence: number },
): MergeDecision {
  if (existing.summary === candidate.summary) {
    return { type: 'exact' };
  }
  if (overlapScore(existing.summary, candidate.summary) >= FUZZY_THRESHOLD) {
    return { type: 'fuzzy' };
  }
  if (isPolarityConflict(existing.summary, candidate.summary)) {
    return { type: 'polarity' };
  }
  return { type: 'new' };
}
