import { describe, it, expect } from 'vitest';
import { routeReviewTarget } from './permission-flow.js';
import type { PermissionMode } from '../../safety/permissions.js';

/**
 * 15.0 机制 A：routeReviewTarget 路由决策纯函数测试。
 *
 * 钉死 requiresReview 的分流规则（handler 据此决定走 Brain 还是用户确认）：
 * - L2 moderate → 任何模式下都 'brain'（机制 A 核心行为，替代旧规则放行/用户确认）
 * - L3 dangerous / 危险工具类别（非 moderate）→ ask 'user' / yolo 'brain'
 */
const modes: PermissionMode[] = ['ask', 'allow-all', 'deny-all', 'yolo'];

describe('routeReviewTarget (15.0 机制 A)', () => {
  describe('L2 moderate → 一律 brain', () => {
    for (const mode of modes) {
      it(`moderate × ${mode} → brain`, () => {
        expect(routeReviewTarget('moderate', mode)).toBe('brain');
      });
    }
  });

  describe('L3 dangerous（及危险工具类别）', () => {
    it('dangerous × ask → user（用户最终权威）', () => {
      expect(routeReviewTarget('dangerous', 'ask')).toBe('user');
    });
    it('dangerous × yolo → brain（yolo 委托 Brain）', () => {
      expect(routeReviewTarget('dangerous', 'yolo')).toBe('brain');
    });
    it('dangerous × allow-all → user（非 yolo 即 user）', () => {
      expect(routeReviewTarget('dangerous', 'allow-all')).toBe('user');
    });
    it('dangerous × deny-all → user', () => {
      expect(routeReviewTarget('dangerous', 'deny-all')).toBe('user');
    });
  });

  describe('safe 但命中危险工具类别（仅此情况 safe 进 requiresReview）', () => {
    it('safe × ask → user', () => {
      expect(routeReviewTarget('safe', 'ask')).toBe('user');
    });
    it('safe × yolo → brain（yolo 下危险类别也交 Brain）', () => {
      expect(routeReviewTarget('safe', 'yolo')).toBe('brain');
    });
  });

  it('路由规则汇总矩阵', () => {
    // 完整矩阵快照，任何调整需显式更新
    const matrix: Record<string, Record<PermissionMode, 'brain' | 'user'>> = {
      moderate: { ask: 'brain', 'allow-all': 'brain', 'deny-all': 'brain', yolo: 'brain' },
      dangerous: { ask: 'user', 'allow-all': 'user', 'deny-all': 'user', yolo: 'brain' },
      safe: { ask: 'user', 'allow-all': 'user', 'deny-all': 'user', yolo: 'brain' },
    };
    for (const [level, expected] of Object.entries(matrix)) {
      for (const mode of modes) {
        expect(routeReviewTarget(level, mode)).toBe(expected[mode]);
      }
    }
  });
});
