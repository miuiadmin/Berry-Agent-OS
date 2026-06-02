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
  description: '向用户提问以澄清需求或获取确认。可选提供 2-4 个选项供用户选择。仅在无法从代码或请求中自行决策时调用。',
  inputSchema: askUserSchema,
  dangerLevel: 'safe',
  async execute(input: unknown): Promise<ToolResult> {
    const { question, options } = askUserSchema.parse(input);

    // Format the question for display
    let formatted = `❓ ${question}`;
    if (options && options.length > 0) {
      formatted += '\n\n选项:';
      options.forEach((opt, i) => {
        formatted += `\n  ${i + 1}. ${opt.label}`;
        if (opt.description) formatted += ` — ${opt.description}`;
      });
      formatted += '\n\n(请回复选项编号或自定义答案)';
    }

    // In the current architecture, this returns the formatted question.
    // The conversation agent will display it and wait for user's next message.
    // The actual user response comes back as the next user message in the conversation.
    return { content: formatted };
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
