/**
 * L2 tools 单元测试——apply_patch 补丁格式（codex 原创，内核篇 §7 拍板采纳）：
 * 解析（合法补丁/各类非法形态）/ Update 定位应用 / 尾换行语义 / Add 内容展开。
 */

import { describe, expect, it } from 'vitest';
import { AppError, FS_PATCH_FAILED } from '../contracts/errors.js';
import { addLinesToContent, applyUpdateLines, parseApplyPatch } from './apply-patch.js';

/** 同步断言快捷：thunk 必抛 AppError 且 code 相符（parse/apply 系列都是同步函数） */
function expectThrow(fn: () => unknown, code: string): void {
  let error: unknown;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

describe('parseApplyPatch — 合法补丁', () => {
  it('Update / Add / Delete 三种操作混合解析', () => {
    const ops = parseApplyPatch(
      [
        '*** Begin Patch',
        '*** Update File: src/a.ts',
        ' import x',
        '-const old = 1',
        '+const neu = 2',
        '*** Add File: docs/note.md',
        '+# 标题',
        '+正文',
        '*** Delete File: tmp/old.txt',
        '*** End Patch',
      ].join('\n'),
    );
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ kind: 'update', path: 'src/a.ts' });
    if (ops[0]!.kind === 'update') {
      expect(ops[0]!.lines).toEqual([
        { tag: 'context', text: 'import x' },
        { tag: 'removed', text: 'const old = 1' },
        { tag: 'added', text: 'const neu = 2' },
      ]);
    }
    expect(ops[1]).toMatchObject({ kind: 'add', path: 'docs/note.md' });
    if (ops[1]!.kind === 'add') {
      expect(ops[1]!.lines).toEqual([
        { tag: 'added', text: '# 标题' },
        { tag: 'added', text: '正文' },
      ]);
    }
    expect(ops[2]).toMatchObject({ kind: 'delete', path: 'tmp/old.txt' });
  });

  it('同一文件多个 Update 段按序保留（各自独立 hunk）', () => {
    const ops = parseApplyPatch(
      ['*** Begin Patch', '*** Update File: a.txt', '+x', '*** Update File: b.txt', '+y', '*** End Patch'].join('\n'),
    );
    expect(ops.map((o) => o.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('裸空行宽容收为空上下文行（codex 惯用 " "，裸空行同义）', () => {
    const ops = parseApplyPatch(
      [
        '*** Begin Patch',
        '*** Update File: a.txt',
        ' line1',
        '',
        ' line3',
        '-line3',
        '+line3-new',
        '*** End Patch',
      ].join('\n'),
    );
    if (ops[0]!.kind === 'update') {
      expect(ops[0]!.lines[1]).toEqual({ tag: 'context', text: '' });
    }
  });
});

describe('parseApplyPatch — 非法形态全拒绝（FS_PATCH_FAILED）', () => {
  it('缺 Begin Patch 头', () => {
    expectThrow(() => parseApplyPatch('*** Update File: a\n+x\n*** End Patch'), FS_PATCH_FAILED);
  });

  it('缺 End Patch 尾', () => {
    expectThrow(() => parseApplyPatch('*** Begin Patch\n*** Update File: a\n+x'), FS_PATCH_FAILED);
  });

  it('不含任何文件操作段（空补丁）', () => {
    expectThrow(() => parseApplyPatch('*** Begin Patch\n*** End Patch'), FS_PATCH_FAILED);
  });

  it('段指令之前出现内容行', () => {
    expectThrow(() => parseApplyPatch('*** Begin Patch\n游离行\n*** End Patch'), FS_PATCH_FAILED);
  });

  it('未知段指令', () => {
    expectThrow(() => parseApplyPatch('*** Begin Patch\n*** Rename File: a\n*** End Patch'), FS_PATCH_FAILED);
  });

  it('Add File 段内出现 - 删除行', () => {
    expectThrow(
      () => parseApplyPatch(['*** Begin Patch', '*** Add File: a.txt', '+ok', '-不该出现', '*** End Patch'].join('\n')),
      FS_PATCH_FAILED,
    );
  });

  it('Delete File 段之后出现内容行', () => {
    expectThrow(
      () => parseApplyPatch(['*** Begin Patch', '*** Delete File: a.txt', '+多余', '*** End Patch'].join('\n')),
      FS_PATCH_FAILED,
    );
  });

  it('行首无标记的裸内容行', () => {
    expectThrow(
      () =>
        parseApplyPatch(
          ['*** Begin Patch', '*** Update File: a.txt', ' context', '裸行无前缀', '*** End Patch'].join('\n'),
        ),
      FS_PATCH_FAILED,
    );
  });

  it('Update File 无任何行', () => {
    expectThrow(
      () => parseApplyPatch(['*** Begin Patch', '*** Update File: a.txt', '*** End Patch'].join('\n')),
      FS_PATCH_FAILED,
    );
  });
});

describe('applyUpdateLines — 定位与替换', () => {
  it('context+removed 锚点定位，added 按补丁序插入（保留前后文）', () => {
    const source = ['头一行', 'target', '尾一行'].join('\n');
    const out = applyUpdateLines('a.txt', source, [
      { tag: 'context', text: '头一行' },
      { tag: 'removed', text: 'target' },
      { tag: 'added', text: 'replaced' },
    ]);
    expect(out.split('\n')).toEqual(['头一行', 'replaced', '尾一行']);
  });

  it('多行 hunk 整体匹配（首处命中；added 落在补丁内位置）', () => {
    const source = ['a', 'b', 'a', 'b', 'c'].join('\n');
    // 匹配序列 a,b 首处命中（位置 0）；hunk 展开序 = removed a 丢弃、context b 保留、added X 插入
    const out = applyUpdateLines('a.txt', source, [
      { tag: 'removed', text: 'a' },
      { tag: 'context', text: 'b' },
      { tag: 'added', text: 'X' },
    ]);
    expect(out.split('\n')).toEqual(['b', 'X', 'a', 'b', 'c']);
  });

  it('定位失败拒绝（文件与读取时不一致的证据形态）', () => {
    expectThrow(
      () => applyUpdateLines('a.txt', '完全不同的内容', [{ tag: 'removed', text: '不存在旧行' }]),
      FS_PATCH_FAILED,
    );
  });

  it('无锚点行（全 added）拒绝——无法定位', () => {
    expectThrow(() => applyUpdateLines('a.txt', '旧内容', [{ tag: 'added', text: '新内容' }]), FS_PATCH_FAILED);
  });

  it('原文尾换行保留；无尾换行不强加', () => {
    const withNl = applyUpdateLines('a', 'x\ny\n', [
      { tag: 'context', text: 'x' },
      { tag: 'added', text: 'x2' },
    ]);
    expect(withNl).toBe('x\nx2\ny\n'); // context 保留 + added 追加 + 尾换行照原样
    const noNl = applyUpdateLines('a', 'x\ny', [
      { tag: 'context', text: 'x' },
      { tag: 'added', text: 'x2' },
    ]);
    expect(noNl).toBe('x\nx2\ny');
  });

  it('纯删除 hunk（context + removed，无 added）', () => {
    const source = ['keep', 'drop-me', 'tail'].join('\n');
    const out = applyUpdateLines('a', source, [
      { tag: 'context', text: 'keep' },
      { tag: 'removed', text: 'drop-me' },
    ]);
    expect(out.split('\n')).toEqual(['keep', 'tail']);
  });
});

describe('addLinesToContent — 新建文件内容展开', () => {
  it('added 行拼接为文件内容（尾换行补齐）', () => {
    const content = addLinesToContent([
      { tag: 'added', text: '# 新文件' },
      { tag: 'added', text: '第二行' },
    ]);
    expect(content).toBe('# 新文件\n第二行\n');
  });

  it('空行内容也保留', () => {
    expect(addLinesToContent([{ tag: 'added', text: '' }])).toBe('\n');
  });
});
