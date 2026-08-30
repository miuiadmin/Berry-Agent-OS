/**
 * L4 channels — @-mention 符号段补全 provider 测试（channels 批刀 B，契约篇 §6.8）。
 *
 * 验收判据 e/f/g/h：两段 token 拦截与条目形状 / 非两段语境三面原样委托 /
 * face undefined 委托腿回归 + warming 无弹层 / 组合下 inner 重获全权。
 */

import { describe, expect, it } from 'vitest';
import { createMentionProvider, type SymbolsFace } from './mention.js';
import type { AutocompleteProvider } from '@earendil-works/pi-tui/dist/autocomplete.js';

/** 记录型内层桩：三面调用全记录；返回可脚本化的哨兵结果（区分「真转发了」与「碰巧同值」） */
function recordingInner(overrides: Partial<AutocompleteProvider> = {}) {
  const calls: { face: string; args: unknown[] }[] = [];
  const inner: AutocompleteProvider = {
    triggerCharacters: ['/'],
    getSuggestions: async (lines, cursorLine, cursorCol) => {
      calls.push({ face: 'getSuggestions', args: [lines[cursorLine], cursorLine, cursorCol] });
      return { items: [{ value: '/cmd', label: 'cmd' }], prefix: '/cm' };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item) => {
      calls.push({ face: 'applyCompletion', args: [lines[cursorLine], cursorLine, cursorCol, item] });
      return { lines: ['<inner-代换>'], cursorLine, cursorCol: 0 };
    },
    shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) => {
      calls.push({ face: 'shouldTriggerFileCompletion', args: [lines[cursorLine], cursorLine, cursorCol] });
      return true;
    },
    ...overrides,
  };
  return { inner, calls };
}

/** 可脚本化 symbolsFor 桩：记录被查询的 path；返回值由用例注入 */
function scriptedFace(result: Awaited<ReturnType<SymbolsFace>>) {
  const paths: string[] = [];
  const face: SymbolsFace = async (path) => {
    paths.push(path);
    return result;
  };
  return { face, paths };
}

/** getSuggestions 第四参的标准形态（signal 必带——与编辑器实调同形） */
const OPTS = { signal: new AbortController().signal };

describe('createMentionProvider 判据 (e)：两段 token 拦截', () => {
  it('`@路径#片段` 命中 → 调 symbolsFor(path) + 名称前缀过滤 + 条目 value=`@path#name`、prefix=全 token、description=:行号', async () => {
    const { inner, calls } = recordingInner();
    const { face, paths } = scriptedFace({
      symbols: [
        { name: 'createRuntime', line: 12, kind: 12 },
        { name: 'createFoo', line: 34, kind: 6 },
        { name: '其他', line: 7 },
      ],
    });
    const provider = createMentionProvider(inner, face);
    const suggestions = await provider.getSuggestions(['看一下 @src/app.ts#create'], 0, 27, OPTS);
    expect(paths).toEqual(['src/app.ts']); // 路径段原样进 face（不含 @ #）
    expect(calls).toEqual([]); // inner 全程未被触（拦截成功）
    expect(suggestions).toEqual({
      items: [
        { value: '@src/app.ts#createRuntime', label: 'createRuntime', description: ':12' },
        { value: '@src/app.ts#createFoo', label: 'createFoo', description: ':34' },
      ],
      prefix: '@src/app.ts#create', // 全 token（代换从 '@' 起）
    });
  });

  it('symbolPrefix 空（刚敲 #）= 全量；行号缺席 = 无 description；零命中 = null（无弹层）', async () => {
    const { inner } = recordingInner();
    const { face } = scriptedFace({ symbols: [{ name: 'solo' }, { name: 'other', line: 3 }] });
    const provider = createMentionProvider(inner, face);
    // 前缀空 = 不过滤全量；line 缺席者不出 description 键
    const all = await provider.getSuggestions(['@main.ts#'], 0, 9, OPTS);
    expect(all).toEqual({
      items: [
        { value: '@main.ts#solo', label: 'solo' },
        { value: '@main.ts#other', label: 'other', description: ':3' },
      ],
      prefix: '@main.ts#',
    });
    const none = await provider.getSuggestions(['@main.ts#zzz'], 0, 12, OPTS);
    expect(none).toBeNull();
  });

  it('符号列表空 = null；token 须紧跟行首或空白（邮箱样误触不拦截——判据不命中即委托腿）', async () => {
    const { inner } = recordingInner();
    const { face, paths } = scriptedFace({ symbols: [] });
    const provider = createMentionProvider(inner, face);
    // '@' 前是字母（邮箱样）：判据不命中 → 非符号段语境，原样委托 inner（非 null）
    const out = await provider.getSuggestions(['a@x.ts#f'], 0, 8, OPTS);
    expect(out).toEqual({ items: [{ value: '/cmd', label: 'cmd' }], prefix: '/cm' });
    expect(paths).toEqual([]); // 未进 face（判据在 face 之前）
  });

  it('applyCompletion：整 token 代换为 `@path#name `（尾空格）+ 保留光标后正文 + 光标落尾空格后', () => {
    const { inner } = recordingInner();
    const { face } = scriptedFace({ symbols: [{ name: 'foo', line: 1 }] });
    const provider = createMentionProvider(inner, face);
    // 行首 token（'@' 即 0 位），光标 12 = 'o' 后（token 尾），后随正文——只代换 token 段
    const out = provider.applyCompletion(
      ['@src/a.ts#fo，再说'],
      0,
      12,
      { value: '@src/a.ts#foo', label: 'foo' },
      '@src/a.ts#fo',
    );
    // 光标 = start(0) + 「@src/a.ts#foo 」长度(14) = 14（落尾空格后）；正文「，再说」原样保留
    expect(out).toEqual({ lines: ['@src/a.ts#foo ，再说'], cursorLine: 0, cursorCol: 14 });
  });
});

describe('createMentionProvider 判据 (f)：非两段语境三面原样委托', () => {
  it('斜杠命令与 @ 文件段语境 → getSuggestions 原样委托 inner（既有行为零漂移）', async () => {
    const { inner, calls } = recordingInner();
    const { face, paths } = scriptedFace({ symbols: [{ name: 'x' }] });
    const provider = createMentionProvider(inner, face);
    // 斜杠命令语境（非 @ token）
    const cmd = await provider.getSuggestions(['/cm'], 0, 3, OPTS);
    expect(cmd).toEqual({ items: [{ value: '/cmd', label: 'cmd' }], prefix: '/cm' });
    // @ 单段（文件段语境——无 #）同样委托
    await provider.getSuggestions(['打开 @src/ma'], 0, 11, OPTS);
    expect(calls.map((c) => c.face)).toEqual(['getSuggestions', 'getSuggestions']);
    expect(paths).toEqual([]); // face 未被触（判据不命中）
  });

  it('applyCompletion / shouldTriggerFileCompletion / triggerCharacters 均随 inner', () => {
    const { inner, calls } = recordingInner();
    const provider = createMentionProvider(inner, scriptedFace({ symbols: [] }).face);
    expect(provider.triggerCharacters).toEqual(['/']); // 沿用内层声明
    const out = provider.applyCompletion(['/xx'], 0, 3, { value: '/cmd', label: 'cmd' }, '/xx');
    expect(out.lines).toEqual(['<inner-代换>']); // 真转发了（哨兵值可见）
    expect(provider.shouldTriggerFileCompletion?.(['@a'], 0, 2)).toBe(true);
    expect(calls.map((c) => c.face)).toEqual(['applyCompletion', 'shouldTriggerFileCompletion']);
  });

  it('inner 未实现 shouldTriggerFileCompletion 时省略键（undefined 语义由编辑器自理）', () => {
    const { inner } = recordingInner({ shouldTriggerFileCompletion: undefined });
    const provider = createMentionProvider(inner, scriptedFace({ symbols: [] }).face);
    expect('shouldTriggerFileCompletion' in provider).toBe(false);
  });
});

describe('createMentionProvider 判据 (g)+(h)：face 档位与委托腿回归', () => {
  it('(g) face undefined（404 档：行未装/根外/熔断）= 委托腿回归——inner 重获全权收到调用', async () => {
    const { inner, calls } = recordingInner();
    const { face, paths } = scriptedFace(undefined);
    const provider = createMentionProvider(inner, face);
    // 两段 token 在场但 face undefined：不私造第二裁决点，原样交还 inner
    const out = await provider.getSuggestions(['@src/app.ts#cre'], 0, 16, OPTS);
    expect(paths).toEqual(['src/app.ts']); // face 被问过（判据命中）
    expect(calls).toEqual([{ face: 'getSuggestions', args: ['@src/app.ts#cre', 0, 16] }]); // inner 收到原样调用
    expect(out).toEqual({ items: [{ value: '/cmd', label: 'cmd' }], prefix: '/cm' }); // 结果即 inner 的
  });

  it('(g) warming 档（语言服务器预热中）= 无弹层不提示——null 且不退委托（暂态非「无话可说」）', async () => {
    const { inner, calls } = recordingInner();
    const { face } = scriptedFace({ symbols: [], warming: true });
    const provider = createMentionProvider(inner, face);
    expect(await provider.getSuggestions(['@a.ts#f'], 0, 7, OPTS)).toBeNull();
    expect(calls).toEqual([]); // inner 未被触（warming 是拦截态）
  });

  it('(h) 组合：同一 provider 先命中拦截（face 在场）、后 face 回 undefined（lsp 行回卷）——inner 在第二阶段重新收到调用', async () => {
    const { inner, calls } = recordingInner();
    // 可变返回：第一拍有 face，第二拍 undefined（模拟 lsp 行回卷摘除）
    let current: Awaited<ReturnType<SymbolsFace>> = { symbols: [{ name: 'foo', line: 2 }] };
    const face: SymbolsFace = async () => current;
    const provider = createMentionProvider(inner, face);
    const first = await provider.getSuggestions(['@a.ts#f'], 0, 7, OPTS);
    expect(first?.items).toEqual([{ value: '@a.ts#foo', label: 'foo', description: ':2' }]); // 阶段一：拦截
    expect(calls).toEqual([]);
    current = undefined; // lsp 行回卷（apply 回卷摘 holder）
    const second = await provider.getSuggestions(['@a.ts#f'], 0, 7, OPTS);
    expect(second).toEqual({ items: [{ value: '/cmd', label: 'cmd' }], prefix: '/cm' }); // 阶段二：委托回归
    expect(calls.map((c) => c.face)).toEqual(['getSuggestions']);
  });
});
