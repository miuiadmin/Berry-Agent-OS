import { z } from 'zod';

// === Constants ===

export const CODE_ACTIONS = ['analyze', 'edit', 'test', 'full_task'] as const;
export const ARTIFACT_TYPES = ['patch_plan', 'file_change', 'test_run', 'diagnostic', 'summary'] as const;
export const TEST_STATUSES = ['passed', 'failed', 'skipped', 'error'] as const;
export const PATCH_STEP_ACTIONS = ['create', 'edit', 'delete'] as const;
export const TEST_LABELS = ['typecheck', 'unit-test', 'build', 'lint', 'custom'] as const;

// === Types ===

export type CodeAction = typeof CODE_ACTIONS[number];
export type ArtifactType = typeof ARTIFACT_TYPES[number];
export type TestStatus = typeof TEST_STATUSES[number];
export type PatchStepAction = typeof PATCH_STEP_ACTIONS[number];
export type TestLabel = typeof TEST_LABELS[number];

// === Zod Schemas ===

export const CodeActionSchema = z.enum(CODE_ACTIONS);
export const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);
export const TestStatusSchema = z.enum(TEST_STATUSES);
export const PatchStepActionSchema = z.enum(PATCH_STEP_ACTIONS);
export const TestLabelSchema = z.enum(TEST_LABELS);

export const CodeTaskInputSchema = z.object({
  action: CodeActionSchema,
  instruction: z.string().min(1),
  workingDir: z.string().optional(),
  testCommand: z.string().optional(),
  files: z.array(z.string()).optional(),
});

export const FailedTestSchema = z.object({
  name: z.string(),
  error: z.string(),
});

export const TestResultSchema = z.object({
  command: z.string(),
  label: TestLabelSchema,
  exitCode: z.number(),
  passed: z.boolean(),
  durationMs: z.number(),
  testCount: z.number().optional(),
  failureCount: z.number().optional(),
  skippedCount: z.number().optional(),
  failedTests: z.array(FailedTestSchema).optional(),
  stdout: z.string(),
  stderr: z.string(),
});

export const TscDiagnosticSchema = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  code: z.string(),
  message: z.string(),
});

export const PatchStepSchema = z.object({
  file: z.string(),
  action: PatchStepActionSchema,
  description: z.string(),
});

export const PatchPlanSchema = z.object({
  description: z.string(),
  steps: z.array(PatchStepSchema),
});

export const CodeTaskOutputSchema = z.object({
  kind: z.literal('code_task'),
  action: CodeActionSchema,
  success: z.boolean(),
  summary: z.string(),
  toolCallCount: z.number().int().min(0),
  filesChanged: z.array(z.string()).optional(),
  testResult: TestResultSchema.optional(),
});

export const TestCommandSchema = z.object({
  command: z.string().min(1),
  label: TestLabelSchema,
  cwd: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  parseOutput: z.boolean().optional(),
});

export const TestSuiteConfigSchema = z.object({
  commands: z.array(TestCommandSchema).min(1),
  failFast: z.boolean().optional(),
});

// === Inferred types ===

export type CodeTaskInput = z.infer<typeof CodeTaskInputSchema>;
export type TestResult = z.infer<typeof TestResultSchema>;
export type TscDiagnostic = z.infer<typeof TscDiagnosticSchema>;
export type PatchPlanInput = z.infer<typeof PatchPlanSchema>;
export type CodeTaskOutput = z.infer<typeof CodeTaskOutputSchema>;
export type TestCommand = z.infer<typeof TestCommandSchema>;
export type TestSuiteConfig = z.infer<typeof TestSuiteConfigSchema>;
export type FailedTest = z.infer<typeof FailedTestSchema>;
