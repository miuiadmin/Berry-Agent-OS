import { genId } from '../utils/id.js';
import { metrics } from '../observability/metrics.js';
import type {
  ICapabilityBus,
  CapabilityDescriptor,
  CapabilityExecutor,
  CapabilityQuery,
  InvokeContext,
  InvokeResult,
  IPermissionGate,
  IBusAuditLogger,
  BusAuditEntry,
  Trigger,
  TriggerEvent,
} from './contract.js';
import { MAX_CALL_DEPTH } from './contract.js';

export class CapabilityBus implements ICapabilityBus {
  private registry = new Map<string, { descriptor: CapabilityDescriptor; executor: CapabilityExecutor }>();
  private permissionGate: IPermissionGate | null = null;
  private auditLogger: IBusAuditLogger | null = null;
  private triggers = new Map<string, Trigger>();
  private eventListeners = new Map<string, Set<(data: unknown) => void>>();

  private invokeCounter = metrics.counter('bus_invoke_total');
  private invokeErrorCounter = metrics.counter('bus_invoke_error_total');
  private invokeDuration = metrics.histogram('bus_invoke_duration_ms');

  setPermissionGate(gate: IPermissionGate): void {
    this.permissionGate = gate;
  }

  getPermissionGate(): IPermissionGate | null {
    return this.permissionGate;
  }

  setAuditLogger(logger: IBusAuditLogger): void {
    this.auditLogger = logger;
  }

  register(capability: CapabilityDescriptor, executor: CapabilityExecutor): void {
    if (this.registry.has(capability.name)) {
      throw new Error(`Capability "${capability.name}" already registered`);
    }
    this.registry.set(capability.name, { descriptor: capability, executor });
    this.emit('capability.registered', { name: capability.name, provider: capability.provider });
  }

  unregister(name: string): void {
    const had = this.registry.has(name);
    this.registry.delete(name);
    if (had) {
      this.emit('capability.unregistered', { name });
    }
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  discover(query?: CapabilityQuery): CapabilityDescriptor[] {
    const results: CapabilityDescriptor[] = [];
    for (const { descriptor } of this.registry.values()) {
      if (query?.providerType && descriptor.provider.type !== query.providerType) continue;
      if (query?.dangerLevel && descriptor.dangerLevel !== query.dangerLevel) continue;
      if (query?.namePattern) {
        const regex = new RegExp(query.namePattern.replace(/\*/g, '.*'));
        if (!regex.test(descriptor.name)) continue;
      }
      results.push(descriptor);
    }
    return results;
  }

  getDescriptor(name: string): CapabilityDescriptor | undefined {
    return this.registry.get(name)?.descriptor;
  }

  async invoke(name: string, input: unknown, ctx: InvokeContext): Promise<InvokeResult> {
    const auditId = genId('binv');
    const start = Date.now();

    const entry = this.registry.get(name);
    if (!entry) {
      return { ok: false, error: `Capability "${name}" not found`, auditId, durationMs: 0, provider: { type: 'builtin', name: 'unknown' } };
    }

    const { descriptor, executor } = entry;

    // Call chain depth check
    if (ctx.callChain.length >= MAX_CALL_DEPTH) {
      return { ok: false, error: `Call depth exceeded (max ${MAX_CALL_DEPTH})`, auditId, durationMs: 0, provider: descriptor.provider };
    }

    // Cycle detection
    const chainKey = `${ctx.callerAgent ?? 'root'}:${name}`;
    if (ctx.callChain.includes(chainKey)) {
      return { ok: false, error: `Cycle detected: ${chainKey} already in call chain`, auditId, durationMs: 0, provider: descriptor.provider };
    }

    // Permission gate
    if (this.permissionGate && descriptor.dangerLevel !== 'safe') {
      const decision = await this.permissionGate.check(descriptor, input, ctx);
      if (!decision.allowed) {
        const durationMs = Date.now() - start;
        this.invokeErrorCounter.inc({ capability: name, reason: 'permission_denied' });
        this.recordAudit(auditId, name, descriptor, ctx, input, null, false, decision.reason, durationMs);
        return { ok: false, error: `Permission denied: ${decision.reason}`, auditId, durationMs, provider: descriptor.provider };
      }
    }

    // Execute
    const childCtx: InvokeContext = { ...ctx, callChain: [...ctx.callChain, chainKey] };
    try {
      const timeoutMs = ctx.timeout ?? 30_000;
      const result = await Promise.race([
        executor(input, childCtx),
        timeoutPromise(timeoutMs, name),
      ]);
      const durationMs = Date.now() - start;

      this.invokeCounter.inc({ capability: name, status: 'ok' });
      this.invokeDuration.observe(durationMs, { capability: name });
      this.recordAudit(auditId, name, descriptor, ctx, input, result, true, null, durationMs);

      return { ok: true, data: result, auditId, durationMs, provider: descriptor.provider };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.invokeErrorCounter.inc({ capability: name, reason: 'execution_error' });
      this.invokeDuration.observe(durationMs, { capability: name });
      this.recordAudit(auditId, name, descriptor, ctx, input, null, false, errorMsg, durationMs);

      return { ok: false, error: errorMsg, auditId, durationMs, provider: descriptor.provider };
    }
  }

  async invokeAll(calls: Array<{ name: string; input: unknown }>, ctx: InvokeContext): Promise<InvokeResult[]> {
    return Promise.all(calls.map((call) => this.invoke(call.name, call.input, ctx)));
  }

  async pipeline(input: unknown, steps: string[], ctx: InvokeContext): Promise<InvokeResult> {
    let current = input;
    let lastResult: InvokeResult | null = null;

    for (const step of steps) {
      lastResult = await this.invoke(step, current, ctx);
      if (!lastResult.ok) return lastResult;
      current = lastResult.data;
    }

    return lastResult ?? { ok: true, data: current, auditId: genId('binv'), durationMs: 0, provider: { type: 'builtin', name: 'pipeline' } };
  }

  async race(calls: Array<{ name: string; input: unknown }>, ctx: InvokeContext): Promise<InvokeResult> {
    const promises = calls.map((call) => this.invoke(call.name, call.input, ctx));
    const results = await Promise.allSettled(promises);

    // Return first successful result
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.ok) return r.value;
    }

    // All failed — return first error
    const first = results[0];
    if (first.status === 'fulfilled') return first.value;
    return { ok: false, error: 'All race participants failed', auditId: genId('binv'), durationMs: 0, provider: { type: 'builtin', name: 'race' } };
  }

  private recordAudit(
    id: string,
    capabilityName: string,
    descriptor: CapabilityDescriptor,
    ctx: InvokeContext,
    input: unknown,
    output: unknown,
    ok: boolean,
    error: string | null,
    durationMs: number,
  ): void {
    if (!this.auditLogger) return;
    const entry: BusAuditEntry = {
      id,
      capabilityName,
      provider: descriptor.provider,
      callerAgent: ctx.callerAgent ?? null,
      sessionId: ctx.sessionId,
      correlationId: ctx.correlationId,
      callChain: ctx.callChain,
      input,
      output,
      ok,
      error,
      durationMs,
      createdAt: Date.now(),
    };
    this.auditLogger.record(entry);
  }

  // --- Event emitter (for Trigger events and inter-capability communication) ---

  emit(event: string, data: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    for (const handler of listeners) {
      try { handler(data); } catch { /* listener errors don't propagate */ }
    }
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  // --- Trigger management ---

  registerTrigger(trigger: Trigger): void {
    if (this.triggers.has(trigger.name)) {
      throw new Error(`Trigger "${trigger.name}" already registered`);
    }
    this.triggers.set(trigger.name, trigger);
    trigger.start((event) => {
      this.emit('trigger', event);
    });
  }

  unregisterTrigger(name: string): void {
    const trigger = this.triggers.get(name);
    if (trigger) {
      trigger.stop();
      this.triggers.delete(name);
    }
  }

  stopAllTriggers(): void {
    for (const trigger of this.triggers.values()) {
      trigger.stop();
    }
    this.triggers.clear();
  }
}

function timeoutPromise(ms: number, name: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Capability "${name}" timed out after ${ms}ms`)), ms);
  });
}
