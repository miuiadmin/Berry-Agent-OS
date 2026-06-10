import type { ChatResult, ChatOptions, LlmClient, ToolUseBlock } from './client.js';
import type { ModelMessage, ModelToolDef, ModelContentBlock } from '../contracts/model.js';
import type { TokenBudgetController, BudgetScope } from './token-budget.js';
import type { StreamChunk } from './contract.js';
import type { TurnCorrectionPayload } from '../contracts/delegation.js';
import { LoopDetector } from '../utils/loop-detector.js';
import { getToolByName } from '../tools/index.js';
import type { DangerLevel, ToolResult } from '../tools/types.js';
import { metrics } from '../observability/metrics.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('tool-caller');

// === Stop Condition ===

export type StopCondition =
  | { type: 'step_count'; maxSteps: number }
  | { type: 'tool_use' }
  | { type: 'stop_sequence'; sequences: string[] };

export const StopCondition = {
  stepCountIs: (maxSteps: number): StopCondition => ({ type: 'step_count', maxSteps }),
  toolUse: (): StopCondition => ({ type: 'tool_use' }),
  stopSequences: (sequences: string[]): StopCondition => ({ type: 'stop_sequence', sequences }),
} as const;

export function evaluateStopCondition(
  condition: StopCondition | undefined,
  stepIndex: number,
  stopReason: string,
  stopSequences: string[],
): boolean {
  if (!condition) return false;
  switch (condition.type) {
    case 'step_count':
      return stepIndex >= condition.maxSteps;
    case 'tool_use':
      return stopReason !== 'tool_use';
    case 'stop_sequence':
      return condition.sequences.some((seq) => stopSequences.includes(seq));
  }
}

// === Tool Execution Mode ===

export type ToolExecution = 'auto' | 'none';

export interface ToolCallRecord {
  name: string;
  input: string;
  permissionToken?: string;
  result: string;
  isError: boolean;
  durationMs: number;
  dangerLevel: DangerLevel;
}

export interface ToolLoopConfig {
  maxCalls: number;
  timeoutMs: number;
  stopCondition?: StopCondition;
  toolExecution?: ToolExecution;
}

export interface ToolLoopParams {
  llm: LlmClient;
  messages: ModelMessage[];
  systemPrompt: string;
  tools: ModelToolDef[];
  config: ToolLoopConfig;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
  onToolResult?: (toolName: string, isError: boolean) => void;
  onUncertainty?: (reason: string) => void;
  /**
   * VF-4: 工具循环终止时的生命周期回调。
   *
   * 触发场景：
   * - 'aborted': signal.aborted 或任务被取消
   * - 'completed': LLM 输出 end_turn（正常完成）
   * - 'budget_exceeded': token 预算超限
   * - 'error': LLM 调用失败
   * - 'limit_reached': 工具调用次数或循环上限
   *
   * 用途：Saga 补偿（回滚已写入的文件）、资源清理等。
   */
  onStop?: (reason: 'aborted' | 'completed' | 'budget_exceeded' | 'error' | 'limit_reached') => Promise<void>;
  chatContext?: Partial<ChatOptions>;
  budgetController?: TokenBudgetController;
  budgetScope?: { scope: BudgetScope; scopeId: string };
  /**
   * 13.0 §3.10: Brain 纠偏消费回调。
   *
   * Agent 的 module-agent 维护 pendingCorrection 变量（通过 turn.correction IPC 写入），
   * tool loop 每轮调用此回调检查是否有新纠偏到达。
   *
   * 返回 TurnCorrectionPayload 表示有纠偏（已被 CAS 消费，回调内会 null out），
   * 返回 null 表示无纠偏。
   *
   * 消费行为：
   * - action='stop' → tool loop 立即终止
   * - action='adjust' + instruction → 注入到 system message
   * - action='adjust' + newConstraints.forbiddenTools → 从 tools 列表中移除
   * - action='restart' → 由调用方处理（tool loop 本身不负责重启）
   */
  getPendingCorrection?: () => TurnCorrectionPayload | null;
  requestPermission: (toolName: string, toolInput: string, dangerLevel: DangerLevel) => Promise<{ allowed: boolean; reason?: string; tokenId?: string }>;
  validatePermission: (tokenId: string, toolName: string, toolInput: string) => Promise<{ allowed: boolean; reason?: string }>;
  consumePermission: (tokenId: string) => Promise<void>;
  acquirePermission?: (toolName: string, toolInput: string, dangerLevel: DangerLevel) => Promise<{ allowed: boolean; reason?: string; tokenId?: string }>;
  auditTool: (record: ToolCallRecord) => void;
}

export interface ToolLoopResult {
  finalContent: string;
  reasoning?: string;
  toolCalls: ToolCallRecord[];
  messages: ModelMessage[];
}

export async function runToolLoop(params: ToolLoopParams): Promise<ToolLoopResult> {
  const { llm, messages, systemPrompt, tools, config, signal, onChunk, onReasoning, onUsage, onToolResult, onUncertainty, onStop, chatContext, budgetController, budgetScope, requestPermission, validatePermission, consumePermission, acquirePermission, auditTool, getPendingCorrection } = params;
  const detector = new LoopDetector(config.maxCalls);
  const toolCalls: ToolCallRecord[] = [];
  const workingMessages: ModelMessage[] = [...messages];
  let accumulatedReasoning = '';
  let stepIndex = 0;
  let consecutivePermissionDenials = 0;
  let consecutiveToolErrors = 0;
  let uncertaintyFired = false;
  const useStreaming = !!onChunk && llm.supportsStreaming();

  /**
   * 13.0 §3.10: 动态 system prompt — Brain 纠偏可能追加指令。
   * 初始值为传入的 systemPrompt，纠偏时追加 Brain instruction。
   * 不修改原始 systemPrompt（冻结快照模式），而是构造动态版本。
   */
  let dynamicSystemPrompt = systemPrompt;

  /**
   * 13.0 §3.10: 动态工具列表 — Brain 纠偏的 forbiddenTools 需要实时移除。
   * 每次纠偏后重新过滤，已执行的中间结果仍保留在 workingMessages。
   */
  let activeTools = tools;

  /** 安全触发 onStop 回调，不阻塞返回路径 */
  const fireOnStop = async (reason: Parameters<NonNullable<typeof onStop>>[0]): Promise<void> => {
    if (onStop) {
      try { await onStop(reason); } catch (e) {
        logger.warn({ reason, err: (e as Error).message }, 'tool-loop:onStop callback error');
      }
    }
  };

  while (true) {
    if (signal?.aborted) {
      await fireOnStop('aborted');
      return {
        finalContent: '任务已取消',
        reasoning: accumulatedReasoning || undefined,
        toolCalls,
        messages: workingMessages,
      };
    }

    // ─── 13.0 §3.10: 检查 Brain 纠偏 ───
    if (getPendingCorrection) {
      const correction = getPendingCorrection();
      if (correction) {
        logger.info({ action: correction.action, instruction: correction.instruction?.slice(0, 100), hasConstraints: !!correction.newConstraints }, 'tool-loop: 收到 Brain 纠偏');

        // action='stop': 立即终止工具循环
        if (correction.action === 'stop') {
          logger.info({ instruction: correction.instruction }, 'tool-loop: Brain 下令停止');
          await fireOnStop('aborted');
          return {
            finalContent: correction.instruction ?? '监督系统要求停止当前任务',
            reasoning: accumulatedReasoning || undefined,
            toolCalls,
            messages: workingMessages,
          };
        }

        // action='adjust': 注入 instruction 到 system message
        if (correction.action === 'adjust') {
          // 软注入：追加 Brain instruction 到 system prompt
          if (correction.instruction) {
            dynamicSystemPrompt = `${dynamicSystemPrompt}\n\n⚠️ 监督系统指令：${correction.instruction}`;
            logger.debug({ instruction: correction.instruction.slice(0, 200) }, 'tool-loop: Brain instruction 已注入 system message');
          }

          // 硬注入：从工具列表中移除 forbiddenTools
          if (correction.newConstraints?.forbiddenTools && correction.newConstraints.forbiddenTools.length > 0) {
            const forbidden = new Set(correction.newConstraints.forbiddenTools);
            const before = activeTools.length;
            activeTools = activeTools.filter(t => !forbidden.has(t.name));
            logger.debug({ forbidden: [...forbidden], removed: before - activeTools.length }, 'tool-loop: forbiddenTools 已从工具列表移除');
          }

          // 注入 requiredApproach 到 system prompt
          if (correction.newConstraints?.requiredApproach) {
            dynamicSystemPrompt = `${dynamicSystemPrompt}\n\n⚠️ 必须使用以下方法：${correction.newConstraints.requiredApproach}`;
          }

          // 硬注入：缩短剩余 token 预算
          if (correction.newConstraints?.maxRemainingTokens) {
            dynamicSystemPrompt = `${dynamicSystemPrompt}\n\n⚠️ 剩余 token 预算已缩减为 ${correction.newConstraints.maxRemainingTokens}，请尽快结束任务。`;
          }
        }

        // action='restart': 不在 tool loop 内处理，由调用方处理
        // 但需要先终止当前循环
        if (correction.action === 'restart') {
          logger.info({ instruction: correction.instruction }, 'tool-loop: Brain 要求重启任务');
          // restart 不走 onStop，直接返回特殊标记让调用方处理
          return {
            finalContent: `[RESTART_REQUIRED]${correction.instruction ?? '任务需要重新执行'}`,
            reasoning: accumulatedReasoning || undefined,
            toolCalls,
            messages: workingMessages,
          };
        }
      }
    }

    if (budgetController && budgetScope) {
      const check = budgetController.checkBudget(budgetScope.scope, budgetScope.scopeId);
      if (!check.allowed) {
        await fireOnStop('budget_exceeded');
        return {
          finalContent: check.alert?.message ?? 'Token 预算已超限，停止执行',
          reasoning: accumulatedReasoning || undefined,
          toolCalls,
          messages: workingMessages,
        };
      }
    }

    const chatOpts: ChatOptions = {
      ...chatContext,
      system: dynamicSystemPrompt, // 13.0: 使用动态 system prompt（可能包含 Brain 纠偏注入）
      tools: activeTools,           // 13.0: 使用动态工具列表（Brain 可能移除了 forbiddenTools）
      maxTokens: 4096,
    };

    // LLM 调用可能因超时、网络故障、模型端错误而抛异常；
    // 捕获后返回有意义的错误信息，而非让异常崩溃整个任务
    let result: ChatResult;
    try {
      if (useStreaming) {
        const streamResult = await consumeStream(llm, workingMessages, chatOpts, onChunk!, onReasoning);
        result = streamResult;
        if (streamResult.reasoning) accumulatedReasoning += streamResult.reasoning;
      } else {
        result = await llm.chat(workingMessages, chatOpts);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn({ step: stepIndex, err: errMsg }, 'tool-loop: LLM 调用失败，提前终止');
      await fireOnStop('error');
      return {
        finalContent: `LLM 调用失败（步骤 ${stepIndex}）：${errMsg}。已执行 ${toolCalls.length} 次工具调用。`,
        reasoning: accumulatedReasoning || undefined,
        toolCalls,
        messages: workingMessages,
      };
    }

    if (onUsage) {
      onUsage(result.inputTokens, result.outputTokens);
    }

    logger.debug({ step: stepIndex, stopReason: result.stopReason, contentLen: result.content.length, inputTokens: result.inputTokens, outputTokens: result.outputTokens }, 'tool-loop:llm-done');

    // Evaluate stop condition after each step
    if (evaluateStopCondition(config.stopCondition, stepIndex, result.stopReason, result.content.split('\n'))) {
      await fireOnStop('completed');
      return { finalContent: result.content, reasoning: accumulatedReasoning || undefined, toolCalls, messages: workingMessages };
    }

    stepIndex++;

    if (result.stopReason !== 'tool_use') {
      await fireOnStop('completed');
      return { finalContent: result.content, reasoning: accumulatedReasoning || undefined, toolCalls, messages: workingMessages };
    }

    workingMessages.push({ role: 'assistant', content: result.contentBlocks });

    const toolUseBlocks = result.contentBlocks.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );

    const toolResults: ModelContentBlock[] = [];

    // --- 提取单工具执行逻辑为内部函数 ---
    async function executeToolBlock(block: ToolUseBlock): Promise<{ record: ToolCallRecord; resultBlock: ModelContentBlock }> {
      const toolDef = getToolByName(block.name);
      const dangerLevel: DangerLevel = toolDef?.dangerLevel ?? 'dangerous';
      const inputStr = JSON.stringify(block.input);

      // 权限获取
      const permission = acquirePermission
        ? await acquirePermission(block.name, inputStr, dangerLevel)
        : await requestPermission(block.name, inputStr, dangerLevel);
      logger.debug({ tool: block.name, allowed: permission.allowed, reason: permission.reason?.slice(0, 100) }, 'tool:permission');

      if (!permission.allowed) {
        const record: ToolCallRecord = { name: block.name, input: inputStr, permissionToken: permission.tokenId, result: `权限被拒绝: ${permission.reason}`, isError: true, durationMs: 0, dangerLevel };
        return { record, resultBlock: { type: 'tool_result', toolUseId: block.id, content: record.result, isError: true } };
      }
      if (!permission.tokenId) {
        const record: ToolCallRecord = { name: block.name, input: inputStr, result: '权限被拒绝: 缺少 permission token', isError: true, durationMs: 0, dangerLevel };
        return { record, resultBlock: { type: 'tool_result', toolUseId: block.id, content: record.result, isError: true } };
      }
      if (typeof validatePermission !== 'function' || typeof consumePermission !== 'function') {
        const record: ToolCallRecord = { name: block.name, input: inputStr, permissionToken: permission.tokenId, result: '权限被拒绝: 缺少 permission token 校验/消费器', isError: true, durationMs: 0, dangerLevel };
        return { record, resultBlock: { type: 'tool_result', toolUseId: block.id, content: record.result, isError: true } };
      }

      // 权限校验（acquirePermission 模式跳过）
      if (!acquirePermission) {
        const validation = await validatePermission(permission.tokenId, block.name, inputStr);
        if (!validation.allowed) {
          const record: ToolCallRecord = { name: block.name, input: inputStr, permissionToken: permission.tokenId, result: `权限被拒绝: ${validation.reason}`, isError: true, durationMs: 0, dangerLevel };
          return { record, resultBlock: { type: 'tool_result', toolUseId: block.id, content: record.result, isError: true } };
        }
      }

      // 执行
      let toolResult: ToolResult;
      const start = Date.now();
      if (!toolDef) {
        toolResult = { content: `未知工具: ${block.name}`, isError: true };
      } else {
        try {
          toolResult = await toolDef.execute(block.input);
        } catch (err) {
          toolResult = { content: `工具执行异常: ${(err as Error).message}`, isError: true };
        }
      }
      const durationMs = Date.now() - start;

      // 消费 token
      await consumePermission(permission.tokenId);

      const status = toolResult.isError ? 'error' : 'ok';
      logger.debug({ tool: block.name, input: inputStr.slice(0, 200), result: toolResult.content.slice(0, 500), durationMs, isError: toolResult.isError ?? false, dangerLevel }, 'tool:executed');
      metrics.counter('tool_calls_total').inc({ tool: block.name, agent: chatContext?.agent ?? '', status });
      metrics.histogram('tool_duration_ms').observe(durationMs, { tool: block.name, agent: chatContext?.agent ?? '' });

      const record: ToolCallRecord = { name: block.name, input: inputStr, permissionToken: permission.tokenId, result: toolResult.content, isError: toolResult.isError ?? false, durationMs, dangerLevel };
      return { record, resultBlock: { type: 'tool_result', toolUseId: block.id, content: toolResult.content, isError: toolResult.isError } };
    }

    // --- 将 toolUseBlocks 分为批次：连续的 parallelizable 工具合为一个并行批 ---
    type Batch = { blocks: ToolUseBlock[]; parallel: boolean };
    const batches: Batch[] = [];
    for (const block of toolUseBlocks) {
      const toolDef = getToolByName(block.name);
      const isParallel = toolDef?.parallelizable === true;
      const last = batches[batches.length - 1];
      if (last && last.parallel && isParallel) {
        last.blocks.push(block);
      } else {
        batches.push({ blocks: [block], parallel: isParallel });
      }
    }

    // --- 按批次执行 ---
    for (const batch of batches) {
      if (batch.parallel && batch.blocks.length > 1) {
        // 并行批：先过 loop check，再并发执行
        const eligible: ToolUseBlock[] = [];
        for (const block of batch.blocks) {
          const isDialogueTool = block.name === 'dialogue' || block.name === 'send_dialogue';
          const inputStr = JSON.stringify(block.input);
          const loopCheck = isDialogueTool ? { loop: false } : detector.check(block.name, inputStr, false);
          if (loopCheck.loop) {
            toolResults.push({ type: 'tool_result', toolUseId: block.id, content: `工具调用循环被中断: ${loopCheck.reason}`, isError: true });
          } else {
            eligible.push(block);
          }
        }

        // 并发执行
        const results = await Promise.all(eligible.map(b => executeToolBlock(b)));

        // 按原始顺序收集结果
        for (let i = 0; i < results.length; i++) {
          const { record, resultBlock } = results[i];
          toolCalls.push(record);
          auditTool(record);
          if (onToolResult) onToolResult(record.name, record.isError);
          if (record.isError) {
            if (record.result.startsWith('权限被拒绝')) {
              consecutivePermissionDenials++;
              if (onUncertainty && !uncertaintyFired && consecutivePermissionDenials >= 2) {
                uncertaintyFired = true;
                onUncertainty('consecutive permission denials');
              }
            } else {
              detector.check(record.name, record.input, true);
              consecutiveToolErrors++;
              if (consecutiveToolErrors >= 3 && onUncertainty && !uncertaintyFired) {
                uncertaintyFired = true;
                onUncertainty('consecutive tool errors: ' + consecutiveToolErrors);
              }
            }
          } else {
            consecutivePermissionDenials = 0;
            consecutiveToolErrors = 0;
          }
          toolResults.push(resultBlock);
        }
      } else {
        // 串行执行（单个工具或非 parallelizable 工具）
        for (const block of batch.blocks) {
          const isDialogueTool = block.name === 'dialogue' || block.name === 'send_dialogue';
          const inputStr = JSON.stringify(block.input);
          const loopCheck = isDialogueTool ? { loop: false } : detector.check(block.name, inputStr, false);
          if (loopCheck.loop) {
            logger.debug({ tool: block.name, reason: loopCheck.reason }, 'tool:loop-detected');
            toolResults.push({ type: 'tool_result', toolUseId: block.id, content: `工具调用循环被中断: ${loopCheck.reason}`, isError: true });
            continue;
          }

          const { record, resultBlock } = await executeToolBlock(block);
          toolCalls.push(record);
          auditTool(record);
          if (onToolResult) onToolResult(record.name, record.isError);

          if (!record.isError) {
            consecutivePermissionDenials = 0;
            consecutiveToolErrors = 0;
          } else {
            if (record.result.startsWith('权限被拒绝')) {
              consecutivePermissionDenials++;
              if (onUncertainty && !uncertaintyFired && consecutivePermissionDenials >= 2) {
                uncertaintyFired = true;
                onUncertainty('consecutive permission denials');
              }
            } else {
              detector.check(block.name, inputStr, true);
              consecutiveToolErrors++;
              if (consecutiveToolErrors >= 3 && onUncertainty && !uncertaintyFired) {
                uncertaintyFired = true;
                onUncertainty('consecutive tool errors: ' + consecutiveToolErrors);
              }
            }
          }

          toolResults.push(resultBlock);
        }
      }
    }

    workingMessages.push({ role: 'user', content: toolResults });

    if (detector.check('__iteration__', '', false).loop) {
      const lastText = toolResults
        .filter((r): r is Extract<ModelContentBlock, { type: 'tool_result' }> => r.type === 'tool_result')
        .map((r) => r.content)
        .join('\n');
      await fireOnStop('limit_reached');
      return { finalContent: `工具调用已达上限。最后结果:\n${lastText}`, reasoning: accumulatedReasoning || undefined, toolCalls, messages: workingMessages };
    }
  }
}

async function consumeStream(
  llm: LlmClient,
  messages: ModelMessage[],
  options: ChatOptions,
  onChunk: (text: string) => void,
  onReasoning?: (text: string) => void,
): Promise<ChatResult & { reasoning?: string }> {
  let result: ChatResult | undefined;
  let reasoning = '';
  for await (const chunk of llm.chatStream(messages, options)) {
    if (chunk.type === 'text_delta') {
      onChunk(chunk.text);
    } else if (chunk.type === 'reasoning_delta') {
      reasoning += chunk.text;
      if (onReasoning) onReasoning(chunk.text);
    } else if (chunk.type === 'message_done') {
      const r = chunk.response;
      result = {
        content: r.content,
        contentBlocks: r.contentBlocks,
        toolCalls: r.toolCalls,
        stopReason: r.stopReason,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
        model: r.model,
      };
    }
  }
  if (!result) {
    throw new Error('Stream ended without message_done');
  }
  return { ...result, reasoning: reasoning || undefined };
}
