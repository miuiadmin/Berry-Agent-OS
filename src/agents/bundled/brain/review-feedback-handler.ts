/**
 * brain.review.feedback handler + prompt 自修改逻辑（§17.4 巨石拆解——从 brain/entry.ts 整组提取）。
 *
 * 用户对 Brain 审核的反馈 → 记录 lesson → 达阈值触发 prompt 自修改（PromptVersioning.propose）。
 * 整组提取：handler + inferPromptKeyFromFeedback + tryTriggerPromptSelfMod + getDefaultPromptContent。
 * deps 注入：db / decisionRecorder / promptVersioning / ipc / DEFAULT_PROMPT_A/BC。
 */

import type Database from 'better-sqlite3';
import type { IpcMessage } from '../../../kernel/types.js';
import { getLogger } from '../../../utils/logger.js';
import { buildRoutingSystemPrompt, buildPermissionJudgeSystemPrompt } from './prompts.js';

/** deps 注入接口（entry.ts 闭包变量——用 any 避免与 BrainDecisionRecorder/PromptVersioning/IpcChildChannel 的具体参数类型逆变不兼容） */
export interface ReviewFeedbackDeps {
  db: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decisionRecorder: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  promptVersioning: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipc: any;
  defaultPromptA: string;
  defaultPromptBc: string;
}

/** 同一 promptKey 累积 3 条 lesson 后触发自修改 */
const PROMPT_SELF_MOD_LESSON_THRESHOLD = 3;

/**
 * 注册 brain.review.feedback handler（§17.4 整组提取）。
 * entry.ts 调 setupReviewFeedbackHandler({ db, decisionRecorder, promptVersioning, ipc, defaultPromptA, defaultPromptBc })。
 */
export function setupReviewFeedbackHandler(deps: ReviewFeedbackDeps): void {
  const { db, decisionRecorder, promptVersioning, ipc, defaultPromptA, defaultPromptBc } = deps;
  const logger = getLogger('brain-feedback');

  ipc.onMessage('brain.review.feedback', (msg: IpcMessage) => {
    const payload = msg.payload as { decisionId?: string; feedbackType?: string; lesson?: string; outcome?: 'good' | 'bad' | 'neutral'; promptKey?: string };
    if (!payload?.decisionId || !payload.lesson) {
      ipc.send('brain.review.feedback.result', 'core', { ok: false, reason: 'Missing decisionId or lesson' }, msg.correlationId ?? msg.id);
      return;
    }
    try {
      decisionRecorder.updateLesson(payload.decisionId, payload.lesson);
      if (payload.outcome) {
        decisionRecorder.record({
          sessionId: 'feedback:' + payload.decisionId,
          decisionType: 'review',
          inputSummary: `feedback_type=${payload.feedbackType ?? 'unknown'}`,
          outputJson: { decisionId: payload.decisionId, feedbackType: payload.feedbackType },
          outcome: payload.outcome,
        });
      }
      logger.info({ decisionId: payload.decisionId, feedbackType: payload.feedbackType, lessonLen: payload.lesson.length }, 'brain:self-review feedback recorded');

      const promptKey = payload.promptKey ?? inferPromptKeyFromFeedback(payload.feedbackType);
      if (promptKey) {
        tryTriggerPromptSelfMod(promptKey, payload.lesson);
      }

      ipc.send('brain.review.feedback.result', 'core', { ok: true, id: payload.decisionId }, msg.correlationId ?? msg.id);
    } catch (err) {
      logger.warn({ err, decisionId: payload.decisionId }, 'brain:self-review feedback failed');
      ipc.send('brain.review.feedback.result', 'core', { ok: false, reason: (err as Error).message }, msg.correlationId ?? msg.id);
    }
  });

  /** 根据反馈类型推断应修改哪个 prompt key */
  function inferPromptKeyFromFeedback(feedbackType?: string): string | null {
    if (!feedbackType) return null;
    if (feedbackType.includes('route') || feedbackType.includes('routing')) return 'brain.routing';
    if (feedbackType.includes('review_a')) return 'brain.review.a';
    if (feedbackType.includes('review') || feedbackType.includes('modify') || feedbackType.includes('reject')) return 'brain.review.bc';
    if (feedbackType.includes('permission') || feedbackType.includes('tool')) return 'brain.permission';
    return null;
  }

  /** 检查该 promptKey 下的 lessons 是否达阈值，触发 prompt 自修改 */
  function tryTriggerPromptSelfMod(promptKey: string, newLesson: string): void {
    try {
      const lessonsWithFeedback = db.prepare(`
        SELECT lesson FROM brain_decisions
        WHERE decision_type = 'review'
          AND lesson IS NOT NULL AND lesson != ''
          AND input_summary LIKE '%' || ? || '%'
        ORDER BY created_at DESC LIMIT ?
      `).all(promptKey, PROMPT_SELF_MOD_LESSON_THRESHOLD + 2) as Array<{ lesson: string }>;

      const allLessons = lessonsWithFeedback.length >= PROMPT_SELF_MOD_LESSON_THRESHOLD
        ? lessonsWithFeedback
        : (db.prepare(`SELECT lesson FROM brain_decisions WHERE lesson IS NOT NULL AND lesson != '' ORDER BY created_at DESC LIMIT ?`).all(PROMPT_SELF_MOD_LESSON_THRESHOLD) as Array<{ lesson: string }>);

      if (allLessons.length < PROMPT_SELF_MOD_LESSON_THRESHOLD) {
        logger.debug({ promptKey, lessonCount: allLessons.length, threshold: PROMPT_SELF_MOD_LESSON_THRESHOLD }, 'brain:prompt-self-mod not triggered');
        return;
      }

      const current = promptVersioning.getActiveVersion(promptKey);
      const baseContent = current?.content ?? getDefaultPromptContent(promptKey);
      const lessonLines = allLessons.slice(0, PROMPT_SELF_MOD_LESSON_THRESHOLD).map((l, i) => `${i + 1}. ${l.lesson.slice(0, 200)}`);
      const supplement = `\n\n## 自动学习的教训（基于 ${allLessons.length} 条反馈更新）\n${lessonLines.join('\n')}`;

      if (baseContent.includes(supplement.slice(0, 50))) {
        logger.debug({ promptKey }, 'brain:prompt-self-mod skipped (supplement already present)');
        return;
      }

      const version = promptVersioning.propose({
        promptKey,
        newContent: baseContent + supplement,
        changeReason: `自动学习：基于 ${allLessons.length} 条审核反馈教训`,
        changeSource: 'brain',
        currentMetrics: { lessonCount: allLessons.length },
      });
      logger.info({ promptKey, version: version.version, lessonCount: allLessons.length }, 'brain:prompt-self-mod triggered');
    } catch (err) {
      logger.warn({ err, promptKey }, 'brain:prompt-self-mod failed (non-critical)');
    }
  }

  /** 获取 promptKey 的默认内容（当没有 active version 时） */
  function getDefaultPromptContent(promptKey: string): string {
    switch (promptKey) {
      case 'brain.review.a': return defaultPromptA;
      case 'brain.review.bc': return defaultPromptBc;
      case 'brain.routing': return buildRoutingSystemPrompt();
      case 'brain.permission': return buildPermissionJudgeSystemPrompt();
      default: return '';
    }
  }
}
