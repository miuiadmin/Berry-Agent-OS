/**
 * 知识记忆的确定性合并 / 冲突消解 —— 借鉴 mercury second brain，并做 CJK 适配（berry 摘要为中文）。
 *
 * 设计目的（见 设计文档/参考-mercury-v1.2.0-吸纳建议.md §A）：
 * berry 原 `addKnowledge` 只在 summary 完全相等时合并，模糊合并 / 冲突消解全部押在
 * `evolution.ts` 的 LLM `consolidateMemories` pass（且 ≥3 条 active 才跑）。本模块把
 * 「明显同义」和「明显极性冲突」两类用确定性代码在插入时即时处理，零 LLM 成本、即时消解。
 *
 * 与 LLM consolidation 的关系：互补不冲突。确定性吃掉明显 case，LLM 保留给用词差异大的
 * 深层语义合并；可借此降低 LLM pass 触发频次。
 *
 * 关键本地化：mercury 的 tokenizer 按 `[^a-z0-9]+` 切分，对纯中文会把整句当成一个 token
 * （Jaccard 失效）。本模块的 `tokenizeSummary` 同时抽取「拉丁/数字词」与「单个 CJK 汉字」，
 * 让 Jaccard 在中英混排摘要上都有效。
 *
 * 参考：参考源码/mercury-agent_v1.2.0/src/memory/user-memory.ts（remember / overlapScore / hasConflict）
 */

/** 合并/冲突裁决时从 knowledge 表读出的候选行（addKnowledge 内查询） */
export interface MergeCandidateRow {
  id: string;
  summary: string;
  detail: string | null;
  confidence: number;
  importance: number;
  durability: number;
  evidence_count: number;
}

/** 模糊合并阈值（token 集合 Jaccard）。保守取值：宁可漏合并（留给 LLM pass），也别误并不同事实 */
const MERGE_THRESHOLD = 0.74;
/** 极性冲突判定时，去掉极性词后的主题重叠阈值（同 mercury hasConflict 的 0.5） */
const CONFLICT_TOPIC_THRESHOLD = 0.5;

/**
 * 判断一个 Unicode 码点是否为 CJK 汉字。
 * 覆盖：CJK 统一表意 (U+4E00..U+9FFF)、扩展 A (U+3400..U+4DBF)、兼容表意 (U+F900..U+FAFF)。
 * 用码点数值比较而非正则 CJK 字面量，规避源码里 CJK 字面量的编码脆弱性。
 */
function isCJK(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0xf900 && code <= 0xfaff);
}

/**
 * 摘要分词：拉丁/数字连续串（长度 ≥ 2，小写）+ 单个 CJK 汉字。
 * 返回去重后的 token 数组（供 Jaccard 计算）。
 */
export function tokenizeSummary(input: string): string[] {
  const lower = input.toLowerCase();
  const tokens = new Set<string>();

  // 拉丁字母 / 数字词（如 "vscode"、"typescript"、"2"）—— 长度 ≥ 2 才算，避免单字符噪声
  const latinRe = /[a-z0-9]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = latinRe.exec(lower)) !== null) {
    tokens.add(m[0]);
  }

  // CJK 汉字逐字作为 token（中文无空格，逐字是 cheapest 的 fuzzy 基元）
  for (const ch of lower) {
    const code = ch.codePointAt(0)!;
    if (isCJK(code)) tokens.add(ch);
  }

  return [...tokens];
}

/** 两个 token 集合的 Jaccard 重叠度：|A∩B| / |A∪B|。任一为空返回 0。 */
export function overlapScore(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let overlap = 0;
  for (const t of aSet) {
    if (bSet.has(t)) overlap += 1;
  }
  return overlap / new Set([...aSet, ...bSet]).size;
}

/** 极性对：同一主题的正面/反面表达（中英双语）。用于检测「偏好 X vs 不偏好 X」类矛盾 */
const POLARITY_PAIRS: ReadonlyArray<{ readonly pos: string; readonly neg: string }> = [
  // 中文
  { pos: '喜欢', neg: '不喜欢' },
  { pos: '偏好', neg: '不偏好' },
  { pos: '想要', neg: '不想要' },
  { pos: '需要', neg: '不需要' },
  { pos: '用', neg: '不用' },
  { pos: '启用', neg: '禁用' },
  { pos: '开启', neg: '关闭' },
  { pos: '支持', neg: '反对' },
  { pos: '同意', neg: '反对' },
  // 英文
  { pos: 'prefers', neg: 'does not prefer' },
  { pos: 'likes', neg: 'does not like' },
  { pos: 'wants', neg: 'does not want' },
  { pos: 'uses', neg: 'does not use' },
  { pos: 'enabled', neg: 'disabled' },
];

/** 中文否定字（逐字 includes 即可，\b 对 CJK 无意义） */
const CJK_NEGATIONS = ['不', '没', '未', '别', '勿', '无', '非', '否'];
/** 英文否定（需词边界，避免匹配 notion / nevertheless 等） */
const EN_NEGATION_RE = /\b(not|never|avoid|against|don't|cannot|without)\b/i;

/** 文本是否含否定意味（中英分别处理） */
function containsNegation(s: string): boolean {
  if (CJK_NEGATIONS.some((ch) => s.includes(ch))) return true;
  return EN_NEGATION_RE.test(s);
}

/**
 * 判断两条摘要是否构成「极性冲突」（同主题、相反极性）。
 * 算法：逐对极性词，若一条含正面、另一条含反面，则去掉极性词后比较主题重叠 ≥ 阈值 → 冲突。
 * 兜底：若一方整体含否定而另一方不含，且主题 Jaccard ≥ 0.7，也判冲突。
 */
export function hasConflict(aSummary: string, bSummary: string): boolean {
  const a = aSummary.toLowerCase();
  const b = bSummary.toLowerCase();
  if (a === b) return false; // 完全相同不算冲突（走合并路径）

  for (const { pos, neg } of POLARITY_PAIRS) {
    const aPosBNeg = a.includes(pos) && b.includes(neg);
    const aNegBPos = a.includes(neg) && b.includes(pos);
    if (aPosBNeg || aNegBPos) {
      // 去掉正/反面词后比较主题
      const topicA = tokenizeSummary(a.replace(pos, '').replace(neg, ''));
      const topicB = tokenizeSummary(b.replace(pos, '').replace(neg, ''));
      if (overlapScore(topicA, topicB) >= CONFLICT_TOPIC_THRESHOLD) return true;
    }
  }

  // 兜底：单边否定 + 高主题重叠
  if (containsNegation(a) !== containsNegation(b)) {
    return overlapScore(tokenizeSummary(a), tokenizeSummary(b)) >= 0.7;
  }

  return false;
}

/**
 * 在同 type 候选行中找模糊合并目标：Jaccard ≥ 阈值 且 非冲突。
 * 返回第一个命中的候选（调用方负责按 updated_at 倒序传入，使最新优先）。
 */
export function pickMergeCandidate(rows: MergeCandidateRow[], incomingSummary: string): MergeCandidateRow | undefined {
  const incomingTokens = tokenizeSummary(incomingSummary);
  return rows.find((row) => {
    if (hasConflict(row.summary, incomingSummary)) return false; // 冲突走冲突路径，不合
    return overlapScore(tokenizeSummary(row.summary), incomingTokens) >= MERGE_THRESHOLD;
  });
}

/** 在同 type 候选行中找极性冲突目标 */
export function pickConflictCandidate(rows: MergeCandidateRow[], incomingSummary: string): MergeCandidateRow | undefined {
  return rows.find((row) => hasConflict(row.summary, incomingSummary));
}

/**
 * 极性冲突裁决：高 confidence 胜；相等则 incoming（新）胜。
 * @returns 'incoming' = 新候选胜（旧条应 dismissed）；'existing' = 旧条胜（丢弃新候选）
 */
export function resolveConflictVerdict(existingConfidence: number, incomingConfidence: number): 'incoming' | 'existing' {
  if (incomingConfidence >= existingConfidence) return 'incoming'; // 相等也取新（更新鲜）
  return 'existing';
}

/** 合并时取更完整的 summary：incoming 更长且 ≤ 220 字则取 incoming，否则保留 existing */
export function pickBetterSummary(existing: string, incoming: string): string {
  const ex = existing.trim();
  const in_ = incoming.trim();
  return in_.length > ex.length && in_.length <= 220 ? in_ : ex;
}
