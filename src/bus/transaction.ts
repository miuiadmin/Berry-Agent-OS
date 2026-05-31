import type { ICapabilityBus, InvokeContext } from './contract.js';
import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';
import { extractToolPath } from '../contracts/tool-input.js';

const logger = getLogger('bus:transaction');

export interface BusTransaction {
  invoke(name: string, input: unknown): Promise<unknown>;
  commit(): void;
  abort(): Promise<void>;
}

interface MutatingRecord {
  capabilityName: string;
  input: unknown;
  beforeState: unknown;
  revertCapability?: string;
}

const MUTATING_CAPABILITIES = new Set([
  'write_file', 'run_command', 'memory_write', 'memory_delete',
  'skill_manage', 'create_agent', 'destroy_agent',
]);

export class TransactionManager {
  private activeTransactions = new Map<string, TransactionContext>();
  private committedHistory: Array<{ id: string; records: MutatingRecord[]; committedAt: number }> = [];
  private maxHistory = 10;

  constructor(private readonly bus: ICapabilityBus) {}

  async begin(ctx: Partial<InvokeContext>): Promise<BusTransaction> {
    const txId = genId('tx');
    const txCtx: TransactionContext = {
      id: txId,
      records: [],
      baseCtx: ctx,
      committed: false,
      aborted: false,
    };
    this.activeTransactions.set(txId, txCtx);

    const transaction: BusTransaction = {
      invoke: async (name, input) => {
        if (txCtx.aborted) throw new Error('Transaction already aborted');
        if (txCtx.committed) throw new Error('Transaction already committed');

        let beforeState: unknown = undefined;
        if (isMutating(name)) {
          beforeState = await this.captureBeforeState(name, input, ctx);
          txCtx.records.push({ capabilityName: name, input, beforeState });
        }

        return this.bus.invoke(name, input, {
          callChain: [],
          sessionId: ctx.sessionId ?? 'tx',
          correlationId: txId,
          traceId: ctx.traceId,
          callerAgent: ctx.callerAgent,
          ...ctx,
        } as InvokeContext).then(r => {
          if (!r.ok) throw new Error(r.error ?? `${name} failed`);
          return r.data;
        });
      },

      commit: () => {
        txCtx.committed = true;
        this.activeTransactions.delete(txId);
        if (txCtx.records.length > 0) {
          this.committedHistory.push({ id: txId, records: txCtx.records, committedAt: Date.now() });
          if (this.committedHistory.length > this.maxHistory) {
            this.committedHistory.shift();
          }
        }
        logger.debug({ txId, mutations: txCtx.records.length }, 'Transaction committed');
      },

      abort: async () => {
        txCtx.aborted = true;
        this.activeTransactions.delete(txId);
        await this.revertRecords(txCtx.records, ctx);
        logger.info({ txId, reverted: txCtx.records.length }, 'Transaction aborted, changes reverted');
      },
    };

    return transaction;
  }

  async revertLastCommitted(ctx: Partial<InvokeContext>): Promise<{ reverted: boolean; txId?: string; count?: number }> {
    const last = this.committedHistory.pop();
    if (!last) return { reverted: false };

    await this.revertRecords(last.records, ctx);
    logger.info({ txId: last.id, reverted: last.records.length }, 'Last committed transaction reverted');
    return { reverted: true, txId: last.id, count: last.records.length };
  }

  private async revertRecords(records: MutatingRecord[], ctx: Partial<InvokeContext>): Promise<void> {
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (record.beforeState === undefined) continue;

      try {
        if (record.capabilityName === 'write_file' && record.beforeState !== null) {
          await this.bus.invoke('write_file', record.beforeState, {
            callChain: ['transaction:revert'],
            sessionId: ctx.sessionId ?? 'tx-revert',
            correlationId: genId('rv'),
            callerAgent: 'transaction-manager',
          } as InvokeContext);
        }
      } catch (err) {
        logger.error({ err, capability: record.capabilityName }, 'Failed to revert mutating operation');
      }
    }
  }

  private async captureBeforeState(name: string, input: unknown, ctx: Partial<InvokeContext>): Promise<unknown> {
    if (name === 'write_file') {
      const filePath = extractToolPath(input);
      if (!filePath) return null;
      try {
        const result = await this.bus.invoke('read_file', { path: filePath }, {
          callChain: ['transaction:snapshot'],
          sessionId: ctx.sessionId ?? 'tx-snapshot',
          correlationId: genId('snap'),
          callerAgent: 'transaction-manager',
        } as InvokeContext);
        return result.ok ? { path: filePath, content: result.data } : null;
      } catch {
        return null;
      }
    }
    return undefined;
  }
}

function isMutating(capabilityName: string): boolean {
  return MUTATING_CAPABILITIES.has(capabilityName);
}

interface TransactionContext {
  id: string;
  records: MutatingRecord[];
  baseCtx: Partial<InvokeContext>;
  committed: boolean;
  aborted: boolean;
}
