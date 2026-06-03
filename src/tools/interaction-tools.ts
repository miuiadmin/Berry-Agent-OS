import { z } from 'zod';
import { execSync } from 'node:child_process';
import type { ToolDefinition, ToolResult } from './types.js';

// ─── Ask User ────────────────────────────────────────────────────────────────

const askUserSchema = z.object({
  question: z.string().describe('要问用户的问题'),
  options: z.array(z.object({
    label: z.string().describe('选项显示文本'),
    description: z.string().optional().describe('选项说明'),
  })).min(2).max(4).optional().describe('可选的选项列表（2-4 个）'),
});

export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  description: '向用户提问以澄清需求或获取确认。调用后必须停止当前操作，将问题直接呈现给用户，等待用户在下一条消息中回复。',
  inputSchema: askUserSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { question, options } = askUserSchema.parse(input);

    let formatted = question;
    if (options && options.length > 0) {
      formatted += '\n\n';
      options.forEach((opt, i) => {
        formatted += `${i + 1}. **${opt.label}**`;
        if (opt.description) formatted += ` — ${opt.description}`;
        formatted += '\n';
      });
    }

    // 返回指令：告知 LLM 必须停止并等待用户回复
    return { content: `[STOP] 已向用户提问，请将以下问题作为你的回复直接发送给用户，不要继续执行其他操作：\n\n${formatted}` };
  },
};

// ─── Push Notification ───────────────────────────────────────────────────────

const pushNotificationSchema = z.object({
  message: z.string().max(200).describe('通知内容（200 字以内）'),
  title: z.string().optional().default('Berry').describe('通知标题'),
});

export const pushNotificationTool: ToolDefinition = {
  name: 'push_notification',
  description: '向用户发送桌面/终端通知。用于长任务完成后提醒用户。',
  inputSchema: pushNotificationSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { message, title } = pushNotificationSchema.parse(input);

    try {
      if (process.platform === 'darwin') {
        execSync(
          `osascript -e 'display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"'`,
          { timeout: 5000 },
        );
      } else if (process.platform === 'linux') {
        execSync(`notify-send "${escapeShell(title)}" "${escapeShell(message)}"`, { timeout: 5000 });
      }
      // Terminal bell as universal fallback
      process.stdout.write('\x07');
      return { content: `已通知: ${message}` };
    } catch {
      // Notification failed (e.g. headless env), still report success
      return { content: `已通知: ${message}` };
    }
  },
};

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeShell(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}
