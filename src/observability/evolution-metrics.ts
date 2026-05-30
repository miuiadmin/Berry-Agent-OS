import { metrics } from './metrics.js';

export const evolutionMetrics = {
  brainFallback: metrics.counter('brain_fallback_total'),
  brainCorrection: metrics.counter('brain_correction_total'),
  skillInvocation: metrics.counter('skill_invocation_total'),
  memoryRecallHit: metrics.counter('memory_recall_hit_total'),
  memoryRecallMiss: metrics.counter('memory_recall_miss_total'),
  permissionJudge: metrics.counter('permission_judge_total'),
  evolutionExtraction: metrics.counter('evolution_extraction_total'),
  brainDecisionRecorded: metrics.counter('brain_decision_recorded_total'),
} as const;

const WINDOW_MS = 60_000 * 10; // 10-minute rolling window
const THRESHOLD_FALLBACK_RATE = 0.3;
const THRESHOLD_CORRECTION_RATE = 0.2;
const MIN_SAMPLE_SIZE = 10;

export interface EvolutionTriggerSignal {
  type: 'high_fallback_rate' | 'high_correction_rate' | 'low_recall_hit_rate';
  currentRate: number;
  threshold: number;
  sampleSize: number;
}

export function checkEvolutionTriggers(): EvolutionTriggerSignal[] {
  const signals: EvolutionTriggerSignal[] = [];

  const fallbacks = evolutionMetrics.brainFallback.get();
  const totalRoutes = fallbacks + evolutionMetrics.skillInvocation.get() + evolutionMetrics.memoryRecallHit.get();
  if (totalRoutes >= MIN_SAMPLE_SIZE) {
    const rate = fallbacks / totalRoutes;
    if (rate > THRESHOLD_FALLBACK_RATE) {
      signals.push({ type: 'high_fallback_rate', currentRate: rate, threshold: THRESHOLD_FALLBACK_RATE, sampleSize: totalRoutes });
    }
  }

  const corrections = evolutionMetrics.brainCorrection.get();
  const totalReviews = corrections + evolutionMetrics.brainDecisionRecorded.get({ decision_type: 'review' });
  if (totalReviews >= MIN_SAMPLE_SIZE) {
    const rate = corrections / totalReviews;
    if (rate > THRESHOLD_CORRECTION_RATE) {
      signals.push({ type: 'high_correction_rate', currentRate: rate, threshold: THRESHOLD_CORRECTION_RATE, sampleSize: totalReviews });
    }
  }

  const hits = evolutionMetrics.memoryRecallHit.get();
  const misses = evolutionMetrics.memoryRecallMiss.get();
  const totalRecall = hits + misses;
  if (totalRecall >= MIN_SAMPLE_SIZE) {
    const hitRate = hits / totalRecall;
    if (hitRate < 0.3) {
      signals.push({ type: 'low_recall_hit_rate', currentRate: hitRate, threshold: 0.3, sampleSize: totalRecall });
    }
  }

  return signals;
}
