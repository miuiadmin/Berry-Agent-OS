/**
 * board-repo 16.0 任务板存储层测试（设计文档/23 §5.1）。
 *
 * 背景：board-repo 是 16.0 协作的核心存储入口（11 个导出函数），被 board-projection /
 * board-observer / board-tool-request-handler / flows/board-ask-handler / flows/permission-flow /
 * flows/brain-command-handler / delegation-orchestrator 共 7 处生产路径依赖。本测试钉死其
 * DB 不变量：seq 单调递增、turn_count 计数、redactSecrets 清洗、幂等性、CRUD 往返。
 *
 * 测试基建说明（与 board-projection.test.ts 同模式）：
 *   - 每个用例独立临时库（mkdtempSync + initDb + initEventBus），afterEach closeDb + rmSync
 *   - 用例独立 taskId 避免板间串扰
 *   - board-repo 依赖 agent_tasks 行存在（board 元数据列由 migration v28 ALTER 补），
 *     故测试需先 INSERT agent_tasks 行再调 initBoard/postBoardMessage
 *
 * 不测：
 *   - board-projection 的 EventBus 派生事件（见 board-projection.test.ts）
 *   - WsEventBridge 的 ws 转发（web 层，归 1-to-1/真实测试）
 *   - AI 生成内容（CLAUDE.md 禁止）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../memory/db.js';
import { initEventBus } from './event-bus.js';
import {
  postBoardMessage,
  getBoardThread,
  getRecentBoardMessages,
  getBoardThreadCount,
  getBoardMeta,
  updateBoardMeta,
  initBoard,
  addBoardMember,
  getBoardMembers,
  isBoardMember,
  transferLeadership,
  createSubBoard,
  countActiveSubs,
  rebuildLeaderContextFromBoard,
  resolveLeaderForDelegate,
  assertBoardMemberOrGovernance,
  getBoardContext,
} from './board-repo.js';
import type { BoardMessage } from '../contracts/board-message.js';

/**
 * 测试辅助：插入一行 agent_tasks（board-repo 落库的前置依赖）。
 * 仅写最小必填列（不含 board_* 列——那些由 migration v28 ALTER 补默认值，initBoard 再覆写）。
 *
 * @param taskId   任务 id（= 板 id，板与 task 1:1）
 * @param extra    额外覆盖字段（如 board_status='in_progress' 模拟运行中板）
 */
function insertAgentTask(
  taskId: string,
  extra: Partial<{ session_id: string; board_status: string; board_leader: string }> = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_tasks (id, session_id, correlation_id, task_type, requester, target_agent, input_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      extra.session_id ?? 'sess-test',
      'corr-test',
      'test',
      'tester',
      'brain',
      '{}',
    );
  // 测试需显式覆写 board_* 列（默认值由 migration ALTER 补，此处按测试场景覆盖）
  if (extra.board_status || extra.board_leader) {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (extra.board_status) {
      sets.push('board_status = ?');
      params.push(extra.board_status);
    }
    if (extra.board_leader) {
      sets.push('board_leader = ?');
      params.push(extra.board_leader);
    }
    params.push(taskId);
    getDb().prepare(`UPDATE agent_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
}

/** 构造一条 delegate 信封（最常用，建板 + 指派） */
function mkDelegate(taskId: string, from = 'brain', to = 'evolution'): BoardMessage {
  return {
    id: `bmsg-${taskId}-d`,
    type: 'delegate',
    from,
    to,
    taskId,
    ts: Date.now(),
    subTaskGoal: '测试子任务目标',
  };
}

/** 构造一条 report(blocked) 信封（用于 stuck 风险检测的测试） */
function mkReportBlocked(taskId: string, from = 'evolution'): BoardMessage {
  return {
    id: `bmsg-${taskId}-r`,
    type: 'report',
    from,
    to: 'brain',
    taskId,
    ts: Date.now(),
    summary: '受阻',
    status: 'blocked',
    artifactRefs: [],
  };
}

/** 构造一条 tool_request 信封（用于 redactSecrets 清洗测试） */
function mkToolRequest(taskId: string, secretInInput: unknown): BoardMessage {
  return {
    id: `bmsg-${taskId}-tr`,
    type: 'tool_request',
    from: 'evolution',
    to: 'system',
    taskId,
    ts: Date.now(),
    toolName: 'shell',
    input: { cmd: secretInInput },
  };
}

describe('board-repo 16.0 任务板存储层', () => {
  let dir: string;

  beforeEach(() => {
    // 每个用例独立临时库 + 独立 EventBus
    dir = mkdtempSync(join(tmpdir(), 'berry-board-repo-'));
    initDb(join(dir, 'test.db'));
    initEventBus();
  });

  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ─── postBoardMessage + getBoardThread + seq ───

  it('postBoardMessage 追加发言 → getBoardThread 按 seq ASC 返回，payload 完整还原', () => {
    insertAgentTask('task-1');
    initBoard('task-1', { goal: '顶层目标', leader: 'brain' });

    // 追加 3 条混合 type 信封
    postBoardMessage('task-1', mkDelegate('task-1'));
    postBoardMessage('task-1', mkReportBlocked('task-1'));
    postBoardMessage('task-1', {
      id: 'bmsg-task-1-t',
      type: 'tell',
      from: 'code',
      to: 'all',
      taskId: 'task-1',
      ts: Date.now(),
      text: '板内讨论',
    });

    const thread = getBoardThread('task-1');
    expect(thread).toHaveLength(3);
    // seq 顺序：按落库顺序（payload_json 反序列化保留原字段）
    expect(thread[0].type).toBe('delegate');
    expect(thread[1].type).toBe('report');
    expect(thread[2].type).toBe('tell');
    // 关键字段完整还原（反序列化无损）
    expect((thread[0] as Extract<BoardMessage, { type: 'delegate' }>).subTaskGoal).toBe('测试子任务目标');
    expect((thread[1] as Extract<BoardMessage, { type: 'report' }>).status).toBe('blocked');
  });

  it('seq 单调递增（板内 MAX(seq)+1，better-sqlite3 同步无并发竞争）', () => {
    insertAgentTask('task-seq');
    initBoard('task-seq', { goal: 'seq 测试', leader: 'brain' });

    for (let i = 0; i < 5; i++) {
      postBoardMessage('task-seq', {
        id: `bmsg-seq-${i}`,
        type: 'tell',
        from: 'agent',
        to: 'all',
        taskId: 'task-seq',
        ts: Date.now(),
        text: `第 ${i} 条`,
      });
    }

    // 直接查 task_thread.seq 列验证单调递增（getBoardThread 不返回 seq，故直查列）
    const seqs = getDb()
      .prepare('SELECT seq FROM task_thread WHERE task_id = ? ORDER BY seq ASC')
      .all('task-seq') as Array<{ seq: number }>;
    expect(seqs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('postBoardMessage 经 Zod 校验：非法信封（缺 subTaskGoal）抛错', () => {
    insertAgentTask('task-invalid');
    initBoard('task-invalid', { goal: '校验测试', leader: 'brain' });

    // 故意构造缺 subTaskGoal 的 delegate（as BoardMessage 绕编译期，钉运行时 Zod 校验）
    const bad = {
      id: 'bmsg-bad',
      type: 'delegate',
      from: 'brain',
      to: 'evolution',
      taskId: 'task-invalid',
      ts: Date.now(),
      // 缺 subTaskGoal（delegate 必填）
    } as unknown as BoardMessage;

    expect(() => postBoardMessage('task-invalid', bad)).toThrow();
    // 校验失败不应落库
    expect(getBoardThread('task-invalid')).toHaveLength(0);
  });

  // ─── redactSecrets 清洗 ───

  it('postBoardMessage 落库前 redactSecrets 清洗 payload_json 中的密钥', () => {
    insertAgentTask('task-redact');
    initBoard('task-redact', { goal: '脱敏测试', leader: 'brain' });

    // 输入含疑似密钥（redactSecrets 会扫描 sk-ant-* 等模式替换为占位符）
    const secret = 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    postBoardMessage('task-redact', mkToolRequest('task-redact', secret));

    const thread = getBoardThread('task-redact');
    expect(thread).toHaveLength(1);
    // payload_json 已清洗——原密钥不应再出现在反序列化结果里
    const payloadStr = JSON.stringify(thread[0]);
    expect(payloadStr).not.toContain(secret);
  });

  // ─── turn_count 递增 ───

  it('postBoardMessage 后 agent_tasks.turn_count +1（板预算计数）', () => {
    insertAgentTask('task-turn');
    initBoard('task-turn', { goal: 'turn 计数测试', leader: 'brain' });

    postBoardMessage('task-turn', mkDelegate('task-turn'));
    // 用唯一 id 的 report 信封追加（mkReportBlocked 默认 id 固定，连调会撞 UNIQUE）
    postBoardMessage('task-turn', {
      ...mkReportBlocked('task-turn'),
      id: 'bmsg-task-turn-r1',
    });
    postBoardMessage('task-turn', {
      ...mkReportBlocked('task-turn'),
      id: 'bmsg-task-turn-r2',
    });

    const turnCount = (
      getDb().prepare('SELECT turn_count AS c FROM agent_tasks WHERE id = ?').get('task-turn') as {
        c: number;
      }
    ).c;
    expect(turnCount).toBe(3);
  });

  // ─── getRecentBoardMessages ───

  it('getRecentBoardMessages(count) 返回最近 N 条且正序（DESC 取后 reverse）', () => {
    insertAgentTask('task-recent');
    initBoard('task-recent', { goal: 'recent 测试', leader: 'brain' });

    for (let i = 0; i < 5; i++) {
      postBoardMessage('task-recent', {
        id: `bmsg-recent-${i}`,
        type: 'tell',
        from: 'agent',
        to: 'all',
        taskId: 'task-recent',
        ts: Date.now(),
        text: `第 ${i} 条`,
      });
    }

    // 取最近 3 条
    const recent = getRecentBoardMessages('task-recent', 3);
    expect(recent).toHaveLength(3);
    // 正序：最早落库的在前（最近 3 条 = 第 2/3/4 条）
    expect((recent[0] as Extract<BoardMessage, { type: 'tell' }>).text).toBe('第 2 条');
    expect((recent[2] as Extract<BoardMessage, { type: 'tell' }>).text).toBe('第 4 条');
  });

  // ─── getBoardThreadCount ───

  it('getBoardThreadCount 返回板发言总数', () => {
    insertAgentTask('task-count');
    initBoard('task-count', { goal: 'count 测试', leader: 'brain' });

    expect(getBoardThreadCount('task-count')).toBe(0);
    postBoardMessage('task-count', mkDelegate('task-count'));
    postBoardMessage('task-count', mkReportBlocked('task-count'));
    expect(getBoardThreadCount('task-count')).toBe(2);
  });

  // ─── getBoardMeta ───

  it('getBoardMeta：不存在的 taskId 返回 null', () => {
    expect(getBoardMeta('task-nonexistent')).toBeNull();
  });

  it('getBoardMeta：initBoard 后返回正确元数据（goal/leader/boardStatus/spawnDepth）', () => {
    insertAgentTask('task-meta');
    initBoard('task-meta', {
      goal: '元数据测试',
      leader: 'brain',
      spawnDepth: 0,
    });

    const meta = getBoardMeta('task-meta');
    expect(meta).not.toBeNull();
    expect(meta!.goal).toBe('元数据测试');
    expect(meta!.leader).toBe('brain');
    expect(meta!.boardStatus).toBe('created'); // initBoard 设 created
    expect(meta!.spawnDepth).toBe(0);
    // 默认预算值（migration v28 列默认）
    expect(meta!.maxTurns).toBe(50);
    expect(meta!.maxSpawnDepth).toBe(3);
  });

  it('getBoardMeta：非 board 的普通 task（board_status 默认 created + leader=NULL）安全返回', () => {
    // 仅 INSERT agent_tasks，不 initBoard —— 模拟普通任务（非板）
    insertAgentTask('task-plain');

    const meta = getBoardMeta('task-plain');
    expect(meta).not.toBeNull();
    expect(meta!.goal).toBeNull();
    expect(meta!.leader).toBeNull();
    expect(meta!.boardStatus).toBe('created'); // 列默认值
  });

  // ─── updateBoardMeta ───

  it('updateBoardMeta：部分更新（只传 goal）不改其他字段', () => {
    insertAgentTask('task-update');
    initBoard('task-update', { goal: '原目标', leader: 'brain' });

    updateBoardMeta('task-update', { goal: '新目标' });

    const meta = getBoardMeta('task-update');
    expect(meta!.goal).toBe('新目标');
    // 其他字段保持不变
    expect(meta!.leader).toBe('brain');
    expect(meta!.boardStatus).toBe('created');
  });

  it('updateBoardMeta：传空 patch 早 return 不报错（sets.length===0 路径）', () => {
    insertAgentTask('task-empty-patch');
    initBoard('task-empty-patch', { goal: '空 patch 测试', leader: 'brain' });

    // 空 patch 不应抛错，也不改任何字段
    expect(() => updateBoardMeta('task-empty-patch', {})).not.toThrow();
    const meta = getBoardMeta('task-empty-patch');
    expect(meta!.goal).toBe('空 patch 测试');
  });

  it('updateBoardMeta：colMap 全字段（goal/boardStatus/leader/spawnDepth/maxTurns/maxSpawnDepth/activeScope）覆盖', () => {
    insertAgentTask('task-full-update');
    initBoard('task-full-update', { goal: '原', leader: 'brain' });

    updateBoardMeta('task-full-update', {
      goal: '全字段目标',
      boardStatus: 'in_progress',
      leader: 'code',
      spawnDepth: 2,
      maxTurns: 100,
      maxSpawnDepth: 5,
      activeScope: '{"allowPaths":["/tmp"]}',
    });

    const meta = getBoardMeta('task-full-update');
    expect(meta!.goal).toBe('全字段目标');
    expect(meta!.boardStatus).toBe('in_progress');
    expect(meta!.leader).toBe('code');
    expect(meta!.spawnDepth).toBe(2);
    expect(meta!.maxTurns).toBe(100);
    expect(meta!.maxSpawnDepth).toBe(5);
    expect(meta!.activeScope).toBe('{"allowPaths":["/tmp"]}');
  });

  // ─── initBoard 幂等性 ───

  it('initBoard 幂等：重复调同一 taskId 不报错（UPDATE + INSERT OR IGNORE 语义）', () => {
    insertAgentTask('task-idem');
    initBoard('task-idem', { goal: '第一次', leader: 'brain' });
    // 重复调——不应抛错（仅 UPDATE 覆写 + addBoardMember INSERT OR IGNORE 跳过）
    expect(() => initBoard('task-idem', { goal: '第二次', leader: 'brain' })).not.toThrow();

    const meta = getBoardMeta('task-idem');
    expect(meta!.goal).toBe('第二次');
    // leader 重复 addBoardMember 幂等——花名册只有一条 leader 记录
    expect(getBoardMembers('task-idem')).toHaveLength(1);
  });

  it('initBoard：parentTaskId 单独写入正确（updateBoardMeta 不含它）', () => {
    insertAgentTask('task-parent');
    insertAgentTask('task-child');
    initBoard('task-child', {
      goal: '子板',
      leader: 'evolution',
      parentTaskId: 'task-parent',
    });

    const meta = getBoardMeta('task-child');
    expect(meta!.parentTaskId).toBe('task-parent');
  });

  // ─── addBoardMember + getBoardMembers + isBoardMember ───

  it('addBoardMember + getBoardMembers：leader/member/governance 三种 role 正确落库', () => {
    insertAgentTask('task-members');
    addBoardMember('task-members', 'brain', 'leader');
    addBoardMember('task-members', 'evolution', 'member');
    addBoardMember('task-members', 'reviewer', 'governance');

    const members = getBoardMembers('task-members');
    expect(members).toHaveLength(3);
    const byRole = new Map(members.map((m) => [m.agentId, m.role]));
    expect(byRole.get('brain')).toBe('leader');
    expect(byRole.get('evolution')).toBe('member');
    expect(byRole.get('reviewer')).toBe('governance');
  });

  it('isBoardMember：在册 true / 不在册 false', () => {
    insertAgentTask('task-is-member');
    addBoardMember('task-is-member', 'evolution', 'member');

    expect(isBoardMember('task-is-member', 'evolution')).toBe(true);
    expect(isBoardMember('task-is-member', 'code')).toBe(false);
  });

  it('addBoardMember 幂等：重复加同 agent 不报错（INSERT OR IGNORE）', () => {
    insertAgentTask('task-dup-member');
    addBoardMember('task-dup-member', 'evolution', 'member');
    expect(() => addBoardMember('task-dup-member', 'evolution', 'member')).not.toThrow();
    // 花名册仍只有一条
    expect(getBoardMembers('task-dup-member')).toHaveLength(1);
  });

  // ─── getBoardContext（组装 brain 看板上下文）───

  it('getBoardContext：initBoard + post + addMember 后返回 BoardContext（meta + members + recentMessages + total）', () => {
    insertAgentTask('task-ctx');
    initBoard('task-ctx', { goal: '上下文测试', leader: 'brain' });
    addBoardMember('task-ctx', 'evolution', 'member');
    postBoardMessage('task-ctx', mkDelegate('task-ctx'));
    postBoardMessage('task-ctx', mkReportBlocked('task-ctx'));

    const ctx = getBoardContext('task-ctx');
    expect(ctx).not.toBeNull();
    expect(ctx!.meta.goal).toBe('上下文测试');
    expect(ctx!.members).toHaveLength(2); // leader(brain) + member(evolution)
    expect(ctx!.recentMessages).toHaveLength(2); // delegate + report
    expect(ctx!.totalMessages).toBe(2);
  });

  it('getBoardContext：未 initBoard 的 taskId（但 agent_tasks 行存在）仍返回非 null（meta 默认值）', () => {
    // agent_tasks 行存在但未 initBoard → getBoardMeta 返回非 null（默认值），getBoardContext 也非 null
    insertAgentTask('task-ctx-plain');
    const ctx = getBoardContext('task-ctx-plain');
    expect(ctx).not.toBeNull();
    expect(ctx!.members).toHaveLength(0); // 未 addMember
    expect(ctx!.recentMessages).toHaveLength(0); // 未 postBoardMessage
    expect(ctx!.totalMessages).toBe(0);
  });

  it('getBoardContext：完全不存在的 taskId 返回 null（getBoardMeta 返回 null 短路）', () => {
    expect(getBoardContext('task-nonexistent-ctx')).toBeNull();
  });

  // ─── transferLeadership（§12 注 handoff = delegate 携带 transferLeadership:true）───

  it('transferLeadership：换 leader + 花名册 role 调整（旧 leader 降 member，新 leader 升 leader）', () => {
    insertAgentTask('task-handoff');
    initBoard('task-handoff', { goal: '交接测试', leader: 'brain' });
    addBoardMember('task-handoff', 'code', 'member'); // code 已在册为 member，将升 leader
    expect(getBoardMeta('task-handoff')!.leader).toBe('brain');

    transferLeadership('task-handoff', 'code');

    // 板 leader 元数据换为 code
    expect(getBoardMeta('task-handoff')!.leader).toBe('code');
    // 花名册：code 升 leader，brain 降 member
    const members = getBoardMembers('task-handoff');
    expect(members.find((m) => m.agentId === 'code')?.role).toBe('leader');
    expect(members.find((m) => m.agentId === 'brain')?.role).toBe('member');
  });

  it('transferLeadership：新 leader 不在册时自动入册升 leader；幂等（同 leader no-op）', () => {
    insertAgentTask('task-handoff2');
    initBoard('task-handoff2', { goal: '交接2', leader: 'brain' });
    // research 不在册 → 自动入册
    transferLeadership('task-handoff2', 'research');
    expect(getBoardMeta('task-handoff2')!.leader).toBe('research');
    expect(getBoardMembers('task-handoff2').find((m) => m.agentId === 'research')?.role).toBe('leader');
    // 幂等：再 transfer 给已是 leader 的 research 无变化
    expect(() => transferLeadership('task-handoff2', 'research')).not.toThrow();
    expect(getBoardMeta('task-handoff2')!.leader).toBe('research');
  });

  // ─── createSubBoard（§5.6.3 拆子板 + §10.3 spawnDepth 封顶）───

  it('createSubBoard：拆子板，子板 spawnDepth=父+1 + parent_task_id 链接 + leader 入册', () => {
    insertAgentTask('task-parent');
    initBoard('task-parent', { goal: '父板', leader: 'assistant', spawnDepth: 0 });
    const result = createSubBoard('task-parent', {
      goal: '子任务', leader: 'code', sessionId: 's1', correlationId: 'c1', requester: 'assistant',
    });
    expect(result.status).toBe('ok');
    const child = getBoardMeta((result as { childTaskId: string }).childTaskId)!;
    expect(child.parentTaskId).toBe('task-parent');
    expect(child.spawnDepth).toBe(1); // 父 0 → 子 1
    expect(child.leader).toBe('code');
    expect(isBoardMember(child.taskId, 'code')).toBe(true); // 子 leader 入花名册
  });

  it('createSubBoard：spawnDepth=2 的父 → 子 spawnDepth=3（恰达封顶仍 ok）', () => {
    insertAgentTask('task-d2');
    initBoard('task-d2', { goal: '二层板', leader: 'assistant', spawnDepth: 2 });
    const result = createSubBoard('task-d2', {
      goal: '三层', leader: 'code', sessionId: 's1', correlationId: 'c1', requester: 'assistant',
    });
    expect(result.status).toBe('ok');
    expect(getBoardMeta((result as { childTaskId: string }).childTaskId)!.spawnDepth).toBe(3);
  });

  it('createSubBoard：父已达 maxSpawnDepth(3) → cant_split 降级（§10.3 不硬 fail）', () => {
    insertAgentTask('task-deep');
    initBoard('task-deep', { goal: '已达封顶', leader: 'assistant', spawnDepth: 3 });
    const result = createSubBoard('task-deep', {
      goal: '拆不动', leader: 'code', sessionId: 's1', correlationId: 'c1', requester: 'assistant',
    });
    expect(result.status).toBe('cant_split');
  });

  it('createSubBoard：父板不存在 → cant_split', () => {
    const result = createSubBoard('task-nonexistent-sub', {
      goal: 'x', leader: 'code', sessionId: 's1', correlationId: 'c1', requester: 'assistant',
    });
    expect(result.status).toBe('cant_split');
  });

  it('createSubBoard：活跃子板 ≥ MAX_ACTIVE_SUBS(8) → cant_split（§16.8 第4道物理闸）', () => {
    insertAgentTask('task-cap-parent');
    initBoard('task-cap-parent', { goal: '多子板父', leader: 'assistant', spawnDepth: 0 });
    // 创建 8 个活跃子板（设为 in_progress 模拟运行中）
    for (let i = 0; i < 8; i++) {
      const sub = createSubBoard('task-cap-parent', {
        goal: `子${i}`, leader: 'code', sessionId: 's', correlationId: 'c', requester: 'assistant',
      });
      expect(sub.status).toBe('ok');
      updateBoardMeta((sub as { childTaskId: string }).childTaskId, { boardStatus: 'in_progress' });
    }
    // countActiveSubs 确认 8 个活跃
    expect(countActiveSubs('task-cap-parent')).toBe(8);
    // 第 9 个 → cant_split（活跃子板上限）
    const result = createSubBoard('task-cap-parent', {
      goal: '第9', leader: 'code', sessionId: 's', correlationId: 'c', requester: 'assistant',
    });
    expect(result.status).toBe('cant_split');
    expect((result as { reason: string }).reason).toContain('活跃子板数');
  });

  // ─── resolveLeaderForDelegate（§5.2.1 派工归 leader 非 brain）───

  it('resolveLeaderForDelegate：无 parentTaskId → conversation（顶层 leader=助手，§5.4）', () => {
    expect(resolveLeaderForDelegate()).toBe('conversation');
    expect(resolveLeaderForDelegate(undefined)).toBe('conversation');
  });

  it('resolveLeaderForDelegate：子板派发（parentTaskId 设）→ 父板 leader', () => {
    insertAgentTask('task-parent-ldr');
    initBoard('task-parent-ldr', { goal: '父板', leader: 'code', spawnDepth: 0 });
    expect(resolveLeaderForDelegate('task-parent-ldr')).toBe('code');
  });

  it('resolveLeaderForDelegate：父板不存在 → conversation fallback', () => {
    expect(resolveLeaderForDelegate('task-nonexistent-ldr')).toBe('conversation');
  });

  // ─── assertBoardMemberOrGovernance（§6 可见性收口）───

  it('assertBoardMemberOrGovernance：成员通过 / 治理 viewer 通过 / 非成员抛错', () => {
    insertAgentTask('task-vis');
    initBoard('task-vis', { goal: '可见性', leader: 'code' });
    addBoardMember('task-vis', 'research', 'member');
    // 成员通过
    expect(() => assertBoardMemberOrGovernance('task-vis', 'code')).not.toThrow();
    expect(() => assertBoardMemberOrGovernance('task-vis', 'research')).not.toThrow();
    // 治理 viewer 通过（不进花名册也能看）
    expect(() => assertBoardMemberOrGovernance('task-vis', 'brain')).not.toThrow();
    expect(() => assertBoardMemberOrGovernance('task-vis', 'conversation')).not.toThrow();
    // 非成员非治理 → 抛错（§6 跨板隔离）
    expect(() => assertBoardMemberOrGovernance('task-vis', 'evil-agent')).toThrow();
  });

  // ─── rebuildLeaderContextFromBoard（§16.9 崩溃恢复：从板状态重建 leader 上下文）───

  it('rebuildLeaderContextFromBoard：从板状态重建恢复上下文（completed/blocked/asks/commands/pending）', () => {
    insertAgentTask('task-recover');
    initBoard('task-recover', { goal: '恢复测试', leader: 'assistant' });
    addBoardMember('task-recover', 'code', 'member');
    // 发各种类型消息
    postBoardMessage('task-recover', { id: 'm1', type: 'delegate', from: 'assistant', to: 'code', taskId: 'task-recover', ts: 1, subTaskGoal: '改模块 X' });
    postBoardMessage('task-recover', { id: 'm2', type: 'report', from: 'code', to: 'brain', taskId: 'task-recover', ts: 2, summary: '改完了', status: 'done', artifactRefs: [] });
    postBoardMessage('task-recover', { id: 'm3', type: 'report', from: 'code', to: 'brain', taskId: 'task-recover', ts: 3, summary: '卡住了', status: 'blocked', artifactRefs: [] });
    postBoardMessage('task-recover', { id: 'm4', type: 'ask', from: 'code', to: 'brain', taskId: 'task-recover', ts: 4, question: '方向偏了？', blocking: true });
    postBoardMessage('task-recover', { id: 'm5', type: 'command', from: 'brain', to: 'code', taskId: 'task-recover', ts: 5, intent: 'redirect', instruction: '改用方案 Y' });

    const recovery = rebuildLeaderContextFromBoard('task-recover');
    expect(recovery).not.toBeNull();
    expect(recovery!.goal).toBe('恢复测试');
    expect(recovery!.leader).toBe('assistant');
    expect(recovery!.members).toContain('code');
    expect(recovery!.completed).toHaveLength(1);
    expect(recovery!.completed[0].summary).toBe('改完了');
    expect(recovery!.blocked).toHaveLength(1);
    expect(recovery!.blocked[0].summary).toBe('卡住了');
    expect(recovery!.unansweredAsks).toHaveLength(1);
    expect(recovery!.unansweredAsks[0].question).toBe('方向偏了？');
    expect(recovery!.commands).toHaveLength(1);
    expect(recovery!.commands[0].intent).toBe('redirect');
    expect(recovery!.pending).toHaveLength(1); // delegate
  });

  it('rebuildLeaderContextFromBoard：板不存在 → null', () => {
    expect(rebuildLeaderContextFromBoard('task-nonexistent-recover')).toBeNull();
  });
});
