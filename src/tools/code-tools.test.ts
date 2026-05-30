import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerCodeTools } from './code-tools.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));

import { readFile, writeFile } from 'node:fs/promises';
import { exec } from 'node:child_process';

const tools = registerCodeTools();
const inspectCode = tools.find(t => t.name === 'inspect_code')!;
const editCode = tools.find(t => t.name === 'edit_code')!;
const runTests = tools.find(t => t.name === 'run_tests')!;
const summarizeChanges = tools.find(t => t.name === 'summarize_changes')!;

describe('inspect_code', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads file and returns numbered lines', async () => {
    (readFile as any).mockResolvedValue('line1\nline2\nline3');
    const result = await inspectCode.execute({ path: 'test.ts' });
    expect(result.content).toContain('1: line1');
    expect(result.content).toContain('3: line3');
  });

  it('returns line range', async () => {
    (readFile as any).mockResolvedValue('a\nb\nc\nd\ne');
    const result = await inspectCode.execute({ path: 'f.ts', startLine: 2, endLine: 4 });
    expect(result.content).toContain('2: b');
    expect(result.content).toContain('4: d');
    expect(result.content).not.toContain('1: a');
    expect(result.content).not.toContain('5: e');
  });

  it('searches with grep', async () => {
    (readFile as any).mockResolvedValue('foo bar\nbaz\nfoo qux');
    const result = await inspectCode.execute({ path: 'f.ts', grep: 'foo' });
    expect(result.content).toContain('2 处匹配');
    expect(result.content).toContain('1: foo bar');
    expect(result.content).toContain('3: foo qux');
  });

  it('returns error when file not found', async () => {
    (readFile as any).mockRejectedValue(new Error('ENOENT: no such file'));
    const result = await inspectCode.execute({ path: 'missing.ts' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('ENOENT');
  });

  it('returns message when grep finds nothing', async () => {
    (readFile as any).mockResolvedValue('hello world');
    const result = await inspectCode.execute({ path: 'f.ts', grep: 'notfound' });
    expect(result.content).toContain('未找到匹配');
  });
});

describe('edit_code', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces text and writes file', async () => {
    (readFile as any).mockResolvedValue('const x = 1;');
    (writeFile as any).mockResolvedValue(undefined);

    const result = await editCode.execute({ path: 'f.ts', oldText: 'x = 1', newText: 'x = 2' });
    expect(result.content).toContain('已修改');
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), 'const x = 2;', 'utf-8');
  });

  it('returns error when oldText not found', async () => {
    (readFile as any).mockResolvedValue('const y = 1;');
    const result = await editCode.execute({ path: 'f.ts', oldText: 'x = 1', newText: 'x = 2' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('未找到');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('replaces all occurrences', async () => {
    (readFile as any).mockResolvedValue('a b a c a');
    (writeFile as any).mockResolvedValue(undefined);

    await editCode.execute({ path: 'f.ts', oldText: 'a', newText: 'X' });
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), 'X b X c X', 'utf-8');
  });
});

describe('run_tests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns stdout on success', async () => {
    (exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => cb(null, 'PASS', ''));
    const result = await runTests.execute({ command: 'npm test' });
    expect(result.content).toContain('PASS');
    expect(result.isError).toBeFalsy();
  });

  it('returns stderr with error', async () => {
    const err = Object.assign(new Error('exit 1'), { code: 1 });
    (exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => cb(err, '', 'error output'));
    const result = await runTests.execute({ command: 'npm test' });
    expect(result.content).toContain('error output');
    expect(result.isError).toBe(true);
  });

  it('truncates long output', async () => {
    const longOutput = 'x'.repeat(25000);
    (exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => cb(null, longOutput, ''));
    const result = await runTests.execute({ command: 'echo' });
    expect(result.content).toContain('截断');
    expect(result.content!.length).toBeLessThan(25000);
  });

  it('passes cwd and timeout to exec', async () => {
    (exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => cb(null, 'ok', ''));
    await runTests.execute({ command: 'test', cwd: '/tmp', timeoutMs: 5000 });
    expect(exec).toHaveBeenCalledWith('test', expect.objectContaining({ cwd: '/tmp', timeout: 5000 }), expect.any(Function));
  });

  it('shows (无输出) when no stdout/stderr', async () => {
    (exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => cb(null, '', ''));
    const result = await runTests.execute({ command: 'true' });
    expect(result.content).toContain('无输出');
  });
});

describe('summarize_changes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns git output', async () => {
    (exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => cb(null, 'M file.ts\n---\n1 file', ''));
    const result = await summarizeChanges.execute({});
    expect(result.content).toContain('M file.ts');
  });

  it('returns error when git fails', async () => {
    const err = new Error('not a git repo');
    (exec as any).mockImplementation((_cmd: any, _opts: any, cb: any) => cb(err, '', 'fatal: not a git repo'));
    const result = await summarizeChanges.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('git 命令失败');
  });
});
