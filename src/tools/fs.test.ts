/**
 * L2 tools 单元测试——fs 工具族（read/write/edit/ls；真文件系统，tmp 工作区）：
 * 观察态 CAS 全链路 / fence containment（含 symlink 逃逸）/ apply_patch 编排 / 两阶段编辑。
 */

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  FS_NOT_FOUND,
  FS_NOT_OBSERVED,
  FS_OUTSIDE_WRITABLE_ROOTS,
  FS_PATCH_FAILED,
  FS_VERSION_CONFLICT,
} from '../contracts/errors.js';
import { createFsTools } from './fs.js';
import type { ToolDefinition } from '../contracts/tools.js';

/** 测试工作区（beforeAll 建临时目录；writableRoots 只放它，fence 判定可控） */
let workspace = '';
/** 工作区外的对照目录（fence 拒绝用） */
let outside = '';

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'berry-fs-test-'));
  outside = await mkdtemp(join(tmpdir(), 'berry-fs-outside-'));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** 每用例新建一套工具族（观察表隔离）；workspace 锚定测试目录；可覆盖个别选项 */
function freshTools(overrides: Partial<Parameters<typeof createFsTools>[0]> = {}) {
  const fs = createFsTools({ workspace: () => workspace, writableRoots: () => [workspace], ...overrides });
  const byName = (name: string): ToolDefinition => fs.tools.find((t) => t.name === name)!;
  return { fs, read: byName('read'), write: byName('write'), edit: byName('edit'), ls: byName('ls') };
}

/** 取错误码（非 AppError 让用例失败） */
function codeOf(error: unknown): string {
  expect(error).toBeInstanceOf(AppError);
  return (error as AppError).code;
}

/** 等一小段确保 mtimeMs 前进（版本指纹依赖；同一毫秒内两次写指纹不变） */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 12));

describe('read — 观察登记入口', () => {
  it('读到内容：返回文本 + 登记 present 观察', async () => {
    const t = freshTools();
    const abs = join(workspace, 'hello.txt');
    await writeFile(abs, 'hello berry', 'utf8');
    const result = await t.read.execute({ path: 'hello.txt' }, { toolCallId: 'tc' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'hello berry' });
    expect(t.fs.observed.get(abs)?.state).toBe('present');
  });

  it('文件不存在：FS_NOT_FOUND 但登记 absent（之后 create 合法）', async () => {
    const t = freshTools();
    const err = await t.read.execute({ path: 'ghost.txt' }, { toolCallId: 'tc' }).catch((e) => e);
    expect(codeOf(err)).toBe(FS_NOT_FOUND);
    expect(t.fs.observed.get(join(workspace, 'ghost.txt'))).toEqual({ state: 'absent' });
  });

  it('超大文件截断提示（注入小上限验证）', async () => {
    const t = freshTools({ maxReadBytes: 128 });
    const abs = join(workspace, 'big.txt');
    await writeFile(abs, 'x'.repeat(300), 'utf8');
    const result = await t.read.execute({ path: 'big.txt' }, { toolCallId: 'tc' });
    expect((result.details as { truncated: boolean }).truncated).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('截断');
  });

  it('绝对路径直读（workspace 外可读——fence 只拦写）', async () => {
    const t = freshTools();
    const abs = join(outside, 'readable.txt');
    await writeFile(abs, 'outside', 'utf8');
    const result = await t.read.execute({ path: abs }, { toolCallId: 'tc' });
    expect((result.content[0] as { text: string }).text).toBe('outside');
  });
});

describe('write — 观察态 CAS 分派', () => {
  it('未读已存在 → FS_NOT_OBSERVED（先 read 再写）', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'exist.txt'), '已有内容', 'utf8');
    const err = await t.write.execute({ path: 'exist.txt', content: '覆盖' }, { toolCallId: 'tc' }).catch((e) => e);
    expect(codeOf(err)).toBe(FS_NOT_OBSERVED);
  });

  it('未读不存在 → 合法创建（create-if-absent）', async () => {
    const t = freshTools();
    await t.write.execute({ path: 'fresh.txt', content: '新内容' }, { toolCallId: 'tc' });
    expect(await readFile(join(workspace, 'fresh.txt'), 'utf8')).toBe('新内容');
    expect(t.fs.observed.get(join(workspace, 'fresh.txt'))?.state).toBe('present');
  });

  it('read 过的文件 → 替换成功且观察回填（写后再写仍合法）', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'rw.txt'), 'v1', 'utf8');
    await t.read.execute({ path: 'rw.txt' }, { toolCallId: 'tc' });
    await t.write.execute({ path: 'rw.txt', content: 'v2' }, { toolCallId: 'tc' });
    expect(await readFile(join(workspace, 'rw.txt'), 'utf8')).toBe('v2');
    // 写后回填观察：紧接着再写（不等 mtime 变化）不误报冲突
    await t.write.execute({ path: 'rw.txt', content: 'v3' }, { toolCallId: 'tc' });
    expect(await readFile(join(workspace, 'rw.txt'), 'utf8')).toBe('v3');
  });

  it('read 后被外部修改 → FS_VERSION_CONFLICT（丢失更新守卫）', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'conflict.txt'), 'v1', 'utf8');
    await t.read.execute({ path: 'conflict.txt' }, { toolCallId: 'tc' });
    await tick();
    await writeFile(join(workspace, 'conflict.txt'), '他方抢先改了', 'utf8'); // 模拟并发修改
    const err = await t.write
      .execute({ path: 'conflict.txt', content: '我的版本' }, { toolCallId: 'tc' })
      .catch((e) => e);
    expect(codeOf(err)).toBe(FS_VERSION_CONFLICT);
  });

  it('read 登记过 absent → 之后创建合法（观察语义闭环：看过「没有」即可造）', async () => {
    const t = freshTools();
    await t.read.execute({ path: 'ghost-create.txt' }, { toolCallId: 'tc' }).catch(() => undefined); // FS_NOT_FOUND + absent 登记
    await t.write.execute({ path: 'ghost-create.txt', content: '诞生' }, { toolCallId: 'tc' });
    expect(await readFile(join(workspace, 'ghost-create.txt'), 'utf8')).toBe('诞生');
  });

  it('absent 观察竞态：读时不存在、写时他方已创建 → 冲突', async () => {
    const t = freshTools();
    await t.read.execute({ path: 'race.txt' }, { toolCallId: 'tc' }).catch(() => undefined); // 登记 absent
    await writeFile(join(workspace, 'race.txt'), '他方抢先创建', 'utf8'); // 期间外部出现
    const err = await t.write.execute({ path: 'race.txt', content: '我的版本' }, { toolCallId: 'tc' }).catch((e) => e);
    expect(codeOf(err)).toBe(FS_VERSION_CONFLICT);
  });

  it('fence：可写根外目标拒绝（FS_OUTSIDE_WRITABLE_ROOTS）', async () => {
    const t = freshTools();
    const err = await t.write
      .execute({ path: join(outside, 'escape.txt'), content: 'x' }, { toolCallId: 'tc' })
      .catch((e) => e);
    expect(codeOf(err)).toBe(FS_OUTSIDE_WRITABLE_ROOTS);
  });

  it('fence：根内 symlink 指向根外 → canonicalize 后拒绝（符号链逃逸）', async () => {
    const t = freshTools();
    await symlink(outside, join(workspace, 'link-to-outside'));
    const err = await t.write
      .execute({ path: 'link-to-outside/escape.txt', content: 'x' }, { toolCallId: 'tc' })
      .catch((e) => e);
    expect(codeOf(err)).toBe(FS_OUTSIDE_WRITABLE_ROOTS);
  });
});

describe('edit — apply_patch 两阶段编排', () => {
  it('标准链路：read → edit 补丁成功替换', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'code.ts'), ['line1', 'line2', 'line3'].join('\n'), 'utf8');
    await t.read.execute({ path: 'code.ts' }, { toolCallId: 'tc' });
    const result = await t.edit.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: code.ts',
          ' line1',
          '-line2',
          '+line2-changed',
          ' line3',
          '*** End Patch',
        ].join('\n'),
      },
      { toolCallId: 'tc' },
    );
    expect((result.content[0] as { text: string }).text).toContain('code.ts');
    expect(await readFile(join(workspace, 'code.ts'), 'utf8')).toBe(['line1', 'line2-changed', 'line3'].join('\n'));
  });

  it('未读即编辑 → FS_NOT_OBSERVED', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'unread.ts'), 'content', 'utf8');
    const err = await t.edit
      .execute(
        { patch: ['*** Begin Patch', '*** Update File: unread.ts', '-content', '+new', '*** End Patch'].join('\n') },
        { toolCallId: 'tc' },
      )
      .catch((e) => e);
    expect(codeOf(err)).toBe(FS_NOT_OBSERVED);
  });

  it('Add File：无需先读（新文件）；已存在则拒绝', async () => {
    const t = freshTools();
    await t.edit.execute(
      { patch: ['*** Begin Patch', '*** Add File: brand-new.md', '+# 新', '*** End Patch'].join('\n') },
      { toolCallId: 'tc' },
    );
    expect(await readFile(join(workspace, 'brand-new.md'), 'utf8')).toBe('# 新\n');
    const err = await t.edit
      .execute(
        { patch: ['*** Begin Patch', '*** Add File: brand-new.md', '+重复', '*** End Patch'].join('\n') },
        { toolCallId: 'tc' },
      )
      .catch((e) => e);
    expect(codeOf(err)).toBe(FS_PATCH_FAILED);
  });

  it('Delete File：必须先读过；读过即删成功', async () => {
    const t = freshTools();
    const abs = join(workspace, 'doomed.txt');
    await writeFile(abs, '将死内容', 'utf8');
    const errNoRead = await t.edit
      .execute(
        { patch: ['*** Begin Patch', '*** Delete File: doomed.txt', '*** End Patch'].join('\n') },
        { toolCallId: 'tc' },
      )
      .catch((e) => e);
    expect(codeOf(errNoRead)).toBe(FS_NOT_OBSERVED);
    await t.read.execute({ path: 'doomed.txt' }, { toolCallId: 'tc' });
    await t.edit.execute(
      { patch: ['*** Begin Patch', '*** Delete File: doomed.txt', '*** End Patch'].join('\n') },
      { toolCallId: 'tc' },
    );
    await expect(readFile(abs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('多文件补丁一次应用（Update + Add + Delete 混合）', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'u.txt'), 'old', 'utf8');
    await writeFile(join(workspace, 'd.txt'), '删除我', 'utf8');
    await t.read.execute({ path: 'u.txt' }, { toolCallId: 'tc' });
    await t.read.execute({ path: 'd.txt' }, { toolCallId: 'tc' });
    const result = await t.edit.execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: u.txt',
          '-old',
          '+new',
          '*** Add File: created.txt',
          '+诞生',
          '*** Delete File: d.txt',
          '*** End Patch',
        ].join('\n'),
      },
      { toolCallId: 'tc' },
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('updated u.txt');
    expect(text).toContain('added created.txt');
    expect(text).toContain('deleted d.txt');
    expect(await readFile(join(workspace, 'u.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(workspace, 'created.txt'), 'utf8')).toBe('诞生\n');
  });

  it('阶段一全检：任一文件校验失败 → 整个补丁拒绝、零写入', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'ok.txt'), 'ok-orig', 'utf8');
    await writeFile(join(workspace, 'not-read.txt'), '未读', 'utf8');
    await t.read.execute({ path: 'ok.txt' }, { toolCallId: 'tc' });
    // 补丁里第一个文件合法、第二个未读 → 整体拒绝，第一个文件也不能已被改
    const err = await t.edit
      .execute(
        {
          patch: [
            '*** Begin Patch',
            '*** Update File: ok.txt',
            '-ok-orig',
            '+ok-new',
            '*** Update File: not-read.txt',
            '-未读',
            '+x',
            '*** End Patch',
          ].join('\n'),
        },
        { toolCallId: 'tc' },
      )
      .catch((e) => e);
    expect(codeOf(err)).toBe(FS_NOT_OBSERVED);
    expect(await readFile(join(workspace, 'ok.txt'), 'utf8')).toBe('ok-orig'); // 未被半途应用
  });

  it('read 后外部修改 → edit 版本守卫拒绝', async () => {
    const t = freshTools();
    const abs = join(workspace, 'stale.txt');
    await writeFile(abs, 'v1', 'utf8');
    await t.read.execute({ path: 'stale.txt' }, { toolCallId: 'tc' });
    await tick();
    await writeFile(abs, '外部已改', 'utf8');
    const err = await t.edit
      .execute(
        { patch: ['*** Begin Patch', '*** Update File: stale.txt', '-v1', '+v2', '*** End Patch'].join('\n') },
        { toolCallId: 'tc' },
      )
      .catch((e) => e);
    expect(codeOf(err)).toBe(FS_VERSION_CONFLICT);
  });

  it('fence 对补丁内每个文件独立生效（夹带根外目标拒绝）', async () => {
    const t = freshTools();
    const err = await t.edit
      .execute(
        {
          patch: ['*** Begin Patch', `*** Add File: ${join(outside, 'smuggle.txt')}`, '+x', '*** End Patch'].join('\n'),
        },
        { toolCallId: 'tc' },
      )
      .catch((e) => e);
    expect(codeOf(err)).toBe(FS_OUTSIDE_WRITABLE_ROOTS);
  });
});

describe('ls — 目录列举', () => {
  it('列目录：目录带 / 后缀、按名排序', async () => {
    const t = freshTools();
    await mkdir(join(workspace, 'sub-dir'));
    await writeFile(join(workspace, 'a-file.txt'), 'x', 'utf8');
    const result = await t.ls.execute({ path: '.' }, { toolCallId: 'tc' });
    const lines = (result.content[0] as { text: string }).text.split('\n');
    expect(lines).toContain('a-file.txt');
    expect(lines).toContain('sub-dir/');
  });

  it('缺省列工作区根', async () => {
    const t = freshTools();
    const result = await t.ls.execute({}, { toolCallId: 'tc' });
    expect((result.details as { path: string }).path).toBe(workspace);
  });

  it('目录不存在 → FS_NOT_FOUND', async () => {
    const t = freshTools();
    const err = await t.ls.execute({ path: 'no-such-dir' }, { toolCallId: 'tc' }).catch((e) => e);
    expect(codeOf(err)).toBe(FS_NOT_FOUND);
  });
});
