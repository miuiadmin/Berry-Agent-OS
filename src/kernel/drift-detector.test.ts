import { describe, it, expect } from 'vitest';
import { buildDriftCheckPrompt, parseDriftCheckResult, applySuggestedAction } from './drift-detector.js';
import { DEFAULT_DRIFT_THRESHOLDS } from '../contracts/intent.js';
import type { IntentAnchor, DriftSignal } from '../contracts/intent.js';

describe('DriftDetector', () => {
  const anchor: IntentAnchor = {
    goal: '重构 auth 模块',
    constraints: ['不改测试文件', '保持向后兼容'],
    outputType: 'code_change',
    entities: ['src/auth.ts', 'login 函数'],
  };

  describe('buildDriftCheckPrompt', () => {
    it('应包含用户意图和产出内容', () => {
      const prompt = buildDriftCheckPrompt(anchor, '已修改 auth.ts', 'final_response');
      expect(prompt).toContain('重构 auth 模块');
      expect(prompt).toContain('不改测试文件');
      expect(prompt).toContain('已修改 auth.ts');
      expect(prompt).toContain('final_response');
    });

    it('应截断过长的内容', () => {
      const longContent = 'x'.repeat(5000);
      const prompt = buildDriftCheckPrompt(anchor, longContent, 'dialogue');
      expect(prompt.length).toBeLessThan(5000);
    });
  });

  describe('parseDriftCheckResult', () => {
    it('应正确解析合法 JSON', () => {
      const llmOutput = '{"alignmentScore": 0.8, "needsIntervention": false, "driftDescription": null, "suggestedAction": "continue"}';
      const signal = parseDriftCheckResult(llmOutput, 'final_response');
      expect(signal.alignmentScore).toBe(0.8);
      expect(signal.needsIntervention).toBe(false);
      expect(signal.suggestedAction).toBe('continue');
      expect(signal.checkpointType).toBe('final_response');
    });

    it('应处理高偏离信号', () => {
      const llmOutput = '{"alignmentScore": 0.2, "needsIntervention": true, "driftDescription": "回复了无关话题", "suggestedAction": "verify"}';
      const signal = parseDriftCheckResult(llmOutput, 'dialogue');
      expect(signal.alignmentScore).toBe(0.2);
      expect(signal.needsIntervention).toBe(true);
      expect(signal.driftDescription).toBe('回复了无关话题');
      expect(signal.suggestedAction).toBe('verify');
    });

    it('应对解析失败返回默认值（不干预）', () => {
      const signal = parseDriftCheckResult('invalid json output', 'task_result');
      expect(signal.alignmentScore).toBe(1);
      expect(signal.needsIntervention).toBe(false);
      expect(signal.checkpointType).toBe('task_result');
    });

    it('应从 markdown 代码块中提取 JSON', () => {
      const llmOutput = '```json\n{"alignmentScore": 0.6, "needsIntervention": true, "suggestedAction": "correct"}\n```';
      const signal = parseDriftCheckResult(llmOutput, 'final_response');
      expect(signal.alignmentScore).toBe(0.6);
      expect(signal.needsIntervention).toBe(true);
    });

    it('应将 alignmentScore 限制在 0-1 范围', () => {
      const signal = parseDriftCheckResult('{"alignmentScore": 1.5, "needsIntervention": false}', 'dialogue');
      expect(signal.alignmentScore).toBe(1);
    });
  });

  describe('applySuggestedAction', () => {
    it('高对齐度应返回 continue', () => {
      const signal: DriftSignal = { alignmentScore: 0.9, needsIntervention: false, checkpointType: 'final_response' };
      const result = applySuggestedAction(signal, DEFAULT_DRIFT_THRESHOLDS);
      expect(result.suggestedAction).toBe('continue');
      expect(result.needsIntervention).toBe(false);
    });

    it('中等偏离应返回 correct', () => {
      const signal: DriftSignal = { alignmentScore: 0.55, needsIntervention: false, checkpointType: 'final_response' };
      const result = applySuggestedAction(signal, DEFAULT_DRIFT_THRESHOLDS);
      expect(result.suggestedAction).toBe('correct');
      expect(result.needsIntervention).toBe(true);
    });

    it('高偏离应返回 verify', () => {
      const signal: DriftSignal = { alignmentScore: 0.3, needsIntervention: false, checkpointType: 'final_response' };
      const result = applySuggestedAction(signal, DEFAULT_DRIFT_THRESHOLDS);
      expect(result.suggestedAction).toBe('verify');
      expect(result.needsIntervention).toBe(true);
    });

    it('对话阈值比 final_response 宽松', () => {
      const signal: DriftSignal = { alignmentScore: 0.55, needsIntervention: false, checkpointType: 'dialogue' };
      const result = applySuggestedAction(signal, DEFAULT_DRIFT_THRESHOLDS);
      // dialogue warnBelow=0.5，0.55 > 0.5 → continue
      expect(result.suggestedAction).toBe('continue');
    });
  });
});
