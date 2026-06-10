/**
 * 13.0 §5.3.7 + §13.20: BrainFeedbackEvolution — 把 Brain 审核反馈转为 user_preferences。
 *
 * 工作机制：
 *   1. 订阅 EventBus 上的 brain.feedback 事件
 *   2. PatternMatcher 从 userComment / restore-original 提取偏好关键词
 *   3. 写 user_preferences 表（90 天过期）
 *
 * PatternMatcher 关键词（可扩展）：
 *   - 「简洁 / 简短 / concise」→ response.style=concise
 *   - 「详细 / 详细解释 / detailed」→ response.style=detailed
 *   - 「中文 / Chinese」→ response.language=zh
 *   - 「英文 / English」→ response.language=en
 *   - 「代码 / 编程」→ topic.prefer=code
 *
 * 这是 stub 实现 — 真正的 Evolution Engine 可以替换为更复杂的 LLM 提取。
 */

import { getEventBus } from './event-bus.js';
import { getUserPreferences } from '../memory/user-preferences.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('brain-feedback-evolution');

interface BrainFeedbackPayload {
  sessionId: string;
  taskId: string;
  feedbackType: string;
  userComment?: string;
  originalResponse?: string;
  modifiedResponse?: string;
}

/** 关键词 → user_pref_key 映射表 */
const PATTERN_MAP: Array<{ regex: RegExp; prefKey: string; prefValue: string }> = [
  { regex: /(简洁|简短|conci[se]|brief|short)/i, prefKey: 'response.style', prefValue: 'concise' },
  { regex: /(详细|detailed|elaborate|展开)/i, prefKey: 'response.style', prefValue: 'detailed' },
  { regex: /(中文|Chinese|汉语)/i, prefKey: 'response.language', prefValue: 'zh' },
  { regex: /(英文|English)/i, prefKey: 'response.language', prefValue: 'en' },
  { regex: /(代码|code|编程|coding|programming)/i, prefKey: 'topic.prefer', prefValue: 'code' },
  { regex: /(解释|explain|说明|clarify)/i, prefKey: 'response.style', prefValue: 'explanatory' },
];

/**
 * 提取的偏好项。
 */
export interface ExtractedPreference {
  prefKey: string;
  prefValue: string;
  matchedPattern: string;
}

/**
 * 从 userComment / originalResponse / modifiedResponse 提取偏好。
 *
 * @returns 匹配到的偏好列表（去重：同一 prefKey 只保留第一个匹配）
 */
export function extractPreferences(payload: BrainFeedbackPayload): ExtractedPreference[] {
  const haystack = [
    payload.userComment ?? '',
    payload.originalResponse ?? '',
    payload.modifiedResponse ?? '',
  ].join('\n');

  const seen = new Set<string>();
  const matches: ExtractedPreference[] = [];

  for (const { regex, prefKey, prefValue } of PATTERN_MAP) {
    const m = haystack.match(regex);
    if (m && !seen.has(prefKey)) {
      seen.add(prefKey);
      matches.push({
        prefKey,
        prefValue,
        matchedPattern: m[0],
      });
    }
  }
  return matches;
}

/**
 * 处理一次 brain.feedback 事件：提取偏好 + 写 user_preferences。
 *
 * @returns 写入的偏好数量
 */
export function processBrainFeedback(payload: BrainFeedbackPayload): number {
  if (payload.feedbackType !== 'brain_modify_wrong' && payload.feedbackType !== 'brain_review_wrong') {
    // restore-original 由 mission-api.ts 单独 emit capability.evolution.request，不走这里
    return 0;
  }

  const prefs = extractPreferences(payload);
  if (prefs.length === 0) {
    logger.debug({ sessionId: payload.sessionId, feedbackType: payload.feedbackType }, 'brain-feedback-evolution: no patterns matched');
    return 0;
  }

  const userPrefs = getUserPreferences();
  let written = 0;
  for (const pref of prefs) {
    const result = userPrefs.set({
      prefKey: pref.prefKey,
      prefValue: pref.prefValue,
      source: 'evolution_engine',
      confidence: 0.85,
      expiresAt: null,  // 90 天由 set() 默认设置
    });
    if (result) {
      written++;
      logger.info({
        sessionId: payload.sessionId,
        prefKey: pref.prefKey,
        prefValue: pref.prefValue,
        matched: pref.matchedPattern,
      }, 'brain-feedback-evolution: preference extracted');
    }
  }
  return written;
}

/**
 * 启动监听 — 在 bootstrap 时调用一次。
 *
 * @returns unsubscribe 函数（用于测试清理）
 */
export function startBrainFeedbackEvolutionListener(): () => void {
  const bus = getEventBus();
  const unsub = bus.on('brain.feedback', (payload: BrainFeedbackPayload) => {
    try {
      processBrainFeedback(payload);
    } catch (err) {
      logger.warn({ err, payload }, 'brain-feedback-evolution: process failed');
    }
  });
  logger.info('brain-feedback-evolution: listener started');
  return unsub;
}