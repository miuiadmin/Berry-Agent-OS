import { genId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('tracer');

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface Span {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  startTime: number;
  endTime: number | null;
  attributes: SpanAttributes;
  status: 'ok' | 'error' | 'unset';
  error?: string;
}

export interface SpanHandle {
  readonly id: string;
  readonly traceId: string;
  setAttributes(attrs: SpanAttributes): void;
  setStatus(status: 'ok' | 'error', error?: string): void;
  end(): void;
  child(name: string, attrs?: SpanAttributes): SpanHandle;
}

export type SpanSink = (span: Span) => void;

class SpanImpl implements SpanHandle {
  readonly id: string;
  readonly traceId: string;
  private span: Span;
  private sink: SpanSink;
  private ended = false;

  constructor(name: string, traceId: string, parentId: string | null, sink: SpanSink, attrs?: SpanAttributes) {
    this.id = genId('spn');
    this.traceId = traceId;
    this.sink = sink;
    this.span = {
      id: this.id,
      traceId,
      parentId,
      name,
      startTime: Date.now(),
      endTime: null,
      attributes: attrs ?? {},
      status: 'unset',
    };
  }

  setAttributes(attrs: SpanAttributes): void {
    if (this.ended) return;
    Object.assign(this.span.attributes, attrs);
  }

  setStatus(status: 'ok' | 'error', error?: string): void {
    if (this.ended) return;
    this.span.status = status;
    if (error) this.span.error = error;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.span.endTime = Date.now();
    if (this.span.status === 'unset') this.span.status = 'ok';
    try {
      this.sink(this.span);
    } catch (err) {
      logger.error({ err, spanId: this.id }, '写入 span 失败');
    }
  }

  child(name: string, attrs?: SpanAttributes): SpanHandle {
    return new SpanImpl(name, this.traceId, this.id, this.sink, attrs);
  }
}

export class Tracer {
  private sinks: SpanSink[] = [];

  addSink(sink: SpanSink): void {
    this.sinks.push(sink);
  }

  startTrace(name: string, attrs?: SpanAttributes): SpanHandle {
    const traceId = genId('trc');
    return new SpanImpl(name, traceId, null, (span) => this.emit(span), attrs);
  }

  startSpan(name: string, traceId: string, parentId: string | null, attrs?: SpanAttributes): SpanHandle {
    return new SpanImpl(name, traceId, parentId, (span) => this.emit(span), attrs);
  }

  private emit(span: Span): void {
    for (const sink of this.sinks) {
      try {
        sink(span);
      } catch (e) { logger.debug({ err: e }, 'Trace sink error'); }
    }
  }
}

// === SQLite Sink ===

export interface TracerDb {
  prepare(sql: string): { run(...args: unknown[]): void };
  exec(sql: string): void;
}

export function createSqliteSink(db: TracerDb): SpanSink {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_spans (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'unset',
      error TEXT,
      attributes TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_spans_trace ON trace_spans(trace_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_trace_spans_parent ON trace_spans(parent_id)`);

  const insert = db.prepare(`
    INSERT INTO trace_spans (id, trace_id, parent_id, name, start_time, end_time, duration_ms, status, error, attributes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return (span: Span) => {
    const durationMs = span.endTime ? span.endTime - span.startTime : null;
    insert.run(
      span.id,
      span.traceId,
      span.parentId,
      span.name,
      span.startTime,
      span.endTime,
      durationMs,
      span.status,
      span.error ?? null,
      JSON.stringify(span.attributes),
      Date.now(),
    );
  };
}

// === In-Memory Sink (for testing) ===

export class MemorySink {
  readonly spans: Span[] = [];

  sink: SpanSink = (span) => {
    this.spans.push(span);
  };

  getTrace(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  clear(): void {
    this.spans.length = 0;
  }
}

// === Global Tracer ===

let globalTracer: Tracer | null = null;

export function initTracer(sinks?: SpanSink[]): Tracer {
  globalTracer = new Tracer();
  if (sinks) {
    for (const sink of sinks) {
      globalTracer.addSink(sink);
    }
  }
  return globalTracer;
}

export function getTracer(): Tracer {
  if (!globalTracer) {
    globalTracer = new Tracer();
  }
  return globalTracer;
}
