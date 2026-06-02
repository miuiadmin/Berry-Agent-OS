import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter, Readable } from 'node:stream';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  glob: vi.fn(),
}));

vi.mock('../utils/kill-tree.js', () => ({
  killTree: vi.fn().mockResolvedValue(undefined),
}));

import { spawn } from 'node:child_process';
import { glob } from 'node:fs/promises';
import { searchFilesTool, grepFilesTool } from './search.js';

const mockSpawn = vi.mocked(spawn);
const mockGlob = vi.mocked(glob);

describe('search_files (glob)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns matched files', async () => {
    async function* fakeGlob() {
      yield 'src/a.ts';
      yield 'src/b.ts';
    }
    mockGlob.mockReturnValue(fakeGlob() as any);

    const result = await searchFilesTool.execute({ pattern: '**/*.ts' });
    expect(result.content).toContain('src/a.ts');
    expect(result.content).toContain('src/b.ts');
    expect(result.isError).toBeUndefined();
  });

  it('returns message when no files match', async () => {
    async function* fakeGlob() {}
    mockGlob.mockReturnValue(fakeGlob() as any);

    const result = await searchFilesTool.execute({ pattern: '**/*.xyz' });
    expect(result.content).toContain('未找到匹配文件');
  });

  it('truncates results beyond maxResults', async () => {
    async function* fakeGlob() {
      for (let i = 0; i < 110; i++) yield `file${i}.ts`;
    }
    mockGlob.mockReturnValue(fakeGlob() as any);

    const result = await searchFilesTool.execute({ pattern: '**/*.ts', maxResults: 5 });
    expect(result.content).toContain('超过 5 个结果');
    expect(result.content.split('\n').filter((l: string) => l.startsWith('file')).length).toBeLessThanOrEqual(5);
  });
});

describe('grep_files', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error for invalid regex', async () => {
    const result = await grepFilesTool.execute({ pattern: '[invalid' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('无效正则');
  });

  it('calls ripgrep and returns results', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    mockSpawn.mockReturnValue(child);

    const p = grepFilesTool.execute({ pattern: 'hello', path: '/tmp/test' });

    setTimeout(() => {
      child.stdout.push(Buffer.from('/tmp/test/a.ts:10:  hello world\n/tmp/test/b.ts:5:  say hello\n'));
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit('close', 0);
    }, 5);

    const result = await p;
    expect(result.content).toContain('a.ts:10');
    expect(result.content).toContain('b.ts:5');
    expect(result.content).toContain('2 条结果');
  });

  it('returns no-match message when ripgrep finds nothing', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    mockSpawn.mockReturnValue(child);

    const p = grepFilesTool.execute({ pattern: 'nonexistent' });

    setTimeout(() => {
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit('close', 1);
    }, 5);

    const result = await p;
    expect(result.content).toContain('未找到匹配');
  });
});
