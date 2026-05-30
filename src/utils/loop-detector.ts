export interface LoopCheckResult {
  loop: boolean;
  reason?: string;
}

export class LoopDetector {
  private calls: Array<{ key: string; isError: boolean }> = [];
  private maxCalls: number;

  constructor(maxCalls = 20) {
    this.maxCalls = maxCalls;
  }

  check(toolName: string, input: string, isError: boolean): LoopCheckResult {
    const key = `${toolName}:${input}`;
    this.calls.push({ key, isError });

    if (this.calls.length >= this.maxCalls) {
      return { loop: true, reason: `已达到最大工具调用次数 (${this.maxCalls})` };
    }

    const recentKeys = this.calls.slice(-4).map((c) => c.key);
    if (recentKeys.length >= 4 && recentKeys.every((k) => k === key)) {
      return { loop: true, reason: `相同工具调用连续重复 4 次: ${toolName}` };
    }

    const recentErrors = this.calls.slice(-6).map((c) => c.isError);
    if (recentErrors.length >= 6 && recentErrors.every(Boolean)) {
      return { loop: true, reason: '连续 6 次工具调用失败' };
    }

    return { loop: false };
  }

  reset(): void {
    this.calls = [];
  }
}
