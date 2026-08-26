/**
 * L1 context 单元测试 — 文本解码决策树 + 码页探测器（骨架篇 §7.5/§7.6，
 * 2026-08-27 P1-3 挖矿 B11 缺口④）。
 *
 * 覆盖：BOM 三族（UTF-8 剥壳续走②/UTF-16LE/BE 权威直解）/ 严格 UTF-8 /
 * 本地码页严格命中（GBK fixture）/ 无标签落④有损 / 头部容忍（丢头续字节
 * 修剪）/ 逃生参数路（显式标签 strict 通过与失败）/ 不支持标签视同未命中 /
 * 非 win32 探测器恒空对。纯函数无 mock。
 */

import { describe, expect, it } from 'vitest';
import { decodeText, peekLocalCodepageLabels, resolveLocalCodepageLabels } from './encoding.js';

/** '测试' 的 GBK 字节序列（B2 E2 CA D4——四字节两汉字） */
const GBK_TEST = Uint8Array.from([0xb2, 0xe2, 0xca, 0xd4]);

describe('decodeText 决策树', () => {
  it('纯 ASCII/UTF-8 = 步②严格通过（method utf8）', () => {
    const r = decodeText(new TextEncoder().encode('hello 测试'));
    expect(r.text).toBe('hello 测试');
    expect(r.encoding).toBe('utf-8');
    expect(r.method).toBe('utf8');
  });

  it('UTF-8 BOM 只剥壳——正文续走②，终判 utf-8 不带 BOM', () => {
    const r = decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('x')]));
    expect(r.text).toBe('x');
    expect(r.encoding).toBe('utf-8');
    expect(r.method).toBe('utf8');
  });

  it('UTF-16LE BOM 权威直解（method bom）', () => {
    // 'A' = 0x0041 → LE 字节 41 00，前置 BOM FF FE
    const r = decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00]));
    expect(r.text).toBe('A');
    expect(r.encoding).toBe('utf-16le');
    expect(r.method).toBe('bom');
  });

  it('UTF-16BE BOM 权威直解', () => {
    // 'A' = 0x0041 → BE 字节 00 41，前置 BOM FE FF
    const r = decodeText(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]));
    expect(r.text).toBe('A');
    expect(r.encoding).toBe('utf-16be');
    expect(r.method).toBe('bom');
  });

  it('本地码页严格命中：GBK 字节 + localLabel gbk → 转码文本（method local）', () => {
    const r = decodeText(GBK_TEST, { localLabel: 'gbk' });
    expect(r.text).toBe('测试');
    expect(r.encoding).toBe('gbk');
    expect(r.method).toBe('local');
  });

  it('无标签的 GBK 字节落④有损（method lossy + utf-8-lossy 标注）', () => {
    const r = decodeText(GBK_TEST);
    expect(r.method).toBe('lossy');
    expect(r.encoding).toBe('utf-8-lossy');
    // 两轮制：首字节 B2 是 UTF-8 续字节区间 → 第二轮修剪后终态（诊断带修剪量）
    expect(r.diagnostics).toContain('头部修剪 1 续字节');
  });

  it('本地标签不支持（small-icu 形态）= ③视同未命中，④诚实回退 utf-8 有损', () => {
    const r = decodeText(GBK_TEST, { localLabel: 'definitely-not-an-encoding' });
    expect(r.method).toBe('lossy');
    expect(r.encoding).toBe('utf-8-lossy');
  });

  it('头部容忍：窗口首字节是 UTF-8 续字节（丢头劈开多字节）→ 修剪后正常解', () => {
    // '测' = E6 B5 8B；前置一个孤立续字节 0x8B 模拟丢头劈开
    const r = decodeText(Uint8Array.from([0x8b, ...new TextEncoder().encode('测ok')]));
    expect(r.text).toBe('测ok');
    expect(r.method).toBe('utf8');
    expect(r.diagnostics).toContain('头部修剪 1 续字节');
  });

  it('逃生参数路：显式标签 strict 通过（method local + 标签即终判）', () => {
    const r = decodeText(GBK_TEST, { explicitLabel: 'gbk' });
    expect(r.text).toBe('测试');
    expect(r.method).toBe('local');
    expect(r.encoding).toBe('gbk');
  });

  it('逃生参数路：显式标签 strict 失败落④有损（encoding 带后缀）', () => {
    // 字节不构成合法 shift_jis 序列（FF FF）→ strict 失败 → lossy
    const r = decodeText(Uint8Array.from([0xff, 0xff]), { explicitLabel: 'shift_jis' });
    expect(r.method).toBe('lossy');
    expect(r.encoding).toBe('shift_jis-lossy');
  });

  it('空输入 = 空 UTF-8（干净路）', () => {
    const r = decodeText(new Uint8Array(0));
    expect(r.text).toBe('');
    expect(r.method).toBe('utf8');
  });

  it('池化 Buffer（byteOffset≠0 的子视图）与 TextEncoder 产物同解（回归锁）', () => {
    // Buffer.concat 小产物从 8KB 池分配、byteOffset 非 0——曾因 subarray 坐标
    // 误用被截成空视图，返回空串+utf8 假成功（spawn 管道 stdout 全空的根因）
    const pooled = Buffer.concat([Buffer.from('hello\n')]);
    expect(pooled.byteOffset).not.toBe(0); // 前置：确证样本确为池化形态
    const r = decodeText(pooled);
    expect(r.text).toBe('hello\n');
    expect(r.method).toBe('utf8');
  });
});

describe('码页探测器（非 win32 恒空对）', () => {
  it('resolveLocalCodepageLabels 非 win32 = {null,null} 且缓存后 peek 同值', async () => {
    const labels = await resolveLocalCodepageLabels();
    expect(labels.oem).toBeNull();
    expect(labels.ansi).toBeNull();
    // 进程内缓存后同步窥探与异步解析同源
    expect(peekLocalCodepageLabels()).toEqual(labels);
  });
});
