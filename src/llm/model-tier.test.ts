import { describe, it, expect } from 'vitest';
import { resolveModel, LlmConfigSchema } from './types.js';
import { PURPOSE_TIER_MAP, MODEL_TIERS, BUNDLED_MODEL_PURPOSES } from '../contracts/model.js';
import { compileRequest } from './compiler.js';

describe('Model Tier System', () => {
  describe('resolveModel', () => {
    it('使用 tier 对应的模型', () => {
      const config = LlmConfigSchema.parse({
        model: 'fallback-model',
        models: { fast: 'fast-model', default: 'default-model', high: 'high-model' },
      });

      expect(resolveModel(config, 'fast')).toBe('fast-model');
      expect(resolveModel(config, 'default')).toBe('default-model');
      expect(resolveModel(config, 'high')).toBe('high-model');
    });

    it('未配置 tier 时 fallback 到 model', () => {
      const config = LlmConfigSchema.parse({
        model: 'my-model',
        models: { fast: 'fast-only' },
      });

      expect(resolveModel(config, 'fast')).toBe('fast-only');
      expect(resolveModel(config, 'default')).toBe('my-model');
      expect(resolveModel(config, 'high')).toBe('my-model');
    });

    it('完全未配置 models 时所有 tier 都使用 model', () => {
      const config = LlmConfigSchema.parse({
        model: 'single-model',
      });

      expect(resolveModel(config, 'fast')).toBe('single-model');
      expect(resolveModel(config, 'default')).toBe('single-model');
      expect(resolveModel(config, 'high')).toBe('single-model');
    });
  });

  describe('PURPOSE_TIER_MAP', () => {
    it('所有内置 purpose 都有对应 tier', () => {
      for (const purpose of BUNDLED_MODEL_PURPOSES) {
        expect(PURPOSE_TIER_MAP[purpose]).toBeDefined();
        expect(MODEL_TIERS).toContain(PURPOSE_TIER_MAP[purpose]);
      }
    });

    it('brain_review 和 learning_review 使用 fast', () => {
      expect(PURPOSE_TIER_MAP.brain_review).toBe('fast');
      expect(PURPOSE_TIER_MAP.learning_review).toBe('fast');
    });

    it('code_task 和 plugin_generation 使用 high', () => {
      expect(PURPOSE_TIER_MAP.code_task).toBe('high');
      expect(PURPOSE_TIER_MAP.plugin_generation).toBe('high');
    });

    it('conversation 和 skill_generation 使用 default', () => {
      expect(PURPOSE_TIER_MAP.conversation).toBe('default');
      expect(PURPOSE_TIER_MAP.skill_generation).toBe('default');
    });
  });

  describe('compileRequest modelTier', () => {
    it('显式指定 modelTier 时直接使用', () => {
      const req = compileRequest({
        agent: 'conversation',
        purpose: 'conversation',
        modelTier: 'high',
        sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(req.modelTier).toBe('high');
    });

    it('未指定 modelTier 时从 purpose 推导', () => {
      const req = compileRequest({
        agent: 'brain',
        purpose: 'brain_review',
        sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'review' }],
      });

      expect(req.modelTier).toBe('fast');
    });

    it('自定义 purpose 默认使用 default tier', () => {
      const req = compileRequest({
        agent: 'conversation',
        purpose: 'custom_purpose',
        sessionId: 'ses_1',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(req.modelTier).toBe('default');
    });
  });

  describe('LlmConfigSchema', () => {
    it('解析含 models 字段的配置', () => {
      const config = LlmConfigSchema.parse({
        baseUrl: 'https://example.com',
        apiKey: 'key',
        model: 'base',
        models: { fast: 'f', high: 'h' },
      });

      expect(config.models.fast).toBe('f');
      expect(config.models.default).toBeUndefined();
      expect(config.models.high).toBe('h');
    });

    it('models 字段默认为空对象', () => {
      const config = LlmConfigSchema.parse({});
      expect(config.models).toEqual({});
    });
  });
});
