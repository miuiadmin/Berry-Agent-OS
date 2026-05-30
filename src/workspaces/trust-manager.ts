import type Database from 'better-sqlite3';
import type {
  TrustLevel,
  ReviewRiskLevel,
  AutoApproveDecision,
} from '../contracts/superior-review.js';
import {
  DEFAULT_TRUST_RULES,
  TRUST_LEVELS_ORDERED,
  AUTO_APPROVE_TOKEN_THRESHOLD,
  AUTONOMOUS_RANDOM_AUDIT_RATE,
} from '../contracts/superior-review.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('trust-manager');

interface ToolCallInfo {
  name: string;
  dangerLevel?: 'safe' | 'moderate' | 'dangerous';
}

export class TrustManager {
  constructor(private readonly db: Database.Database) {}

  getTrustLevel(agentId: string): TrustLevel {
    const row = this.db.prepare(
      'SELECT trust_level FROM workspace_agents WHERE id = ?',
    ).get(agentId) as { trust_level: string } | undefined;
    const level = row?.trust_level as TrustLevel | undefined;
    return level && TRUST_LEVELS_ORDERED.includes(level) ? level : 'probation';
  }

  getReviewMode(agentId: string): 'strict' | 'trust_based' {
    const row = this.db.prepare(
      'SELECT review_mode FROM workspace_agents WHERE id = ?',
    ).get(agentId) as { review_mode: string } | undefined;
    return row?.review_mode === 'strict' ? 'strict' : 'trust_based';
  }

  shouldAutoApprove(agentId: string, draftResponse: string, toolCalls: ToolCallInfo[]): AutoApproveDecision {
    const reviewMode = this.getReviewMode(agentId);
    if (reviewMode === 'strict') {
      return { autoApprove: false, reason: 'strict review mode', riskLevel: this.classifyRisk(draftResponse, toolCalls) };
    }

    const trustLevel = this.getTrustLevel(agentId);
    const riskLevel = this.classifyRisk(draftResponse, toolCalls);

    if (trustLevel === 'probation' || trustLevel === 'standard') {
      return { autoApprove: false, reason: `trust level ${trustLevel} requires review`, riskLevel };
    }

    if (riskLevel === 'high') {
      return { autoApprove: false, reason: 'high risk output requires review', riskLevel };
    }

    if (trustLevel === 'autonomous' && Math.random() < AUTONOMOUS_RANDOM_AUDIT_RATE) {
      return { autoApprove: false, reason: 'random audit (5%)', riskLevel };
    }

    return { autoApprove: true, reason: `trust level ${trustLevel}, risk ${riskLevel}`, riskLevel };
  }

  classifyRisk(draftResponse: string, toolCalls: ToolCallInfo[]): ReviewRiskLevel {
    if (toolCalls.length === 0 && draftResponse.length < AUTO_APPROVE_TOKEN_THRESHOLD) {
      return 'low';
    }

    const hasDangerous = toolCalls.some(tc => tc.dangerLevel === 'dangerous');
    if (hasDangerous) return 'high';

    const hasModerate = toolCalls.some(tc => tc.dangerLevel === 'moderate');
    if (hasModerate) return 'medium';

    if (toolCalls.length > 0) return 'medium';

    return 'low';
  }

  recordApproval(agentId: string): TrustLevel {
    const row = this.db.prepare(
      'SELECT trust_level, consecutive_approvals FROM workspace_agents WHERE id = ?',
    ).get(agentId) as { trust_level: string; consecutive_approvals: number } | undefined;

    if (!row) return 'probation';

    const newCount = row.consecutive_approvals + 1;
    let newLevel = row.trust_level as TrustLevel;

    if (newLevel === 'probation' && newCount >= DEFAULT_TRUST_RULES.probationToStandard) {
      newLevel = 'standard';
      logger.info({ agentId, from: 'probation', to: 'standard' }, 'Trust escalated');
    } else if (newLevel === 'standard' && newCount >= DEFAULT_TRUST_RULES.standardToTrusted) {
      newLevel = 'trusted';
      logger.info({ agentId, from: 'standard', to: 'trusted' }, 'Trust escalated');
    }

    this.db.prepare(`
      UPDATE workspace_agents SET consecutive_approvals = ?, trust_level = ? WHERE id = ?
    `).run(newCount, newLevel, agentId);

    return newLevel;
  }

  recordRejection(agentId: string): TrustLevel {
    const row = this.db.prepare(
      'SELECT trust_level, total_rejections FROM workspace_agents WHERE id = ?',
    ).get(agentId) as { trust_level: string; total_rejections: number } | undefined;

    if (!row) return 'probation';

    const newTotalRejections = row.total_rejections + 1;
    const currentLevel = row.trust_level as TrustLevel;
    const currentIdx = TRUST_LEVELS_ORDERED.indexOf(currentLevel);

    let newLevel: TrustLevel;
    if (newTotalRejections % 3 === 0) {
      newLevel = 'probation';
    } else if (currentIdx > 0) {
      newLevel = TRUST_LEVELS_ORDERED[currentIdx - 1];
    } else {
      newLevel = 'probation';
    }

    logger.info({ agentId, from: currentLevel, to: newLevel, totalRejections: newTotalRejections }, 'Trust demoted');

    this.db.prepare(`
      UPDATE workspace_agents SET consecutive_approvals = 0, total_rejections = ?, trust_level = ? WHERE id = ?
    `).run(newTotalRejections, newLevel, agentId);

    return newLevel;
  }

  setTrustLevel(agentId: string, level: TrustLevel): void {
    this.db.prepare(
      'UPDATE workspace_agents SET trust_level = ?, consecutive_approvals = 0 WHERE id = ?',
    ).run(level, agentId);
    logger.info({ agentId, level }, 'Trust level manually set');
  }
}
