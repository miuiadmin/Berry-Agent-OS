import { describe, it, expect } from 'vitest';
import { PermissionEngine, DANGEROUS_TOOL_CATEGORIES, type PermissionMode } from './permissions.js';
import type { DangerLevel } from '../utils/types.js';

/**
 * 权限引擎表征测试（characterization）—— 15.0 机制 A 重构前的安全网。
 *
 * 目的：钉死 PermissionEngine.checkPermission 的【当前】行为矩阵，供后续「收敛决策路径」
 * 重构对照。重构应保持这些语义（除非显式改变），任何行为漂移都会被测试捕获。
 *
 * 矩阵维度：mode(allow-all/ask/deny-all) × dangerLevel(safe/moderate/dangerous) × 是否危险工具类别。
 * 注意这里记录的是【实际行为】（含历史 quirks），不是【理想行为】。
 */
function engine(mode: PermissionMode): PermissionEngine {
  return new PermissionEngine(mode);
}

describe('PermissionEngine.checkPermission 表征（当前行为）', () => {
  // ── allow-all：默认配置 ──
  describe('mode = allow-all（默认配置）', () => {
    it('safe 普通工具 → allowed', () => {
      const r = engine('allow-all').checkPermission('memory_query', '{}', 'safe');
      expect(r.allowed).toBe(true);
      expect(r.requiresReview).toBeFalsy();
    });

    it('moderate 普通工具 → allowed（allow-all 放行一切非危险类别）', () => {
      const r = engine('allow-all').checkPermission('some_moderate_tool', '{}', 'moderate');
      expect(r.allowed).toBe(true);
    });

    it('dangerous 普通工具 → allowed（allow-all 不看 dangerLevel）', () => {
      const r = engine('allow-all').checkPermission('some_tool', '{}', 'dangerous');
      expect(r.allowed).toBe(true);
    });

    it('危险工具类别（如 write_file）→ requiresReview（即使 allow-all）', () => {
      // quirk：危险工具类别检查在 mode 分支之前，allow-all 也无法绕过
      expect(DANGEROUS_TOOL_CATEGORIES.has('write_file')).toBe(true);
      const r = engine('allow-all').checkPermission('write_file', '{}', 'safe');
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBe(true);
    });
  });

  // ── ask ──
  describe('mode = ask', () => {
    it('safe 普通工具 → allowed', () => {
      const r = engine('ask').checkPermission('memory_query', '{}', 'safe');
      expect(r.allowed).toBe(true);
    });

    it('moderate 普通工具 → requiresReview（ask 模式非 safe 一律审核）', () => {
      const r = engine('ask').checkPermission('some_moderate_tool', '{}', 'moderate');
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBe(true);
    });

    it('dangerous 普通工具 → requiresReview', () => {
      const r = engine('ask').checkPermission('some_tool', '{}', 'dangerous');
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBe(true);
    });

    it('危险工具类别 → requiresReview', () => {
      const r = engine('ask').checkPermission('edit_code', '{}', 'moderate');
      expect(r.requiresReview).toBe(true);
    });
  });

  // ── yolo（15.0 机制 A）──
  describe('mode = yolo（15.0 机制 A：用户委托 Brain）', () => {
    it('safe 普通工具 → allowed（L1 仍规则放行）', () => {
      const r = engine('yolo').checkPermission('memory_query', '{}', 'safe');
      expect(r.allowed).toBe(true);
    });

    it('moderate 普通工具 → requiresReview（L2 走 Brain，非规则放行）', () => {
      const r = engine('yolo').checkPermission('moderate_tool', '{}', 'moderate');
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBe(true);
      expect(r.reason).toContain('yolo');
    });

    it('dangerous 普通工具 → requiresReview（L3 也走 Brain，不再 user_confirm）', () => {
      const r = engine('yolo').checkPermission('plain_tool', '{}', 'dangerous');
      expect(r.requiresReview).toBe(true);
    });

    it('危险工具类别 → requiresReview（yolo 下交 Brain）', () => {
      const r = engine('yolo').checkPermission('write_file', '{}', 'safe');
      expect(r.requiresReview).toBe(true);
    });

    it('getMode 返回 yolo', () => {
      expect(engine('yolo').getMode()).toBe('yolo');
    });
  });

  // ── deny-all ──
  describe('mode = deny-all', () => {
    it('任何工具 → denied', () => {
      const r = engine('deny-all').checkPermission('memory_query', '{}', 'safe');
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBeFalsy();
    });

    it('危险工具类别 → denied（不走 requiresReview）', () => {
      const r = engine('deny-all').checkPermission('write_file', '{}', 'safe');
      expect(r.allowed).toBe(false);
      expect(r.requiresReview).toBeFalsy();
    });
  });

  // ── 危险工具类别 + run_command blocklist 交互（quirk 记录）──
  describe('危险工具类别与 blocklist 交互', () => {
    it('run_command 属于危险工具类别 → 走 requiresReview，不经 blocklist', () => {
      // quirk：run_command 在 DANGEROUS_TOOL_CATEGORIES 内，dangerous_tool 检查（行 76）
      // 先于 blocklist 检查（行 89）触发，故 ask 模式下 run_command 恒为 requiresReview
      expect(DANGEROUS_TOOL_CATEGORIES.has('run_command')).toBe(true);
      const r = engine('ask').checkPermission('run_command', 'rm -rf /', 'moderate');
      expect(r.requiresReview).toBe(true);
      // 即使是恶意命令，engine 层也只标 requiresReview（实际拦截由上层 blocklist/coordinator 负责）
    });

    it('isDangerousTool / listDangerousTools 辅助 API', () => {
      const e = engine('ask');
      expect(e.isDangerousTool('write_file')).toBe(true);
      expect(e.isDangerousTool('memory_query')).toBe(false);
      expect(e.listDangerousTools()).toContain('write_file');
    });

    it('getMode 返回构造时传入的模式', () => {
      expect(engine('yolo' as PermissionMode).getMode()).toBe('yolo');
      // 15.0 机制 A：yolo case 已补全（见上方 'mode = yolo' describe），不再落到 undefined。
    });
  });

  // ── 自定义危险工具集合覆盖 ──
  describe('自定义危险工具集合', () => {
    it('构造时传入自定义集合覆盖默认 DANGEROUS_TOOL_CATEGORIES', () => {
      const e = new PermissionEngine('ask', new Set(['custom_dangerous']));
      expect(e.isDangerousTool('write_file')).toBe(false); // 默认集合被覆盖
      expect(e.isDangerousTool('custom_dangerous')).toBe(true);
    });
  });

  // ── DangerLevel 类型 Sanity ──
  describe('DangerLevel 三档', () => {
    const levels: DangerLevel[] = ['safe', 'moderate', 'dangerous'];
    for (const lvl of levels) {
      it(`ask 模式下 ${lvl} 普通工具的判定一致性`, () => {
        const r = engine('ask').checkPermission('plain_tool', '{}', lvl);
        if (lvl === 'safe') expect(r.allowed).toBe(true);
        else expect(r.requiresReview).toBe(true);
      });
    }
  });
});
