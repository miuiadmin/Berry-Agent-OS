/**
 * L6 skills 单元测试 — 目录发现扫描（P1-3 挖矿 B11 缺口④ prompt 面读者）。
 *
 * 覆盖：SKILL.md 编码不可判定 = decode-failed 诊断跳过（绝不静默 mojibake
 * 进系统提示词）；同扫描内合法技能照常入册（跳过不阻断发现序）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSkillLocation } from './discovery.js';

/** 扫描根（beforeAll 建 / afterAll 拆） */
let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'skills-scan-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanSkillLocation — 编码决策树读者（骨架篇 §7.5）', () => {
  it('SKILL.md 编码不可判定（GBK 无标签）= decode-failed 跳过 + 合法技能照常入册', () => {
    // 坏件：SKILL.md 内容是 '测试' 的 GBK 字节（非 win32 本地标签恒空 → ④lossy）
    mkdirSync(join(root, 'bad-encoding'));
    writeFileSync(join(root, 'bad-encoding', 'SKILL.md'), Buffer.from([0xb2, 0xe2, 0xca, 0xd4]));
    // 好件：合法 frontmatter 技能（同层并存——跳过不阻断发现序）
    mkdirSync(join(root, 'good-skill'));
    writeFileSync(join(root, 'good-skill', 'SKILL.md'), '---\ndescription: 合法技能\n---\n\n正文');

    const { skills, diagnostics } = scanSkillLocation({ dir: root, source: 'project' });
    expect(skills.map((s) => s.name)).toEqual(['good-skill']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'decode-failed', type: 'warning' });
    expect(diagnostics[0]!.message).toContain('编码无法判定');
    expect(diagnostics[0]!.path).toBe(join(root, 'bad-encoding', 'SKILL.md'));
  });
});
