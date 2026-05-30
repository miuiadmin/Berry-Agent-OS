import { describe, expect, it } from 'vitest';
import {
  CodeActionSchema,
  ArtifactTypeSchema,
  CodeTaskInputSchema,
  TestResultSchema,
  CodeTaskOutputSchema,
  PatchPlanSchema,
  TestCommandSchema,
  TscDiagnosticSchema,
} from './code.js';

describe('contracts/code schemas', () => {
  describe('CodeActionSchema', () => {
    it('接受合法 action', () => {
      expect(CodeActionSchema.parse('analyze')).toBe('analyze');
      expect(CodeActionSchema.parse('edit')).toBe('edit');
      expect(CodeActionSchema.parse('test')).toBe('test');
      expect(CodeActionSchema.parse('full_task')).toBe('full_task');
    });

    it('拒绝无效 action', () => {
      expect(() => CodeActionSchema.parse('invalid')).toThrow();
      expect(() => CodeActionSchema.parse('')).toThrow();
    });
  });

  describe('ArtifactTypeSchema', () => {
    it('接受所有 artifact 类型', () => {
      expect(ArtifactTypeSchema.parse('patch_plan')).toBe('patch_plan');
      expect(ArtifactTypeSchema.parse('file_change')).toBe('file_change');
      expect(ArtifactTypeSchema.parse('test_run')).toBe('test_run');
      expect(ArtifactTypeSchema.parse('diagnostic')).toBe('diagnostic');
      expect(ArtifactTypeSchema.parse('summary')).toBe('summary');
    });
  });

  describe('CodeTaskInputSchema', () => {
    it('验证完整输入', () => {
      const input = {
        action: 'analyze',
        instruction: '分析代码结构',
        workingDir: '/repo',
        testCommand: 'npm test',
        files: ['src/index.ts'],
      };
      const result = CodeTaskInputSchema.parse(input);
      expect(result.action).toBe('analyze');
      expect(result.instruction).toBe('分析代码结构');
    });

    it('接受最小输入', () => {
      const input = { action: 'edit', instruction: '修改文件' };
      const result = CodeTaskInputSchema.parse(input);
      expect(result.workingDir).toBeUndefined();
      expect(result.files).toBeUndefined();
    });

    it('拒绝空 instruction', () => {
      expect(() => CodeTaskInputSchema.parse({ action: 'test', instruction: '' })).toThrow();
    });

    it('拒绝无效 action', () => {
      expect(() => CodeTaskInputSchema.parse({ action: 'deploy', instruction: 'x' })).toThrow();
    });
  });

  describe('TestResultSchema', () => {
    it('验证完整测试结果', () => {
      const result = TestResultSchema.parse({
        command: 'npm test',
        label: 'unit-test',
        exitCode: 0,
        passed: true,
        durationMs: 3200,
        testCount: 50,
        failureCount: 0,
        skippedCount: 2,
        failedTests: [],
        stdout: 'all passed',
        stderr: '',
      });
      expect(result.passed).toBe(true);
      expect(result.testCount).toBe(50);
    });

    it('验证失败测试结果', () => {
      const result = TestResultSchema.parse({
        command: 'vitest run',
        label: 'unit-test',
        exitCode: 1,
        passed: false,
        durationMs: 1500,
        testCount: 10,
        failureCount: 2,
        failedTests: [
          { name: 'test A', error: 'expected true' },
          { name: 'test B', error: 'timeout' },
        ],
        stdout: 'output',
        stderr: 'errors',
      });
      expect(result.failedTests).toHaveLength(2);
    });

    it('接受无 parsed 字段的结果', () => {
      const result = TestResultSchema.parse({
        command: 'tsc --noEmit',
        label: 'typecheck',
        exitCode: 0,
        passed: true,
        durationMs: 800,
        stdout: '',
        stderr: '',
      });
      expect(result.testCount).toBeUndefined();
    });
  });

  describe('CodeTaskOutputSchema', () => {
    it('验证成功输出', () => {
      const output = CodeTaskOutputSchema.parse({
        kind: 'code_task',
        action: 'analyze',
        success: true,
        summary: '分析完成',
        toolCallCount: 3,
        filesChanged: ['src/a.ts'],
      });
      expect(output.kind).toBe('code_task');
    });

    it('拒绝 kind 不匹配', () => {
      expect(() => CodeTaskOutputSchema.parse({
        kind: 'other',
        action: 'analyze',
        success: true,
        summary: 'x',
        toolCallCount: 0,
      })).toThrow();
    });

    it('拒绝负数 toolCallCount', () => {
      expect(() => CodeTaskOutputSchema.parse({
        kind: 'code_task',
        action: 'test',
        success: true,
        summary: 'x',
        toolCallCount: -1,
      })).toThrow();
    });
  });

  describe('PatchPlanSchema', () => {
    it('验证完整 patch plan', () => {
      const plan = PatchPlanSchema.parse({
        description: '添加功能',
        steps: [
          { file: 'src/a.ts', action: 'create', description: '新建文件' },
          { file: 'src/b.ts', action: 'edit', description: '修改导出' },
        ],
      });
      expect(plan.steps).toHaveLength(2);
    });

    it('拒绝无效 step action', () => {
      expect(() => PatchPlanSchema.parse({
        description: 'x',
        steps: [{ file: 'a', action: 'rename', description: 'x' }],
      })).toThrow();
    });
  });

  describe('TestCommandSchema', () => {
    it('验证完整命令配置', () => {
      const cmd = TestCommandSchema.parse({
        command: 'npm test',
        label: 'unit-test',
        cwd: '/repo',
        timeoutMs: 30000,
        parseOutput: true,
      });
      expect(cmd.label).toBe('unit-test');
    });

    it('拒绝空命令', () => {
      expect(() => TestCommandSchema.parse({ command: '', label: 'build' })).toThrow();
    });
  });

  describe('TscDiagnosticSchema', () => {
    it('验证 TypeScript 诊断', () => {
      const diag = TscDiagnosticSchema.parse({
        file: 'src/index.ts',
        line: 10,
        column: 5,
        code: 'TS2304',
        message: "Cannot find name 'foo'.",
      });
      expect(diag.code).toBe('TS2304');
    });
  });
});
