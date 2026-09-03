/**
 * MentionInput 测试（遗漏大扫 20260902 #10——@-mention 两段补全在新 jsdom+RTL
 * 轨的零覆盖补面；fd 接线小刀公开面宣称的 SPA 呈现行为回归锁）。
 *
 * mock 边界（纪律：mock 只停 IO 腿）：`./api` 只桩 fetchFiles/fetchSymbols 两件
 * （本组件仅消费这两件——app.test.tsx 才是全件面 + 面同步执法位）；React 全真。
 * 防抖（DEBOUNCE_MS = 150ms）用假钟推进——advanceTimersByTimeAsync 连
 * microtasks 一并 flush，取数 promise 链收束后再断言（RTL waitFor 与假钟不睦，
 * 本文件不用 waitFor）。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MentionInput } from './mention-input';
import type { SymbolQuery } from './types';

/* ---------------- mock 边界 ---------------- */

/** ./api 本件消费面（只有两件——MentionInput 的 import 面） */
const api = vi.hoisted(() => ({
  fetchFiles: vi.fn(),
  fetchSymbols: vi.fn(),
}));

vi.mock('./api', () => ({ fetchFiles: api.fetchFiles, fetchSymbols: api.fetchSymbols }));

/* ---------------- 夹具 ---------------- */

/**
 * 受控 harness（MentionInput 是受控 value + onChange 上抛——不持状态会被 React
 * 拉回空串；harness 持 state，断言读 DOM input.value 即代换结果，行为级不刺内部）
 */
function Harness(): React.ReactElement {
  const [value, setValue] = useState('');
  return <MentionInput value={value} onChange={setValue} onSubmit={vi.fn()} disabled={false} placeholder="输入消息" />;
}

/** 符号应答素材（SymbolQuery 形状——symbols + 行号） */
function symbolsOf(names: Array<[name: string, line: number]>): SymbolQuery {
  return { symbols: names.map(([name, line]) => ({ name, line })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  api.fetchFiles.mockResolvedValue([]);
  api.fetchSymbols.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 键入并过防抖（change 设值后 jsdom 光标在末尾——caretRef 镜像正确；async 推进连取数 promise 链一起收） */
async function typePastDebounce(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
    await vi.advanceTimersByTimeAsync(150);
  });
}

describe('MentionInput 第一段：@ 文件补全', () => {
  it("键入 '@s' → fetchFiles('s') 取数 + 候选渲染（弹层开 + 计数头）", async () => {
    api.fetchFiles.mockResolvedValue(['src/app.ts', 'README.md']);
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@s');
    expect(api.fetchFiles).toHaveBeenCalledWith('s');
    expect(api.fetchFiles).toHaveBeenCalledTimes(1); // 防抖收敛：一次 change 一次取数
    expect(screen.getByText('工作区文件（2）')).toBeTruthy(); // 弹层计数头
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  it("无 '@' 前缀不触发（'新消息' 零取数——弹层不开）", async () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '新消息');
    expect(api.fetchFiles).not.toHaveBeenCalled();
    expect(api.fetchSymbols).not.toHaveBeenCalled();
    expect(screen.queryByText(/工作区文件/)).toBeNull();
  });

  it('点击候选：代换 token + 尾空格 + 收弹（受控值即断言面）', async () => {
    api.fetchFiles.mockResolvedValue(['src/app.ts']);
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@s');
    await act(async () => {
      fireEvent.mouseDown(screen.getByText('src/app.ts')); // mousedown（组件 preventDefault 不夺焦点）
    });
    expect(input.value).toBe('@src/app.ts '); // 代换 '@src/app.ts' + 尾空格断 token
    expect(screen.queryByText(/工作区文件/)).toBeNull(); // 代换即收弹
  });
});

describe('MentionInput 第二段：@path# 符号补全', () => {
  it("键入 '@src/app.ts#' → fetchSymbols('src/app.ts') 取数 + 符号候选（名 + 行号）+ Enter 接受代换", async () => {
    api.fetchSymbols.mockResolvedValue(
      symbolsOf([
        ['MentionInput', 68],
        ['parseMention', 36],
      ]),
    );
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@src/app.ts#');
    expect(api.fetchSymbols).toHaveBeenCalledWith('src/app.ts');
    expect(api.fetchFiles).not.toHaveBeenCalled(); // 档别正确（符号段不走文件腿）
    expect(screen.getByText('MentionInput')).toBeTruthy();
    expect(screen.getByText(':68')).toBeTruthy(); // 行号徽标
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' }); // 弹层开时 Enter 接受候选（不冒泡成提交）
    });
    expect(input.value).toBe('@src/app.ts#MentionInput ');
    expect(screen.queryByText(/的符号/)).toBeNull(); // 代换即收弹（caretRef 同步先行——修前旧光标位重开弹层）
  });

  it('404 降级（null 应答）：诚实提示行非空列表', async () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@gone.ts#');
    expect(screen.getByText('无符号（文件不在盘或语言不支持）')).toBeTruthy();
    expect(screen.queryByText(/:6/)).toBeNull(); // 无行号徽标（零符号列表）
  });

  it('符号段前缀过滤（A13——与 TUI 侧 channels/mention.ts 同形 name.startsWith）：@a.ts#be 只列 betaB', async () => {
    // 取数键只锚 pathPrefix（symbolPrefix 续打不换键不重取）——客户端按符号前缀
    // 过滤候选。修前红位：全量罗列不过滤，alphaA 同屏喧宾夺主
    api.fetchSymbols.mockResolvedValue(
      symbolsOf([
        ['alphaA', 10],
        ['betaB', 20],
      ]),
    );
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@a.ts#be');
    expect(api.fetchSymbols).toHaveBeenCalledWith('a.ts'); // 键仍只锚 pathPrefix（不重取）
    expect(screen.getByText('betaB')).toBeTruthy();
    expect(screen.queryByText('alphaA')).toBeNull(); // 修前红：不过滤同屏在场
  });

  it('符号段前缀过滤后零命中：诚实「无匹配符号」行（A13）', async () => {
    api.fetchSymbols.mockResolvedValue(symbolsOf([['alphaA', 10]]));
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@a.ts#zz');
    expect(screen.getByText('无匹配符号')).toBeTruthy(); // 修前红：该行不存在（全量罗列）
    expect(screen.queryByText('alphaA')).toBeNull();
  });
});

describe('MentionInput 候选来源键（全面复盘 20260903 #13——陈旧候选双竞速守门）', () => {
  it('符号档换代竞速：@a.ts#x 取数落定后改打 @b.ts#y，防抖窗内 Enter 不接受陈旧符号（修前必红）', async () => {
    api.fetchSymbols.mockResolvedValue(symbolsOf([['alphaA', 10]]));
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@a.ts#x'); // a.ts 取数落定（symbols=[alphaA]）
    // 换代：只过 change 触发重解析（弹层按新查询开）+ microtask flush（effect 落定）
    // ——不过防抖，Enter 在新查询的取数落定前按下
    await act(async () => {
      fireEvent.change(input, { target: { value: '@b.ts#y' } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    // 修前红：files/symbols state 未随查询重置——symbols[0]=alphaA 被当作 b.ts 的
    // 候选接受，value 变 '@b.ts#alphaA '（陈旧候选劫持换代后的接受键）
    expect(input.value).toBe('@b.ts#y'); // 键门挡下 → Enter 落回原文提交路径
  });

  it('文件档换代竞速：@sr 取数落定后改打 @pkg，防抖窗内 Enter 不接受陈旧文件（修前必红）', async () => {
    api.fetchFiles.mockResolvedValue(['src/app.ts']);
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@sr'); // sr 取数落定（files=['src/app.ts']）
    await act(async () => {
      fireEvent.change(input, { target: { value: '@pkg' } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(input.value).toBe('@pkg'); // 修前红：'@src/app.ts '（陈旧文件候选劫持）
  });

  it('弹层渲染门：@a.ts#x 落定后改打 @b.ts#，防抖窗内列表不渲染陈旧符号（修前必红）', async () => {
    api.fetchSymbols.mockResolvedValue(symbolsOf([['alphaA', 10]]));
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@a.ts#x');
    await act(async () => {
      fireEvent.change(input, { target: { value: '@b.ts#' } });
      await vi.advanceTimersByTimeAsync(0); // effect + 重渲染落定（防抖计时器未到）
    });
    expect(screen.getByText('b.ts 的符号…')).toBeTruthy(); // 新档头如实（loading 期）
    expect(screen.queryByText('alphaA')).toBeNull(); // 修前红：陈旧符号仍在列表
  });
});

describe('MentionInput 候选形对齐（TUI-7，20260904——与 TUI 侧 channels/mention.ts 同笔同形）', () => {
  it('目录候选（携尾 /）：接受不补尾空格 + 值即 token 续走钻取（修前必红——尾空格断 token）', async () => {
    api.fetchFiles.mockResolvedValue(['src/']); // 服务端目录条目携尾 /（webui/files.ts 同批）
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@sr'); // 前缀 'sr' → 服务端返回 src/（前缀命中）
    expect(api.fetchFiles).toHaveBeenCalledWith('sr');
    await act(async () => {
      fireEvent.mouseDown(screen.getByText('src/')); // mousedown（不夺焦点）
    });
    expect(input.value).toBe('@src/'); // 修前红：'@src/ '（尾空格击穿 token——目录无法续钻）
    // 续钻：代换值即新 token（光标落末尾），重解析命中 → 防抖后再取数
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(api.fetchFiles).toHaveBeenLastCalledWith('src/'); // 目录内层继续补全
  });

  it('含空格路径：接受采 @"…" 引号形 + 尾空格（修前必红——裸形 `@my notes.md ` 尾空格击穿 token 判据）', async () => {
    api.fetchFiles.mockResolvedValue(['my notes.md']); // 服务端全路径前缀命中（'my'）
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '@my'); // 裸形 token 只能到 '@my'（空格断判据）
    await act(async () => {
      fireEvent.mouseDown(screen.getByText('my notes.md'));
    });
    expect(input.value).toBe('@"my notes.md" '); // 引号形 + 尾空格（token 收弹）
  });

  it('引号 token 续钻：键入 @"my dir/s 剥引号取数（修前必红——判据不识别引号形）', async () => {
    api.fetchFiles.mockResolvedValue([]);
    render(<Harness />);
    const input = screen.getByPlaceholderText('输入消息') as HTMLInputElement;
    await typePastDebounce(input, '看 @"my dir/s'); // 未闭合引号形（闭引在光标后场景同形）
    expect(api.fetchFiles).toHaveBeenCalledWith('my dir/s'); // 引号剥净进取数
  });
});
