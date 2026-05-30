export interface CronField {
  type: 'any' | 'value' | 'range' | 'step' | 'list';
  values: number[];
}

export function parseCronExpression(expression: string): CronField[] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: ${expression}`);
  return parts.map((part, index) => parseField(part, index));
}

function parseField(field: string, index: number): CronField {
  const ranges: [number, number][] = [
    [0, 59], [0, 23], [1, 31], [1, 12], [0, 6],
  ];
  const [min, max] = ranges[index];

  if (field === '*') return { type: 'any', values: [] };

  if (field.includes('/')) {
    const [base, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    const start = base === '*' ? min : parseInt(base, 10);
    const values: number[] = [];
    for (let i = start; i <= max; i += step) values.push(i);
    return { type: 'step', values };
  }

  if (field.includes(',')) {
    const values = field.split(',').map(v => parseInt(v, 10));
    return { type: 'list', values };
  }

  if (field.includes('-')) {
    const [startStr, endStr] = field.split('-');
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    const values: number[] = [];
    for (let i = start; i <= end; i++) values.push(i);
    return { type: 'range', values };
  }

  return { type: 'value', values: [parseInt(field, 10)] };
}

export function matchesCron(fields: CronField[], date: Date): boolean {
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  return fields.every((field, i) => {
    if (field.type === 'any') return true;
    return field.values.includes(values[i]);
  });
}

export function getNextTrigger(fields: CronField[], after: Date): Date {
  const next = new Date(after.getTime() + 60000);
  next.setSeconds(0, 0);
  for (let i = 0; i < 525600; i++) {
    if (matchesCron(fields, next)) return next;
    next.setTime(next.getTime() + 60000);
  }
  throw new Error('No matching time found within one year');
}

export type CronCallback = () => void;

export class CronScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  schedule(id: string, expression: string, callback: CronCallback): void {
    const fields = parseCronExpression(expression);
    const timer = setInterval(() => {
      if (matchesCron(fields, new Date())) callback();
    }, 60000);
    this.timers.set(id, timer);
  }

  unschedule(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  clear(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
