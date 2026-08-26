/**
 * L4 channels — 内置渲染测试（headless 纯函数）。
 *
 * 自定义角色的 render intent 依赖 agent 模块的全局角色注册表——用例间用
 * 唯一角色名 + 注销器清理，避免污染共享注册表。
 */

import { describe, expect, it } from 'vitest';
import { registerHostMessageRole } from '../contracts/messages.js';
import type { AgentMessage, CustomMessage } from '../contracts/messages.js';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '../contracts/llm.js';
import {
  assistantText,
  assistantToolLines,
  formatToolEnd,
  formatToolStart,
  joinTextContent,
  renderAgentMessage,
  truncate,
} from './render.js';
import type { RendererDefinition } from './types.js';

/* ---------------- 测试消息工厂 ---------------- */

const now = 1_750_000_000_000;

const userMsg = (content: UserMessage['content']): UserMessage => ({
  role: 'user',
  content,
  timestamp: now,
});

const assistantMsg = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
  stopReason: 'stop',
  timestamp: now,
});

const toolResultMsg = (text: string, isError = false): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'fs.read',
  content: [{ type: 'text', text }],
  isError,
  timestamp: now,
});

const customMsg = (role: string, content: unknown): CustomMessage => ({ role, content, timestamp: now });

/* ---------------- 工具函数 ---------------- */

describe('truncate', () => {
  it('短文原样；超长截断加省略号且长度守恒', () => {
    expect(truncate('短文')).toBe('短文');
    const long = 'a'.repeat(300);
    expect(truncate(long)).toHaveLength(160);
    expect(truncate(long).endsWith('…')).toBe(true);
  });
});

describe('joinTextContent', () => {
  it('字符串直通；块数组拼 text、图片以占位符表示', () => {
    expect(joinTextContent('纯文本')).toBe('纯文本');
    const blocks = [
      { type: 'text', text: '第一段' },
      { type: 'image', data: '...', mimeType: 'image/png' },
      { type: 'text', text: '第二段' },
    ] as UserMessage['content'];
    expect(joinTextContent(blocks)).toBe('第一段\n[图片]\n第二段');
  });
});

/* ---------------- assistant 摘要 ---------------- */

describe('assistantText / assistantToolLines', () => {
  it('text 块拼接；thinking 不进正文', () => {
    const message = assistantMsg([
      { type: 'thinking', thinking: '推理过程不展示' },
      { type: 'text', text: '你好' },
      { type: 'text', text: '再见' },
    ]);
    expect(assistantText(message)).toBe('你好\n再见');
  });

  it('工具调用块渲染为 ⚙ 行（arguments 序列化）', () => {
    const message = assistantMsg([{ type: 'toolCall', id: 'c1', name: 'fs.read', arguments: { path: '/tmp/x' } }]);
    expect(assistantToolLines(message)).toEqual(['⚙ fs.read {"path":"/tmp/x"}']);
  });
});

describe('formatToolStart / formatToolEnd', () => {
  it('开始行 = ⚙ 名 + 参数摘要', () => {
    expect(formatToolStart('fs.read', { path: '/tmp/x' })).toBe('⚙ fs.read {"path":"/tmp/x"}');
  });

  it('结束行 = ↳/✖ + 首行文本摘要；空结果只有符号', () => {
    const result = { content: [{ type: 'text' as const, text: '第一行\n第二行' }] };
    expect(formatToolEnd(result, false)).toBe('↳ 第一行');
    expect(formatToolEnd(result, true)).toBe('✖ 第一行');
    expect(formatToolEnd({ content: [] }, false)).toBe('↳');
  });
});

/* ---------------- 总入口 ---------------- */

describe('renderAgentMessage 内置三角色', () => {
  it('user：❯ 前缀首行 + 缩进续行', () => {
    expect(renderAgentMessage(userMsg('第一行\n第二行'))).toEqual(['❯ 第一行', '  第二行']);
  });

  it('assistant：正文行 + 工具行拼合', () => {
    const message = assistantMsg([
      { type: 'text', text: '答案' },
      { type: 'toolCall', id: 'c1', name: 'fs.read', arguments: {} },
    ]);
    expect(renderAgentMessage(message)).toEqual(['答案', '⚙ fs.read {}']);
  });

  it('toolResult：↳/✖ 首行摘要（历史投影与活体事件同形）', () => {
    expect(renderAgentMessage(toolResultMsg('好的'))).toEqual(['↳ 好的']);
    expect(renderAgentMessage(toolResultMsg('坏了', true))).toEqual(['✖ 坏了']);
  });

  it('空 user 消息不产生展示行', () => {
    expect(renderAgentMessage(userMsg('  '))).toEqual([]);
  });
});

describe('renderAgentMessage 自定义渲染器优先', () => {
  it('按角色覆盖内置形态；返回空数组 = 不展示', () => {
    const renderers = new Map<string, RendererDefinition>([
      ['user', { role: 'user', render: () => ['[自定义] 用户'] }],
      ['assistant', { role: 'assistant', render: () => [] }],
    ]);
    const rendererFor = (role: string) => renderers.get(role);
    expect(renderAgentMessage(userMsg('hi'), rendererFor)).toEqual(['[自定义] 用户']);
    expect(renderAgentMessage(assistantMsg([{ type: 'text', text: '藏起来' }]), rendererFor)).toEqual([]);
  });
});

describe('renderAgentMessage 渲染器异常隔离（隔离案一第一刀 #1 回归锁）', () => {
  it('坏渲染器抛错 → 回落内置形态 + onRendererError 携错误与角色名上报', () => {
    const seen: { err: unknown; role: string }[] = [];
    const boom = new Error('渲染器坏了');
    const renderers = new Map<string, RendererDefinition>([
      [
        'user',
        {
          role: 'user',
          render: () => {
            throw boom;
          },
        },
      ],
    ]);
    const rendererFor = (role: string) => renderers.get(role);
    // 修复前：异常直接穿透 renderAgentMessage 抛出（P15/P16 进程退出级）
    const lines = renderAgentMessage(userMsg('回落正文'), rendererFor, (err, role) => {
      seen.push({ err, role });
    });
    expect(lines).toEqual(['❯ 回落正文']); // 内置形态兜底——消息不丢
    expect(seen).toEqual([{ err: boom, role: 'user' }]); // 诊断不静默
  });

  it('正常渲染器不受隔离壳影响；无回调时回落照常（缺省可省参）', () => {
    const renderers = new Map<string, RendererDefinition>([
      ['user', { role: 'user', render: () => ['[自定义] 正常'] }],
    ]);
    const rendererFor = (role: string) => renderers.get(role);
    expect(renderAgentMessage(userMsg('hi'), rendererFor)).toEqual(['[自定义] 正常']);
    // 无诊断回调 + 坏渲染器：回落照常、不炸（回调可选）
    const bad = new Map<string, RendererDefinition>([
      [
        'user',
        {
          role: 'user',
          render: () => {
            throw new Error('x');
          },
        },
      ],
    ]);
    expect(renderAgentMessage(userMsg('兜底'), (role) => bad.get(role))).toEqual(['❯ 兜底']);
  });
});

describe('renderAgentMessage 自定义角色（render intent）', () => {
  it('hidden → 空行；label 定制；未注册角色按角色名兜底', () => {
    const unregisterHidden = registerHostMessageRole('t-hidden-x', {
      render: { intent: 'hidden' },
    });
    const unregisterLabeled = registerHostMessageRole('t-labeled-x', {
      render: { intent: 'status', label: '提醒' },
    });
    try {
      expect(renderAgentMessage(customMsg('t-hidden-x', '不该看到'))).toEqual([]);
      expect(renderAgentMessage(customMsg('t-labeled-x', '喝水'))).toEqual(['[提醒] 喝水']);
      // 未注册角色：inline 兜底，label 缺省角色名
      expect(renderAgentMessage(customMsg('t-unknown-x', '随便'))).toEqual(['[t-unknown-x] 随便']);
    } finally {
      unregisterHidden();
      unregisterLabeled();
    }
  });

  it('非字符串载荷 JSON 序列化并截断（截断作用于载荷，前缀另计）', () => {
    const line = renderAgentMessage(customMsg('t-unknown-x', { big: 'x'.repeat(300) }))[0]!;
    expect(line.startsWith('[t-unknown-x] ')).toBe(true);
    expect(line).toHaveLength('[t-unknown-x] '.length + 160);
    expect(line.endsWith('…')).toBe(true);
  });
});

/* ---------------- 类型守卫冒烟（AgentMessage 联合可分派） ---------------- */

it('AgentMessage 联合分派无遗漏（编译期测试）', () => {
  const samples: AgentMessage[] = [userMsg('a'), assistantMsg([]), toolResultMsg('b'), customMsg('r', 1)];
  for (const message of samples) expect(renderAgentMessage(message)).toBeInstanceOf(Array);
});
