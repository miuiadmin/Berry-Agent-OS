import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TemplateContext {
  skillDir: string;
  sessionId?: string;
  arguments?: string;
  positional?: string[];
  named?: Record<string, string>;
  cwd?: string;
}

const BLOCKED_ENV_PATTERNS = /key|secret|token|password|credential|auth/i;

export function processTemplateVars(content: string, ctx: TemplateContext): string {
  let result = content;

  result = result.replace(/\$\{BERRY_SKILL_DIR\}/g, ctx.skillDir);
  result = result.replace(/\$\{BERRY_SESSION_ID\}/g, ctx.sessionId ?? '');
  result = result.replace(/\$\{cwd\}/g, ctx.cwd ?? process.cwd());

  result = result.replace(/\$\{env\.([^}]+)\}/g, (_, key: string) => {
    if (BLOCKED_ENV_PATTERNS.test(key)) return '';
    return process.env[key] ?? '';
  });

  if (ctx.arguments !== undefined) {
    result = result.replace(/\$ARGUMENTS/g, ctx.arguments);
  }
  if (ctx.positional) {
    for (let i = 0; i < ctx.positional.length; i++) {
      result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), ctx.positional[i]);
    }
  }
  if (ctx.named) {
    for (const [key, val] of Object.entries(ctx.named)) {
      result = result.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), val);
      result = result.replace(new RegExp(`\\$${key}\\b`, 'g'), val);
    }
  }

  return result;
}

export async function processShellInjections(content: string, skillDir: string): Promise<string> {
  const blockPattern = /```!\n([\s\S]*?)```/g;
  const inlinePattern = /!`([^`]+)`/g;

  let result = content;

  for (const match of [...content.matchAll(blockPattern)]) {
    const output = await execShellSafe(match[1].trim(), skillDir);
    result = result.replace(match[0], output);
  }

  for (const match of [...result.matchAll(inlinePattern)]) {
    const output = await execShellSafe(match[1], skillDir);
    result = result.replace(match[0], output);
  }

  return result;
}

async function execShellSafe(cmd: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd], {
      cwd,
      timeout: 5000,
      maxBuffer: 32 * 1024,
    });
    return stdout.trim();
  } catch {
    return `[shell error: ${cmd}]`;
  }
}
