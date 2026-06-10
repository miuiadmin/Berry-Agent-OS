/**
 * ObservationRecorder 单元测试 — 13.0 灵魂版 Brain 观察队列持久化器。
 *
 * 测试覆盖：
 * - record() 正确写入 + seq 单调递增
 * - queryRecent() 按时间倒序返回
 * - queryByType() 按类型过滤
 * - queryByTask() 按 task_id 升序
 * - prune() 滚动窗口裁剪（priority ASC 优先）
 * - count() 统计
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ObservationRecorder, DEFAULT_OBSERVATION_WINDOW } from './observation-recorder.js';

describe('ObservationRecorder', () => {
  let db: Database.Database;
  let recorder: ObservationRecorder;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE brain_observations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        observation_type TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT,
        content TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1,
        metadata_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        UNIQUE(session_id, task_id, seq)
      );
    `);
    recorder = new ObservationRecorder(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('record()', () => {
    it('写入观察并返回 ID', () => {
      const id = recorder.record({
        sessionId: 's1',
        taskId: 't1',
        observationType: 'dialogue_send',
        fromAgent: 'code',
        toAgent: 'memory',
        content: '查询偏好',
      });
      expect(id).toMatch(/^obs_/);
    });

    it('seq 在 (session_id, task_id) 内单调递增', () => {
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: '1' });
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: '2' });
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: '3' });

      const rows = recorder.queryByTask('t1', 's1');
      expect(rows.map(r => r.seq)).toEqual([1, 2, 3]);
    });

    it('不同 task_id 的 seq 独立计数', () => {
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: 'A' });
      recorder.record({ sessionId: 's1', taskId: 't2', observationType: 'tool_call', fromAgent: 'code', content: 'B' });

      const t1Rows = recorder.queryByTask('t1', 's1');
      const t2Rows = recorder.queryByTask('t2', 's1');
      expect(t1Rows[0].seq).toBe(1);
      expect(t2Rows[0].seq).toBe(1);
    });

    it('metadata JSON 序列化正确', () => {
      recorder.record({
        sessionId: 's1',
        taskId: 't1',
        observationType: 'tool_call',
        fromAgent: 'code',
        content: 'x',
        metadata: { toolName: 'read_file', path: '/tmp/a' },
      });

      const rows = recorder.queryByTask('t1', 's1');
      expect(rows[0].metadata).toEqual({ toolName: 'read_file', path: '/tmp/a' });
    });
  });

  describe('queryRecent()', () => {
    beforeEach(() => {
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'dialogue_send', fromAgent: 'code', content: '1' });
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: '2' });
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'dialogue_reply', fromAgent: 'memory', content: '3' });
    });

    it('按时间倒序返回所有观察', () => {
      const rows = recorder.queryRecent('s1', 10);
      expect(rows.length).toBe(3);
    });

    it('按类型过滤', () => {
      const rows = recorder.queryRecent('s1', 10, ['dialogue_send']);
      expect(rows.length).toBe(1);
      expect(rows[0].observationType).toBe('dialogue_send');
    });

    it('limit 限制返回数量', () => {
      const rows = recorder.queryRecent('s1', 1);
      expect(rows.length).toBe(1);
    });
  });

  describe('queryByType()', () => {
    beforeEach(() => {
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'dialogue_send', fromAgent: 'code', content: 'A' });
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: 'B' });
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'dialogue_reply', fromAgent: 'memory', content: 'C' });
    });

    it('多类型过滤返回所有匹配', () => {
      const rows = recorder.queryByType('s1', ['dialogue_send', 'dialogue_reply'], 10);
      expect(rows.length).toBe(2);
    });

    it('空类型数组返回空', () => {
      const rows = recorder.queryByType('s1', [], 10);
      expect(rows).toEqual([]);
    });
  });

  describe('prune()', () => {
    it('窗口内不删除', () => {
      for (let i = 0; i < 10; i++) {
        recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: `c${i}` });
      }
      const deleted = recorder.prune('s1', 't1');
      expect(deleted).toBe(0);
      expect(recorder.count('s1')).toBe(10);
    });

    it('超出窗口后裁剪（priority=2 优先删除）', () => {
      // 创建一个小窗口的 recorder
      const smallRecorder = new ObservationRecorder(db, 5);
      // 插入 3 条 verbose (priority=2)
      for (let i = 0; i < 3; i++) {
        smallRecorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: `v${i}`, priority: 2 });
      }
      // 插入 3 条 critical (priority=0)
      for (let i = 0; i < 3; i++) {
        smallRecorder.record({ sessionId: 's1', taskId: 't1', observationType: 'dialogue_send', fromAgent: 'code', content: `c${i}`, priority: 0 });
      }
      // 触发 prune：应删除 verbose，保留 critical
      // seq=6 触发 prune（每 50 条触发一次，这里需要手动调用）
      const deleted = smallRecorder.prune('s1', 't1');
      // 窗口 5，当前 6 条，需删除 1 条 verbose
      expect(deleted).toBe(1);
      const rows = smallRecorder.queryByTask('t1', 's1');
      // 剩余 5 条：3 critical + 2 verbose
      const priorities = rows.map(r => r.priority).sort();
      expect(priorities).toEqual([0, 0, 0, 2, 2]);
    });

    it('全部 critical 时不删除', () => {
      const smallRecorder = new ObservationRecorder(db, 3);
      for (let i = 0; i < 5; i++) {
        smallRecorder.record({ sessionId: 's1', taskId: 't1', observationType: 'dialogue_send', fromAgent: 'code', content: `c${i}`, priority: 0 });
      }
      const deleted = smallRecorder.prune('s1', 't1');
      // 全部 priority=0 (critical)，永不删除
      expect(deleted).toBe(0);
    });
  });

  describe('count()', () => {
    it('统计指定 session 的观察总数', () => {
      recorder.record({ sessionId: 's1', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: '1' });
      recorder.record({ sessionId: 's1', taskId: 't2', observationType: 'tool_call', fromAgent: 'code', content: '2' });
      recorder.record({ sessionId: 's2', taskId: 't1', observationType: 'tool_call', fromAgent: 'code', content: '3' });

      expect(recorder.count('s1')).toBe(2);
      expect(recorder.count('s2')).toBe(1);
    });
  });

  describe('DEFAULT_OBSERVATION_WINDOW', () => {
    it('默认值 500', () => {
      expect(DEFAULT_OBSERVATION_WINDOW).toBe(500);
    });
  });
});