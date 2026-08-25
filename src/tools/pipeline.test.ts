/**
 * L2 tools 单元测试——三段管道全语义面：
 * 参数校验 / 守门（allow·mutate·block·fail-closed）/ 执行段（超时·接管）/ 后处理改写 /
 * 输出护栏（64KiB 保尾截断 + spill——契约篇 §3.1，随 mcp 第一刀兑现，全部工具受益）。
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import { AppError, TOOL_ARGUMENTS_INVALID, TOOL_BLOCKED, TOOL_GATE_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import type { AgentToolResult, GateDecisionPayload, TextContent, ToolDefinition } from '../contracts/tools.js';
import { createContext } from '../context/index.js';
import { createToolPipeline, OUTPUT_GUARD_BYTES } from './pipeline.js';

/** 标准测试工具：echo 回显 args（执行段真实跑到的证据） */
function echoTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'echo',
    description: '回显参数',
    parameters: Type.Object({ msg: Type.String(), n: Type.Optional(Type.Number()) }),
    execute: async (args) => ({
      content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }],
    }),
    ...overrides,
  };
}

/** 取 AppError 的 code（非 AppError 抛出时让用例失败并显示原值） */
function codeOf(error: unknown): string {
  if (error instanceof AppError) return error.code;
  throw error;
}

describe('createToolPipeline — 参数校验（前置步）', () => {
  it('不合法参数不进守门/执行段：TOOL_ARGUMENTS_INVALID 且 message 带字段路径', async () => {
    const ctx = createContext({ name: 'test' });
    let gated = false;
    ctx.on('tools_pre_execute', () => {
      gated = true;
    });
    const run = createToolPipeline(ctx);
    const err = await run(echoTool(), 'tc-1', { msg: 123 }).catch((e) => e);
    expect(codeOf(err)).toBe(TOOL_ARGUMENTS_INVALID);
    expect((err as Error).message).toContain('/msg');
    expect(gated).toBe(false); // 守门段未被触达
  });

  it('缺必填字段同样拒绝', async () => {
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx);
    const err = await run(echoTool(), 'tc-1', {}).catch((e) => e);
    expect(codeOf(err)).toBe(TOOL_ARGUMENTS_INVALID);
  });
});

describe('createToolPipeline — 守门段（tools_pre_execute）', () => {
  it('无守门监听器时直通执行', async () => {
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx);
    const result = await run(echoTool(), 'tc-1', { msg: 'hi' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'echo:{"msg":"hi"}' });
  });

  it('allow 决策放行（显式 return next()）', async () => {
    const ctx = createContext({ name: 'test' });
    ctx.on('tools_pre_execute', (input, next) => {
      expect(input.callId).toBe('tc-1');
      return next();
    });
    const run = createToolPipeline(ctx);
    const result = await run(echoTool(), 'tc-1', { msg: 'hi' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'echo:{"msg":"hi"}' });
  });

  it('allowReason 透传（免问放行可审计——第二十四批题1a接线批）：守门者标注进 gate/decision', async () => {
    const ctx = createContext({ name: 'test' });
    const decisions: GateDecisionPayload[] = [];
    ctx.on('tools_pre_execute', (input, next) => {
      input.allowReason = 'allowlist:0';
      return next();
    });
    const run = createToolPipeline(ctx, { onGateDecision: (d) => decisions.push(d) });
    const result = await run(echoTool(), 'tc-1', { msg: 'hi' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'echo:{"msg":"hi"}' });
    expect(decisions).toEqual([{ toolCallId: 'tc-1', decision: 'allow', reason: 'allowlist:0' }]);
  });

  it('mutate 决策就地改参：执行段看到改后参数', async () => {
    const ctx = createContext({ name: 'test' });
    const decisions: GateDecisionPayload[] = [];
    ctx.on('tools_pre_execute', (input, next) => {
      input.args.msg = '改写后';
      input.mutated = true;
      return next();
    });
    const run = createToolPipeline(ctx, { onGateDecision: (d) => decisions.push(d) });
    const result = await run(echoTool(), 'tc-1', { msg: '原始' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'echo:{"msg":"改写后"}' });
    expect(decisions).toEqual([{ toolCallId: 'tc-1', decision: 'mutate', reason: 'ok' }]);
  });

  it('block 决策短路：不进执行段、错误携带 reason', async () => {
    const ctx = createContext({ name: 'test' });
    const decisions: GateDecisionPayload[] = [];
    let executed = false;
    ctx.on('tools_pre_execute', () => ({ decision: 'block', reason: '危险操作' }));
    const run = createToolPipeline(ctx, { onGateDecision: (d) => decisions.push(d) });
    const err = await run(
      echoTool({
        execute: async () => {
          executed = true;
          return { content: [] };
        },
      }),
      'tc-1',
      { msg: 'hi' },
    ).catch((e) => e);
    expect(codeOf(err)).toBe(TOOL_BLOCKED);
    expect((err as Error).message).toContain('危险操作');
    expect(executed).toBe(false);
    expect(decisions).toEqual([{ toolCallId: 'tc-1', decision: 'block', reason: '危险操作' }]);
  });

  it('fail-closed：守门监听器抛错视为 block（TOOL_GATE_FAILED）', async () => {
    const ctx = createContext({ name: 'test' });
    const decisions: GateDecisionPayload[] = [];
    ctx.on('tools_pre_execute', () => {
      throw new Error('审批服务不可用');
    });
    const run = createToolPipeline(ctx, { onGateDecision: (d) => decisions.push(d) });
    const err = await run(echoTool(), 'tc-1', { msg: 'hi' }).catch((e) => e);
    expect(codeOf(err)).toBe(TOOL_GATE_FAILED);
    expect((err as Error).message).toContain('审批服务不可用');
    expect(decisions[0]).toMatchObject({ decision: 'block' });
  });

  it('多守门者按注册序，prepend 插队首位（安全栈占位形态）', async () => {
    const ctx = createContext({ name: 'test' });
    const order: string[] = [];
    ctx.on('tools_pre_execute', (_input, next) => {
      order.push('normal');
      return next();
    });
    ctx.on(
      'tools_pre_execute',
      (_input, next) => {
        order.push('prepend');
        return next();
      },
      { prepend: true },
    );
    const run = createToolPipeline(ctx);
    await run(echoTool(), 'tc-1', { msg: 'hi' });
    expect(order).toEqual(['prepend', 'normal']);
  });

  it('链上第二个守门者 block：第一个守门者透传短路结果', async () => {
    const ctx = createContext({ name: 'test' });
    ctx.on('tools_pre_execute', (_input, next) => next());
    ctx.on('tools_pre_execute', () => ({ decision: 'block', reason: '后位拒绝' }));
    const run = createToolPipeline(ctx);
    const err = await run(echoTool(), 'tc-1', { msg: 'hi' }).catch((e) => e);
    expect(codeOf(err)).toBe(TOOL_BLOCKED);
    expect((err as Error).message).toContain('后位拒绝');
  });
});

describe('createToolPipeline — 执行段（tools_execute）', () => {
  it('超时预算触发：TOOL_TIMEOUT 替换结果', async () => {
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx, { defaultTimeoutMs: 20 });
    const slow = echoTool({
      execute: () =>
        new Promise<AgentToolResult>(() => {
          /* 永不结算 */
        }),
    });
    const err = await run(slow, 'tc-1', { msg: 'hi' }).catch((e) => e);
    expect(codeOf(err)).toBe(TOOL_TIMEOUT);
  });

  it('def.timeoutMs 覆盖默认预算', async () => {
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx, { defaultTimeoutMs: 5 });
    // 工具级预算放宽到 500ms——能跑完即证明覆盖生效
    const tool = echoTool({
      timeoutMs: 500,
      execute: () =>
        new Promise<AgentToolResult>((resolve) =>
          setTimeout(() => resolve({ content: [{ type: 'text', text: '慢但成功' }] }), 40),
        ),
    });
    const result = await run(tool, 'tc-1', { msg: 'hi' });
    expect(result.content[0]).toMatchObject({ text: '慢但成功' });
  });

  it('timeoutMs=0 显式不设预算', async () => {
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx, { defaultTimeoutMs: 5 });
    const tool = echoTool({
      timeoutMs: 0,
      execute: () =>
        new Promise<AgentToolResult>((resolve) =>
          setTimeout(() => resolve({ content: [{ type: 'text', text: '长任务完成' }] }), 30),
        ),
    });
    const result = await run(tool, 'tc-1', { msg: 'hi' });
    expect(result.content[0]).toMatchObject({ text: '长任务完成' });
  });

  it('执行段接管：监听者不调 next 即替换执行（mock/录制挂点）', async () => {
    const ctx = createContext({ name: 'test' });
    let realExecute = false;
    ctx.on('tools_execute', (input) => ({
      content: [{ type: 'text', text: `接管执行：${input.tool.name}` }],
    }));
    const run = createToolPipeline(ctx);
    const result = await run(
      echoTool({
        execute: async () => {
          realExecute = true;
          return { content: [] };
        },
      }),
      'tc-1',
      { msg: 'hi' },
    );
    expect(result.content[0]).toMatchObject({ text: '接管执行：echo' });
    expect(realExecute).toBe(false);
  });

  it('执行段拦截者调 next：包裹原执行（指标/重试挂点形态）', async () => {
    const ctx = createContext({ name: 'test' });
    ctx.on('tools_execute', async (input, next) => {
      const inner = await next();
      inner.content = [{ type: 'text', text: `包裹[${inner.content[0]!.type}]` }];
      return inner;
    });
    const run = createToolPipeline(ctx);
    const result = await run(echoTool(), 'tc-1', { msg: 'hi' });
    expect(result.content[0]).toMatchObject({ text: '包裹[text]' });
  });

  it('工具 execute 抛错原样上抛（loop 侧编码 isError——错误是数据）', async () => {
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx);
    const err = await run(
      echoTool({
        execute: async () => {
          throw new AppError(TOOL_TIMEOUT, '[X] 业务失败');
        },
      }),
      'tc-1',
      { msg: 'hi' },
    ).catch((e) => e);
    expect((err as Error).message).toContain('业务失败');
  });

  it('ToolCtx 透传 toolCallId 与 onUpdate', async () => {
    const ctx = createContext({ name: 'test' });
    const seen: unknown[] = [];
    const updates: AgentToolResult[] = [];
    const tool = echoTool({
      execute: async (_args, tctx) => {
        seen.push(tctx.toolCallId);
        tctx.onUpdate?.({ content: [{ type: 'text', text: '进度 50%' }] });
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    const run = createToolPipeline(ctx);
    const result = await run(tool, 'tc-42', { msg: 'hi' }, undefined, (partial) => updates.push(partial));
    expect(seen).toEqual(['tc-42']);
    expect(result.content[0]).toMatchObject({ text: 'done' });
    expect(updates[0]?.content[0]).toMatchObject({ text: '进度 50%' });
  });
});

describe('createToolPipeline — 后处理段（tools_post_execute）', () => {
  it('post 监听者可就地改写结果（裁剪/spill 挂点形态）', async () => {
    const ctx = createContext({ name: 'test' });
    ctx.on('tools_post_execute', (input) => {
      input.result.content = [{ type: 'text', text: `已裁剪（原 ${input.result.content.length} 块）` }];
    });
    const run = createToolPipeline(ctx);
    const result = await run(echoTool(), 'tc-1', { msg: 'hi' });
    expect(result.content[0]).toMatchObject({ text: '已裁剪（原 1 块）' });
  });

  it('gate/decision 在 allow 时也记录（守门不可绕不变式的 durable 载体）', async () => {
    const ctx = createContext({ name: 'test' });
    const decisions: GateDecisionPayload[] = [];
    const run = createToolPipeline(ctx, { onGateDecision: (d) => decisions.push(d) });
    await run(echoTool(), 'tc-7', { msg: 'hi' });
    expect(decisions).toEqual([{ toolCallId: 'tc-7', decision: 'allow', reason: 'ok' }]);
  });
});

describe('createToolPipeline — 输出护栏（缺省链尾 64KiB，契约篇 §3.1/§6.6）', () => {
  /** 产出指定全文文本的工具（execute 直返——护栏在链尾，对执行段产物执法） */
  function bigOutputTool(text: string): ToolDefinition {
    return {
      name: 'flood',
      description: '产出大文本',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text }] }),
    };
  }

  /** 清理本组用例落下的 spill 文件（callId 受控 → 文件名前缀可预测） */
  function sweepSpills(callId: string): void {
    const prefix = `spill-${callId.replace(/[^A-Za-z0-9_-]/g, '_')}-`;
    for (const f of readdirSync(tmpdir())) {
      if (f.startsWith(prefix)) rmSync(`${tmpdir()}/${f}`);
    }
  }

  /** 取结果首块文本（护栏用例的断言面——经守卫收窄避开 ImageContent 分支） */
  function firstText(result: AgentToolResult): string {
    const part = result.content.find((p): p is TextContent => p.type === 'text');
    return part?.text ?? '';
  }

  it('超预算：保尾截断 + spill 全文外溢 + 注记含总字节数与路径', async () => {
    // 头部界标（前 12 字节）注定被截；尾部界标必须在保尾段里幸存
    const full = `头部界标${'x'.repeat(66_560)}尾部界标`;
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx);
    const result = await run(bigOutputTool(full), 'tc-guard-a', {});
    const text = firstText(result);
    // 头部被截（保尾方向——丢头留尾，错误信息通常在尾部）
    expect(text).not.toContain('头部界标');
    // 尾部幸存 + 截断注记（总字节数 + 外溢路径）
    expect(text).toContain('尾部界标');
    expect(text).toMatch(/超 64KiB 上限，已保尾截断；全文外溢至 .+spill-tc-guard-a-\d+\.txt/);
    expect(text).toContain(`${Buffer.byteLength(full, 'utf8')} 字节`);
    // spill 文件 = 原始全文（两头界标都在——截断只影响工具结果不影响外溢）
    const spillName = readdirSync(tmpdir()).find((f) => f.startsWith('spill-tc-guard-a-'));
    expect(spillName).toBeTruthy();
    expect(readFileSync(`${tmpdir()}/${spillName}`, 'utf8')).toBe(full);
    sweepSpills('tc-guard-a');
  });

  it('UTF-8 安全：截断点落在多字节字符中间则跳过被切字符（不产替换符）', async () => {
    // 精确构造：totalBytes = 100 + 3 + 65534 = 65637，保尾起点 = 101——
    // 恰好落在「中」（E4 B8 AD）的第 2 字节 B8（续字节）上。
    // 纪律（与 exec 件 tailUtf8 同款）：起点跳过剩余续字节到下一字符边界——
    // 被切字符整个丢弃（至多 3 字节损耗），解码不产 U+FFFD 乱码。
    const full = `${'A'.repeat(100)}中${'B'.repeat(OUTPUT_GUARD_BYTES - 2)}`;
    expect(Buffer.byteLength(full, 'utf8')).toBe(65_637); // 构造自检（改动护栏常量时此处先红）
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx);
    const result = await run(bigOutputTool(full), 'tc-guard-b', {});
    const text = firstText(result);
    // 若不跳续字节：B8 AD 起头会解码成替换符——此断言即红
    expect(text.startsWith('B')).toBe(true);
    // 全文解码无替换符（护栏产出的必须是合法 UTF-8 文本）
    expect(text).not.toContain('�');
    sweepSpills('tc-guard-b');
  });

  it('预算内：原样返回（无注记、无 spill 文件）', async () => {
    const full = '可控输出'.repeat(100); // 1200 字节，远低于预算
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx);
    const result = await run(bigOutputTool(full), 'tc-guard-c', {});
    expect(result.content).toEqual([{ type: 'text', text: full }]);
    expect(readdirSync(tmpdir()).some((f) => f.startsWith('spill-tc-guard-c-'))).toBe(false);
  });

  it('远端形态 JSON Schema（MCP inputSchema 直传，非 typebox 构造）：前置步照拦照放', async () => {
    // MCP 工具的 parameters 来自外部服务器声明——纯 JSON 对象（无 typebox 符号面）。
    // 管道护栏对任何来源的 schema 同一执法：非法参数在守门段之前即拒。
    const remoteSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    } as unknown as ToolDefinition['parameters'];
    const tool: ToolDefinition = {
      name: 'mcp__demo__read',
      description: '远端工具',
      parameters: remoteSchema,
      execute: async (args) => ({ content: [{ type: 'text', text: `读到 ${(args as { path: string }).path}` }] }),
    };
    const ctx = createContext({ name: 'test' });
    const run = createToolPipeline(ctx);
    // 非法（类型违远端声明）→ 前置步 TOOL_ARGUMENTS_INVALID，不触执行段
    const err = await run(tool, 'tc-1', { path: 123 }).catch((e) => e);
    expect(codeOf(err)).toBe(TOOL_ARGUMENTS_INVALID);
    // 合法 → 直通执行
    const ok = await run(tool, 'tc-2', { path: '/etc/hosts' });
    expect(ok.content[0]).toMatchObject({ text: '读到 /etc/hosts' });
  });
});
