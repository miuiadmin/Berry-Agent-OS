import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('./read-tracker.js', () => ({
  markFileRead: vi.fn(),
}));

import { readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises';
import { readFileTool, writeFileTool, listDirectoryTool, deleteFileTool } from './filesystem.js';
import { markFileRead } from './read-tracker.js';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockReaddir = vi.mocked(readdir);
const mockUnlink = vi.mocked(unlink);
const mockStat = vi.mocked(stat);
const mockMarkFileRead = vi.mocked(markFileRead);

describe('filesystem tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('assertWithinBoundary (via readFileTool)', () => {
    it('allows paths within cwd', async () => {
      mockReadFile.mockResolvedValue('hello');

      const result = await readFileTool.execute({ path: 'foo.txt' });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('1\thello');
    });

    it('rejects paths outside cwd via ../', async () => {
      const result = await readFileTool.execute({ path: '../../../etc/passwd' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('路径越界');
    });

    it('rejects absolute paths outside cwd', async () => {
      const result = await readFileTool.execute({ path: '/etc/passwd' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('路径越界');
    });

    it('allows cwd itself', async () => {
      mockReadFile.mockRejectedValue(new Error('EISDIR'));
      const result = await readFileTool.execute({ path: '.' });
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain('路径越界');
    });
  });

  describe('readFileTool', () => {
    it('returns file content with line numbers', async () => {
      mockReadFile.mockResolvedValue('line one\nline two\nline three');
      const result = await readFileTool.execute({ path: 'test.txt' });
      expect(result.content).toContain('1\tline one');
      expect(result.content).toContain('2\tline two');
      expect(result.content).toContain('3\tline three');
      expect(result.isError).toBeUndefined();
    });

    it('marks file as read in tracker', async () => {
      mockReadFile.mockResolvedValue('hello');
      await readFileTool.execute({ path: 'test.txt' });
      expect(mockMarkFileRead).toHaveBeenCalled();
    });

    it('supports startLine and endLine pagination', async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
      mockReadFile.mockResolvedValue(lines);
      const result = await readFileTool.execute({ path: 'test.txt', startLine: 3, endLine: 5 });
      expect(result.content).toContain('3\tline 3');
      expect(result.content).toContain('5\tline 5');
      expect(result.content).not.toContain('2\tline 2');
      expect(result.content).not.toContain('6\tline 6');
    });

    it('supports limit parameter', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
      mockReadFile.mockResolvedValue(lines);
      const result = await readFileTool.execute({ path: 'test.txt', limit: 5 });
      expect(result.content).toContain('1\tline 1');
      expect(result.content).toContain('5\tline 5');
      expect(result.content).not.toContain('6\tline 6');
    });

    it('truncates large files and shows hint', async () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
      mockReadFile.mockResolvedValue(lines);
      const result = await readFileTool.execute({ path: 'big.txt' });
      expect(result.content).toContain('共 3000 行');
      expect(result.content).toContain('已显示前 2000 行');
      expect(result.content).not.toContain('2001\t');
    });

    it('returns error for missing file', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));
      const result = await readFileTool.execute({ path: 'missing.txt' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('读取文件失败');
    });
  });

  describe('writeFileTool', () => {
    it('writes file on success', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      const result = await writeFileTool.execute({ path: 'out.txt', content: 'data' });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('已写入');
      expect(mockWriteFile).toHaveBeenCalledWith(resolve(homedir(), 'out.txt'), 'data', 'utf-8');
    });

    it('rejects paths outside boundary', async () => {
      const result = await writeFileTool.execute({ path: '/tmp/evil.txt', content: 'x' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('路径越界');
    });

    it('returns error on write failure', async () => {
      mockWriteFile.mockRejectedValue(new Error('EACCES'));
      const result = await writeFileTool.execute({ path: 'denied.txt', content: 'x' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('写入文件失败');
    });
  });

  describe('listDirectoryTool', () => {
    it('lists directory entries', async () => {
      mockReaddir.mockResolvedValue([
        { name: 'file.ts', isDirectory: () => false, isFile: () => true },
        { name: 'subdir', isDirectory: () => true, isFile: () => false },
      ] as any);
      const result = await listDirectoryTool.execute({ path: '.' });
      expect(result.content).toContain('[文件] file.ts');
      expect(result.content).toContain('[目录] subdir');
    });

    it('rejects paths outside boundary', async () => {
      const result = await listDirectoryTool.execute({ path: '/etc' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('路径越界');
    });
  });

  describe('deleteFileTool', () => {
    it('deletes a file', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => false } as any);
      mockUnlink.mockResolvedValue(undefined);
      const result = await deleteFileTool.execute({ path: 'temp.txt' });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('已删除');
    });

    it('refuses to delete directories', async () => {
      mockStat.mockResolvedValue({ isDirectory: () => true } as any);
      const result = await deleteFileTool.execute({ path: 'somedir' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('不能使用此工具删除目录');
    });

    it('rejects paths outside boundary', async () => {
      const result = await deleteFileTool.execute({ path: '/etc/important' });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('路径越界');
    });
  });
});
