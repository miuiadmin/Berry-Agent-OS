import type { TestHarness, MessageResult } from './harness.js';
import { LiveTestContext } from './live-test-context.js';
import { sendWithRetry } from './live-test-helpers.js';

export interface TurnResult {
  message: string;
  result: MessageResult;
  turnIndex: number;
}

export interface ConversationResult {
  turns: TurnResult[];
  sessionId: string;
  totalMs: number;
}

type ResponseCheck = string | RegExp | ((response: string) => void);
type TurnAssertion = (turn: TurnResult, ctx: LiveTestContext) => void;
type FinalAssertion = (result: ConversationResult, ctx: LiveTestContext) => void;

interface TurnSpec {
  message: string;
  assertions: TurnAssertion[];
}

export class ConversationBuilder {
  private turnSpecs: TurnSpec[] = [];
  private finalAssertions: FinalAssertion[] = [];
  private retryOpts: { maxRetries?: number; backoffMs?: number } = {};

  constructor(
    private readonly harness: TestHarness,
    private readonly ctx: LiveTestContext,
  ) {}

  turn(message: string): this {
    this.turnSpecs.push({ message, assertions: [] });
    return this;
  }

  assertResponse(check: ResponseCheck): this {
    const spec = this.lastTurn();
    spec.assertions.push((turn) => {
      const response = turn.result.response;
      if (typeof check === 'string') {
        if (!response.includes(check)) {
          throw new Error(`Turn ${turn.turnIndex}: response does not contain "${check}"`);
        }
      } else if (check instanceof RegExp) {
        if (!check.test(response)) {
          throw new Error(`Turn ${turn.turnIndex}: response does not match ${check}`);
        }
      } else {
        check(response);
      }
    });
    return this;
  }

  assertAfterTurn(fn: (ctx: LiveTestContext) => void): this {
    const spec = this.lastTurn();
    spec.assertions.push((_turn, ctx) => fn(ctx));
    return this;
  }

  assertFinal(fn: FinalAssertion): this {
    this.finalAssertions.push(fn);
    return this;
  }

  withRetry(opts: { maxRetries?: number; backoffMs?: number }): this {
    this.retryOpts = opts;
    return this;
  }

  async run(opts?: { sessionId?: string }): Promise<ConversationResult> {
    const startTime = Date.now();
    const turns: TurnResult[] = [];
    let sessionId = opts?.sessionId ?? '';

    for (let i = 0; i < this.turnSpecs.length; i++) {
      const spec = this.turnSpecs[i];
      const result = await sendWithRetry(this.harness, this.ctx, spec.message, {
        ...this.retryOpts,
        sessionId: sessionId || undefined,
      });

      if (!sessionId) sessionId = result.sessionId;

      const turnResult: TurnResult = {
        message: spec.message,
        result,
        turnIndex: i,
      };
      turns.push(turnResult);

      for (const assertion of spec.assertions) {
        assertion(turnResult, this.ctx);
      }
    }

    const conversationResult: ConversationResult = {
      turns,
      sessionId,
      totalMs: Date.now() - startTime,
    };

    for (const assertion of this.finalAssertions) {
      assertion(conversationResult, this.ctx);
    }

    return conversationResult;
  }

  private lastTurn(): TurnSpec {
    if (this.turnSpecs.length === 0) {
      throw new Error('No turn added yet. Call .turn() first.');
    }
    return this.turnSpecs[this.turnSpecs.length - 1];
  }
}
