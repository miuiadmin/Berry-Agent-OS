/**
 * BrainFeedbackEvolution 单元测试（§5.3.7 + §13.20）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setAppHome, getAppHome } from '../utils/paths.js';
import { initEventBus, getEventBus } from './event-bus.js';
import { getDb, initDb } from '../memory/index.js';
import { getUserPreferences } from '../memory/user-preferences.js';
import { extractPreferences, processBrainFeedback, startBrainFeedbackEvolutionListener } from './brain-feedback-evolution.js';

let originalHome: string;
let testDir: string;

beforeEach(() => {
  originalHome = getAppHome();
  testDir = mkdtempSync(join(tmpdir(), 'brain-feedback-evolution-test-'));
  setAppHome(testDir);

  // 初始化 db（用全局 db）+ 创建 user_preferences 表
  initDb();
  initEventBus();

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      pref_key TEXT NOT NULL,
      pref_value TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      expires_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE(user_id, pref_key)
    );
  `);
});

afterEach(() => {
  setAppHome(originalHome);
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe('extractPreferences', () => {
  it('从 userComment 提取简洁风格偏好', () => {
    const prefs = extractPreferences({
      sessionId: 's1', taskId: 't1', feedbackType: 'brain_modify_wrong',
      userComment: '请用简洁一点的回复',
    });
    expect(prefs.find(p => p.prefKey === 'response.style')?.prefValue).toBe('concise');
  });

  it('从 originalResponse 提取详细偏好', () => {
    const prefs = extractPreferences({
      sessionId: 's1', taskId: 't1', feedbackType: 'brain_modify_wrong',
      originalResponse: '这里需要详细解释每个步骤',
    });
    expect(prefs.find(p => p.prefKey === 'response.style')?.prefValue).toBe('detailed');
  });

  it('从 userComment 提取语言偏好（中文）', () => {
    const prefs = extractPreferences({
      sessionId: 's1', taskId: 't1', feedbackType: 'brain_modify_wrong',
      userComment: '请用中文回复',
    });
    expect(prefs.find(p => p.prefKey === 'response.language')?.prefValue).toBe('zh');
  });

  it('去重：同一 prefKey 只保留第一个匹配', () => {
    const prefs = extractPreferences({
      sessionId: 's1', taskId: 't1', feedbackType: 'brain_modify_wrong',
      userComment: '要简洁，详细一点也行',  // 两个 style 关键词
    });
    const stylePrefs = prefs.filter(p => p.prefKey === 'response.style');
    expect(stylePrefs).toHaveLength(1);
  });

  it('无匹配返回空数组', () => {
    const prefs = extractPreferences({
      sessionId: 's1', taskId: 't1', feedbackType: 'brain_modify_wrong',
      userComment: '你好世界',
    });
    expect(prefs).toEqual([]);
  });
});

describe('processBrainFeedback', () => {
  it('brain_modify_wrong + 关键词 → 写 user_preferences', () => {
    const written = processBrainFeedback({
      sessionId: 's1', taskId: 't1', feedbackType: 'brain_modify_wrong',
      userComment: '请简洁点',
    });
    expect(written).toBe(1);

    const prefs = getUserPreferences().list('default');
    expect(prefs.find(p => p.prefKey === 'response.style')?.prefValue).toBe('concise');
    expect(prefs[0].source).toBe('evolution_engine');
  });

  it('非 modify_wrong / review_wrong 反馈 → 不写入', () => {
    const written = processBrainFeedback({
      sessionId: 's1', taskId: 't1', feedbackType: 'restore_original',
      userComment: '请简洁点',
    });
    expect(written).toBe(0);
    expect(getUserPreferences().list('default')).toHaveLength(0);
  });

  it('brain_review_wrong 也触发写入', () => {
    const written = processBrainFeedback({
      sessionId: 's1', taskId: 't1', feedbackType: 'brain_review_wrong',
      userComment: '请详细解释',
    });
    expect(written).toBeGreaterThanOrEqual(1);
    expect(getUserPreferences().list('default').some(p => p.prefValue === 'detailed')).toBe(true);
  });
});

describe('startBrainFeedbackEvolutionListener', () => {
  it('监听 brain.feedback 事件并自动写入', async () => {
    const unsub = startBrainFeedbackEvolutionListener();

    getEventBus().emit('brain.feedback' as any, {
      sessionId: 's1', taskId: 't1', feedbackType: 'brain_modify_wrong',
      userComment: '简洁回复',
    });

    // microtask 等处理
    await new Promise(r => setTimeout(r, 10));

    const prefs = getUserPreferences().list('default');
    expect(prefs.some(p => p.prefKey === 'response.style' && p.prefValue === 'concise')).toBe(true);

    unsub();
  });
});