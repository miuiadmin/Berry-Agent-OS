import { createHash } from 'node:crypto';

let TOOL_RESULT_TRIM_THRESHOLD = 40_000;
const RECENT_TURNS_PROTECTED = 2;

export function setToolOutputMaxBytes(maxBytes: number): void {
  TOOL_RESULT_TRIM_THRESHOLD = maxBytes;
}

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

  const template = `## 目标
（用户本次会话要达成什么）

## 已完成
（已经做完的步骤，含关键文件路径/命令）

## 决策记录
（做出的选择及原因）

## 关键上下文
（文件路径、变量名、配置值、错误信息等硬事实）

## 待处理
（尚未完成的任务/阻塞项）

如果某类别为空，写"无"。`;

  if (previousSummary) {
    return `将以下对话压缩为结构化摘要。基于已有摘要更新，严格按模板输出。

已有摘要:
${previousSummary}

新增对话:
${newContent}

输出模板:
${template}`;
  }

  return `将以下对话压缩为结构化摘要。严格按模板输出，不遗漏任何类别。

对话内容:
${newContent}

输出模板:
${template}`;
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
