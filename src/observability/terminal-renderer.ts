import type { EventBus, EventName } from '../kernel/event-bus.js';

const isTTY = process.stdout.isTTY === true;

const C = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  green: isTTY ? '\x1b[32m' : '',
  red: isTTY ? '\x1b[31m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
};

function ts(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${C.dim}${h}:${m}:${s}${C.reset}`;
}

function truncate(text: string, max = 120): string {
  const oneLine = text.replace(/\n/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '...' : oneLine;
}

export class TerminalRenderer {
  private unsubscribers: (() => void)[] = [];

  start(eventBus: EventBus): void {
    // --- Agent lifecycle ---
    this.subscribe(eventBus, 'agent.registered', ({ name, pid }) => {
      this.write(`${C.green}✓${C.reset} Agent ${C.bold}${name}${C.reset} ${C.dim}(pid:${pid})${C.reset} 就绪`);
    });

    this.subscribe(eventBus, 'agent.crashed', ({ name, error, circuitBroken }) => {
      const suffix = circuitBroken ? ' [熔断]' : '';
      this.write(`${C.red}✗${C.reset} Agent ${C.bold}${name}${C.reset} 崩溃: ${error ?? '未知'}${suffix}`);
    });

    this.subscribe(eventBus, 'agent.installed', ({ name, version }) => {
      this.write(`${C.green}+${C.reset} Agent 安装: ${C.bold}${name}${C.reset} v${version}`);
    });

    this.subscribe(eventBus, 'agent.removed', ({ name }) => {
      this.write(`${C.red}-${C.reset} Agent 移除: ${C.bold}${name}${C.reset}`);
    });

    this.subscribe(eventBus, 'agent.upgraded', ({ name, fromVersion, toVersion }) => {
      this.write(`${C.blue}↑${C.reset} Agent 升级: ${C.bold}${name}${C.reset} ${fromVersion} → ${toVersion}`);
    });

    this.subscribe(eventBus, 'agent.enabled', ({ name }) => {
      this.write(`${C.green}✓${C.reset} Agent 启用: ${name}`);
    });

    this.subscribe(eventBus, 'agent.disabled', ({ name, reason }) => {
      this.write(`${C.yellow}⚠${C.reset} Agent 禁用: ${name}${reason ? ' — ' + reason : ''}`);
    });

    // --- Task lifecycle ---
    this.subscribe(eventBus, 'task.created', ({ taskId, taskType, targetAgent }) => {
      this.write(`${C.blue}→${C.reset} [${C.cyan}${targetAgent}${C.reset}] 任务创建 ${C.dim}${taskId.slice(0, 8)}${C.reset} (${taskType})`);
    });

    this.subscribe(eventBus, 'task.dispatched', ({ taskId, targetAgent }) => {
      this.write(`  ${C.dim}${taskId.slice(0, 8)}${C.reset} → ${C.cyan}${targetAgent}${C.reset} 已分发`);
    });

    this.subscribe(eventBus, 'task.started', ({ taskId, targetAgent }) => {
      this.write(`  ${C.dim}${taskId.slice(0, 8)}${C.reset} ${C.cyan}${targetAgent}${C.reset} 开始执行`);
    });

    this.subscribe(eventBus, 'task.progress', ({ taskId, message }) => {
      this.write(`  ${C.dim}${taskId.slice(0, 8)}${C.reset} ${message}`);
    });

    this.subscribe(eventBus, 'task.completed', ({ taskId, targetAgent }) => {
      this.write(`${C.green}✓${C.reset} [${C.cyan}${targetAgent}${C.reset}] 任务完成 ${C.dim}${taskId.slice(0, 8)}${C.reset}`);
    });

    this.subscribe(eventBus, 'task.failed', ({ taskId, targetAgent, error }) => {
      this.write(`${C.red}✗${C.reset} [${C.cyan}${targetAgent}${C.reset}] 任务失败: ${error}`);
    });

    this.subscribe(eventBus, 'task.timeout', ({ taskId, targetAgent }) => {
      this.write(`${C.yellow}⚠${C.reset} [${C.cyan}${targetAgent}${C.reset}] 任务超时 ${C.dim}${taskId.slice(0, 8)}${C.reset}`);
    });

    this.subscribe(eventBus, 'task.cancelled', ({ taskId, reason }) => {
      this.write(`${C.yellow}⚠${C.reset} 任务取消 ${C.dim}${taskId.slice(0, 8)}${C.reset}${reason ? ': ' + reason : ''}`);
    });

    this.subscribe(eventBus, 'task.backgrounded', ({ taskId }) => {
      this.write(`  ${C.dim}${taskId.slice(0, 8)} → 后台${C.reset}`);
    });

    this.subscribe(eventBus, 'task.retrieved', ({ taskId }) => {
      this.write(`  ${C.dim}${taskId.slice(0, 8)} ← 恢复${C.reset}`);
    });

    // --- Tool execution ---
    this.subscribe(eventBus, 'tool.executed', ({ agentName, toolName, durationMs, isError }) => {
      const icon = isError ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`;
      this.write(`  ${icon} 🔧 ${C.bold}${toolName}${C.reset} ${C.dim}(${agentName}, ${durationMs}ms)${C.reset}`);
    });

    // --- Review ---
    this.subscribe(eventBus, 'review.requested', ({ level, sessionId }) => {
      this.write(`${C.magenta}📋${C.reset} 审核中 ${C.dim}(level:${level}, session:${sessionId.slice(0, 8)})${C.reset}`);
    });

    this.subscribe(eventBus, 'review.completed', ({ verdict }) => {
      const icon = verdict === 'approved' ? `${C.green}✓${C.reset}` : `${C.yellow}⚠${C.reset}`;
      this.write(`${C.magenta}📋${C.reset} 审核结果: ${icon} ${verdict}`);
    });

    // --- Delegation ---
    this.subscribe(eventBus, 'delegation.created', ({ delegationId, targetAgent }) => {
      this.write(`${C.blue}↗${C.reset} 委派 → ${C.cyan}${targetAgent}${C.reset} ${C.dim}${delegationId.slice(0, 8)}${C.reset}`);
    });

    this.subscribe(eventBus, 'delegation.acknowledged', ({ delegationId, targetAgent }) => {
      this.write(`  ${C.dim}${delegationId.slice(0, 8)}${C.reset} ${C.cyan}${targetAgent}${C.reset} 已确认`);
    });

    this.subscribe(eventBus, 'delegation.completed', ({ delegationId, targetAgent, durationMs }) => {
      this.write(`${C.green}✓${C.reset} 委派完成 ${C.cyan}${targetAgent}${C.reset} ${C.dim}(${durationMs}ms)${C.reset}`);
    });

    this.subscribe(eventBus, 'delegation.failed', ({ delegationId, targetAgent, error }) => {
      this.write(`${C.red}✗${C.reset} 委派失败 ${C.cyan}${targetAgent}${C.reset}: ${error}`);
    });

    this.subscribe(eventBus, 'delegation.checkpoint_needed', ({ delegationId, trigger }) => {
      this.write(`${C.yellow}⚠${C.reset} 委派暂停 ${C.dim}${delegationId.slice(0, 8)}${C.reset}: ${trigger}`);
    });

    // --- Budget ---
    this.subscribe(eventBus, 'budget.alert', ({ message, tier }) => {
      const icon = tier === 'critical' || tier === 'exceeded' ? `${C.red}✗${C.reset}` : `${C.yellow}⚠${C.reset}`;
      this.write(`${icon} 预算: ${message}`);
    });

    // --- MCP ---
    this.subscribe(eventBus, 'mcp.connected', ({ serverName, toolCount }) => {
      this.write(`${C.green}✓${C.reset} MCP ${C.bold}${serverName}${C.reset} ${C.dim}(${toolCount} tools)${C.reset}`);
    });

    this.subscribe(eventBus, 'mcp.failed', ({ serverName, error }) => {
      this.write(`${C.red}✗${C.reset} MCP ${C.bold}${serverName}${C.reset}: ${error}`);
    });

    this.subscribe(eventBus, 'mcp.disconnected', ({ serverName, reason }) => {
      this.write(`${C.yellow}⚠${C.reset} MCP ${serverName} 断开${reason ? ': ' + reason : ''}`);
    });

    this.subscribe(eventBus, 'mcp.tools_changed', ({ serverName, added, removed }) => {
      if (added.length) this.write(`  MCP ${serverName} +tools: ${added.join(', ')}`);
      if (removed.length) this.write(`  MCP ${serverName} -tools: ${removed.join(', ')}`);
    });

    this.subscribe(eventBus, 'mcp.reconnecting', ({ serverName, attempt }) => {
      this.write(`${C.dim}  MCP ${serverName} 重连中 (attempt:${attempt})${C.reset}`);
    });

    // --- Daemon ---
    this.subscribe(eventBus, 'daemon.connected', ({ runtimes }) => {
      const names = runtimes.map((r: { name: string }) => r.name).join(', ');
      this.write(`${C.green}✓${C.reset} Daemon 连接 ${C.dim}(${names})${C.reset}`);
    });

    this.subscribe(eventBus, 'daemon.disconnected', ({ reason }) => {
      this.write(`${C.yellow}⚠${C.reset} Daemon 断开: ${reason}`);
    });

    this.subscribe(eventBus, 'daemon.task.completed', ({ taskId, runtime, durationMs }) => {
      this.write(`${C.green}✓${C.reset} Daemon 任务完成 ${C.dim}${taskId.slice(0, 8)}${C.reset} (${runtime}, ${durationMs}ms)`);
    });

    this.subscribe(eventBus, 'daemon.task.failed', ({ taskId, runtime, error }) => {
      this.write(`${C.red}✗${C.reset} Daemon 任务失败 ${C.dim}${taskId.slice(0, 8)}${C.reset} (${runtime}): ${error}`);
    });

    // --- Cron ---
    this.subscribe(eventBus, 'cron.fired', ({ description }) => {
      this.write(`${C.blue}⏱${C.reset} 定时任务: ${description}`);
    });

    this.subscribe(eventBus, 'cron.completed', ({ taskId }) => {
      this.write(`${C.green}✓${C.reset} 定时任务完成 ${C.dim}${taskId.slice(0, 8)}${C.reset}`);
    });

    this.subscribe(eventBus, 'cron.failed', ({ taskId, error }) => {
      this.write(`${C.red}✗${C.reset} 定时任务失败 ${C.dim}${taskId.slice(0, 8)}${C.reset}: ${error}`);
    });

    // --- Config ---
    this.subscribe(eventBus, 'config.reloaded', ({ fields }) => {
      this.write(`${C.dim}⟳ 配置已刷新: ${fields.join(', ')}${C.reset}`);
    });

    // --- User message flow ---
    this.subscribe(eventBus, 'message.received', ({ message }) => {
      this.write(`${C.yellow}←${C.reset} [用户] ${truncate(message)}`);
    });

    this.subscribe(eventBus, 'message.routed', ({ targetAgent, intent }) => {
      const desc = intent ? ` (${intent})` : '';
      this.write(`${C.magenta}🧠${C.reset} Brain → ${C.cyan}${targetAgent}${C.reset}${desc}`);
    });

    this.subscribe(eventBus, 'message.responded', ({ response, verdict }) => {
      const verdictStr = verdict ? ` ${C.dim}[${verdict}]${C.reset}` : '';
      this.write(`${C.green}→${C.reset} [回复]${verdictStr} ${truncate(response, 200)}`);
    });

    // --- LLM ---
    this.subscribe(eventBus, 'llm.request.completed', ({ agentName, inputTokens, outputTokens, cacheRead, durationMs }) => {
      const cache = cacheRead ? ` cache:${cacheRead}` : '';
      this.write(`  ${C.dim}🤖${C.reset} LLM ${C.cyan}${agentName}${C.reset} ${C.dim}(${inputTokens}+${outputTokens} tokens${cache}, ${durationMs}ms)${C.reset}`);
    });
  }

  info(message: string): void {
    this.write(`${C.green}▶${C.reset} ${message}`);
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  private subscribe<E extends EventName>(eventBus: EventBus, event: E, handler: (payload: any) => void): void {
    this.unsubscribers.push(eventBus.on(event, handler));
  }

  private write(line: string): void {
    process.stdout.write(`${ts()} ${line}\n`);
  }
}
