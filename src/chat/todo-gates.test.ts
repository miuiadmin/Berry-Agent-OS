/**
 * L4 chat — todo gates 验证器 + 段约束执法单元测试（骨架篇 §6.8 goal 循环批
 * 刀二，2026-08-30）。
 *
 * 回归面：
 * - resume_when 词法：相对窗（+n[mhd]）/ ISO 绝对时刻 / 各坏形；
 * - 段约束：非 goal 段扩字段申报即拒（七字段逐一）；goal 段 deferred 必携
 *   resume_when + completed 二择一恰一 + 词汇归属（悬空即拒）；
 * - 申报期准入：files spec 形状 / command 无 needsWrite = denied /
 *   diagnostics 面缺席 = missing；
 * - files gate：真 tmpdir 存在非空过 / 缺文件 / 空文件 / 根外逃逸 = missing；
 * - command gate：抛面分类（TOOL_TIMEOUT → timeout / TOOL_BLOCKED → denied）+
 *   结果面分类（denial 标记 → denied / 退出码非零 → nonzero）；
 * - diagnostics gate：error 级在场 → nonzero / missing → missing / malformed →
 *   malformed / 查询面缺席 → missing；
 * - 渲染：GateFailure → GOAL_GATE_FAILED 回执文本结构化前缀。
 *
 * 全栈链（goal_set → todo 落账 → 计划态投影 → open 项否决）归 src/app/goal.test.ts。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppError, TOOL_BLOCKED, TOOL_TIMEOUT } from '../contracts/errors.js';
import {
  declareGateFailure,
  enforceTodoScope,
  isValidResumeWhen,
  renderGateFailure,
  runTodoGates,
  type CommandGateRunner,
  type DiagnosticsGateQuery,
  type TodoGateFaces,
  type TodoGoalScope,
} from './todo-gates.js';
import type { TodoItem } from './todo.js';

/* ---------------- 测试基建 ---------------- */

/** goal 段视野桩（activatedSeq 本文件不触达 gates——只有 fold 消费锚） */
const SCOPE: TodoGoalScope = { active: true, activatedSeq: 5, needsWrite: true };
/** 只读档（command gate 准入判据用） */
const SCOPE_READ_ONLY: TodoGoalScope = { active: true, activatedSeq: 5, needsWrite: false };

/** 造临时工作区根（files gate 的 fence 锚——真 stat 非 mock） */
const root = mkdtempSync(join(tmpdir(), 'todo-gates-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** command 假执行面（成功形缺省——分类测试逐场覆写） */
const okRunner: CommandGateRunner = async () => ({ exitCode: 0, isError: false, text: 'ok' });

/** diagnostics 假查询面（全绿缺省） */
const okQuery: DiagnosticsGateQuery = async (paths) => paths.map((path) => ({ path, outcome: 'ok', errors: [] }));

/** 标准执法依赖束（needsWrite 开洞档） */
const facesOf = (over: Partial<TodoGateFaces> = {}): TodoGateFaces => ({
  workspaceRoot: root,
  runCommand: okRunner,
  queryDiagnostics: okQuery,
  needsWrite: true,
  ...over,
});

/** 段约束断言辅助：违规应抛 GOAL_TODO_SCOPE 且文案含定位 */
const expectScopeReject = (items: readonly TodoItem[], scope: TodoGoalScope | undefined, match: RegExp): void => {
  try {
    enforceTodoScope(items, scope);
    expect.unreachable('应抛 GOAL_TODO_SCOPE');
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('GOAL_TODO_SCOPE');
    expect((err as AppError).message).toMatch(match);
  }
};

/* ---------------- resume_when 词法 ---------------- */

describe('isValidResumeWhen（复活条件词法）', () => {
  it('合法形：相对窗 +n[mhd] 与 ISO 绝对时刻', () => {
    expect(isValidResumeWhen('after@+30m')).toBe(true);
    expect(isValidResumeWhen('after@+2h')).toBe(true);
    expect(isValidResumeWhen('after@+3d')).toBe(true);
    expect(isValidResumeWhen('after@2026-09-01T09:00:00Z')).toBe(true);
  });

  it('坏形：无前缀 / 单位外 / 零与前置零 / 负数 / 空值 / 空白', () => {
    expect(isValidResumeWhen('+30m')).toBe(false); // 缺 after@ 前缀
    expect(isValidResumeWhen('after@+30s')).toBe(false); // 单位外（只收 m/h/d）
    expect(isValidResumeWhen('after@+0h')).toBe(false); // 零窗无意义
    expect(isValidResumeWhen('after@+007h')).toBe(false); // 前置零（[1-9] 起手）
    expect(isValidResumeWhen('after@+-3h')).toBe(false); // 负数
    expect(isValidResumeWhen('after@')).toBe(false); // 空时刻
    expect(isValidResumeWhen('after@not a time')).toBe(false); // 非 ISO
    expect(isValidResumeWhen('after@2026-13-99')).toBe(false); // 坏日期
  });
});

/* ---------------- 段约束执法 ---------------- */

describe('enforceTodoScope（段约束——todo 执行段位）', () => {
  it('非 goal 段：基础三值自由通过；扩字段申报即拒（七字段逐一）', () => {
    // 基础面照旧（旧测试同款形状——回归保护）
    expect(() =>
      enforceTodoScope(
        [
          { content: 'a', status: 'pending' },
          { content: 'b', status: 'in_progress' },
          { content: 'c', status: 'completed' },
        ],
        undefined,
      ),
    ).not.toThrow();
    // goal 段词汇不悬空：逐字段申报即拒
    expectScopeReject([{ content: 'a', status: 'deferred', resumeWhen: 'after@+1h' }], undefined, /deferred/);
    expectScopeReject([{ content: 'a', status: 'pending', role: 'user' }], undefined, /role/);
    expectScopeReject([{ content: 'a', status: 'pending', taskClass: '重构' }], undefined, /task_class/);
    expectScopeReject([{ content: 'a', status: 'pending', resumeWhen: 'after@+1h' }], undefined, /resume_when/);
    expectScopeReject([{ content: 'a', status: 'completed', followUp: '后续' }], undefined, /follow_up/);
    expectScopeReject([{ content: 'a', status: 'completed', noFollowUp: true }], undefined, /no_follow_up/);
    expectScopeReject(
      [{ content: 'a', status: 'pending', gate: { kind: 'files', spec: ['x.ts'] } }],
      undefined,
      /gate/,
    );
  });

  it('goal 段：deferred 必携合法 resume_when——缺 / 坏词形 / 非 deferred 悬空全拒', () => {
    expectScopeReject([{ content: 'a', status: 'deferred' }], SCOPE, /缺 resume_when/);
    expectScopeReject([{ content: 'a', status: 'deferred', resumeWhen: '明天吧' }], SCOPE, /词形非法/);
    expectScopeReject([{ content: 'a', status: 'pending', resumeWhen: 'after@+1h' }], SCOPE, /只随 deferred/);
    // 合法 deferred 通过
    expect(() =>
      enforceTodoScope([{ content: 'a', status: 'deferred', resumeWhen: 'after@+2h' }], SCOPE),
    ).not.toThrow();
  });

  it('goal 段：completed 强制 follow_up / no_follow_up 二择一恰一', () => {
    expectScopeReject([{ content: 'a', status: 'completed' }], SCOPE, /缺后继申报/);
    expectScopeReject([{ content: 'a', status: 'completed', followUp: 'x', noFollowUp: true }], SCOPE, /同时携带/);
    expectScopeReject([{ content: 'a', status: 'pending', followUp: 'x' }], SCOPE, /只随 completed/);
    expectScopeReject([{ content: 'a', status: 'pending', noFollowUp: true }], SCOPE, /只随 completed/);
    // 两合法形通过
    expect(() => enforceTodoScope([{ content: 'a', status: 'completed', followUp: '还有收尾' }], SCOPE)).not.toThrow();
    expect(() => enforceTodoScope([{ content: 'a', status: 'completed', noFollowUp: true }], SCOPE)).not.toThrow();
  });

  it('一次收集全部违规（模型可修一笔改对）', () => {
    try {
      enforceTodoScope(
        [
          { content: '甲', status: 'deferred' },
          { content: '乙', status: 'completed' },
        ],
        SCOPE,
      );
      expect.unreachable('应抛');
    } catch (err) {
      const message = (err as AppError).message;
      expect(message).toContain('甲');
      expect(message).toContain('乙'); // 两条都在场——非首错即断
    }
  });
});

/* ---------------- 申报期准入 ---------------- */

describe('declareGateFailure（申报期机制门槛）', () => {
  it('files spec 形状：空清单 / 非串元素 = malformed', () => {
    expect(
      declareGateFailure(
        { kind: 'files', spec: [] },
        { needsWrite: true, runCommand: okRunner, queryDiagnostics: okQuery },
      ),
    ).toMatchObject({ reason: 'malformed' });
    expect(
      declareGateFailure(
        { kind: 'files', spec: ['a.ts', ''] },
        { needsWrite: true, runCommand: okRunner, queryDiagnostics: okQuery },
      ),
    ).toMatchObject({ reason: 'malformed' });
  });

  it('command gate：needsWrite 未申报 = denied（模型自造命令免审批自跑是注入面）', () => {
    const failure = declareGateFailure(
      { kind: 'command', spec: 'npm test' },
      { needsWrite: false, runCommand: okRunner, queryDiagnostics: okQuery },
    );
    expect(failure).toMatchObject({ kind: 'command', reason: 'denied' });
  });

  it('command gate：执行面缺席 = malformed；diagnostics gate：查询面缺席 = missing', () => {
    expect(declareGateFailure({ kind: 'command', spec: 'npm test' }, { needsWrite: true })).toMatchObject({
      reason: 'malformed',
    });
    expect(declareGateFailure({ kind: 'diagnostics', spec: 'src/a.ts' }, { needsWrite: false })).toMatchObject({
      kind: 'diagnostics',
      reason: 'missing',
    });
  });

  it('合法申报全过（needsWrite + 面在场）', () => {
    expect(
      declareGateFailure({ kind: 'command', spec: 'npm test' }, { needsWrite: true, runCommand: okRunner }),
    ).toBeUndefined();
    expect(declareGateFailure({ kind: 'files', spec: ['a.ts'] }, { needsWrite: false })).toBeUndefined();
    expect(
      declareGateFailure({ kind: 'diagnostics', spec: 'a.ts' }, { needsWrite: false, queryDiagnostics: okQuery }),
    ).toBeUndefined();
  });
});

/* ---------------- files gate（真 tmpdir） ---------------- */

describe('runTodoGates·files（存在 + 非空 + fence）', () => {
  it('全清单存在且非空 → 过；pending 项带 gate 不验（只验置 completed）', async () => {
    writeFileSync(join(root, 'present.ts'), 'export {};\n');
    const gated: TodoItem = {
      content: '落码完成',
      status: 'completed',
      followUp: '收尾文档',
      gate: { kind: 'files', spec: ['present.ts'] },
    };
    expect(await runTodoGates([gated], facesOf())).toBeUndefined();
    // 未完项带 gate = 待验（不触发验证器）
    const pending: TodoItem = {
      content: '未到验收点',
      status: 'in_progress',
      gate: { kind: 'files', spec: ['不存在的.ts'] },
    };
    expect(await runTodoGates([pending], facesOf())).toBeUndefined();
  });

  it('缺文件 / 空文件 / 非常规文件 → missing', async () => {
    writeFileSync(join(root, 'empty.ts'), '');
    mkdirSync(join(root, 'adir'), { recursive: true });
    const missing: TodoItem = {
      content: 'x',
      status: 'completed',
      noFollowUp: true,
      gate: { kind: 'files', spec: ['absent.ts'] },
    };
    expect(await runTodoGates([missing], facesOf())).toMatchObject({ kind: 'files', reason: 'missing' });
    const empty: TodoItem = { ...missing, gate: { kind: 'files', spec: ['empty.ts'] } };
    expect(await runTodoGates([empty], facesOf())).toMatchObject({ reason: 'missing', detail: /文件为空/ });
    const dir: TodoItem = { ...missing, gate: { kind: 'files', spec: ['adir'] } };
    expect(await runTodoGates([dir], facesOf())).toMatchObject({ reason: 'missing', detail: /不是常规文件/ });
  });

  it('可读根 fence：绝对路径逃逸 / ../ 归一逃逸 → missing（CR-20 存在性 oracle 封口）', async () => {
    const escape: TodoItem = {
      content: 'x',
      status: 'completed',
      noFollowUp: true,
      gate: { kind: 'files', spec: [join(tmpdir(), 'elsewhere.ts')] }, // 绝对路径直逃
    };
    expect(await runTodoGates([escape], facesOf())).toMatchObject({ reason: 'missing', detail: /可读根外/ });
    const dotdot: TodoItem = { ...escape, gate: { kind: 'files', spec: ['../outside.ts'] } }; // 相对词法逃逸
    expect(await runTodoGates([dotdot], facesOf())).toMatchObject({ reason: 'missing', detail: /可读根外/ });
  });
});

/* ---------------- command gate（分类面） ---------------- */

describe('runTodoGates·command（三段管道抛面 + 结果面分类）', () => {
  const gated: TodoItem = {
    content: '测试全绿',
    status: 'completed',
    noFollowUp: true,
    gate: { kind: 'command', spec: 'npm test' },
  };

  it('退出码 0 → 过；非零 → nonzero（判据信号不绿）', async () => {
    expect(await runTodoGates([gated], facesOf())).toBeUndefined();
    const fail: CommandGateRunner = async () => ({ exitCode: 1, isError: true, text: 'exit code: 1' });
    expect(await runTodoGates([gated], facesOf({ runCommand: fail }))).toMatchObject({
      kind: 'command',
      reason: 'nonzero',
      detail: 'exit code: 1',
    });
  });

  it('抛面：TOOL_TIMEOUT → timeout；TOOL_BLOCKED → denied；他错 → malformed', async () => {
    const timeout: CommandGateRunner = async () => {
      throw new AppError(TOOL_TIMEOUT, '[TOOL_TIMEOUT] 超时');
    };
    expect(await runTodoGates([gated], facesOf({ runCommand: timeout }))).toMatchObject({ reason: 'timeout' });
    const blocked: CommandGateRunner = async () => {
      throw new AppError(TOOL_BLOCKED, '[TOOL_BLOCKED] 守门拒');
    };
    expect(await runTodoGates([gated], facesOf({ runCommand: blocked }))).toMatchObject({ reason: 'denied' });
    const boom: CommandGateRunner = async () => {
      throw new Error('spawn 失败');
    };
    expect(await runTodoGates([gated], facesOf({ runCommand: boom }))).toMatchObject({ reason: 'malformed' });
  });

  it('结果面 denial 标记（[sandbox: …] / 升权审批被拒）→ denied 先于退出码', async () => {
    const denied: CommandGateRunner = async () => ({
      exitCode: 1,
      isError: true,
      text: '[sandbox: file access denied under read-only]（命中沙箱拒绝特征：EACCES）',
    });
    expect(await runTodoGates([gated], facesOf({ runCommand: denied }))).toMatchObject({ reason: 'denied' });
    const rejected: CommandGateRunner = async () => ({
      isError: true,
      text: '[sandbox: x] 升权审批被拒（reject）。',
    });
    expect(await runTodoGates([gated], facesOf({ runCommand: rejected }))).toMatchObject({ reason: 'denied' });
  });
});

/* ---------------- diagnostics gate（分类面） ---------------- */

describe('runTodoGates·diagnostics（lsp 结果分类）', () => {
  const gated: TodoItem = {
    content: '编译干净',
    status: 'completed',
    noFollowUp: true,
    gate: { kind: 'diagnostics', spec: 'src/a.ts' },
  };

  it('error 级在场 → nonzero；全绿 / 仅 Warning → 过', async () => {
    const red: DiagnosticsGateQuery = async (paths) =>
      paths.map((path) => ({ path, outcome: 'ok', errors: [{ line: 3, message: 'Type error' }] }));
    expect(await runTodoGates([gated], facesOf({ queryDiagnostics: red }))).toMatchObject({
      kind: 'diagnostics',
      reason: 'nonzero',
      detail: /src\/a\.ts:3 Type error/,
    });
    const warn: DiagnosticsGateQuery = async (paths) => paths.map((path) => ({ path, outcome: 'ok', errors: [] }));
    expect(await runTodoGates([gated], facesOf({ queryDiagnostics: warn }))).toBeUndefined();
  });

  it('outcome missing / malformed → 同名 reason；查询面缺席 → missing', async () => {
    const missingFile: DiagnosticsGateQuery = async (paths) =>
      paths.map((path) => ({ path, outcome: 'missing', errors: [] }));
    expect(await runTodoGates([gated], facesOf({ queryDiagnostics: missingFile }))).toMatchObject({
      reason: 'missing',
      detail: /不在盘/,
    });
    const stale: DiagnosticsGateQuery = async (paths) =>
      paths.map((path) => ({ path, outcome: 'malformed', note: '诊断未及回流', errors: [] }));
    expect(await runTodoGates([gated], facesOf({ queryDiagnostics: stale }))).toMatchObject({
      reason: 'malformed',
      detail: /诊断未及回流/,
    });
    expect(await runTodoGates([gated], facesOf({ queryDiagnostics: undefined }))).toMatchObject({
      reason: 'missing',
      detail: /查询面缺席/,
    });
  });
});

/* ---------------- 渲染 ---------------- */

describe('renderGateFailure（结构化回执）', () => {
  it('kind=… reason=… 前缀 + 项定位 + 细节', () => {
    const text = renderGateFailure({
      item: '测试全绿',
      kind: 'command',
      reason: 'nonzero',
      detail: 'exit code: 2',
    });
    expect(text).toContain('kind=command reason=nonzero');
    expect(text).toContain('「测试全绿」');
    expect(text).toContain('exit code: 2');
  });
});
