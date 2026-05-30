export type InjectionCategory =
  | 'hidden_instruction'
  | 'role_override'
  | 'system_prompt_leak'
  | 'tool_abuse'
  | 'encoding_bypass'
  | 'delimiter_injection';

export interface InjectionFinding {
  category: InjectionCategory;
  severity: 'low' | 'medium' | 'high';
  pattern: string;
  location: string;
  snippet: string;
  explanation: string;
}

export interface ScanResult {
  safe: boolean;
  findings: InjectionFinding[];
  scannedChars: number;
}

export interface ScanOptions {
  maxContentLength?: number;
  strictMode?: boolean;
}

interface PatternDef {
  category: InjectionCategory;
  severity: 'low' | 'medium' | 'high';
  pattern: RegExp;
  name: string;
  explanation: string;
}

// Zero-width characters: U+200B, U+200C, U+200D, U+FEFF, U+2060-U+2064
const ZERO_WIDTH_RE = /[​‌‍﻿⁠⁡⁢⁣⁤]/;

// Bidi override: U+202A-U+202E, U+2066-U+2069
const BIDI_RE = /[‪-‮⁦-⁩]/;

// Unicode Tag characters: U+E0000-U+E007F
const TAG_CHARS_RE = /[\u{E0000}-\u{E007F}]/u;

const HIDDEN_INSTRUCTION_PATTERNS: PatternDef[] = [
  {
    category: 'hidden_instruction',
    severity: 'high',
    pattern: ZERO_WIDTH_RE,
    name: 'zero-width-chars',
    explanation: '检测到零宽字符，可能隐藏不可见指令',
  },
  {
    category: 'hidden_instruction',
    severity: 'high',
    pattern: BIDI_RE,
    name: 'bidi-override',
    explanation: '检测到双向文本控制字符，可能用于隐藏文本方向',
  },
  {
    category: 'hidden_instruction',
    severity: 'high',
    pattern: TAG_CHARS_RE,
    name: 'tag-characters',
    explanation: '检测到 Unicode Tag 字符（U+E0000–E007F），可能隐藏指令',
  },
  {
    category: 'hidden_instruction',
    severity: 'medium',
    pattern: /<!--[\s\S]*?-->/,
    name: 'html-comment',
    explanation: '检测到 HTML 注释，可能包含隐藏指令',
  },
];

const ROLE_OVERRIDE_PATTERNS: PatternDef[] = [
  {
    category: 'role_override',
    severity: 'high',
    pattern: /\[system\]|\[SYSTEM\]|<\|system\|>|<\|im_start\|>system/i,
    name: 'system-tag',
    explanation: '检测到系统角色标记注入，试图冒充系统消息',
  },
  {
    category: 'role_override',
    severity: 'high',
    pattern: /^(Human|User|Assistant|System)\s*:/m,
    name: 'role-prefix',
    explanation: '检测到对话角色前缀，试图注入虚假对话轮次',
  },
  {
    category: 'role_override',
    severity: 'medium',
    pattern: /<system>|<\/system>|<\|endoftext\|>/i,
    name: 'system-xml-tag',
    explanation: '检测到系统 XML 标记，可能试图突破角色边界',
  },
];

const SYSTEM_PROMPT_LEAK_PATTERNS: PatternDef[] = [
  {
    category: 'system_prompt_leak',
    severity: 'high',
    pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts|rules)/i,
    name: 'ignore-previous',
    explanation: '检测到"忽略之前指令"模式，典型提示词注入',
  },
  {
    category: 'system_prompt_leak',
    severity: 'high',
    pattern: /disregard\s+(all\s+)?(above|previous|prior|earlier)/i,
    name: 'disregard-above',
    explanation: '检测到"无视之前内容"模式，典型提示词注入',
  },
  {
    category: 'system_prompt_leak',
    severity: 'medium',
    pattern: /repeat\s+(your|the)\s+(system\s+prompt|instructions|rules)/i,
    name: 'repeat-prompt',
    explanation: '检测到要求重复系统提示词的模式',
  },
  {
    category: 'system_prompt_leak',
    severity: 'medium',
    pattern: /output\s+(your|the)\s+(system|initial)\s+(prompt|message|instructions)/i,
    name: 'output-system',
    explanation: '检测到要求输出系统提示词的模式',
  },
  {
    category: 'system_prompt_leak',
    severity: 'medium',
    pattern: /你的(系统|初始)(提示|指令|规则)|忽略(上面|之前|以上)(的)?(指令|规则|提示)/,
    name: 'chinese-leak',
    explanation: '检测到中文提示词泄露/覆盖模式',
  },
];

const TOOL_ABUSE_PATTERNS: PatternDef[] = [
  {
    category: 'tool_abuse',
    severity: 'high',
    pattern: /"type"\s*:\s*"tool_use"|<tool_use>|<function_call>/,
    name: 'fake-tool-call',
    explanation: '检测到伪造的工具调用结构，试图注入工具执行',
  },
  {
    category: 'tool_abuse',
    severity: 'high',
    pattern: /permission[_\s]?token|approval[_\s]?request/i,
    name: 'permission-forge',
    explanation: '检测到伪造权限 token 或审批请求的内容',
  },
  {
    category: 'tool_abuse',
    severity: 'medium',
    pattern: /"name"\s*:\s*"(shell|bash|exec|run_command|execute)"/i,
    name: 'shell-inject',
    explanation: '检测到试图注入 shell 命令执行工具调用',
  },
];

const ENCODING_BYPASS_PATTERNS: PatternDef[] = [
  {
    category: 'encoding_bypass',
    severity: 'medium',
    pattern: /(?:[A-Za-z0-9+/]{4}){16,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)/,
    name: 'base64-block',
    explanation: '检测到较长 Base64 编码块（64+ 字符），可能隐藏恶意指令',
  },
];

const STRICT_PATTERNS: PatternDef[] = [
  {
    category: 'role_override',
    severity: 'low',
    pattern: /\bact\s+as\b|\bpretend\s+(you\s+are|to\s+be)\b/i,
    name: 'persona-switch',
    explanation: '检测到角色切换指令（严格模式）',
  },
  {
    category: 'system_prompt_leak',
    severity: 'low',
    pattern: /what\s+(are|were)\s+your\s+(instructions|rules|system\s+prompt)/i,
    name: 'probe-instructions',
    explanation: '检测到探测系统指令的问题（严格模式）',
  },
];

const ALL_PATTERNS: PatternDef[] = [
  ...HIDDEN_INSTRUCTION_PATTERNS,
  ...ROLE_OVERRIDE_PATTERNS,
  ...SYSTEM_PROMPT_LEAK_PATTERNS,
  ...TOOL_ABUSE_PATTERNS,
  ...ENCODING_BYPASS_PATTERNS,
];

function findLocation(content: string, match: RegExpExecArray): string {
  const before = content.slice(0, match.index);
  const line = before.split('\n').length;
  return `第 ${line} 行`;
}

function extractSnippet(content: string, match: RegExpExecArray): string {
  const start = Math.max(0, match.index - 20);
  const end = Math.min(content.length, match.index + match[0].length + 20);
  let snippet = content.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';
  return snippet.replace(/\n/g, '\\n');
}

function runPatterns(content: string, patterns: PatternDef[]): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const def of patterns) {
    const flags = def.pattern.flags.includes('g') ? def.pattern.flags : def.pattern.flags + 'g';
    const regex = new RegExp(def.pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      findings.push({
        category: def.category,
        severity: def.severity,
        pattern: def.name,
        location: findLocation(content, match),
        snippet: extractSnippet(content, match),
        explanation: def.explanation,
      });
      break;
    }
  }
  return findings;
}

export function scanForInjection(content: string, options?: ScanOptions): ScanResult {
  const maxLen = options?.maxContentLength ?? 50000;
  const text = content.slice(0, maxLen);
  const patterns = options?.strictMode ? [...ALL_PATTERNS, ...STRICT_PATTERNS] : ALL_PATTERNS;
  const findings = runPatterns(text, patterns);

  return {
    safe: findings.length === 0,
    findings,
    scannedChars: text.length,
  };
}

export function scanManifest(manifest: Record<string, unknown>, options?: ScanOptions): ScanResult {
  const fieldsToScan = ['description', 'ai_description', 'useWhen', 'avoidWhen'];
  const parts: string[] = [];

  for (const key of fieldsToScan) {
    const val = manifest[key];
    if (typeof val === 'string') parts.push(val);
  }

  const tools = manifest.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (typeof tool === 'object' && tool !== null) {
        const t = tool as Record<string, unknown>;
        if (typeof t.description === 'string') parts.push(t.description);
      }
    }
  }

  const combined = parts.join('\n');
  return scanForInjection(combined, options);
}
