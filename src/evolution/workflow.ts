import type { Database } from 'better-sqlite3';
import { PluginRegistry } from '../plugins/index.js';
import { SkillsRegistry } from '../skills/index.js';
import { EvolutionProposalStore } from './store.js';
import type { EvolutionProposal } from './types.js';

export class EvolutionWorkflow {
  private readonly proposals: EvolutionProposalStore;
  private readonly skills: SkillsRegistry;
  private readonly plugins: PluginRegistry;

  constructor(db: Database) {
    this.proposals = new EvolutionProposalStore(db);
    this.skills = new SkillsRegistry(db);
    this.plugins = new PluginRegistry(db);
  }

  validate(proposalId: string): EvolutionProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.type.startsWith('skill_')) {
      if (!proposal.draftPath) throw new Error('技能提案缺少 draft_path');
      const result = this.skills.validateFile(proposal.draftPath);
      return this.proposals.update(proposal.id, {
        status: result.ok ? 'approved' : 'failed',
        validatorResult: { ...result },
        reason: result.ok ? proposal.reason : result.errors.join('; '),
      });
    }

    const plugin = this.plugins.get(proposal.targetName);
    if (!plugin) throw new Error(`插件不存在: ${proposal.targetName}`);
    const result = this.plugins.validate(plugin.name);
    return this.proposals.update(proposal.id, {
      status: result.ok ? 'pending_review' : 'failed',
      validatorResult: { ...result },
      reason: result.ok ? proposal.reason : result.errors.join('; '),
    });
  }

  approve(proposalId: string, opts: { enable?: boolean; reviewer?: string } = {}): EvolutionProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === 'rejected' || proposal.status === 'failed' || proposal.status === 'rolled_back') {
      throw new Error(`提案状态不允许批准: ${proposal.status}`);
    }

    if (proposal.type.startsWith('skill_')) {
      return this.proposals.update(proposal.id, {
        status: 'applied',
        brainReviewId: opts.reviewer ?? 'manual',
      });
    }

    if (proposal.riskLevel === 'high' && opts.enable) {
      const updated = this.proposals.update(proposal.id, {
        status: 'pending_user_confirm',
        brainReviewId: opts.reviewer ?? 'manual',
        reason: '高风险插件需要用户确认后启用',
      });
      this.plugins.setStatus(proposal.targetName, 'pending_user_confirm', '高风险插件需要用户确认');
      return updated;
    }

    if (opts.enable) {
      this.plugins.enable(proposal.targetName);
      return this.proposals.update(proposal.id, {
        status: 'applied',
        brainReviewId: opts.reviewer ?? 'manual',
      });
    }

    this.plugins.setStatus(proposal.targetName, 'pending_user_confirm', '已批准，等待启用确认');
    return this.proposals.update(proposal.id, {
      status: 'approved',
      brainReviewId: opts.reviewer ?? 'manual',
    });
  }

  reject(proposalId: string, reason: string): EvolutionProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.type.startsWith('plugin_')) {
      const plugin = this.plugins.get(proposal.targetName);
      if (plugin) this.plugins.disable(plugin.name, reason);
    } else if (proposal.type.startsWith('skill_')) {
      const skill = this.skills.get(proposal.targetName);
      if (skill) this.skills.setDisabled(skill.name, true);
    }
    return this.proposals.update(proposalId, { status: 'rejected', reason });
  }

  rollback(proposalId: string, reason = '用户请求回滚'): EvolutionProposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.type.startsWith('plugin_')) {
      const plugin = this.plugins.get(proposal.targetName);
      if (plugin) this.plugins.rollback(plugin.name, reason);
    } else if (proposal.type.startsWith('skill_')) {
      const skill = this.skills.get(proposal.targetName);
      if (skill) this.skills.setDisabled(skill.name, true);
    }
    return this.proposals.update(proposalId, { status: 'rolled_back', reason });
  }

  private requireProposal(id: string): EvolutionProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`自进化提案不存在: ${id}`);
    return proposal;
  }
}
