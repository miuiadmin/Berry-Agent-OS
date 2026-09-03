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

  it('攒头态帽 16KiB：分隔符永不到的字节洪流在帽处抛错（遗漏大扫 20260903 runtime D4-1 修死）', () => {
    // 修前：buffer 无上界 concat——故障/恶意服务器持续写无分隔符字节流，
    // 宿主堆无界吸收。修后：16KiB 帽拦死（契约篇 §6.7 帧资源卫生双帽）
    const feed = createFrameDecoder(() => undefined);
    expect(() => feed('x'.repeat(16 * 1024 + 1))).toThrow(/帧头攒积超/);
  });

  it('攒头态帽 16KiB：分段喂入同样拦（跨 chunk 累计攒头）', () => {
    const feed = createFrameDecoder(() => undefined);
    // 每段 4KiB × 5 段 = 20KiB > 16KiB——第 5 段抛（前 4 段各在帽下不抛）
    for (let i = 0; i < 4; i += 1) {
      expect(() => feed('y'.repeat(4 * 1024))).not.toThrow();
    }
    expect(() => feed('y'.repeat(4 * 1024))).toThrow(/帧头攒积超/);
  });

  it('攒正文态帽 16MiB：Content-Length 声明超帽在头解析点即抛（不待正文攒到）', () => {
    // 修前：声明值直接进 pendingBodyBytes——超大声明预先授权无界吸收。
    // 修后：头解析点即拦，一字节正文未到也抛
    const feed = createFrameDecoder(() => undefined);
    expect(() => feed(`Content-Length: ${16 * 1024 * 1024 + 1}\r\n\r\n`)).toThrow(/Content-Length .* 超上限/);
  });

  it('恰达帽不抛：攒头恰 16KiB 不封、声明恰 16MiB 放行（严格大于才执法）', () => {
    // 恰 16KiB 攒头（未到分隔符）——不抛；随后补正常帧头解出（攒头内容作
    // 头行无 Content-Length 会抛缺键错——与帽无关，故此用例只验帽位不先抛）
    const feed = createFrameDecoder(() => undefined);
    expect(() => feed('z'.repeat(16 * 1024))).not.toThrow();
    // 声明恰 16MiB + 正文差一字节——不抛（未满正文安静攒）
    const feed2 = createFrameDecoder(() => undefined);
    expect(() => feed2(`Content-Length: ${16 * 1024 * 1024}\r\n\r\n` + 'a'.repeat(1024))).not.toThrow();
  });

  it('Buffer 与 string 两形态 chunk 同解', () => {
    const got: string[] = [];
    const feed = createFrameDecoder((json) => got.push(json));
    const frame = encodeFrame('{"k":"v"}');
    feed(Buffer.from(frame, 'utf8'));
    expect(got).toEqual(['{"k":"v"}']);
  });
});
