/**
 * L2 tools 单元测试——fs 工具族（read/write/edit/ls；真文件系统，tmp 工作区）：
 * 观察态 CAS 全链路 / fence containment（含 symlink 逃逸）/ apply_patch 编排 / 两阶段编辑。
 */

import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  FS_DECODE_NON_UTF8,
  FS_DECODE_UNDECIDABLE,
  FS_NOT_FOUND,
  FS_NOT_OBSERVED,
  FS_OUTSIDE_WRITABLE_ROOTS,
  FS_PATCH_FAILED,
  FS_VERSION_CONFLICT,
  FS_WRITE_TARGET_DRIFTED,
  TOOL_ARGUMENTS_INVALID,
} from '../contracts/errors.js';
import { createFsTools, serializeWrites } from './fs.js';
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

describe('read 图片分支 — 多模态内容块（§5.1 尾刀增量）', () => {
  /** 最小合法 1×1 PNG（base64 直解——不需要真渲染，只需字节形态稳定） */
  const PNG_1PX_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('png 读为 image 块（text 元信息 + image base64）+ 登记 present 观察', async () => {
    const t = freshTools();
    const abs = join(workspace, 'pic.png');
    await writeFile(abs, Buffer.from(PNG_1PX_BASE64, 'base64'));
    const result = await t.read.execute({ path: 'pic.png' }, { toolCallId: 'tc' });
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG_1PX_BASE64 });
    expect(result.details).toMatchObject({ image: true, mimeType: 'image/png' });
    // 观察语义不分内容型：图片读后同样登记（后续 edit/delete 守卫照走）
    expect(t.fs.observed.get(abs)?.state).toBe('present');
  });

  it('大写扩展名 .PNG 同样识别（判定前 toLowerCase）', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'PIC.PNG'), Buffer.from(PNG_1PX_BASE64, 'base64'));
    const result = await t.read.execute({ path: 'PIC.PNG' }, { toolCallId: 'tc' });
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('webp/jpg/jpeg/gif 各映射正确 MIME', async () => {
    const t = freshTools();
    for (const [ext, mime] of [
      ['webp', 'image/webp'],
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['gif', 'image/gif'],
    ] as const) {
      const name = `x.${ext}`;
      await writeFile(join(workspace, name), Buffer.from(PNG_1PX_BASE64, 'base64'));
      const result = await t.read.execute({ path: name }, { toolCallId: 'tc' });
      expect(result.content[1], ext).toMatchObject({ type: 'image', mimeType: mime });
    }
  });

  it('超限：isError 结果面拒绝不截断（fail-loud 指路压缩）', async () => {
    const t = freshTools({ maxImageBytes: 8 }); // 注入小上限
    await writeFile(join(workspace, 'huge.png'), Buffer.from(PNG_1PX_BASE64, 'base64'));
    const result = await t.read.execute({ path: 'huge.png' }, { toolCallId: 'tc' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('压缩');
    expect(result.details).toMatchObject({ rejected: 'too-large' });
    // 拒绝读 ≠ 观察成立：未登记（模型没看过内容，后续写守卫不因此放行）
    expect(t.fs.observed.get(join(workspace, 'huge.png'))).toBeUndefined();
  });
});

describe('read/edit 编码决策树 — read 半边（P1-3 挖矿 B11 缺口④，骨架篇 §7.5）', () => {
  /** '测试' 的 GBK 字节（B2 E2 CA D4）——writeFile 不带编码直落原始字节 */
  const GBK_BYTES = Buffer.from([0xb2, 0xe2, 0xca, 0xd4]);

  it('GBK 文件 + encoding 逃生参数 = 转码视图：content 尾注 + details.encoding 双面', async () => {
    const t = freshTools();
    const abs = join(workspace, 'gbk-with-label.txt');
    await writeFile(abs, GBK_BYTES);
    const result = await t.read.execute({ path: 'gbk-with-label.txt', encoding: 'gbk' }, { toolCallId: 'tc' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('测试'); // 转码成功——正文可读
    expect(text).toContain('gbk 编码'); // in-band 尾注（模型只见 content，标注必须进 content）
    expect(result.details).toMatchObject({ encoding: 'gbk' });
    // 读成立 = 观察登记（转码视图也是合法观察——但 edit 仍拒改，见下）
    expect(t.fs.observed.get(abs)?.state).toBe('present');
  });

  it('GBK 文件无标签（非 win32 本地标签恒空）→ FS_DECODE_UNDECIDABLE 响亮失败', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'gbk-no-label.txt'), GBK_BYTES);
    const err = await t.read.execute({ path: 'gbk-no-label.txt' }, { toolCallId: 'tc' }).catch((e) => e);
    expect(codeOf(err)).toBe(FS_DECODE_UNDECIDABLE);
    expect((err as AppError).message).toContain('encoding 参数'); // 指路逃生参数
  });

  it('非法编码标签 = 守门段 TOOL_ARGUMENTS_INVALID（参数可修复错误，不碰文件）', async () => {
    const t = freshTools();
    await writeFile(join(workspace, 'any.txt'), 'plain', 'utf8');
    const err = await t.read
      .execute({ path: 'any.txt', encoding: 'definitely-not-an-encoding' }, { toolCallId: 'tc' })
      .catch((e) => e);
    expect(codeOf(err)).toBe(TOOL_ARGUMENTS_INVALID);
  });

  it('edit 拒改非 UTF-8 文件两终局：BOM 直解 → FS_DECODE_NON_UTF8；无标签 GBK → FS_DECODE_UNDECIDABLE（防转码回写毁档）', async () => {
    // 终局一：UTF-16LE BOM 文件——read 走 BOM 直解成观察，edit 重解码 method 'bom'
    const t1 = freshTools();
    await writeFile(join(workspace, 'utf16-edit-guard.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x00])); // BOM + 'A'
    await t1.read.execute({ path: 'utf16-edit-guard.txt' }, { toolCallId: 'tc' });
    const err1 = await t1.edit
      .execute(
        {
          patch: ['*** Begin Patch', '*** Update File: utf16-edit-guard.txt', '-A', '+B', '*** End Patch'].join('\n'),
        },
        { toolCallId: 'tc' },
      )
      .catch((e) => e);
    expect(codeOf(err1)).toBe(FS_DECODE_NON_UTF8);
    expect((err1 as AppError).message).toContain('write 全文替换'); // 指路显式转码通道

    // 终局二：GBK 文件带标签读成观察——edit 重解码不带标签（非 win32 本地标签
    // 恒空）落④lossy → UNDECIDABLE；观察成立也拦（防「读得过」绕过）
    const t2 = freshTools();
    await writeFile(join(workspace, 'gbk-edit-guard.txt'), GBK_BYTES);
    await t2.read.execute({ path: 'gbk-edit-guard.txt', encoding: 'gbk' }, { toolCallId: 'tc' });
    const err2 = await t2.edit
      .execute(
        {
          patch: ['*** Begin Patch', '*** Update File: gbk-edit-guard.txt', '-测试', '+改', '*** End Patch'].join('\n'),
        },
        { toolCallId: 'tc' },
      )
      .catch((e) => e);
    expect(codeOf(err2)).toBe(FS_DECODE_UNDECIDABLE);
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

describe('写串行链 + 观察态 per-driver（S2 骨架篇 §7.5②/§7.5①——多驱动并存的地基）', () => {
  /** 互斥探针：执行期并发计数（>1 = 重叠即互斥破）+ 进出事件序 */
  function probe(events: string[], tag: string): () => Promise<string> {
    let inside = 0;
    return async () => {
      inside++;
      if (inside > 1) events.push(`OVERLAP:${tag}`);
      events.push(`enter:${tag}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`exit:${tag}`);
      inside--;
      return tag;
    };
  }

  it('占位链尾互斥：同路径并发操作严格串行（先安装先执行，执行期零重叠）', async () => {
    const events: string[] = [];
    const p = join(workspace, 'chain-mutex.txt');
    const [a, b] = await Promise.all([
      serializeWrites([p], probe(events, 'a')),
      serializeWrites([p], probe(events, 'b')),
    ]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    // 严格交替 + 零重叠：b 的等待边恒指 a 的占位（安装序 = 执行序）
    expect(events).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b']);
  });

  it('多路径共享占位：edit 式跨文件操作与单路径写经共享路径互斥（安装序全序，无死锁）', async () => {
    const events: string[] = [];
    const pa = join(workspace, 'chain-a.txt');
    const pb = join(workspace, 'chain-b.txt');
    const [multi, single] = await Promise.all([
      serializeWrites([pa, pb], probe(events, 'multi')),
      serializeWrites([pb], probe(events, 'single')),
    ]);
    expect([multi, single]).toEqual(['multi', 'single']);
    // single 的前驱 = multi 在 pb 上的占位：multi 完整退出后才进
    expect(events).toEqual(['enter:multi', 'exit:multi', 'enter:single', 'exit:single']);
  });

  it('互斥跨实例：两套 fs 族（两驱动形态）同路径并发写——恰一成一败，败者 FS_VERSION_CONFLICT', async () => {
    const t1 = freshTools();
    const t2 = freshTools();
    const rel = 'cross-instance.txt';
    await writeFile(join(workspace, rel), 'v1', 'utf8');
    await t1.read.execute({ path: rel }, { toolCallId: 'tc' });
    await t2.read.execute({ path: rel }, { toolCallId: 'tc' });
    await tick(); // mtime 前进——两实例观察指纹齐指 v1
    const results = await Promise.allSettled([
      t1.write.execute({ path: rel, content: 'w1' }, { toolCallId: 'tc1' }),
      t2.write.execute({ path: rel, content: 'w2' }, { toolCallId: 'tc2' }),
    ]);
    // 先进链尾者胜（物理落盘 + 自己的观察回填）；后进者的 CAS 比对停在 v1 → 冲突
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(codeOf((rejected[0] as PromiseRejectedResult).reason)).toBe(FS_VERSION_CONFLICT);
    const final = await readFile(join(workspace, rel), 'utf8');
    expect(['w1', 'w2']).toContain(final);
  });

  it('观察态 per-driver：A 读过的文件 B 盲写 → FS_NOT_OBSERVED（读不过户——各驱动各账）', async () => {
    const t1 = freshTools();
    const t2 = freshTools();
    const rel = 'blind-write.txt';
    await writeFile(join(workspace, rel), '内容', 'utf8');
    await t1.read.execute({ path: rel }, { toolCallId: 'tc' });
    const err = await t2.write.execute({ path: rel, content: '盲写' }, { toolCallId: 'tc' }).catch((e) => e);
    expect(codeOf(err)).toBe(FS_NOT_OBSERVED);
    // B 自己读过即可写（各账闭环）
    await t2.read.execute({ path: rel }, { toolCallId: 'tc' });
    await t2.write.execute({ path: rel, content: 'B 的合法写' }, { toolCallId: 'tc' });
    expect(await readFile(join(workspace, rel), 'utf8')).toBe('B 的合法写');
  });
});

describe('写串行链 — 段内写目标漂移重验（复盘 20260901 S-2 回归锁）', () => {
  /**
   * 竞速复现编舞（确定性——不抢拍）：holder 先持住 canonical 链 → 工具调用在
   * 链外完成 canonicalize/fence 后到链上等待（此窗口即 T0→T1）→ 攻击者（不受
   * 链约束的共享写者——external 域应用形态）把真实父目录换成指向根外 outside
   * 的符号链 → 释放 holder → 工具进入互斥段执行物理写。
   * HEAD（无重验）：writeFile 沿换上的符号链把宿主特权写落到 fence 外且报成功；
   * 修复：物理写前重验 canonicalize 与链外定键值，漂移即拒 FS_WRITE_TARGET_DRIFTED。
   */
  /** 持住指定链键直至返回的释放器被调用（攻击窗口的确定性构造） */
  const holdChain = async (key: string): Promise<() => Promise<void>> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = serializeWrites([key], () => gate);
    return async () => {
      release();
      await held;
    };
  };
  /** 让工具的链外段（一次 realpath 走查，微秒级）完成——50ms 三个数量级裕度 */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
  /** 存在性探针 */
  const exists = async (p: string): Promise<boolean> => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  };
  /** 攻击动作：真实目录移走 + 同名符号链指向根外（共享写者不受链约束） */
  const swapDirToOutside = async (dir: string): Promise<void> => {
    await rename(dir, `${dir}-moved`);
    await symlink(outside, dir);
  };
  /** 清场（workspace/outside 全文件件共享——符号链与移走的目录各自还原缺席） */
  const cleanupSwap = async (dir: string): Promise<void> => {
    await rm(dir, { force: true });
    await rm(`${dir}-moved`, { recursive: true, force: true });
  };

  it('write：父目录被 swap 成根外符号链 → 拒 FS_WRITE_TARGET_DRIFTED，根外零落盘', async () => {
    const t = freshTools();
    const dir = join(workspace, 's2-swap');
    await mkdir(dir);
    // T0 canonical 复算（同 canonicalize 最近存在祖先回退：dir 真实 → realpath(dir)+basename）
    const key = join(await realpath(dir), 'new.txt');
    const open = await holdChain(key);
    const pending = t.write.execute({ path: 's2-swap/new.txt', content: 'evil' }, { toolCallId: 'tc' });
    await settle(); // 链外段完成：工具已按真实目录定键、在链上等待
    await swapDirToOutside(dir);
    await open(); // 释放持链——工具进入互斥段
    await expect(pending).rejects.toMatchObject({ code: FS_WRITE_TARGET_DRIFTED });
    expect(await exists(join(outside, 'new.txt'))).toBe(false); // 宿主特权写不出 fence
    await cleanupSwap(dir);
  });

  it('edit（Add File 同向量）→ 拒 FS_WRITE_TARGET_DRIFTED，根外零落盘', async () => {
    const t = freshTools();
    const dir = join(workspace, 's2-swap-b');
    await mkdir(dir);
    const key = join(await realpath(dir), 'added.txt');
    const open = await holdChain(key);
    const patch = '*** Begin Patch\n*** Add File: s2-swap-b/added.txt\n+evil\n*** End Patch';
    const pending = t.edit.execute({ patch }, { toolCallId: 'tc' });
    await settle();
    await swapDirToOutside(dir);
    await open();
    await expect(pending).rejects.toMatchObject({ code: FS_WRITE_TARGET_DRIFTED });
    expect(await exists(join(outside, 'added.txt'))).toBe(false);
    await cleanupSwap(dir);
  });
});
