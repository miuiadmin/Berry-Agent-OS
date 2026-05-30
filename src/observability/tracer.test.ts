import { describe, it, expect, beforeEach } from 'vitest';
import { Tracer, MemorySink, createSqliteSink } from './tracer.js';
import Database from 'better-sqlite3';

describe('Tracer', () => {
  let tracer: Tracer;
  let memorySink: MemorySink;

  beforeEach(() => {
    tracer = new Tracer();
    memorySink = new MemorySink();
    tracer.addSink(memorySink.sink);
  });

  it('creates a trace with root span', () => {
    const span = tracer.startTrace('root-operation', { agent: 'brain' });
    span.end();

    expect(memorySink.spans).toHaveLength(1);
    expect(memorySink.spans[0].name).toBe('root-operation');
    expect(memorySink.spans[0].parentId).toBeNull();
    expect(memorySink.spans[0].attributes.agent).toBe('brain');
    expect(memorySink.spans[0].status).toBe('ok');
    expect(memorySink.spans[0].endTime).toBeGreaterThan(0);
  });

  it('creates child spans with same traceId', () => {
    const root = tracer.startTrace('request');
    const child = root.child('routing', { intent: 'chat' });
    const grandchild = child.child('llm-call');

    grandchild.end();
    child.end();
    root.end();

    expect(memorySink.spans).toHaveLength(3);
    const traceId = root.traceId;
    expect(memorySink.spans.every((s) => s.traceId === traceId)).toBe(true);
    expect(memorySink.spans[0].parentId).toBe(child.id);
    expect(memorySink.spans[1].parentId).toBe(root.id);
    expect(memorySink.spans[2].parentId).toBeNull();
  });

  it('records error status', () => {
    const span = tracer.startTrace('failing-op');
    span.setStatus('error', 'something went wrong');
    span.end();

    expect(memorySink.spans[0].status).toBe('error');
    expect(memorySink.spans[0].error).toBe('something went wrong');
  });

  it('ignores operations after end()', () => {
    const span = tracer.startTrace('op');
    span.end();
    span.setStatus('error', 'late error');
    span.setAttributes({ late: 'attr' });

    expect(memorySink.spans[0].status).toBe('ok');
    expect(memorySink.spans[0].attributes.late).toBeUndefined();
  });

  it('sets attributes incrementally', () => {
    const span = tracer.startTrace('op', { a: '1' });
    span.setAttributes({ b: '2' });
    span.setAttributes({ c: 3 });
    span.end();

    expect(memorySink.spans[0].attributes).toEqual({ a: '1', b: '2', c: 3 });
  });
});

describe('SQLite Sink', () => {
  it('persists spans to database', () => {
    const db = new Database(':memory:');
    const sink = createSqliteSink(db);
    const tracer = new Tracer();
    tracer.addSink(sink);

    const root = tracer.startTrace('db-test', { foo: 'bar' });
    const child = root.child('child-op');
    child.setStatus('error', 'test error');
    child.end();
    root.end();

    const rows = db.prepare('SELECT * FROM trace_spans ORDER BY start_time').all() as Array<{
      id: string; trace_id: string; parent_id: string | null; name: string;
      duration_ms: number | null; status: string; error: string | null; attributes: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('child-op');
    expect(rows[0].status).toBe('error');
    expect(rows[0].error).toBe('test error');
    expect(rows[0].parent_id).toBe(root.id);
    expect(rows[0].trace_id).toBe(root.traceId);
    expect(rows[1].name).toBe('db-test');
    expect(rows[1].parent_id).toBeNull();
    expect(JSON.parse(rows[1].attributes)).toEqual({ foo: 'bar' });

    db.close();
  });
});
