import { createHash } from 'node:crypto';

const TOOL_RESULT_TRIM_THRESHOLD = 40_000;
const RECENT_TURNS_PROTECTED = 2;

interface Message {
  role: string;
  content: string;
}

export function compressToolOutputs(messages: Message[]): Message[] {
  if (messages.length <= RECENT_TURNS_PROTECTED * 2) return messages;

  const protectedStart = messages.length - RECENT_TURNS_PROTECTED * 2;
  const seenHashes = new Set<string>();
  const compressed: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (i >= protectedStart) {
      compressed.push(msg);
      continue;
    }

    if (msg.role === 'user' && looksLikeToolResult(msg.content)) {
      const hash = md5(msg.content);

      if (seenHashes.has(hash)) {
        compressed.push({ role: msg.role, content: '[duplicate tool output removed]' });
        continue;
      }
      seenHashes.add(hash);

      if (msg.content.length > TOOL_RESULT_TRIM_THRESHOLD) {
        compressed.push({ role: msg.role, content: summarizeToolResult(msg.content) });
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
