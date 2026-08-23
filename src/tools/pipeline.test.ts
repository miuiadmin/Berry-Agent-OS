/**
 * L2 tools 单元测试——三段管道全语义面：
 * 参数校验 / 守门（allow·mutate·block·fail-closed）/ 执行段（超时·接管）/ 后处理改写。
 */

import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';
import { AppError, TOOL_ARGUMENTS_INVALID, TOOL_BLOCKED, TOOL_GATE_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import type { AgentToolResult, GateDecisionPayload, ToolDefinition } from '../contracts/tools.js';
import { createContext } from '../context/index.js';
import { createToolPipeline } from './pipeline.js';

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
