import { exec } from 'node:child_process';
import type { TestCommand, TestResult, TscDiagnostic } from '../contracts/code.js';

const MAX_OUTPUT = 20000;
const DEFAULT_TIMEOUT_MS = 60000;

export interface ParsedTestOutput {
  testCount: number;
  failureCount: number;
  skippedCount: number;
  failedTests: Array<{ name: string; error: string }>;
}

export interface TestRunResult {
  command: string;
  label: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  parsed: ParsedTestOutput | null;
}

export interface TestSuiteResult {
  results: TestRunResult[];
  allPassed: boolean;
  totalDurationMs: number;
  stoppedEarly: boolean;
}

export async function runTestCommand(cmd: TestCommand): Promise<TestRunResult> {
  const { command, label, cwd, timeoutMs } = cmd;
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  return new Promise((resolve) => {
    exec(command, { timeout, cwd, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const durationMs = Date.now() - start;
      const truncatedStdout = truncate(stdout);
      const truncatedStderr = truncate(stderr);
      const exitCode = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 1 : getExitCode(err)) : 0;
      const passed = exitCode === 0;

      let parsed: ParsedTestOutput | null = null;
      if (cmd.parseOutput !== false) {
        parsed = parseVitestOutput(stdout) ?? parseJestOutput(stdout);
      }

      resolve({
        command,
        label,
        exitCode,
        passed,
        durationMs,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        parsed,
      });
    });
  });
}

export async function runTestSuite(commands: TestCommand[], options?: { failFast?: boolean }): Promise<TestSuiteResult> {
  const results: TestRunResult[] = [];
  const suiteStart = Date.now();
  let stoppedEarly = false;

  for (const cmd of commands) {
    const result = await runTestCommand(cmd);
    results.push(result);

    if (!result.passed && options?.failFast) {
      stoppedEarly = true;
      break;
    }
  }

  return {
    results,
    allPassed: results.every(r => r.passed),
    totalDurationMs: Date.now() - suiteStart,
    stoppedEarly,
  };
}

export function parseVitestOutput(stdout: string): ParsedTestOutput | null {
  const testsPassedMatch = stdout.match(/Tests\s+(?:.*?)(\d+)\s+passed/);
  const testsFailedMatch = stdout.match(/Tests\s+(?:.*?)(\d+)\s+failed/);
  const testsSkippedMatch = stdout.match(/Tests\s+(?:.*?)(\d+)\s+skipped/);

  if (!testsPassedMatch && !testsFailedMatch) return null;

  const passedCount = testsPassedMatch ? parseInt(testsPassedMatch[1], 10) : 0;
  const failureCount = testsFailedMatch ? parseInt(testsFailedMatch[1], 10) : 0;
  const skippedCount = testsSkippedMatch ? parseInt(testsSkippedMatch[1], 10) : 0;
  const testCount = passedCount + failureCount + skippedCount;

  const failedTests: Array<{ name: string; error: string }> = [];
  const failedMatches = stdout.matchAll(/(?:FAIL|×|✗)\s+(.+?)(?:\n\s+(.+?))?(?:\n|$)/g);
  for (const match of failedMatches) {
    failedTests.push({
      name: match[1].trim(),
      error: match[2]?.trim() ?? '',
    });
  }

  return { testCount, failureCount, skippedCount, failedTests: failedTests.slice(0, 20) };
}

export function parseJestOutput(stdout: string): ParsedTestOutput | null {
  const summaryMatch = stdout.match(/Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/);
  if (!summaryMatch) return null;

  const failureCount = summaryMatch[1] ? parseInt(summaryMatch[1], 10) : 0;
  const skippedCount = summaryMatch[2] ? parseInt(summaryMatch[2], 10) : 0;
  const testCount = parseInt(summaryMatch[4], 10);

  const failedTests: Array<{ name: string; error: string }> = [];
  const failedMatches = stdout.matchAll(/● (.+?)(?:\n\s+(.+?))?(?:\n\n|$)/g);
  for (const match of failedMatches) {
    failedTests.push({
      name: match[1].trim(),
      error: match[2]?.trim() ?? '',
    });
  }

  return { testCount, failureCount, skippedCount, failedTests: failedTests.slice(0, 20) };
}

export function parseTscOutput(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    diagnostics.push({
      file: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      code: match[4],
      message: match[5],
    });
  }

  return diagnostics;
}

export function toTestResult(runResult: TestRunResult): TestResult {
  return {
    command: runResult.command,
    label: runResult.label as TestResult['label'],
    exitCode: runResult.exitCode,
    passed: runResult.passed,
    durationMs: runResult.durationMs,
    testCount: runResult.parsed?.testCount,
    failureCount: runResult.parsed?.failureCount,
    skippedCount: runResult.parsed?.skippedCount,
    failedTests: runResult.parsed?.failedTests,
    stdout: runResult.stdout,
    stderr: runResult.stderr,
  };
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n...(截断)' : s;
}

function getExitCode(err: Error): number {
  const code = (err as { code?: number | string }).code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string') return 1;
  return 1;
}
