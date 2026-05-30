import { getLogger } from '../../utils/logger.js';

const logger = getLogger('event-channel');

export class EventChannel<T> {
  private queue: T[] = [];
  private waiters: Array<{
    resolve: (v: IteratorResult<T, undefined>) => void;
    reject: (e: Error) => void;
  }> = [];
  private closed = false;
  private err: Error | null = null;

  push(event: T): void {
    if (this.closed) return;

    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    for (const waiter of this.waiters) {
      waiter.resolve({ value: undefined, done: true });
    }
    this.waiters.length = 0;
  }

  fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.err = err;

    for (const waiter of this.waiters) {
      waiter.reject(err);
    }
    this.waiters.length = 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }

      if (this.closed) {
        if (this.err) throw this.err;
        return;
      }

      const result = await new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });

      if (result.done) return;
      yield result.value;
    }
  }
}
