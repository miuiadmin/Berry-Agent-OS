/**
 * L4 channels — @-mention 补全 provider 测试（channels 批刀 B，契约篇 §6.8；
 * 文件段 = daemon 刀二 attach 通道契约）。
 *
 * 验收判据 e/f/g/h：两段 token 拦截与条目形状 / 非两段语境三面原样委托 /
 * face undefined 委托腿回归 + warming 无弹层 / 组合下 inner 重获全权。
 *
 * 第十轮 TUI 专项扫雷三笔锁（TUI-4/7/9，20260904）：非文件段语境分流
 * （force Tab/路径前缀收窄、斜杠命令放行）/ 候选形对齐（引号形 + 目录不补
 * 尾空格）/ face 拒绝收弹不崩 + signal 透传。
 */

import { describe, expect, it } from 'vitest';
import { createFileSegmentProvider, createMentionProvider, type FilesFace, type SymbolsFace } from './mention.js';
import type { AutocompleteProvider } from '@earendil-works/pi-tui'; // TUI-10：裸名（公开面再导出，与 mention.ts 同载体）

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

/** 可脚本化 filesFor 桩：记录被查询前缀；返回值由用例切换（文件段族共用） */
function scriptedFiles() {
  const prefixes: string[] = [];
  const state: { result: { readonly files: readonly string[] } | undefined } = {
    result: { files: ['src/app.ts', 'src/api.ts'] },
  };
  const face: FilesFace = async (prefix) => {
    prefixes.push(prefix);
    return state.result;
  };
  return { face, prefixes, state };
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

/* ---------------- 文件段注入 provider（daemon 刀二：attach 通道契约） ---------------- */

describe('createFileSegmentProvider：单段 @ token 拦截 + undefined 无弹层不回委托', () => {
  it('判据命中：光标前 `@src/ap` 收尾 → filesFor(路径前缀) + 防御过滤 + 条目 value=`@文件`、prefix=全 token', async () => {
    const { inner, calls } = recordingInner();
    const { face, prefixes } = scriptedFiles();
    const provider = createFileSegmentProvider(inner, face);
    // line = '改 @src/ap'（光标 10 = 行尾）
    const suggestions = await provider.getSuggestions(['改 @src/ap'], 0, 10, OPTS);
    expect(prefixes).toEqual(['src/ap']); // '@' 剥离后进 face
    expect(calls).toEqual([]); // inner 未被触（拦截成功）
    expect(suggestions).toEqual({
      items: [
        { value: '@src/app.ts', label: 'src/app.ts' },
        { value: '@src/api.ts', label: 'src/api.ts' },
      ],
      prefix: '@src/ap', // 整 token（代换从 '@' 起）
    });
  });

  it('防御性前缀过滤：face 给全量也保正确（服务端已滤是常态，客户端滤是防御）', async () => {
    const { inner } = recordingInner();
    const face: FilesFace = async () => ({ files: ['src/app.ts', 'docs/x.md', 'xsrc.ts'] });
    const provider = createFileSegmentProvider(inner, face);
    const suggestions = await provider.getSuggestions(['@src'], 0, 4, OPTS);
    expect(suggestions?.items).toEqual([{ value: '@src/app.ts', label: 'src/app.ts' }]); // 仅前缀真命中
  });

  it('face undefined = 无弹层**不回委托**（真源在远端——回委托是错工作区）', async () => {
    const { inner, calls } = recordingInner();
    const { face, state } = scriptedFiles();
    state.result = undefined; // 404/连接失败
    const provider = createFileSegmentProvider(inner, face);
    const suggestions = await provider.getSuggestions(['@src'], 0, 4, OPTS);
    expect(suggestions).toBeNull(); // null = 无弹层（非 undefined 委托哨兵）
    expect(calls).toEqual([]); // 关键：inner 未被触——诚实收窄
  });

  it('空命中 = null；两段 token（# 在场）→ 收窄 null 不委托（TUI-4：外层符号段 404 委托腿穿透到此处，内层 @ 模糊腿是 fd 本地行走 = 错工作区）', async () => {
    const { inner, calls } = recordingInner();
    const face: FilesFace = async () => ({ files: [] }); // 空命中
    const provider = createFileSegmentProvider(inner, face);
    expect(await provider.getSuggestions(['@nope'], 0, 5, OPTS)).toBeNull();
    // '#' 在场 = 两段符号 token：file wrap 判据不命中且非斜杠语境 → null
    //（修前此处委托 inner——错工作区本地腿，TUI-4 探针 C 案）
    expect(await provider.getSuggestions(['@a.ts#f'], 0, 7, OPTS)).toBeNull();
    expect(calls).toEqual([]); // 空命中那次是拦截（face 判据命中）——全程零委托
  });

  it('applyCompletion：整 token 代换（@ 起点到光标）+ 尾空格 + 光标推进；非文件段语境 → 委托', () => {
    const { inner, calls } = recordingInner();
    const face: FilesFace = async () => ({ files: ['src/app.ts'] });
    const provider = createFileSegmentProvider(inner, face);
    // line = '改 @src/ap看看'（光标 9 = 紧随 'p'）：代换 '@src/ap' → '@src/app.ts '
    const applied = provider.applyCompletion(
      ['改 @src/ap看看'],
      0,
      9,
      { value: '@src/app.ts', label: 'src/app.ts' },
      '@src/ap',
    );
    expect(applied).toEqual({ lines: ['改 @src/app.ts 看看'], cursorLine: 0, cursorCol: 14 });
    // 非文件段语境：apply 委托 inner（内层条目接受路）
    const delegated = provider.applyCompletion(['/he'], 0, 3, { value: '/cmd', label: 'cmd' }, '/cm');
    expect(delegated).toEqual({ lines: ['<inner-代换>'], cursorLine: 0, cursorCol: 0 });
    expect(calls.map((c) => c.face)).toEqual(['applyCompletion']);
  });

  it('第三面 shouldTriggerFileCompletion 委托（内层缺面时透传缺席）', async () => {
    const withFace = recordingInner();
    const providerA = createFileSegmentProvider(withFace.inner, scriptedFiles().face);
    expect(providerA.shouldTriggerFileCompletion?.(['x'], 0, 1)).toBe(true);
    expect(withFace.calls.map((c) => c.face)).toEqual(['shouldTriggerFileCompletion']);
    // 内层无此面 → 包装后仍无（不造面）
    const bare = recordingInner({ shouldTriggerFileCompletion: undefined });
    const providerB = createFileSegmentProvider(bare.inner, scriptedFiles().face);
    expect(providerB.shouldTriggerFileCompletion).toBeUndefined();
  });
});

/* ---------------- 第十轮 TUI 专项扫雷三笔（TUI-4/7/9，20260904） ---------------- */

describe('TUI-4 非文件段语境分流：force Tab/路径前缀收窄，斜杠命令放行', () => {
  it('force Tab（探针 B 案）与路径前缀语境 → null 不委托（内层本地腿 = 错工作区）', async () => {
    const { inner, calls } = recordingInner();
    const { face, prefixes } = scriptedFiles();
    const provider = createFileSegmentProvider(inner, face);
    // force Tab：内层 extractPathPrefix(force) 恒返前缀 → 本地 readdir 行走
    // 拿 attach 客户端 cwd 冒充 daemon 工作区（修前此腿委托出本地候选）
    expect(await provider.getSuggestions(['hello wor'], 0, 9, { ...OPTS, force: true })).toBeNull();
    // 路径前缀自然触发（'./x' 形）：内层本地路径补全同属错工作区 → null
    expect(await provider.getSuggestions(['看 ./sr'], 0, 8, OPTS)).toBeNull();
    // 无 @ 的普通文本：内层本来也返回 null（extractPathPrefix 自然态不命中）
    // ——收窄与委托等价，锁死「不为普通文本私放行」的边界
    expect(await provider.getSuggestions(['普通文本'], 0, 4, OPTS)).toBeNull();
    expect(calls).toEqual([]); // 三腿全程零委托
    expect(prefixes).toEqual([]); // face 未被触（判据未命中，分流在 face 之前）
  });

  it('斜杠命令语境放行委托（判据镜像 Combined：非 force + 光标前行首 /）；force + 斜杠不放行', async () => {
    const { inner, calls } = recordingInner();
    const provider = createFileSegmentProvider(inner, scriptedFiles().face);
    // 非 force + 行首 '/'：命令补全是客户端本地数据面（无工作区漂移）→ 委托
    expect(await provider.getSuggestions(['/he'], 0, 3, OPTS)).toEqual({
      items: [{ value: '/cmd', label: 'cmd' }],
      prefix: '/cm',
    });
    // force + 斜杠：Combined 此时不走命令腿（force 越过命令分支）——不放行
    expect(await provider.getSuggestions(['/he'], 0, 3, { ...OPTS, force: true })).toBeNull();
    expect(calls.map((c) => c.face)).toEqual(['getSuggestions']); // 仅命令腿一次委托
  });
});

describe('TUI-7 候选形对齐：引号形 + 目录不补尾空格（与 pi-tui 本地腿同形）', () => {
  it('含空格路径 value 采 @"…" 引号形；无空格路径保持裸形', async () => {
    const { inner } = recordingInner();
    const face: FilesFace = async () => ({ files: ['my notes.md', 'plain.ts'] });
    const provider = createFileSegmentProvider(inner, face);
    // 前缀空串 = 全量（防御过滤对空串恒真）
    const suggestions = await provider.getSuggestions(['@'], 0, 1, OPTS);
    expect(suggestions?.items).toEqual([
      { value: '@"my notes.md"', label: 'my notes.md' }, // 含空白 → 引号形（闭引在场）
      { value: '@plain.ts', label: 'plain.ts' }, // 无空白 → 裸形
    ]);
  });

  it('引号 token 续钻判据命中：`@"my dir/sub`（闭引在光标后）剥引号进 face', async () => {
    const { inner } = recordingInner();
    const prefixes: string[] = [];
    // 候选带命中项（防御过滤 `my dir/su` 前缀真命中——否则空命中收弹 null）
    const face: FilesFace = async (prefix) => {
      prefixes.push(prefix);
      return { files: ['my dir/sub.ts'] };
    };
    const provider = createFileSegmentProvider(inner, face);
    // 接受引号形目录后光标落闭引前——续钻时闭引在光标后（未闭合形）
    const suggestions = await provider.getSuggestions(['看 @"my dir/su'], 0, 13, OPTS);
    expect(prefixes).toEqual(['my dir/su']); // 引号剥净进 face
    expect(suggestions?.prefix).toBe('@"my dir/su'); // token 保留用户实打引号形
    // 光标行至闭引后（闭合形）同样命中（引号双剥）
    await provider.getSuggestions(['看 @"my dir/su"'], 0, 14, OPTS);
    expect(prefixes).toEqual(['my dir/su', 'my dir/su']);
  });

  it('applyCompletion：目录候选不补尾空格（token 不断——续走钻取）+ 引号形目录光标落闭引前', () => {
    const { inner } = recordingInner();
    const face: FilesFace = async () => ({ files: [] });
    const provider = createFileSegmentProvider(inner, face);
    // 裸形目录：'看 @my'（光标 5 = 行尾）→ '@my dir/' 无尾空格，光标落 '/' 后
    const dir = provider.applyCompletion(['看 @my'], 0, 5, { value: '@my dir/', label: 'my dir/' }, '@my');
    expect(dir).toEqual({ lines: ['看 @my dir/'], cursorLine: 0, cursorCol: 10 });
    // 引号形目录（闭合形 token）：光标落闭引前（续输入继续落在引号内——
    // pi-tui 本地腿同形：cursorOffset = value.length - 1）
    const quoted = provider.applyCompletion(
      ['看 @"my dir/"'],
      0,
      12, // 光标在行尾（闭引后）——闭合形 token 整段代换
      { value: '@"my dir/sub/"', label: 'my dir/sub/' },
      '@"my dir/"',
    );
    expect(quoted).toEqual({ lines: ['看 @"my dir/sub/"'], cursorLine: 0, cursorCol: 15 }); // 闭引前一位
    // 引号形文件：光标落闭引后 + 尾空格（token 收弹）
    const file = provider.applyCompletion(
      ['看 @"my no'],
      0,
      9, // 行尾
      { value: '@"my notes.md"', label: 'my notes.md' },
      '@"my no',
    );
    expect(file).toEqual({ lines: ['看 @"my notes.md" '], cursorLine: 0, cursorCol: 17 });
  });
});

describe('TUI-9 face 拒绝收弹不崩 + signal 透传（两 wrap 各证）', () => {
  it('filesFor reject → null 不冒泡（编辑器 fire-and-forget——rejection 即 unhandledRejection 崩进程）', async () => {
    const { inner, calls } = recordingInner();
    const face: FilesFace = async () => {
      throw new Error('face 拒绝探针');
    };
    const provider = createFileSegmentProvider(inner, face);
    // 修前此调用产 rejected promise（fire-and-forget 语境 = unhandledRejection
    // → signals.ts exit(1)）；修后收弹 null
    await expect(provider.getSuggestions(['@src'], 0, 4, OPTS)).resolves.toBeNull();
    expect(calls).toEqual([]); // 拒绝不退委托（与 undefined 档同形：无弹层）
  });

  it('symbolsFor reject → null 不冒泡（同律）', async () => {
    const { inner, calls } = recordingInner();
    const face: SymbolsFace = async () => {
      throw new Error('face 拒绝探针');
    };
    const provider = createMentionProvider(inner, face);
    await expect(provider.getSuggestions(['@a.ts#f'], 0, 7, OPTS)).resolves.toBeNull();
    expect(calls).toEqual([]); // 拒绝不退委托
  });

  it('options.signal 透传 face（filesFor/symbolsFor 第二参——编辑器换代即中止在飞取数）', async () => {
    const { inner } = recordingInner();
    /** 收到的信号记录（两 wrap 各一腿） */
    const seen: Array<AbortSignal | undefined> = [];
    const filesFace: FilesFace = async (_prefix, signal) => {
      seen.push(signal);
      return { files: ['a.ts'] };
    };
    const symbolsFace: SymbolsFace = async (_path, signal) => {
      seen.push(signal);
      return { symbols: [] };
    };
    const fileProvider = createFileSegmentProvider(inner, filesFace);
    await fileProvider.getSuggestions(['@a'], 0, 2, OPTS);
    const symbolProvider = createMentionProvider(inner, symbolsFace);
    await symbolProvider.getSuggestions(['@a.ts#f'], 0, 7, OPTS);
    expect(seen).toEqual([OPTS.signal, OPTS.signal]); // 编辑器给的信号原样到 face
  });
});
