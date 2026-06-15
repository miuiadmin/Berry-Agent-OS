export { CodeRuntime } from './runtime.js';
export type { CodeAction, CodeTaskInput, CodeTaskOutput, PatchPlan, TestResult, ArtifactType } from './types.js';
export { detectWorkspace, validateFilePath, checkDirtyState, refreshWorkspace } from './workspace.js';
export type { CodeWorkspace, ValidationResult, DirtyCheckResult, WorkspaceOptions } from './workspace.js';
export { LockManager, LockConflictError } from './file-locks.js';
export type { FileLock, AcquireParams } from './file-locks.js';
// LockStatus 已在 16.0 §17.8 随 isLocked 一并删除
export { buildPatchPlan, validatePatchPlan, groupSteps, buildRollbackPlan, serializePlan, deserializePlan } from './patch-plan.js';
export type { PatchStep, PatchPlanV2, PatchGroup, PlanValidationResult } from './patch-plan.js';
export { runTestCommand, runTestSuite, parseVitestOutput, parseJestOutput, parseTscOutput, toTestResult } from './test-runner.js';
export type { ParsedTestOutput, TestRunResult, TestSuiteResult } from './test-runner.js';
export { runTaskPhases } from './task-phases.js';
export type { PhaseContext, PhaseResult, TaskPhasesResult } from './task-phases.js';
