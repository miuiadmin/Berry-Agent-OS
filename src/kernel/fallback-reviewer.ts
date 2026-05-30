import { getLogger } from '../utils/logger.js';

const logger = getLogger('fallback-reviewer');

export type FallbackVerdict = 'approve' | 'hold' | 'deny';

export interface FallbackReviewInput {
  responseText: string;
  hasToolCalls: boolean;
  toolNames?: string[];
  agentName: string;
}

const DANGEROUS_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s/i,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM\s+\w+\s*;/i,
  /format\s+[a-z]:/i,
  /sudo\s+rm/i,
  />\s*\/dev\/sd[a-z]/i,
  /mkfs\./i,
  /dd\s+if=/i,
];

const DANGEROUS_TOOLS = new Set([
  'shell_exec',
  'delete_file',
  'write_file',
]);

export class FallbackReviewer {
  review(input: FallbackReviewInput): { verdict: FallbackVerdict; reason: string } {
    if (this.containsDangerousPattern(input.responseText)) {
      return { verdict: 'deny', reason: 'Response contains dangerous command pattern' };
    }

    if (input.hasToolCalls) {
      const dangerousTools = input.toolNames?.filter(t => DANGEROUS_TOOLS.has(t)) ?? [];
      if (dangerousTools.length > 0) {
        return { verdict: 'hold', reason: `Tool calls include risky tools: ${dangerousTools.join(', ')}` };
      }
      return { verdict: 'hold', reason: 'Response contains tool calls requiring review' };
    }

    if (this.containsCodeBlock(input.responseText)) {
      if (input.responseText.length > 500) {
        return { verdict: 'hold', reason: 'Large response with code blocks' };
      }
    }

    if (this.isSimpleText(input.responseText)) {
      return { verdict: 'approve', reason: 'Simple text response under threshold' };
    }

    return { verdict: 'hold', reason: 'Unrecognized response pattern, holding for review' };
  }

  private containsDangerousPattern(text: string): boolean {
    return DANGEROUS_PATTERNS.some(p => p.test(text));
  }

  private containsCodeBlock(text: string): boolean {
    return text.includes('```');
  }

  private isSimpleText(text: string): boolean {
    return text.length <= 200 && !this.containsCodeBlock(text);
  }
}
