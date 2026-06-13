import { describe, it, expect } from 'vitest';
import { buildUserResponse } from './build-response.js';

/**
 * buildUserResponse 诚实汇报单测（C）。
 *
 * 背景：code agent（glm-5.1）有时只规划不执行（implementation 阶段没调 edit_code/write_file），
 * filesChanged:[]。原 buildUserResponse 在此情况下不显式说明，回复看起来像正常完成，Brain 把
 * 空结果误批。C 修复：implementation 任务却 filesChanged:[] → 诚实追加"未执行任何文件改动"，
 * 让 Brain/用户看到真相后重新决策（配合 B 的 prompt 执行强约束兜底）。
 *
 * 本测试钉死三个分支，防止诚实汇报逻辑被无声回退或误扩到 analyze/test。
 */
describe('buildUserResponse 诚实汇报未执行（C）', () => {
  const implPhase = { phase: 'implementation', success: true, summary: '我打算这样修改……' };

  it('implementation 任务未产生文件改动 → 诚实汇报「未执行任何文件改动」', () => {
    const res = buildUserResponse({
      phases: [implPhase],
      success: false,
      summary: '计划已制定',
      filesChanged: [],
    });
    expect(res).toContain('未执行任何文件改动');
  });

  it('implementation 任务有文件改动 → 列出文件，不报「未执行」', () => {
    const res = buildUserResponse({
      phases: [implPhase],
      success: true,
      summary: '已完成修改',
      filesChanged: ['src/snake.js'],
    });
    expect(res).toContain('变更的文件');
    expect(res).toContain('src/snake.js');
    expect(res).not.toContain('未执行任何文件改动');
  });

  it('analyze 任务（无 implementation phase）未改文件 → 不报「未执行」（filesChanged:[] 是预期）', () => {
    const res = buildUserResponse({
      phases: [{ phase: 'synthesis', success: true, summary: '分析结论：无需改动' }],
      success: true,
      summary: '分析结论：无需改动',
      filesChanged: [],
    });
    expect(res).not.toContain('未执行任何文件改动');
  });
});
