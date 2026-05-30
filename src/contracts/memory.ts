import { z } from 'zod';

export const KNOWLEDGE_TYPES = [
  'identity',
  'preference',
  'goal',
  'project',
  'habit',
  'decision',
  'constraint',
  'relationship',
  'fact',
  'reflection',
] as const;

export const EVIDENCE_KINDS = ['direct', 'inferred', 'manual', 'system'] as const;
export const USER_WRITABLE_EVIDENCE_KINDS = ['direct', 'inferred', 'manual'] as const;
export const KNOWLEDGE_SCOPES = ['active', 'durable'] as const;
export const KNOWLEDGE_SOURCES = ['conversation', 'manual', 'import', 'system', 'tool', 'plugin'] as const;
export const RECALL_SOURCES = ['auto_recall', 'tool_query', 'brain_requested'] as const;

export type KnowledgeType = typeof KNOWLEDGE_TYPES[number];
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
export type UserWritableEvidenceKind = typeof USER_WRITABLE_EVIDENCE_KINDS[number];
export type KnowledgeScope = typeof KNOWLEDGE_SCOPES[number];
export type KnowledgeSource = typeof KNOWLEDGE_SOURCES[number];
export type RecallSource = typeof RECALL_SOURCES[number];

export const KnowledgeTypeSchema = z.enum(KNOWLEDGE_TYPES);
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export const UserWritableEvidenceKindSchema = z.enum(USER_WRITABLE_EVIDENCE_KINDS);
export const KnowledgeScopeSchema = z.enum(KNOWLEDGE_SCOPES);
export const KnowledgeSourceSchema = z.enum(KNOWLEDGE_SOURCES);
export const RecallSourceSchema = z.enum(RECALL_SOURCES);

export interface KnowledgeEntry {
  id: string;
  ownerKey: string;
  type: KnowledgeType;
  summary: string;
  detail: string | null;
  scope: KnowledgeScope;
  evidenceKind: EvidenceKind;
  source: KnowledgeSource;
  confidence: number;
  importance: number;
  durability: number;
  evidenceCount: number;
  provenance: string | null;
  dismissed: boolean;
  supersededBy: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  lastUsedAt: number | null;
  lastUsedQuery: string | null;
}

export interface AddKnowledgeInput {
  ownerKey?: string;
  type: KnowledgeType;
  summary: string;
  detail?: string;
  evidenceKind?: EvidenceKind;
  source?: KnowledgeSource;
  confidence?: number;
  importance?: number;
  durability?: number;
  provenance?: string;
}

export interface MemoryQueryPayload {
  query: string;
  type?: KnowledgeType;
  limit?: number;
}

export interface MemoryAddPayload {
  type: KnowledgeType;
  summary: string;
  detail?: string;
  evidence_kind?: UserWritableEvidenceKind;
  confidence?: number;
  importance?: number;
}

export interface MemoryDeletePayload {
  id: string;
}

export interface MemoryContextFrame {
  id: string;
  sessionId: string;
  runId?: string;
  query: string;
  recallSource: RecallSource;
  contextText: string;
  records: Array<{
    id: string;
    type: KnowledgeType;
    summary: string;
    score: number;
    confidence: number;
    importance: number;
    updatedAt: number;
  }>;
  budget: {
    maxRecords: number;
    maxChars: number;
    usedChars: number;
    truncated: boolean;
  };
}

export const MemoryQuerySchema = z.object({
  query: z.string().describe('搜索关键词'),
  type: KnowledgeTypeSchema.optional().describe('知识类型过滤'),
  limit: z.number().int().positive().optional().describe('返回数量上限，默认 5'),
});

export const MemoryAddSchema = z.object({
  type: KnowledgeTypeSchema.describe('知识类型'),
  summary: z.string().min(1).describe('简短摘要，一句话概括'),
  detail: z.string().optional().describe('详细描述'),
  evidence_kind: UserWritableEvidenceKindSchema.optional().describe('证据类型: direct=用户明说, inferred=推断, manual=手动'),
  confidence: z.number().min(0).max(1).optional().describe('置信度 0-1'),
  importance: z.number().min(0).max(1).optional().describe('重要性 0-1'),
});

export const MemoryDeleteSchema = z.object({
  id: z.string().min(1).describe('要删除的记忆 ID'),
});
