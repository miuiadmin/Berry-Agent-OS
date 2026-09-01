/**
 * L5 app — crash-log（崩溃证据落盘）单元测试。
 *
 * 覆盖面（基建大扫 20260901 第五十七批 #52 回归锁）：
 * - 致命路径同步追写一行 JSON 至 <数据目录>/crash.log（kind/entry/pid/version/error）；
 * - 追写语义（多次追加成多行——每次崩溃一条，append-only 不整替）；
 * - best-effort：落盘失败（目录不可建/不可写）吞错不二炸——崩溃路径不容二次异常。
 */

import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendCrashRecord } from './crash-log.js';
import { VERSION } from './version.js';

describe('appendCrashRecord：崩溃证据落盘（基建大扫 #52）', () => {
  it('追写一行 JSON（kind/entry/pid/version/error 齐备）+ 多次追加成多行', () => {
    const root = mkdtempSync(join(tmpdir(), 'crash-log-'));
    const boom = new Error('炸了');
    appendCrashRecord({ kind: 'uncaughtException', entry: 'tui', error: boom }, root);
    // 追加语义：第二次崩溃另起一行（append-only——boot-failures.json 整替写是 boot 面，崩溃面按次累积）
    appendCrashRecord({ kind: 'unhandledRejection', entry: 'daemon', error: '字符串形态异常' }, root);
    const lines = readFileSync(join(root, 'crash.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first['kind']).toBe('uncaughtException');
    expect(first['entry']).toBe('tui');
    expect(first['pid']).toBe(process.pid);
    expect(first['version']).toBe(VERSION);
    const err = first['error'] as Record<string, unknown>;
    expect(err['message']).toBe('炸了');
    expect(String(err['stack'])).toContain('Error: 炸了');
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second['kind']).toBe('unhandledRejection');
    expect((second['error'] as Record<string, unknown>)['message']).toBe('字符串形态异常'); // 非 Error 形态入 message 字段
    rmSync(root, { recursive: true, force: true });
  });

  it('数据目录缺席先建档（首崩溃早于任何初始化的形态）', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'crash-log-')), 'not-yet'); // 不存在的子目录
    appendCrashRecord({ kind: 'uncaughtException', entry: 'run', error: new Error('早崩') }, root);
    expect(readFileSync(join(root, 'crash.log'), 'utf8')).toContain('早崩');
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('best-effort 吞错不二炸：路径被同名文件占死（mkdir 必败）——静默放弃不抛', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'crash-log-')), 'blocked');
    writeFileSync(root, '我是个文件不是目录'); // mkdir recursive 撞文件名 → ENOTDIR
    expect(() =>
      appendCrashRecord({ kind: 'uncaughtException', entry: 'attach', error: new Error('x') }, root),
    ).not.toThrow();
    rmSync(join(root, '..'), { recursive: true, force: true });
  });
});
