/**
 * L3 mcp 单元测试 — 行帧 JSON-RPC 桥（纯协议层，零子进程）。
 *
 * 覆盖面：id 关联表结算（响应/超时/关闭三路）、行分发四腿（响应/服务器
 * 请求自动 -32601/通知忽略/非 JSON 杂音）、服务器错误不升 AppError（身份
 * 归调用方——契约篇 §6.6）、双结算闸（超时后响应不误清不二次结算）。
 */

import { describe, expect, it } from 'vitest';
import { AppError, MCP_CONNECT_FAILED, TOOL_TIMEOUT } from '../contracts/errors.js';
import { JsonRpcConnection } from './jsonrpc.js';

/** 收集 writeLine 输出的假写面（桥视角的「子进程 stdin」） */
function makeWriteCapture() {
  const lines: string[] = [];
  return { lines, writeLine: (line: string) => lines.push(line) };
}

/** 解析最近一条写出帧（断言便利） */
function lastFrame(lines: readonly string[]): Record<string, unknown> {
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe('JsonRpcConnection — 请求/响应结算', () => {
  it('request 发帧带 id/method/params；feed 响应行结算 resolve', async () => {
    const io = makeWriteCapture();
    const conn = new JsonRpcConnection({ writeLine: io.writeLine });
    const pending = conn.request('initialize', { a: 1 });
    // 帧形态：jsonrpc 2.0 + 数字 id + method；params 有值才发
    const frame = lastFrame(io.lines);
    expect(frame['jsonrpc']).toBe('2.0');
    expect(frame['method']).toBe('initialize');
    expect(frame['params']).toEqual({ a: 1 });
    const id = frame['id'] as number;
    conn.feed(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('params 为 undefined 不发 params 字段（tools/list 首页无参形态）', () => {
    const io = makeWriteCapture();
    const conn = new JsonRpcConnection({ writeLine: io.writeLine });
    void conn.request('tools/list').catch(() => undefined);
    expect(lastFrame(io.lines)).not.toHaveProperty('params');
  });

  it('超时按调用方给的码拒绝：connect 期 MCP_CONNECT_FAILED / 调用期 TOOL_TIMEOUT', async () => {
    const conn = new JsonRpcConnection({ writeLine: () => undefined });
    const p1 = conn.request('initialize', undefined, { timeoutMs: 5, timeoutCode: MCP_CONNECT_FAILED });
    await expect(p1).rejects.toMatchObject({ code: MCP_CONNECT_FAILED });
    const p2 = conn.request('tools/call', { name: 'x' }, { timeoutMs: 5, timeoutCode: TOOL_TIMEOUT });
    await expect(p2).rejects.toMatchObject({ code: TOOL_TIMEOUT });
  });

  it('服务器错误响应以普通 Error 上抛（数据不升 AppError——身份归调用方）', async () => {
    const io = makeWriteCapture();
    const conn = new JsonRpcConnection({ writeLine: io.writeLine });
    const pending = conn.request('tools/call', { name: 'x' });
    const id = lastFrame(io.lines)['id'] as number;
    conn.feed(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: '工具内部炸了' } }));
    await expect(pending).rejects.toSatisfy((err: unknown) => {
      // 关键断言：非 AppError（桥不赋予身份）+ 消息含服务器码与原文
      return err instanceof Error && !(err instanceof AppError) && String(err.message).includes('-32000');
    });
  });

  it('双结算闸：超时先结算后响应迟到不二次结算不误清', async () => {
    const io = makeWriteCapture();
    const conn = new JsonRpcConnection({ writeLine: io.writeLine });
    const pending = conn.request('tools/call', { name: 'x' }, { timeoutMs: 5, timeoutCode: TOOL_TIMEOUT });
    const id = lastFrame(io.lines)['id'] as number;
    await expect(pending).rejects.toMatchObject({ code: TOOL_TIMEOUT });
    // 响应迟到——应被静默丢弃（未知 id 腿），不抛未处理拒绝
    conn.feed(JSON.stringify({ jsonrpc: '2.0', id, result: {} }));
    // 后续请求不受污染
    const next = conn.request('ping');
    conn.feed(JSON.stringify({ jsonrpc: '2.0', id: lastFrame(io.lines)['id'] as number, result: {} }));
    await expect(next).resolves.toEqual({});
  });
});

describe('JsonRpcConnection — 行分发四腿', () => {
  it('服务器→客户端请求：自动回 -32601 MethodNotFound（第一刀拒答扩展 capability）', () => {
    const io = makeWriteCapture();
    const conn = new JsonRpcConnection({ writeLine: io.writeLine });
    conn.feed(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'sampling/createMessage', params: {} }));
    const reply = lastFrame(io.lines);
    expect(reply['id']).toBe(99);
    expect(reply['error']).toMatchObject({ code: -32601 });
  });

  it('服务器通知：忽略 + 杂音出口（tools/list_changed 不热刷）', () => {
    const noises: string[] = [];
    const conn = new JsonRpcConnection({ writeLine: () => undefined, onNoise: (m) => noises.push(m) });
    conn.feed(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
    expect(noises.join('\n')).toContain('tools/list_changed');
  });

  it('非 JSON 行：丢弃 + 杂音出口（stdout 被服务器 banner 污染场景）', () => {
    const noises: string[] = [];
    const conn = new JsonRpcConnection({ writeLine: () => undefined, onNoise: (m) => noises.push(m) });
    conn.feed('=== welcome to my server ===');
    expect(noises.join('\n')).toContain('非 JSON');
  });

  it('未知 id 响应：杂音丢弃不抛', () => {
    const noises: string[] = [];
    const conn = new JsonRpcConnection({ writeLine: () => undefined, onNoise: (m) => noises.push(m) });
    conn.feed(JSON.stringify({ jsonrpc: '2.0', id: 424242, result: {} }));
    expect(noises.join('\n')).toContain('未知 id');
  });

  it('空行忽略（行帧间残留）', () => {
    const noises: string[] = [];
    const conn = new JsonRpcConnection({ writeLine: () => undefined, onNoise: (m) => noises.push(m) });
    conn.feed('   ');
    expect(noises).toEqual([]);
  });
});

describe('JsonRpcConnection — close 语义', () => {
  it('close 结清全部 pending（MCP_CONNECT_FAILED）并封桥：新请求拒绝', async () => {
    const conn = new JsonRpcConnection({ writeLine: () => undefined });
    const p1 = conn.request('tools/call', { name: 'a' }, { timeoutCode: TOOL_TIMEOUT });
    const p2 = conn.request('tools/call', { name: 'b' }, { timeoutCode: TOOL_TIMEOUT });
    conn.close('服务器子进程退出');
    await expect(p1).rejects.toMatchObject({ code: MCP_CONNECT_FAILED });
    await expect(p2).rejects.toMatchObject({ code: MCP_CONNECT_FAILED });
    await expect(conn.request('ping')).rejects.toMatchObject({ code: MCP_CONNECT_FAILED });
    expect(conn.isClosed).toBe(true);
  });

  it('notify：close 后静默不发；在世时发无 id 帧', () => {
    const io = makeWriteCapture();
    const conn = new JsonRpcConnection({ writeLine: io.writeLine });
    conn.notify('notifications/initialized');
    const frame = lastFrame(io.lines);
    expect(frame['method']).toBe('notifications/initialized');
    expect(frame).not.toHaveProperty('id');
    conn.close('done');
    conn.notify('notifications/cancelled');
    expect(io.lines).toHaveLength(1);
  });
});
