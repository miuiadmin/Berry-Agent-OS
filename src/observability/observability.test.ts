import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import Database from 'better-sqlite3';
import { redact, redactString, isLikelySecret } from './redaction.js';
import { safeStringify } from './capture.js';
import { RunContext } from './artifacts.js';
import { ConsoleRenderer } from './console.js';
import { Counter, Histogram } from './metrics.js';
import { setAppHome } from '../utils/paths.js';
import { CORE_SCHEMA_SQL, CORE_INDEX_SQL } from '../memory/schema.js';

describe('redaction', () => {
  it('隐藏敏感 key 的值', () => {
    const result = redact({ api_key: 'secret123', name: 'alice' }) as Record<string, unknown>;
    expect(result.api_key).toBe('[REDACTED]');
    expect(result.name).toBe('alice');
  });

  it('隐藏 URL 参数中的 token', () => {
    const result = redact('https://api.example.com?token=abc123&name=test');
    expect(result).toBe('https://api.example.com?token=[REDACTED]&name=test');
  });

  it('隐藏 Bearer token', () => {
    const result = redactString('Authorization: Bearer sk-abc123xyz');
    expect(result).toContain('Bearer [REDACTED]');
    expect(result).not.toContain('sk-abc123xyz');
  });

  it('隐藏 sk- 前缀的字符串值', () => {
    const result = redact('sk-proj-abc123');
    expect(result).toBe('[REDACTED]');
  });

  it('隐藏 ghp_ 前缀的 GitHub token', () => {
    const result = redact('ghp_xxxxxxxxxxxx');
    expect(result).toBe('[REDACTED]');
  });

  it('isLikelySecret 检测敏感 key', () => {
    expect(isLikelySecret('api_key')).toBe(true);
    expect(isLikelySecret('Authorization')).toBe(true);
    expect(isLikelySecret('name')).toBe(false);
    expect(isLikelySecret('user_password')).toBe(true);
  });

  it('递归处理嵌套对象', () => {
    const result = redact({
      config: { api_key: 'x', url: 'https://a.com?key=secret' },
      items: [{ token: 'y' }],
    }) as Record<string, unknown>;
    expect((result.config as Record<string, unknown>).api_key).toBe('[REDACTED]');
    expect((result.config as Record<string, unknown>).url).toBe('https://a.com?key=[REDACTED]');
    expect(((result.items as unknown[])[0] as Record<string, unknown>).token).toBe('[REDACTED]');
  });
});

describe('safeStringify', () => {
  it('正常 JSON 序列化', () => {
    const result = safeStringify({ msg: 'hello', count: 42 });
    expect(JSON.parse(result)).toEqual({ msg: 'hello', count: 42 });
  });

  it('转义 U+2028 LINE SEPARATOR', () => {
    const input = { text: 'before after' };
    const result = safeStringify(input);
    expect(result).not.toContain(' ');
    expect(result).toContain('\\u2028');
    expect(result.split('\n')).toHaveLength(1);
  });

  it('转义 U+2029 PARAGRAPH SEPARATOR', () => {
    const input = { text: 'before after' };
    const result = safeStringify(input);
    expect(result).not.toContain(' ');
    expect(result).toContain('\\u2029');
  });

  it('同时脱敏敏感数据', () => {
    const input = { api_key: 'secret', data: 'ok' };
    const result = safeStringify(input);
    const parsed = JSON.parse(result);
    expect(parsed.api_key).toBe('[REDACTED]');
    expect(parsed.data).toBe('ok');
  });
});

describe('ConsoleRenderer', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let origStdoutWrite: typeof process.stdout.write;
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    origStdoutWrite = process.stdout.write;
    origStderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string) => { stdoutChunks.push(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { stderrChunks.push(chunk); return true; }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  });

  it('human 模式: info 输出到 stdout', () => {
    const renderer = new ConsoleRenderer({ mode: 'human' });
    renderer.info('你好');
    expect(stdoutChunks.join('')).toContain('你好');
    expect(stderrChunks.join('')).toBe('');
  });

  it('human 模式: error 输出到 stderr', () => {
    const renderer = new ConsoleRenderer({ mode: 'human' });
    renderer.error('出错了');
    expect(stderrChunks.join('')).toContain('出错了');
    expect(stdoutChunks.join('')).toBe('');
  });

  it('json 模式: info 重定向到 stderr', () => {
    const renderer = new ConsoleRenderer({ mode: 'json' });
    renderer.info('调试信息');
    expect(stderrChunks.join('')).toContain('调试信息');
    expect(stdoutChunks.join('')).toBe('');
  });

  it('json 模式: json() 输出到 stdout', () => {
    const renderer = new ConsoleRenderer({ mode: 'json' });
    renderer.json({ status: 'ok' });
    const output = stdoutChunks.join('');
    expect(JSON.parse(output.trim())).toEqual({ status: 'ok' });
  });

  it('json() 自动脱敏', () => {
    const renderer = new ConsoleRenderer({ mode: 'json' });
    renderer.json({ api_key: 'secret', name: 'test' });
    const parsed = JSON.parse(stdoutChunks.join('').trim());
    expect(parsed.api_key).toBe('[REDACTED]');
    expect(parsed.name).toBe('test');
  });
});

describe('RunContext', () => {
  let tmpDir: string;
  let savedHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'obs-test-'));
    savedHome = process.env.SERVICE_HOME ?? '';
    process.env.SERVICE_HOME = tmpDir;
    setAppHome(tmpDir);
  });

  afterEach(() => {
    if (savedHome) process.env.SERVICE_HOME = savedHome;
    else delete process.env.SERVICE_HOME;
    setAppHome(savedHome || join(homedir(), '.berry'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('创建 artifact 目录和文件', async () => {
    const run = new RunContext('test-cmd');
    expect(existsSync(run.artifactDir)).toBe(true);
    expect(existsSync(join(run.artifactDir, 'berry.log.jsonl'))).toBe(true);
    expect(existsSync(join(run.artifactDir, 'console.jsonl'))).toBe(true);
    await run.close(0);
  });

  it('log 写入 JSONL', async () => {
    const run = new RunContext('test-cmd');
    run.log('info', 'test', '消息内容', { key: 'value' });
    await run.close(0);
    const content = readFileSync(join(run.artifactDir, 'berry.log.jsonl'), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]);
    expect(event.msg).toBe('消息内容');
    expect(event.module).toBe('test');
    expect(event.level).toBe('info');
  });

  it('writeConsole 写入 console.jsonl + raw 文件', async () => {
    const run = new RunContext('test-cmd');
    run.writeConsole('stdout', 'hello stdout');
    run.writeConsole('stderr', 'hello stderr');
    await run.close(0);

    const stdout = readFileSync(join(run.artifactDir, 'stdout.log'), 'utf-8');
    const stderr = readFileSync(join(run.artifactDir, 'stderr.log'), 'utf-8');
    expect(stdout).toBe('hello stdout');
    expect(stderr).toBe('hello stderr');

    const consoleLog = readFileSync(join(run.artifactDir, 'console.jsonl'), 'utf-8');
    const frames = consoleLog.trim().split('\n').map(l => JSON.parse(l));
    expect(frames).toHaveLength(2);
    expect(frames[0].stream).toBe('stdout');
    expect(frames[1].stream).toBe('stderr');
  });

  it('close 生成 result.json', async () => {
    const run = new RunContext('test-cmd');
    const artifact = await run.close(0);
    expect(artifact.status).toBe('passed');
    expect(artifact.command).toBe('test-cmd');

    const resultJson = JSON.parse(readFileSync(join(run.artifactDir, 'result.json'), 'utf-8'));
    expect(resultJson.runId).toBe(run.runId);
    expect(resultJson.status).toBe('passed');
  });

  it('exitCode 非零时 status 为 failed', async () => {
    const run = new RunContext('test-cmd');
    const artifact = await run.close(1);
    expect(artifact.status).toBe('failed');
  });

  it('DB 持久化: run_artifacts 写入', async () => {
    const db = new Database(':memory:');
    db.exec(CORE_SCHEMA_SQL);
    db.exec(CORE_INDEX_SQL);

    const run = new RunContext('test-cmd', { db });
    run.log('info', 'test', 'hello');
    run.writeConsole('stdout', 'output');
    await run.close(0);

    const rows = db.prepare('SELECT * FROM run_artifacts').all() as Array<{ id: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(run.runId);
    expect(rows[0].status).toBe('passed');

    const logRows = db.prepare('SELECT * FROM log_events').all() as Array<{ message: string }>;
    expect(logRows).toHaveLength(1);
    expect(logRows[0].message).toBe('hello');

    const frames = db.prepare('SELECT * FROM console_frames').all() as Array<{ text: string; seq: number }>;
    expect(frames).toHaveLength(1);
    expect(frames[0].text).toBe('output');
    expect(frames[0].seq).toBe(0);

    db.close();
  });

  it('handleLargeOutput: 小内容直接返回', async () => {
    const run = new RunContext('test-cmd');
    const result = await run.handleLargeOutput('test', 'small content', 1024);
    expect(result.stored).toBe(false);
    expect(result.content).toBe('small content');
    await run.close(0);
  });

  it('handleLargeOutput: 大内容落盘', async () => {
    const run = new RunContext('test-cmd');
    const bigContent = 'x'.repeat(100 * 1024);
    const result = await run.handleLargeOutput('big-output', bigContent, 64 * 1024);
    expect(result.stored).toBe(true);
    expect(result.path).toBeDefined();
    expect(result.hash).toBeDefined();
    expect(result.size).toBe(Buffer.byteLength(bigContent));
    expect(result.preview).toBe('x'.repeat(500));
    expect(existsSync(result.path!)).toBe(true);
    await run.close(0);
  });
});

describe('Counter', () => {
  it('从零开始递增', () => {
    const c = new Counter('test_counter');
    expect(c.get()).toBe(0);
    c.inc();
    expect(c.get()).toBe(1);
    c.inc({}, 5);
    expect(c.get()).toBe(6);
  });

  it('按标签独立计数', () => {
    const c = new Counter('http_requests');
    c.inc({ method: 'GET' });
    c.inc({ method: 'POST' }, 3);
    c.inc({ method: 'GET' });
    expect(c.get({ method: 'GET' })).toBe(2);
    expect(c.get({ method: 'POST' })).toBe(3);
  });

  it('snapshot 返回所有标签组合', () => {
    const c = new Counter('ops');
    c.inc({ status: 'ok' }, 10);
    c.inc({ status: 'error' }, 2);
    const snap = c.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.find(s => s.labels.status === 'ok')?.value).toBe(10);
    expect(snap.find(s => s.labels.status === 'error')?.value).toBe(2);
  });
});

describe('Histogram', () => {
  it('计算百分位数', () => {
    const h = new Histogram('latency');
    for (let i = 1; i <= 100; i++) h.observe(i);
    expect(h.percentile(0.5)).toBeGreaterThanOrEqual(50);
    expect(h.percentile(0.5)).toBeLessThanOrEqual(51);
    expect(h.percentile(0.95)).toBeGreaterThanOrEqual(95);
    expect(h.percentile(0.99)).toBeGreaterThanOrEqual(99);
  });

  it('按标签独立统计', () => {
    const h = new Histogram('duration');
    h.observe(10, { agent: 'brain' });
    h.observe(20, { agent: 'brain' });
    h.observe(100, { agent: 'code' });
    expect(h.count({ agent: 'brain' })).toBe(2);
    expect(h.count({ agent: 'code' })).toBe(1);
  });

  it('空直方图返回零', () => {
    const h = new Histogram('empty');
    expect(h.percentile(0.5)).toBe(0);
    expect(h.count()).toBe(0);
  });

  it('snapshot 包含百分位统计', () => {
    const h = new Histogram('req_ms');
    for (let i = 1; i <= 50; i++) h.observe(i, { path: '/api' });
    const snap = h.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].labels.path).toBe('/api');
    expect(snap[0].count).toBe(50);
    expect(snap[0].p50).toBeGreaterThan(0);
  });
});
