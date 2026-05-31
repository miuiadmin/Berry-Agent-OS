import type { LlmClient } from '../llm/index.js';
import type { IpcChildChannel } from '../contracts/infrastructure.js';
import type { ToolCallRecord } from '../llm/tool-caller.js';
import type { ModelMessage, ModelToolDef } from '../contracts/model.js';
import type { DangerLevel, ToolDefinition } from '../tools/types.js';
import type { CodeWorkspace } from './workspace.js';
import type { CodeRuntime } from './runtime.js';
import type { LockManager } from './file-locks.js';
import type { TestResult, CodeAction } from '../contracts/code.js';
import type {
  PermissionResultPayload,
  PermissionValidatePayload,
  PermissionConsumePayload,
} from '../contracts/permissions.js';
import type { ToolAuditPayload } from '../contracts/audit.js';
import { runToolLoop } from '../llm/tool-caller.js';
import { toModelTools } from '../tools/types.js';
import { registerTool } from '../tools/index.js';
import { runTestCommand, toTestResult } from './test-runner.js';
import { buildPatchPlan, validatePatchPlan } from './patch-plan.js';
import { resolveConfig } from '../config/resolver.js';
import { getConfigPath } from '../utils/paths.js';
import { genId } from '../utils/id.js';
import { registerCodeTools } from '../tools/code-tools.js';

const config = resolveConfig(getConfigPath());
const MAX_RETRIES = 2;

export interface PhaseContext {
  taskId: string;
  sessionId: string;
  action: CodeAction;
  instruction: string;
  workingDir: string;
  testCommand?: string;
  files?: string[];
  workspace: CodeWorkspace;
  llm: LlmClient;
  ipc: IpcChildChannel;
  runtime: CodeRuntime;
  lockManager: LockManager;
}

export interface PhaseResult {
  phase: 'research' | 'synthesis' | 'implementation' | 'verification';
  success: boolean;
  summary: string;
  toolCalls: ToolCallRecord[];
  artifacts: string[];
}

export interface TaskPhasesResult {
  phases: PhaseResult[];
  success: boolean;
  summary: string;
  filesChanged: string[];
  testResult?: TestResult;
  totalToolCalls: number;
}

const CODE_SYSTEM_PROMPT = `你是 代码智能体，专门处理代码阅读、分析、修改和测试任务。

工作原则：
1. 先充分阅读和理解代码再做修改
2. 修改后尽可能运行测试验证
3. 只修改用户明确要求的部分，不做额外重构
4. 输出简洁的中文摘要说明做了什么`;

const RESEARCH_SUFFIX = `\n\n你当前处于 research 阶段。只能使用 inspect_code 和 summarize_changes 工具阅读代码，不能修改任何文件。
请充分理解代码结构，收集需要修改的信息。`;

const SYNTHESIS_SUFFIX = `\n\n你当前处于 synthesis 阶段。根据之前的研究，生成一个修改计划。
请输出 JSON 格式的 PatchPlan：
\`\`\`json
{
  "description": "计划描述",
  "steps": [
    { "file": "文件路径", "action": "create|edit|delete", "description": "步骤说明" }
  ]
}
\`\`\`
不要使用任何工具，直接输出计划。`;

const IMPLEMENTATION_SUFFIX = `\n\n你当前处于 implementation 阶段。按照计划修改文件。
使用 inspect_code 确认文件内容，使用 edit_code 执行修改。`;

const RESEARCH_TOOLS = ['inspect_code', 'summarize_changes'];
const IMPLEMENTATION_TOOLS = ['inspect_code', 'edit_code'];

export async function runTaskPhases(ctx: PhaseContext): Promise<TaskPhasesResult> {
  const phases: PhaseResult[] = [];
  let filesChanged: string[] = [];
  let testResult: TestResult | undefined;
  let totalToolCalls = 0;

  const allTools = registerCodeTools();
  for (const tool of allTools) {
    registerTool(tool);
  }

  if (ctx.action === 'test') {
    const verifyResult = await runVerification(ctx);
    phases.push(verifyResult.phase);
    totalToolCalls += verifyResult.phase.toolCalls.length;
    testResult = verifyResult.testResult;
    return {
      phases,
      success: verifyResult.phase.success,
      summary: verifyResult.phase.summary,
      filesChanged: [],
      testResult,
      totalToolCalls,
    };
  }

  // Phase 1: Research
  const researchResult = await runResearch(ctx, allTools);
  phases.push(researchResult);
  totalToolCalls += researchResult.toolCalls.length;

  if (!researchResult.success) {
    return { phases, success: false, summary: researchResult.summary, filesChanged: [], totalToolCalls };
  }

  // Phase 2: Synthesis
  const researchMessages = researchResult.toolCalls.length > 0
    ? buildResearchContext(ctx, researchResult)
    : [];
  const synthesisResult = await runSynthesis(ctx, researchMessages);
  phases.push(synthesisResult.phase);
  totalToolCalls += synthesisResult.phase.toolCalls.length;

  if (ctx.action === 'analyze') {
    return {
      phases,
      success: synthesisResult.phase.success,
      summary: synthesisResult.phase.summary,
      filesChanged: [],
      totalToolCalls,
    };
  }

  if (!synthesisResult.phase.success || !synthesisResult.plan) {
    return { phases, success: false, summary: synthesisResult.phase.summary, filesChanged: [], totalToolCalls };
  }

  // Phase 3 + 4: Implementation ↔ Verification retry loop
  let prevFailure: string | undefined;
  let lastImplResult: PhaseResult | undefined;

  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    const implResult = await runImplementation(ctx, synthesisResult.plan, allTools, prevFailure);
    phases.push(implResult);
    totalToolCalls += implResult.toolCalls.length;
    lastImplResult = implResult;
    filesChanged = extractFilesChanged(implResult.toolCalls);

    if (!implResult.success) break;

    const shouldVerify = ctx.action === 'full_task' || ctx.testCommand;
    if (!shouldVerify) break;

    const verifyResult = await runVerification(ctx);
    phases.push(verifyResult.phase);
    totalToolCalls += verifyResult.phase.toolCalls.length;
    testResult = verifyResult.testResult;

    if (verifyResult.phase.success) break;

    if (retry < MAX_RETRIES) {
      prevFailure = verifyResult.phase.summary;
    }
  }

  const lastPhase = phases[phases.length - 1];
  return {
    phases,
    success: lastPhase.success,
    summary: lastPhase.summary,
    filesChanged,
    testResult,
    totalToolCalls,
  };
}

async function runResearch(ctx: PhaseContext, allTools: ToolDefinition[]): Promise<PhaseResult> {
  const tools = filterTools(allTools, RESEARCH_TOOLS);
  const modelTools = toModelTools(tools);
  const artifacts: string[] = [];

  const messages: ModelMessage[] = [{
    role: 'user',
    content: buildTaskPrompt(ctx),
  }];

  const result = await runToolLoop({
    llm: ctx.llm,
    messages,
    systemPrompt: CODE_SYSTEM_PROMPT + RESEARCH_SUFFIX,
    tools: modelTools,
    config: { maxCalls: config.toolLoop.maxCalls, timeoutMs: config.toolLoop.timeoutMs },
    chatContext: {
      agent: 'code',
      purpose: 'code_task',
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
    },
    onToolResult: (toolName, isError) => {
      ctx.ipc.send('task.telemetry', 'core', { kind: 'tool_result', taskId: ctx.taskId, toolName, isError });
    },
    onUncertainty: (reason) => {
      ctx.ipc.send('task.telemetry', 'core', { kind: 'uncertainty', taskId: ctx.taskId, reason });
    },
    requestPermission: safePermission,
    validatePermission: safeValidate,
    consumePermission: safeConsume,
    auditTool: buildAuditFn(ctx),
  });

  return {
    phase: 'research',
    success: true,
    summary: result.finalContent,
    toolCalls: result.toolCalls,
    artifacts,
  };
}

interface SynthesisOutput {
  phase: PhaseResult;
  plan?: { description: string; steps: Array<{ file: string; action: 'create' | 'edit' | 'delete'; description: string }> };
}

async function runSynthesis(ctx: PhaseContext, researchMessages: ModelMessage[]): Promise<SynthesisOutput> {
  const messages: ModelMessage[] = [
    ...researchMessages,
    { role: 'user', content: `基于以上研究结果，为以下任务生成修改计划：\n${ctx.instruction}` },
  ];

  const result = await ctx.llm.chat(messages, {
    system: CODE_SYSTEM_PROMPT + SYNTHESIS_SUFFIX,
    maxTokens: 4096,
    agent: 'code',
    purpose: 'code_task',
    sessionId: ctx.sessionId,
    taskId: ctx.taskId,
  });

  const planJson = extractJsonFromResponse(result.content);
  const artifacts: string[] = [];

  if (!planJson) {
    return {
      phase: {
        phase: 'synthesis',
        success: ctx.action === 'analyze',
        summary: result.content,
        toolCalls: [],
        artifacts,
      },
    };
  }

  try {
    const plan = planJson as { description: string; steps: Array<{ file: string; action: 'create' | 'edit' | 'delete'; description: string }> };
    const patchPlan = buildPatchPlan(plan, ctx.workspace);
    const validation = validatePatchPlan(patchPlan, ctx.workspace);

    const artifactId = ctx.runtime.recordArtifact(ctx.taskId, 'patch_plan', {
      plan,
      validation: { valid: validation.valid, errorCount: validation.errors.length },
    });
    artifacts.push(artifactId);

    if (!validation.valid) {
      const errorSummary = validation.errors.map(e => `step ${e.stepIndex}: ${e.message}`).join('; ');
      return {
        phase: {
          phase: 'synthesis',
          success: false,
          summary: `计划验证失败: ${errorSummary}`,
          toolCalls: [],
          artifacts,
        },
      };
    }

    return {
      phase: {
        phase: 'synthesis',
        success: true,
        summary: plan.description,
        toolCalls: [],
        artifacts,
      },
      plan,
    };
  } catch (err) {
    return {
      phase: {
        phase: 'synthesis',
        success: false,
        summary: `计划解析失败: ${(err as Error).message}`,
        toolCalls: [],
        artifacts,
      },
    };
  }
}

async function runImplementation(
  ctx: PhaseContext,
  plan: { description: string; steps: Array<{ file: string; action: 'create' | 'edit' | 'delete'; description: string }> },
  allTools: ToolDefinition[],
  prevTestFailure?: string,
): Promise<PhaseResult> {
  const tools = filterTools(allTools, IMPLEMENTATION_TOOLS);
  const modelTools = toModelTools(tools);
  const artifacts: string[] = [];

  const filesToLock = [...new Set(plan.steps.filter(s => s.action !== 'delete').map(s => s.file))];

  try {
    for (const file of filesToLock) {
      ctx.lockManager.acquire({
        filePath: file,
        workspaceDir: ctx.workspace.gitRoot,
        taskId: ctx.taskId,
        agentName: 'code',
        lockType: 'write',
      });
    }
  } catch (err) {
    ctx.lockManager.releaseAll(ctx.taskId);
    return {
      phase: 'implementation',
      success: false,
      summary: `文件锁获取失败: ${(err as Error).message}`,
      toolCalls: [],
      artifacts,
    };
  }

  try {
    const planText = plan.steps.map((s, i) => `${i + 1}. [${s.action}] ${s.file}: ${s.description}`).join('\n');
    let promptContent = `请按照以下计划修改文件:\n\n${planText}`;
    if (prevTestFailure) {
      promptContent += `\n\n上一轮测试失败信息:\n${prevTestFailure}\n\n请修复这些问题。`;
    }

    const messages: ModelMessage[] = [{ role: 'user', content: promptContent }];

    const result = await runToolLoop({
      llm: ctx.llm,
      messages,
      systemPrompt: CODE_SYSTEM_PROMPT + IMPLEMENTATION_SUFFIX,
      tools: modelTools,
      config: { maxCalls: config.toolLoop.maxCalls, timeoutMs: config.toolLoop.timeoutMs },
      chatContext: {
        agent: 'code',
        purpose: 'code_task',
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
      },
      onToolResult: (toolName, isError) => {
        ctx.ipc.send('task.telemetry', 'core', { kind: 'tool_result', taskId: ctx.taskId, toolName, isError });
      },
      onUncertainty: (reason) => {
        ctx.ipc.send('task.telemetry', 'core', { kind: 'uncertainty', taskId: ctx.taskId, reason });
      },
      requestPermission: buildPermissionFn(ctx),
      validatePermission: buildValidateFn(ctx),
      consumePermission: buildConsumeFn(ctx),
      auditTool: buildAuditFn(ctx),
    });

    for (const tc of result.toolCalls) {
      if (tc.name === 'edit_code' && !tc.isError) {
        const artifactId = ctx.runtime.recordArtifact(ctx.taskId, 'file_change', {
          toolInput: tc.input,
          result: tc.result,
        }, { filePath: extractPath(tc.input) });
        artifacts.push(artifactId);
      }
    }

    return {
      phase: 'implementation',
      success: true,
      summary: result.finalContent,
      toolCalls: result.toolCalls,
      artifacts,
    };
  } finally {
    ctx.lockManager.releaseAll(ctx.taskId);
  }
}

interface VerificationOutput {
  phase: PhaseResult;
  testResult?: TestResult;
}

async function runVerification(ctx: PhaseContext): Promise<VerificationOutput> {
  const command = ctx.testCommand ?? 'npm test';
  const artifacts: string[] = [];

  const runResult = await runTestCommand({
    command,
    label: 'custom',
    cwd: ctx.workingDir,
    timeoutMs: config.toolLoop.timeoutMs,
  });

  const testResult = toTestResult(runResult);
  const artifactId = ctx.runtime.recordArtifact(ctx.taskId, 'test_run', testResult, { command });
  artifacts.push(artifactId);

  const passed = runResult.passed;
  let summary: string;
  if (passed) {
    summary = `测试通过${runResult.parsed ? ` (${runResult.parsed.testCount} 个测试)` : ''}`;
  } else {
    const failInfo = runResult.parsed
      ? `${runResult.parsed.failureCount}/${runResult.parsed.testCount} 个测试失败`
      : `退出码 ${runResult.exitCode}`;
    summary = `测试失败: ${failInfo}`;
    if (runResult.parsed?.failedTests?.length) {
      summary += '\n' + runResult.parsed.failedTests.slice(0, 5).map(t => `  - ${t.name}: ${t.error}`).join('\n');
    }
  }

  return {
    phase: {
      phase: 'verification',
      success: passed,
      summary,
      toolCalls: [],
      artifacts,
    },
    testResult,
  };
}

// --- helpers ---

function filterTools(allTools: ToolDefinition[], allowedNames: string[]): ToolDefinition[] {
  return allTools.filter(t => allowedNames.includes(t.name));
}

function buildTaskPrompt(ctx: PhaseContext): string {
  const parts: string[] = [];
  parts.push(`任务类型: ${ctx.action}`);
  if (ctx.workingDir) parts.push(`工作目录: ${ctx.workingDir}`);
  if (ctx.testCommand) parts.push(`测试命令: ${ctx.testCommand}`);
  if (ctx.files?.length) parts.push(`相关文件: ${ctx.files.join(', ')}`);
  parts.push('');
  parts.push(`指令:\n${ctx.instruction}`);
  return parts.join('\n');
}

function buildResearchContext(ctx: PhaseContext, research: PhaseResult): ModelMessage[] {
  return [
    { role: 'user', content: buildTaskPrompt(ctx) },
    { role: 'assistant', content: research.summary },
  ];
}

function extractJsonFromResponse(content: string): Record<string, unknown> | null {
  const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : content;
  try {
    const parsed = JSON.parse(jsonStr.trim());
    if (typeof parsed === 'object' && parsed !== null && 'steps' in parsed) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractFilesChanged(toolCalls: ToolCallRecord[]): string[] {
  const files = new Set<string>();
  for (const tc of toolCalls) {
    if (tc.name === 'edit_code' && !tc.isError) {
      const path = extractPath(tc.input);
      if (path) files.add(path);
    }
  }
  return [...files];
}

function extractPath(inputStr: string): string | undefined {
  try {
    const input = JSON.parse(inputStr);
    return input.path;
  } catch {
    return undefined;
  }
}

// --- permission helpers ---

async function safePermission(_toolName: string, _toolInput: string, _dangerLevel: DangerLevel) {
  return { allowed: true, tokenId: genId('pt') };
}

async function safeValidate(_tokenId: string, _toolName: string, _toolInput: string) {
  return { allowed: true };
}

async function safeConsume(_tokenId: string) {}

function buildPermissionFn(ctx: PhaseContext) {
  return async (toolName: string, toolInput: string, dangerLevel: DangerLevel) => {
    const response = await ctx.ipc.request('permission.request', 'core', {
      toolName,
      toolInput,
      dangerLevel,
      taskId: ctx.taskId,
    }, config.requestTimeoutMs);
    const p = response.payload as PermissionResultPayload;
    return { allowed: p.allowed, reason: p.reason, tokenId: p.tokenId };
  };
}

function buildValidateFn(ctx: PhaseContext) {
  return async (tokenId: string, toolName: string, toolInput: string) => {
    const response = await ctx.ipc.request('permission.validate', 'core', {
      tokenId,
      sessionId: ctx.sessionId,
      toolName,
      toolInput,
    } satisfies PermissionValidatePayload, config.requestTimeoutMs);
    const p = response.payload as PermissionResultPayload;
    return { allowed: p.allowed, reason: p.reason };
  };
}

function buildConsumeFn(ctx: PhaseContext) {
  return async (tokenId: string) => {
    const response = await ctx.ipc.request('permission.consume', 'core', {
      tokenId,
    } satisfies PermissionConsumePayload, config.requestTimeoutMs);
    const p = response.payload as PermissionResultPayload;
    if (!p.allowed) throw new Error(p.reason ?? 'permission token 消费失败');
  };
}

function buildAuditFn(ctx: PhaseContext) {
  return (record: ToolCallRecord) => {
    ctx.ipc.send('tool.audit', 'core', {
      sessionId: ctx.sessionId,
      taskId: ctx.taskId,
      toolName: record.name,
      toolInput: record.input,
      permissionToken: record.permissionToken,
      toolResult: record.result,
      isError: record.isError,
      dangerLevel: record.dangerLevel,
      durationMs: record.durationMs,
    } satisfies ToolAuditPayload);
  };
}
