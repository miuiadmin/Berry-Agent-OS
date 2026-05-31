import { createHash } from 'node:crypto';

const TOOL_RESULT_TRIM_THRESHOLD = 40_000;
const RECENT_TURNS_PROTECTED = 2;

interface Message {
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
}

export function compressToolOutputs<T extends Message>(messages: T[]): T[] {
  if (messages.length <= RECENT_TURNS_PROTECTED * 2) return messages;

  const protectedStart = messages.length - RECENT_TURNS_PROTECTED * 2;
  const seenHashes = new Set<string>();
  const compressed: T[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (i >= protectedStart) {
      compressed.push(msg);
      continue;
    }

    if (msg.role === 'user' && looksLikeToolResult(msg.content)) {
      const hash = md5(msg.content);

      if (seenHashes.has(hash)) {
        compressed.push({ ...msg, content: '[duplicate tool output removed]' });
        continue;
      }
      seenHashes.add(hash);

      if (msg.content.length > TOOL_RESULT_TRIM_THRESHOLD) {
        compressed.push({ ...msg, content: summarizeToolResult(msg.content) });
        continue;
      }
    }

    compressed.push(msg);
  }

  return compressed;
}

function looksLikeToolResult(content: string): boolean {
  return content.startsWith('[') && (content.includes('] ') || content.includes('] ERROR:'));
}

function summarizeToolResult(content: string): string {
  const lines = content.split('\n');
  const summaries: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\]\s*(ERROR:\s*)?(.*)/);
    if (match) {
      const toolId = match[1];
      const isError = !!match[2];
      const resultPreview = match[3].slice(0, 80);
      summaries.push(`[${toolId}] ${isError ? 'ERROR: ' : ''}${resultPreview}... (${match[3].length} chars trimmed)`);
    }
  }

  if (summaries.length === 0) {
    return `[tool output trimmed: ${content.length} chars, ${lines.length} lines]`;
  }

  return summaries.join('\n');
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, 16);
}

// === Phase 2: Iterative LLM Summary ===

const DEFAULT_CONTEXT_WINDOW = 200_000;
const CAPACITY_THRESHOLD = 0.8;
const SUMMARY_BUDGET_RATIO = 0.05;
const MAX_SUMMARY_TOKENS = 12_000;

export interface CompressionConfig {
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface CompressionState {
  previousSummary: string | null;
  consecutiveLowSavings: number;
}

export function needsPhase2(messages: Message[], maxContextChars: number): boolean {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return totalChars > maxContextChars * CAPACITY_THRESHOLD;
}

export function buildSummaryPrompt(previousSummary: string | null, newMessages: Message[]): string {
  const newContent = newMessages.map(m => `[${m.role}]: ${m.content.slice(0, 500)}`).join('\n');

  if (previousSummary) {
    return `Update this running summary with new information. Keep the structured format.

Previous summary:
${previousSummary}

New messages since last summary:
${newContent}

Output updated summary in this format:
- Active tasks: (what's currently being worked on)
- Completed: (what was finished)
- Decisions: (choices made)
- Key context: (file paths, variables, constraints)
- Blockers: (what's unresolved)`;
  }

  return `Summarize these messages into a structured running summary.

Messages:
${newContent}

Output summary in this format:
- Active tasks: (what's currently being worked on)
- Completed: (what was finished)
- Decisions: (choices made)
- Key context: (file paths, variables, constraints)
- Blockers: (what's unresolved)`;
}

export function applyPhase2(
  messages: Message[],
  summary: string,
  protectedHeadCount: number,
  protectedTailCount: number,
): Message[] {
  const head = messages.slice(0, protectedHeadCount);
  const tail = messages.slice(-protectedTailCount);

  return [
    ...head,
    { role: 'user', content: `[context compacted]\n\nRunning summary:\n${summary}` },
    { role: 'assistant', content: '[context compacted, continue task]' },
    ...tail,
  ];
}

export function shouldSkipCompression(state: CompressionState, savedPercent: number): boolean {
  if (savedPercent < 0.1) {
    state.consecutiveLowSavings++;
  } else {
    state.consecutiveLowSavings = 0;
  }
  return state.consecutiveLowSavings >= 2;
}

export function getSummaryBudget(contextChars: number): number {
  return Math.min(Math.floor(contextChars * SUMMARY_BUDGET_RATIO), MAX_SUMMARY_TOKENS * 4);
}
