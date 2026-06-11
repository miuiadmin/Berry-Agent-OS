/**
 * 13.0 多智能体协作 — Squad 组织语言工具（squad tool）。
 *
 * §11.10 — squad tool 的 5 个操作：
 *   - read：读整个组织图
 *   - create_squad：创建新 squad（leader 裂变时调用，深度验证 <=3）
 *   - update_member：更新成员状态（worker/checker 汇报进度）
 *   - handoff：交接成果（from squad → to squad）
 *   - signal：发送信号（progress/blocker/done/question）
 *
 * 设计要点：
 *   - dangerLevel: 'moderate'（创建 squad 涉及组织结构调整）
 *   - 深度硬限制在工具层强制执行（LLM 不需要自律，系统帮它守底线）
 *   - signals 同时写入 squad.signals 和全局 signals（不重复不遗漏）
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './types.js';
import { SquadToolInputSchema } from '../contracts/mission.js';
import { getManager } from './plan-tools.js';

/**
 * squad tool — 管理团队组织：创建/裂变 squad、分配角色、交接成果、发送信号。
 *
 * 5 个概念：squad / role / goal / handoff / signal
 * 3 种角色：lead（思考协调）/ work（执行）/ check（验证）
 * 裂变规则：leader 可以创建子 squad，深度不超过 3
 */
export const squadTool: ToolDefinition = {
  name: 'squad',
  description: `管理团队组织：创建/裂变 squad、分配角色、交接成果、发送信号。

5 个操作：
  - read：查看整个 squad 组织图（squad 树、成员、角色、状态）
  - create_squad：创建新的 squad（leader 裂变时使用，深度不超过 3）
  - update_member：更新成员状态（working/done/failed）
  - handoff：向上游/下游 squad 交接成果
  - signal：发送信号（progress=进度更新, blocker=被阻塞, done=完成, question=有疑问）

角色说明：
  - lead：思考 + 协调 + 分配 + 创建子 squad
  - work：执行具体任务
  - check：独立验证执行结果（每个 squad 至少一个）

深度限制：最多 3 层嵌套（mission=0, squad=1, sub-squad=2, 最底层=3）`,

  inputSchema: SquadToolInputSchema,
  dangerLevel: 'moderate',

  async execute(input: unknown): Promise<ToolResult> {
    const parsed = SquadToolInputSchema.parse(input);
    const manager = getManager();

    try {
      switch (parsed.action) {
        case 'read':
          return handleRead(manager, parsed.mission_id);
        case 'create_squad':
          return handleCreateSquad(manager, parsed);
        case 'update_member':
          return handleUpdateMember(manager, parsed);
        case 'signal':
          return handleSignal(manager, parsed);
        case 'handoff':
          return handleHandoff(manager, parsed);
        default:
          return { content: `未知操作: ${parsed.action}`, isError: true };
      }
    } catch (err) {
      const msg = (err as Error).message;
      return { content: `squad tool 错误: ${msg}`, isError: true };
    }
  },
};

// ─── 操作处理函数 ───

/** 递归渲染 squad 树为文本 */
function renderSquadTree(
  squad: {
    id: string; name: string; depth: number; goal: string; leader: string;
    status: string; members: Array<{ agent: string; role: string; on: string; status: string }>;
    squads?: any[];
  },
  indent: string,
  lines: string[],
): void {
  lines.push(`${indent}┌─ ${squad.name} (${squad.id}) [${squad.status}]`);
  lines.push(`${indent}│ Goal: ${squad.goal}`);
  lines.push(`${indent}│ Leader: @${squad.leader}`);

  for (const member of squad.members) {
    const icon = member.role === 'check' ? '🔍' : member.role === 'lead' ? '🧠' : '🔧';
    lines.push(`${indent}│ ${icon} @${member.agent} [${member.status}]: ${member.on}`);
  }

  if (squad.squads && squad.squads.length > 0) {
    for (const sub of squad.squads) {
      renderSquadTree(sub, indent + '│ ', lines);
    }
  }
  lines.push(`${indent}└─`);
}

/**
 * read — 读取并格式化 squad 组织图。
 */
function handleRead(manager: ReturnType<typeof getManager>, missionId: string): ToolResult {
  const squadFile = manager.readSquad(missionId);
  if (!squadFile) {
    // 可能只有 plan 没有 squad
    const plan = manager.readPlan(missionId);
    if (plan) {
      return { content: `Mission ${missionId} 存在但还没有 squad 组织结构。使用 create_squad 创建。` };
    }
    return { content: `Mission ${missionId} 不存在`, isError: true };
  }

  const lines: string[] = [];
  lines.push(`Mission: ${squadFile.mission.goal} (${squadFile.mission.status})`);
  lines.push('');

  for (const squad of squadFile.org.squads) {
    renderSquadTree(squad, '', lines);
  }

  // 显示交接状态
  if (squadFile.handoffs.length > 0) {
    lines.push('');
    lines.push('Handoffs:');
    for (const h of squadFile.handoffs) {
      lines.push(`  ${h.from} → ${h.to}: ${h.what} [${h.status}]`);
    }
  }

  // 显示最近的信号
  if (squadFile.signals.length > 0) {
    lines.push('');
    const recentSignals = squadFile.signals.slice(-5);
    lines.push(`Recent Signals (${squadFile.signals.length} total):`);
    for (const s of recentSignals) {
      const icon = s.type === 'blocker' ? '🚫' : s.type === 'done' ? '✅' : s.type === 'question' ? '❓' : '📊';
      lines.push(`  ${icon} ${s.from}: ${s.msg}`);
    }
  }

  return { content: lines.join('\n') };
}

/**
 * create_squad — 创建新 squad，带深度验证。
 */
function handleCreateSquad(manager: ReturnType<typeof getManager>, parsed: z.infer<typeof SquadToolInputSchema>): ToolResult {
  if (!parsed.squad) {
    return { content: 'create_squad 需要 squad 参数', isError: true };
  }

  try {
    const result = manager.createSquad(parsed.mission_id, {
      name: parsed.squad.name,
      goal: parsed.squad.goal,
      parentSquadId: parsed.squad.parent_squad_id,
      leader: parsed.squad.leader,
      members: parsed.squad.members,
    });

    if (!result) {
      return { content: '创建 squad 失败（mission 不存在或父 squad 无效）', isError: true };
    }

    const parentInfo = parsed.squad.parent_squad_id ? ` (父: ${parsed.squad.parent_squad_id})` : '';

    return {
      content: `✅ Squad "${parsed.squad.name}" 已创建${parentInfo}\n` +
        `  Leader: @${parsed.squad.leader}\n` +
        `  成员: ${(parsed.squad.members ?? []).map(m => `${m.agent}(${m.role})`).join(', ') || '无'}\n` +
        `  目标: ${parsed.squad.goal}`,
    };
  } catch (err) {
    // 深度超限错误
    if ((err as Error).message.includes('depth limit')) {
      return { content: `❌ ${(err as Error).message}\n建议：用扁平 task list 代替继续嵌套`, isError: true };
    }
    throw err;
  }
}

/**
 * update_member — 更新成员状态。
 */
function handleUpdateMember(manager: ReturnType<typeof getManager>, parsed: z.infer<typeof SquadToolInputSchema>): ToolResult {
  if (!parsed.member_update) {
    return { content: 'update_member 需要 member_update 参数', isError: true };
  }

  const { squad_id, agent, status, result } = parsed.member_update;
  const squadFile = manager.updateMember(parsed.mission_id, squad_id, agent, status, result);

  if (!squadFile) {
    return { content: `更新失败（squad ${squad_id} 或 agent ${agent} 不存在）`, isError: true };
  }

  return {
    content: `✅ @${agent} in ${squad_id} → ${status}${result ? `\n  结果: ${result}` : ''}`,
  };
}

/**
 * signal — 发送信号。
 */
function handleSignal(manager: ReturnType<typeof getManager>, parsed: z.infer<typeof SquadToolInputSchema>): ToolResult {
  if (!parsed.signal) {
    return { content: 'signal 需要 signal 参数', isError: true };
  }

  const { squad_id, type, msg } = parsed.signal;
  const squadFile = manager.sendSignal(
    parsed.mission_id,
    squad_id,
    squad_id, // from = squad_id（agent 信号以 squad 名义发出）
    type,
    msg,
  );

  if (!squadFile) {
    return { content: `发送信号失败（squad ${squad_id} 不存在）`, isError: true };
  }

  const icons: Record<string, string> = { progress: '📊', blocker: '🚫', done: '✅', question: '❓' };
  return { content: `${icons[type] ?? '📡'} 信号已发送: [${type}] ${msg}` };
}

/**
 * handoff — 执行交接。
 *
 * 13.0 §5.3.11: handoff 时构建结构化的 HandoffContext。
 * 从 plan.json 的已完成任务结果和 squad signals 中提取上下文信息，
 * 让接班的 Agent 获得完整的工作状态快照，避免重复劳动。
 */
function handleHandoff(manager: ReturnType<typeof getManager>, parsed: z.infer<typeof SquadToolInputSchema>): ToolResult {
  if (!parsed.handoff_data) {
    return { content: 'handoff 需要 handoff_data 参数', isError: true };
  }

  const { from_squad, to_squad, what, content } = parsed.handoff_data;

  // ─── 构建 HandoffContext（§5.3.11） ───
  const plan = manager.readPlan(parsed.mission_id);

  /** 从 plan 的已完成任务中提取文件操作记录 */
  const filesRead: string[] = [];
  const filesModified: Array<{ path: string; diffHash?: string }> = [];
  const agentConversations: Array<{ with: string; summary: string; at: number }> = [];

  if (plan) {
    for (const task of plan.tasks) {
      // 收集所有已完成任务中相关 agent 的结果
      if (task.status === 'done' && task.result) {
        // 从 result 文本中提取文件路径（简单模式匹配）
        const filePathPattern = /(?:read|reading|读取|查看了?)\s+[`"']?([^\s`"']+\.(?:ts|js|json|md|yaml|yml|py|tsx|jsx|css|html|sql))["`']?/gi;
        let match: RegExpExecArray | null;
        while ((match = filePathPattern.exec(task.result)) !== null) {
          if (!filesRead.includes(match[1])) filesRead.push(match[1]);
        }

        const modifiedPattern = /(?:modified|修改|changed|wrote|写入|编辑)\s+[`"']?([^\s`"']+\.(?:ts|js|json|md|yaml|yml|py|tsx|jsx|css|html|sql))["`']?/gi;
        while ((match = modifiedPattern.exec(task.result)) !== null) {
          const path = match[1];
          if (!filesModified.some(f => f.path === path)) {
            filesModified.push({ path });
          }
        }
      }

      // 记录各 agent 的任务执行作为 "对话摘要"
      if (task.status !== 'waiting' && task.who) {
        agentConversations.push({
          with: task.who,
          summary: task.status === 'done'
            ? `完成了 "${task.what}" → ${task.result?.slice(0, 200) ?? '(无结果)'}`
            : `正在执行 "${task.what}" (状态: ${task.status})`,
          at: task.updated_at ? new Date(task.updated_at).getTime() : Date.now(),
        });
      }
    }
  }

  // 从 squad signals 中提取 blockers
  const blockers: Array<{ reason: string; raisedAt: number; raisedBy: string }> = [];
  const squadFile = manager.readSquad(parsed.mission_id);
  if (squadFile) {
    const fromSquadObj = findSquadById(squadFile, from_squad);
    if (fromSquadObj?.signals) {
      for (const sig of fromSquadObj.signals) {
        if (sig.type === 'blocker') {
          blockers.push({
            reason: sig.msg,
            raisedAt: sig.at ? new Date(sig.at).getTime() : Date.now(),
            raisedBy: sig.from,
          });
        }
      }
    }
  }

  const handoffContext: import('../contracts/delegation.js').HandoffContext = {
    originalInstruction: plan?.mission?.context ?? what,
    intentAnchor: plan ? {
      goal: plan.mission?.goal ?? what,
      successCriteria: [],
      scope: {},
    } : undefined,
    filesRead,
    filesModified,
    agentConversations: agentConversations.slice(-10), // 保留最近 10 条
    currentProgress: content ?? what,
    blockers,
    handoffAt: Date.now(),
    fromAgent: from_squad,
  };

  const result = manager.executeHandoff(parsed.mission_id, from_squad, to_squad, what, content, handoffContext);

  if (!result) {
    return { content: '交接失败（squad 不存在）', isError: true };
  }

  return {
    content: `✅ 交接完成: ${from_squad} → ${to_squad}\n  内容: ${what}\n  上下文: 已读 ${filesRead.length} 文件, 已改 ${filesModified.length} 文件, ${blockers.length} 个阻塞`,
  };
}

/**
 * 在 squad.json 中按 ID 递归查找 squad（含任意层级子 squad）。
 *
 * 修复：旧版只遍历 2 层（顶层 + 1 层 sub-squad），depth=3 的最深 squad 找不到。
 * 现在改为真正的递归，与 MissionManager.findSquad() 行为一致。
 */
function findSquadById(squadFile: import('../contracts/mission.js').SquadFile, squadId: string): import('../contracts/mission.js').Squad | null {
  if (!squadFile.org?.squads) return null;
  return findSquadInList(squadFile.org.squads, squadId);
}

/** 递归辅助：在 squad 列表中（含各自子 squad）查找目标 ID */
function findSquadInList(squads: import('../contracts/mission.js').Squad[], squadId: string): import('../contracts/mission.js').Squad | null {
  for (const squad of squads) {
    if (squad.id === squadId) return squad;
    // 递归进入子 squad（任意深度）
    const subSquads = (squad as unknown as { squads?: import('../contracts/mission.js').Squad[] }).squads;
    if (subSquads && subSquads.length > 0) {
      const found = findSquadInList(subSquads, squadId);
      if (found) return found;
    }
  }
  return null;
}
