export type { CodeAction, ArtifactType } from '../contracts/code.js';

export interface CodeTaskInput {
  action: 'analyze' | 'edit' | 'test' | 'full_task';
  instruction: string;
  workingDir?: string;
  testCommand?: string;
  files?: string[];
}

export interface CodeTaskOutput {
  kind: 'code_task';
  action: string;
  success: boolean;
  summary: string;
  toolCallCount: number;
  filesChanged?: string[];
  testResult?: TestResult;
}

export interface PatchPlan {
  description: string;
  steps: Array<{ file: string; action: 'create' | 'edit' | 'delete'; description: string }>;
}

export interface TestResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
}
