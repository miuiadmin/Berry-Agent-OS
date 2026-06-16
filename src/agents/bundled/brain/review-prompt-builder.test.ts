/**
 * buildReviewSystemPrompt 纯函数测试（①② 第1步 / §17.4 续——review systemPrompt 构造提取）。
 *
 * 钉死提取后的构造行为：基础 prompt + 历史决策回溯 + uncertain 升级指令必含；
 * C 级注入板上下文；世界状态/insights 在空库下安全降级（不抛错）。
 * 不测 AI 生成内容（CLAUDE.md 禁）——本函数是确定性代码，断言其输出结构合法。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, type Database } from '../../../memory/db.js';
import { buildReviewSystemPrompt } from './review-prompt-builder.js';

describe('buildReviewSystemPrompt（①② review 逻辑提取）', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'berry-review-prompt-'));
    db = initDb(join(dir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** 最小依赖 mock：observationRecorder / missionManager 空实现（C 级观察/板/mission 注入降级） */
  const mockCtx = {
    db: undefined as unknown as Database, // 每个 it 内重设
    observationRecorder: {
      queryByType: () => [],
      isTruncated: () => false,
    } as never,
    missionManager: { readPlan: () => undefined } as never,
    getBasePrompt: (level: 'A' | 'B' | 'C') => `BASE_PROMPT_${level}`,
    recallDecisionsBlock: (decisionType: string) => `\n## 历史决策(${decisionType})`,
  };

  it('A 级：含基础 prompt + 历史决策回溯 + uncertain 升级指令（空库降级不抛错）', () => {
    const prompt = buildReviewSystemPrompt(
      { sessionId: 's1', level: 'A' },
      { ...mockCtx, db },
    );
    expect(prompt).toContain('BASE_PROMPT_A');
    expect(prompt).toContain('历史决策(review)');
    expect(prompt).toContain('拿不准时升级'); // uncertain 升级指令恒附加
  });

  it('C 级 + boardTaskId：尝试注入板上下文（空库无板→安全降级，不抛错）', () => {
    // C 级会查 observation（mock 返 []）+ 板上下文（空库 getBoardContext 返 null）。
    // 验证 C 级路径不抛错 + 仍含基础段。
    const prompt = buildReviewSystemPrompt(
      { sessionId: 's2', level: 'C', boardTaskId: 'task-board-1' },
      { ...mockCtx, db },
    );
    expect(prompt).toContain('BASE_PROMPT_C');
    expect(prompt).toContain('拿不准时升级');
  });

  it('getBasePrompt 按 level 取对应基础 prompt（A/B/C 分别注入）', () => {
    const a = buildReviewSystemPrompt({ sessionId: 's', level: 'A' }, { ...mockCtx, db });
    const bc = buildReviewSystemPrompt({ sessionId: 's', level: 'C' }, { ...mockCtx, db });
    expect(a).toContain('BASE_PROMPT_A');
    expect(bc).toContain('BASE_PROMPT_C');
    expect(bc).not.toContain('BASE_PROMPT_A');
  });
});
