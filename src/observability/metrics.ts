export type Labels = Record<string, string>;

function labelsKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

export class Counter {
  readonly name: string;
  private values = new Map<string, number>();

  constructor(name: string) {
    this.name = name;
  }

  inc(labels: Labels = {}, delta = 1): void {
    const key = labelsKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + delta);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelsKey(labels)) ?? 0;
  }

  snapshot(): Array<{ labels: Labels; value: number }> {
    const result: Array<{ labels: Labels; value: number }> = [];
    for (const [key, value] of this.values) {
      const labels: Labels = {};
      if (key) {
        for (const pair of key.split(',')) {
          const [k, v] = pair.split('=');
          labels[k] = v;
        }
      }
      result.push({ labels, value });
    }
    return result;
  }
}

export class Histogram {
  readonly name: string;
  private observations = new Map<string, number[]>();

  constructor(name: string) {
    this.name = name;
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelsKey(labels);
    let arr = this.observations.get(key);
    if (!arr) {
      arr = [];
      this.observations.set(key, arr);
    }
    arr.push(value);
    if (arr.length > 10000) {
      arr.splice(0, arr.length - 5000);
    }
  }

  percentile(p: number, labels: Labels = {}): number {
    const arr = this.observations.get(labelsKey(labels));
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
    return sorted[idx];
  }

  count(labels: Labels = {}): number {
    return this.observations.get(labelsKey(labels))?.length ?? 0;
  }

  snapshot(): Array<{ labels: Labels; count: number; p50: number; p95: number; p99: number }> {
    const result: Array<{ labels: Labels; count: number; p50: number; p95: number; p99: number }> = [];
    for (const [key] of this.observations) {
      const labels: Labels = {};
      if (key) {
        for (const pair of key.split(',')) {
          const [k, v] = pair.split('=');
          labels[k] = v;
        }
      }
      result.push({
        labels,
        count: this.count(labels),
        p50: this.percentile(0.5, labels),
        p95: this.percentile(0.95, labels),
        p99: this.percentile(0.99, labels),
      });
    }
    return result;
  }
}

class MetricsRegistry {
  private counters = new Map<string, Counter>();
  private histograms = new Map<string, Histogram>();
  private startedAt = Date.now();

  counter(name: string): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new Counter(name);
      this.counters.set(name, c);
    }
    return c;
  }

  histogram(name: string): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram(name);
      this.histograms.set(name, h);
    }
    return h;
  }

  snapshot(): {
    uptimeMs: number;
    counters: Record<string, Array<{ labels: Labels; value: number }>>;
    histograms: Record<string, Array<{ labels: Labels; count: number; p50: number; p95: number; p99: number }>>;
  } {
    const counters: Record<string, Array<{ labels: Labels; value: number }>> = {};
    for (const [name, c] of this.counters) {
      counters[name] = c.snapshot();
    }
    const histograms: Record<string, Array<{ labels: Labels; count: number; p50: number; p95: number; p99: number }>> = {};
    for (const [name, h] of this.histograms) {
      histograms[name] = h.snapshot();
    }
    return { uptimeMs: Date.now() - this.startedAt, counters, histograms };
  }
}

export const metrics = new MetricsRegistry();
