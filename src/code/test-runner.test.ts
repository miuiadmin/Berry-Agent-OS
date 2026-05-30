import { describe, expect, it } from 'vitest';
import {
  runTestCommand,
  runTestSuite,
  parseVitestOutput,
  parseJestOutput,
  parseTscOutput,
  toTestResult,
} from './test-runner.js';

describe('test-runner', () => {
  describe('runTestCommand', () => {
    it('执行成功命令返回 passed: true', async () => {
      const result = await runTestCommand({
        command: 'echo "hello"',
        label: 'custom',
      });
      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('执行失败命令返回 passed: false', async () => {
      const result = await runTestCommand({
        command: 'exit 1',
        label: 'custom',
      });
      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('超时返回错误', async () => {
      const result = await runTestCommand({
        command: 'sleep 10',
        label: 'custom',
        timeoutMs: 100,
      });
      expect(result.passed).toBe(false);
    }, 5000);

    it('记录 stderr', async () => {
      const result = await runTestCommand({
        command: 'echo "err" >&2',
        label: 'custom',
      });
      expect(result.stderr).toContain('err');
    });

    it('设置正确的 label', async () => {
      const result = await runTestCommand({
        command: 'echo ok',
        label: 'typecheck',
      });
      expect(result.label).toBe('typecheck');
    });
  });

  describe('runTestSuite', () => {
    it('执行所有命令并汇总', async () => {
      const result = await runTestSuite([
        { command: 'echo "a"', label: 'custom' },
        { command: 'echo "b"', label: 'custom' },
      ]);
      expect(result.results).toHaveLength(2);
      expect(result.allPassed).toBe(true);
      expect(result.stoppedEarly).toBe(false);
      expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('failFast 首个失败停止后续', async () => {
      const result = await runTestSuite([
        { command: 'exit 1', label: 'custom' },
        { command: 'echo "should not run"', label: 'custom' },
      ], { failFast: true });
      expect(result.results).toHaveLength(1);
      expect(result.allPassed).toBe(false);
      expect(result.stoppedEarly).toBe(true);
    });

    it('不使用 failFast 时运行全部', async () => {
      const result = await runTestSuite([
        { command: 'exit 1', label: 'custom' },
        { command: 'echo "runs"', label: 'custom' },
      ]);
      expect(result.results).toHaveLength(2);
      expect(result.stoppedEarly).toBe(false);
      expect(result.allPassed).toBe(false);
    });
  });

  describe('parseVitestOutput', () => {
    it('解析标准 vitest 总结行', () => {
      const output = `
 ✓ src/code/workspace.test.ts (19 tests) 2766ms
 ✓ src/code/file-locks.test.ts (16 tests) 129ms

 Test Files  3 passed (3)
      Tests  52 passed (52)
   Start at  10:01:01
   Duration  3.01s
`;
      const parsed = parseVitestOutput(output);
      expect(parsed).not.toBeNull();
      expect(parsed!.testCount).toBe(52);
      expect(parsed!.failureCount).toBe(0);
    });

    it('解析包含失败的输出', () => {
      const output = `
 ✓ src/a.test.ts (10 tests)
 × src/b.test.ts (2 tests)

 Test Files  1 failed | 1 passed (2)
      Tests  3 failed | 10 passed (13)
   Duration  2.5s
`;
      const parsed = parseVitestOutput(output);
      expect(parsed).not.toBeNull();
      expect(parsed!.failureCount).toBe(3);
      expect(parsed!.testCount).toBeGreaterThan(0);
    });

    it('非 vitest 输出返回 null', () => {
      const parsed = parseVitestOutput('some random output\nno test summary here');
      expect(parsed).toBeNull();
    });
  });

  describe('parseJestOutput', () => {
    it('解析 Jest 总结行', () => {
      const output = `
PASS src/a.test.ts
FAIL src/b.test.ts

Tests:       2 failed, 1 skipped, 10 passed, 13 total
Snapshots:   0 total
Time:        3.5 s
`;
      const parsed = parseJestOutput(output);
      expect(parsed).not.toBeNull();
      expect(parsed!.testCount).toBe(13);
      expect(parsed!.failureCount).toBe(2);
      expect(parsed!.skippedCount).toBe(1);
    });

    it('非 Jest 输出返回 null', () => {
      const parsed = parseJestOutput('hello world');
      expect(parsed).toBeNull();
    });
  });

  describe('parseTscOutput', () => {
    it('解析 TypeScript 编译错误', () => {
      const output = `src/index.ts(10,5): error TS2304: Cannot find name 'foo'.
src/utils.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.`;
      const diagnostics = parseTscOutput(output);
      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0].file).toBe('src/index.ts');
      expect(diagnostics[0].line).toBe(10);
      expect(diagnostics[0].column).toBe(5);
      expect(diagnostics[0].code).toBe('TS2304');
      expect(diagnostics[0].message).toBe("Cannot find name 'foo'.");
      expect(diagnostics[1].code).toBe('TS2322');
    });

    it('无错误返回空数组', () => {
      const diagnostics = parseTscOutput('Compilation successful.');
      expect(diagnostics).toEqual([]);
    });
  });

  describe('toTestResult', () => {
    it('转换 TestRunResult 为 TestResult', () => {
      const runResult = {
        command: 'npm test',
        label: 'unit-test' as const,
        exitCode: 0,
        passed: true,
        durationMs: 1000,
        stdout: 'ok',
        stderr: '',
        parsed: { testCount: 5, failureCount: 0, skippedCount: 0, failedTests: [] },
      };
      const result = toTestResult(runResult);
      expect(result.command).toBe('npm test');
      expect(result.label).toBe('unit-test');
      expect(result.testCount).toBe(5);
      expect(result.passed).toBe(true);
    });

    it('parsed 为 null 时 testCount 为 undefined', () => {
      const runResult = {
        command: 'tsc --noEmit',
        label: 'typecheck' as const,
        exitCode: 0,
        passed: true,
        durationMs: 500,
        stdout: '',
        stderr: '',
        parsed: null,
      };
      const result = toTestResult(runResult);
      expect(result.testCount).toBeUndefined();
    });
  });
});
