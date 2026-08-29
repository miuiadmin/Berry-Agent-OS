/**
 * L3 lsp 单元测试 — Content-Length 头帧编解码（纯函数层）。
 *
 * 覆盖：帧往返、字节计（UTF-8 多字节——Content-Length 按字节非字符数）、
 * 流式分块（任意 chunk 边界——含逐字节喂入的极端分帧）、一次 chunk 多帧、
 * 坏帧（头缺 Content-Length）抛错。
 */

import { describe, expect, it } from 'vitest';
import { createFrameDecoder, encodeFrame } from './framing.js';

describe('lsp framing — encodeFrame', () => {
  it('帧形态：Content-Length 头 + \\r\\n\\r\\n 分隔 + 正文', () => {
    const frame = encodeFrame('{"a":1}');
    expect(frame).toBe(`Content-Length: 7\r\n\r\n{"a":1}`);
  });

  it('字节计按 UTF-8（中文三字节/字符）——Content-Length 非字符数', () => {
    const json = '{"msg":"中文"}';
    // 转义后正文按 UTF-8 字节计（Buffer.byteLength 与头声明一致）
    const frame = encodeFrame(json);
    const match = /^Content-Length: (\d+)\r\n\r\n([\s\S]*)$/.exec(frame);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(Buffer.byteLength(json, 'utf8'));
    expect(match![2]).toBe(json);
  });
});

describe('lsp framing — createFrameDecoder', () => {
  it('整帧一次喂入即解出', () => {
    const got: string[] = [];
    const feed = createFrameDecoder((json) => got.push(json));
    feed(encodeFrame('{"x":1}'));
    expect(got).toEqual(['{"x":1}']);
  });

  it('一次 chunk 多帧（服务器批量推送形态）', () => {
    const got: string[] = [];
    const feed = createFrameDecoder((json) => got.push(json));
    feed(`${encodeFrame('{"a":1}')}${encodeFrame('{"b":2}')}${encodeFrame('{"c":3}')}`);
    expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('跨 chunk 分帧：头与正文各断在任意字节边界仍完整解出', () => {
    const got: string[] = [];
    const feed = createFrameDecoder((json) => got.push(json));
    const frame = encodeFrame('{"msg":"中文多字节正文"}');
    // 逐字节喂入（最极端分帧——多字节字符必被 chunk 腰斩，帧边界上才解码）
    for (const byte of Buffer.from(frame, 'utf8')) {
      feed(Buffer.from([byte]));
    }
    expect(got).toEqual(['{"msg":"中文多字节正文"}']);
  });

  it('两帧跨 chunk 交叠：第一帧尾与第二帧头在同一 chunk', () => {
    const got: string[] = [];
    const feed = createFrameDecoder((json) => got.push(json));
    const f1 = encodeFrame('{"one":1}');
    const f2 = encodeFrame('{"two":2}');
    const both = f1 + f2;
    // 从中间任意点切两半喂入（交叠边界）
    const cut = Math.floor(both.length / 2);
    feed(both.slice(0, cut));
    feed(both.slice(cut));
    expect(got).toEqual(['{"one":1}', '{"two":2}']);
  });

  it('未满帧攒缓冲不解出（继续喂才触发）', () => {
    const got: string[] = [];
    const feed = createFrameDecoder((json) => got.push(json));
    const frame = encodeFrame('{"hello":"world"}');
    feed(frame.slice(0, frame.length - 5)); // 差 5 字节
    expect(got).toEqual([]);
    feed(frame.slice(frame.length - 5));
    expect(got).toEqual(['{"hello":"world"}']);
  });

  it('坏帧（头缺 Content-Length）抛错——连接不可信交调用方归因', () => {
    const feed = createFrameDecoder(() => undefined);
    expect(() => feed('Content-Type: text\r\n\r\n{}')).toThrow(/Content-Length/);
  });

  it('Buffer 与 string 两形态 chunk 同解', () => {
    const got: string[] = [];
    const feed = createFrameDecoder((json) => got.push(json));
    const frame = encodeFrame('{"k":"v"}');
    feed(Buffer.from(frame, 'utf8'));
    expect(got).toEqual(['{"k":"v"}']);
  });
});
