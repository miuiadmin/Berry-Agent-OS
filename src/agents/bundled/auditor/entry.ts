import type { AgentTaskPayload } from '../../../contracts/tasks.js';
import { getDb, startModuleAgent } from '../../module-agent.js';
import { runAudit } from './scan.js';

/**
 * 15.0 机制 C：Auditor Agent 入口（on-demand module-agent）。
 *
 * 被动事后审计者：收到 audit_scan 任务时运行 5 维确定性扫描（scan.ts），返回 AuditReport。
 * 不在关键路径、不阻塞业务。触发方式：cron 定时调度 / Brain 通过 brain.command(inspect)
 * 主动请求 / 其它任务派发。报告交给 Brain 决策（划 scope / 升级用户 / 触发进化）。
 *
 * 依据 CLAUDE.md「确定性逻辑优先做代码模块」：扫描全部是确定性 SQL（scan.ts），本入口
 * 只做编排（取 db → 扫描 → 返回），无 LLM；未来如需 LLM 模式解释，在 scan 产出后增量加。
 */
startModuleAgent(async (payload: AgentTaskPayload) => {
  const input = (payload.inputPayload ?? {}) as { since?: number; to?: number };
  const report = runAudit(getDb(), { since: input.since, to: input.to });
  return { kind: 'audit_scan', report };
});
