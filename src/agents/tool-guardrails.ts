import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger.js';
import { extractToolPath } from '../contracts/tool-input.js';

const logger = getLogger('tool-guardrails');

export type ToolCategory = 'idempotent' | 'mutating' | 'never_parallel';

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  read_file: 'idempotent',
  list_directory: 'idempotent',
  memory_read: 'idempotent',
  memory_search: 'idempotent',
  session_search: 'idempotent',
  query_brain_decisions: 'idempotent',
  get_metrics: 'idempotent',
  write_file: 'mutating',
  run_command: 'mutating',
  memory_write: 'mutating',
  memory_delete: 'mutating',
  skill_manage: 'mutating',
  create_agent: 'mutating',
  destroy_agent: 'mutating',
  ask_user: 'never_parallel',
};

export type GuardrailAction = 'allow' | 'warn' | 'block';

export interface GuardrailResult {
  action: GuardrailAction;
  reason?: string;
}

const REPETITION_THRESHOLD = 3;
const NO_PROGRESS_THRESHOLD = 5;

export class ToolGuardrails {
  private callHistory: Array<{ name: string; inputHash: string; category: ToolCategory }> = [];
  private consecutiveIdempotent = 0;
  private warned = false;

  classify(toolName: string): ToolCategory {
    return TOOL_CATEGORIES[toolName] ?? 'mutating';
  }

  check(toolName: string, input: unknown): GuardrailResult {
    const category = this.classify(toolName);
    const inputHash = hashInput(input);

    // Check repetition: same tool + same input ≥ THRESHOLD times consecutively
    const recentSame = this.countConsecutiveSame(toolName, inputHash);
    if (recentSame >= REPETITION_THRESHOLD) {
      return { action: 'block', reason: `Tool "${toolName}" called ${recentSame + 1} times with same input — deadloop detected` };
    }
    if (recentSame === REPETITION_THRESHOLD - 1) {
      return { action: 'warn', reason: `Tool "${toolName}" called repeatedly with same input — possible loop` };
    }

    // Check no-progress: many idempotent calls without any mutating
    if (category === 'idempotent') {
      this.consecutiveIdempotent++;
      if (this.consecutiveIdempotent >= NO_PROGRESS_THRESHOLD * 2) {
        return { action: 'block', reason: `${this.consecutiveIdempotent} consecutive read-only calls with no write — no progress` };
      }
      if (this.consecutiveIdempotent >= NO_PROGRESS_THRESHOLD && !this.warned) {
        this.warned = true;
        return { action: 'warn', reason: `${this.consecutiveIdempotent} consecutive read-only calls — consider taking action` };
      }
    } else {
      this.consecutiveIdempotent = 0;
      this.warned = false;
    }

    this.callHistory.push({ name: toolName, inputHash, category });
    if (this.callHistory.length > 50) this.callHistory = this.callHistory.slice(-30);

    return { action: 'allow' };
  }

  canParallel(toolCalls: Array<{ name: string; input: unknown }>): boolean {
    if (toolCalls.length <= 1) return false;
    if (toolCalls.some(tc => this.classify(tc.name) === 'never_parallel')) return false;

    const mutatingPaths = toolCalls
      .filter(tc => this.classify(tc.name) === 'mutating')
      .map(tc => extractPath(tc.input))
      .filter(Boolean);

    if (mutatingPaths.length <= 1) return true;
    return !hasPathOverlap(mutatingPaths as string[]);
  }

  reset(): void {
    this.callHistory = [];
    this.consecutiveIdempotent = 0;
    this.warned = false;
  }

  private countConsecutiveSame(name: string, inputHash: string): number {
    let count = 0;
    for (let i = this.callHistory.length - 1; i >= 0; i--) {
      if (this.callHistory[i].name === name && this.callHistory[i].inputHash === inputHash) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }
}

function hashInput(input: unknown): string {
  const str = JSON.stringify(input ?? '');
  return createHash('md5').update(str).digest('hex').slice(0, 12);
}

function extractPath(input: unknown): string | null {
  return extractToolPath(input);
}

function hasPathOverlap(paths: string[]): boolean {
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[i] === paths[j] || paths[i].startsWith(paths[j]) || paths[j].startsWith(paths[i])) {
        return true;
      }
    }
  }
  return false;
}
