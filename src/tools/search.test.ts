/**
 * L2 tools 单元测试——检索族（find / grep；真文件系统，tmp 工作区）：
 * glob→RegExp 编译（含非法拒绝）/ gitignore-aware 遍历（根与嵌套规则、常量剪枝）/
 * grep 双输出模式 / 二进制与超限护栏 / 显式单文件目标不受 ignore 剪枝。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import { createSearchTools, globToRegExp } from './search.js';
import type { ToolDefinition } from '../contracts/tools.js';

/** 测试工作区（beforeAll 建临时目录 + 固定样例树） */
let workspace = '';

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'berry-search-test-'));
  // 样例树：ignore 规则（根 + 嵌套）/ 深层嵌套 / 常量剪枝目录 / 二进制
  await writeFile(join(workspace, '.gitignore'), 'ignored-dir/\n*.log\n', 'utf8');
  await mkdir(join(workspace, 'src', 'b'), { recursive: true });
  await writeFile(join(workspace, 'src', 'a.ts'), 'alpha\nbeta SEARCHME\n', 'utf8');
  await writeFile(join(workspace, 'src', 'b', 'c.ts'), 'SEARCHME deep\n', 'utf8');
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await writeFile(join(workspace, 'docs', '.gitignore'), '*.md\n', 'utf8');
  await writeFile(join(workspace, 'docs', 'doc.md'), 'SEARCHME md\n', 'utf8');
  await writeFile(join(workspace, 'docs', 'keep.txt'), 'keep\n', 'utf8');
  await writeFile(join(workspace, 'plain.txt'), 'plain\n', 'utf8');
  await mkdir(join(workspace, 'ignored-dir'), { recursive: true });
  await writeFile(join(workspace, 'ignored-dir', 'x.ts'), 'SEARCHME ignored\n', 'utf8');
  await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(workspace, 'node_modules', 'pkg', 'y.ts'), 'SEARCHME nm\n', 'utf8');
  await writeFile(join(workspace, 'big.log'), 'SEARCHME log\n', 'utf8');
  // 二进制样本：前 8 KiB 内含 NUL 字节
  await writeFile(join(workspace, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x53, 0x45, 0x41]));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** 每用例新建工具族（workspace 锚定测试目录；可覆盖 maxResults/maxScanBytes） */
function freshTools(overrides: Partial<Parameters<typeof createSearchTools>[0]> = {}) {
  const search = createSearchTools({ workspace: () => workspace, ...overrides });
  const byName = (name: string): ToolDefinition => search.tools.find((t) => t.name === name)!;
  return { find: byName('find'), grep: byName('grep') };
}

/** 取错误码（非 AppError 让用例失败） */
function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

describe('globToRegExp — glob 编译（纯函数）', () => {
  it('`**/*.ts` 匹配任意深度的 .ts（含根层）', () => {
    const re = globToRegExp('**/*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/b/c.ts')).toBe(true);
    expect(re.test('a.txt')).toBe(false);
  });

  it('`src/**` 匹配 src 下任意深度路径；`*` 不跨段', () => {
    const re = globToRegExp('src/**');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/b/c.ts')).toBe(true);
    expect(re.test('docs/a.ts')).toBe(false);
    const root = globToRegExp('*.txt');
    expect(root.test('plain.txt')).toBe(true);
    expect(root.test('docs/keep.txt')).toBe(false); // 段内通配不跨 /
  });

  it('`a/**/b` 零层也成立；`?` 单字符；字面点转义', () => {
    const mid = globToRegExp('a/**/b');
    expect(mid.test('a/b')).toBe(true); // ** 含零层
    expect(mid.test('a/x/y/b')).toBe(true);
    expect(mid.test('a/b/c')).toBe(false);
    const q = globToRegExp('v?.ts');
    expect(q.test('v1.ts')).toBe(true);
    expect(q.test('v12.ts')).toBe(false);
    const dot = globToRegExp('v1.2');
    expect(dot.test('v1.2')).toBe(true);
    expect(dot.test('v1x2')).toBe(false); // `.` 是字面不是任意字符
  });

  it('段内混嵌 `**`（非整段）拒绝为参数错误', () => {
    expect(() => globToRegExp('a**b')).toThrow(AppError);
    try {
      globToRegExp('src/**bad/*.ts');
      expect.unreachable();
    } catch (err) {
      expect(codeOf(err)).toBe(TOOL_ARGUMENTS_INVALID);
    }
  });
});

describe('find — glob 找文件', () => {
  it('`**/*.ts` 尊重 gitignore 与常量剪枝（排序输出）', async () => {
    const t = freshTools();
    const result = await t.find.execute({ pattern: '**/*.ts' }, { toolCallId: 'tc' });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: 'src/a.ts\nsrc/b/c.ts', // ignored-dir/x.ts / node_modules/pkg/y.ts 被剪
    });
    expect(result.details).toMatchObject({ matches: 2, truncated: false });
  });

  it('嵌套 .gitignore 只作用其子树（docs/*.md 剪、docs/keep.txt 留）', async () => {
    const t = freshTools();
    const md = await t.find.execute({ pattern: 'docs/*.md' }, { toolCallId: 'tc' });
    expect(md.content[0]).toMatchObject({ type: 'text', text: '（无匹配文件）' });
    const txt = await t.find.execute({ pattern: 'docs/*.txt' }, { toolCallId: 'tc' });
    expect(txt.content[0]).toMatchObject({ type: 'text', text: 'docs/keep.txt' }); // doc.md 被嵌套规则剪
  });

  it('path 起点参数收窄遍历域 + maxResults 截断早停', async () => {
    const t = freshTools({ maxResults: 1 });
    const result = await t.find.execute({ pattern: '**/*.ts', path: 'src' }, { toolCallId: 'tc' });
    expect(result.details).toMatchObject({ truncated: true, root: join(workspace, 'src') });
    expect((result.content[0] as { text: string }).text).toContain('…（已达 1 条上限');
  });
});

describe('grep — 正则内容扫描', () => {
  it('files_with_matches：命中文件列表（ignore/常量剪枝生效）', async () => {
    const t = freshTools();
    const result = await t.grep.execute({ pattern: 'SEARCHME' }, { toolCallId: 'tc' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'src/a.ts\nsrc/b/c.ts' });
    expect(result.details).toMatchObject({ mode: 'files_with_matches', matched: 2 });
  });

  it('content 模式：路径:行号:命中行（去 \\r 与行序正确）', async () => {
    const t = freshTools();
    const result = await t.grep.execute(
      { pattern: 'SEARCHME', output_mode: 'content', path: 'src/a.ts' },
      { toolCallId: 'tc' },
    );
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'src/a.ts:2:beta SEARCHME' });
  });

  it('glob 文件名过滤只搜匹配文件', async () => {
    const t = freshTools();
    const result = await t.grep.execute({ pattern: 'SEARCHME', glob: '**/b/**' }, { toolCallId: 'tc' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'src/b/c.ts' });
  });

  it('显式单文件目标不受 ignore 剪枝（用户意图优先）', async () => {
    const t = freshTools();
    const result = await t.grep.execute({ pattern: 'SEARCHME', path: 'ignored-dir/x.ts' }, { toolCallId: 'tc' });
    expect(result.details).toMatchObject({ matched: 1 });
  });

  it('二进制文件跳过计数；超限文件只扫前段（截断入账）', async () => {
    const t = freshTools({ maxScanBytes: 5 });
    const result = await t.grep.execute({ pattern: 'SEARCHME' }, { toolCallId: 'tc' });
    // oversize = .gitignore(19B)/plain.txt(6B)/a.ts(20B)/c.ts(14B) 共 4 件；
    // docs/.gitignore 与 keep.txt 恰 5B 不超（≤ 不截断）；binary.bin 走 binary 短路不计 oversize
    expect(result.details).toMatchObject({ skippedBinary: 1, skippedOversize: 4 });
  });

  it('无效正则与非法 glob 均拒绝为参数错误', async () => {
    const t = freshTools();
    try {
      await t.grep.execute({ pattern: '[' }, { toolCallId: 'tc' });
      expect.unreachable();
    } catch (err) {
      expect(codeOf(err)).toBe(TOOL_ARGUMENTS_INVALID);
    }
    try {
      await t.grep.execute({ pattern: 'x', glob: 'a**b' }, { toolCallId: 'tc' });
      expect.unreachable();
    } catch (err) {
      expect(codeOf(err)).toBe(TOOL_ARGUMENTS_INVALID);
    }
  });
});
