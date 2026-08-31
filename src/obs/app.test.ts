/**
 * L3 obs — 组合根全栈测试（契约篇 §6.9 刀一：obs 行默认层装载 + session/event
 * 真总线摄取 + flush 落库 + obs_query 工具回执——mock 零介入：宿主侧直接向
 * 聚焦会话 append 核心事件，onLiveEvent 总线镜像驱动全链）。
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime, type AppRuntime } from '../app/assembly.js';
import type { ToolDefinition } from '../contracts/tools.js';

const runtimes: AppRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
});

/** 等待 obs flush 窗（overlay config flushMs=60——测试缝） */
const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('obs 观测件：组合根全栈（默认层第十五行真装载）', () => {
  it('session/event 真总线 → 聚合 → obs_query 回执：app 维/工具分桶/审批全链', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-e2e-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    // flush 测试缝：60ms 落账窗（行 config schema 校验过——运营旋钮同面）
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      compositionDir,
    });
    runtimes.push(runtime);

    // 行激活（默认层第十五行——session/event 订阅已挂、rollup.db 已开）
    const row = runtime.appsService.list().find((r) => r.id === 'obs');
    expect(row?.status).toBe('activated');

    // 宿主侧向聚焦会话 append 核心事件（onLiveEvent → 总线 → obs 摄取）
    const session = runtime.session;
    expect(session).toBeDefined();
    session!.append('request/header', {
      config: {},
      systemPrompt: 'x',
      toolSchemas: [],
      reason: 'initial',
      app: 'chat',
    });
    session!.append('user/message', { content: '帮我看看' });
    session!.append('tool/call', { toolCallId: 'tc1', name: 'read', arguments: '{}' });
    session!.append('tool/result', { toolCallId: 'tc1', content: 'ok' });
    session!.append('assistant/message', { content: '好了' });
    session!.append('llm/usage', {
      callId: 'c1',
      model: 'faux/model-1',
      priority: 'foreground',
      usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 },
    });
    session!.append('approval/asked', { approvalId: 'a1', summary: '写文件' });
    session!.append('approval/decided', { approvalId: 'a1', decision: 'approve' });
    session!.append('turn/start', {});
    session!.append('turn/end', { reason: 'completed' });
    await settle();

    // obs_query 工具直调（模型路回执）
    const obsQuery = runtime.tools.get('obs_query') as ToolDefinition;
    expect(obsQuery).toBeDefined();
    const turnResult = await obsQuery.execute({ metric: 'turn', groupBy: ['app'] }, { toolCallId: 'obs-e2e-turn' });
    const turnText = JSON.stringify(turnResult.content);
    expect(turnText).toContain('chat');
    expect(turnText).toContain('turns');
    // turns=1 / user_msgs=1 / assistant_msgs=1 / tool_calls=1 的文本呈现
    expect(turnResult.content[0]).toMatchObject({ type: 'text' });

    const llmResult = await obsQuery.execute({ metric: 'llm', groupBy: ['model'] }, { toolCallId: 'obs-e2e-llm' });
    const llmText = JSON.stringify(llmResult.content);
    expect(llmText).toContain('faux/model-1');

    const toolResult = await obsQuery.execute({ metric: 'tool', groupBy: ['tool'] }, { toolCallId: 'obs-e2e-tool' });
    expect(JSON.stringify(toolResult.content)).toContain('read');

    const approvalResult = await obsQuery.execute({ metric: 'approval', groupBy: [] }, { toolCallId: 'obs-e2e-appr' });
    expect(JSON.stringify(approvalResult.content)).toContain('asked');
  });

  it('卸载语义：overlay 禁用 obs 行——宿主照启、事件面与工具面缺席', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-off-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    disabled: true\n');

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      compositionDir,
    });
    runtimes.push(runtime);

    const row = runtime.appsService.list().find((r) => r.id === 'obs');
    expect(row?.status).toBe('skipped'); // Ring 2 真·可卸——核心循环不破
    expect(runtime.tools.get('obs_query')).toBeUndefined(); // 工具面缺席
    const session = runtime.session;
    expect(session).toBeDefined(); // 会话照常（观测缺席不反噬）
  });

  it('刀二告警全栈：/obs-alerts add → 事件摄取 → 内联执法 → obs/alert 总线 + ui 通知（规范触发三件）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-alert-e2e-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      compositionDir,
    });
    runtimes.push(runtime);

    // 观察哨两路：obs/alert 总线事件 + recording backend 通知
    const busAlerts: unknown[] = [];
    runtime.ctx.on('obs/alert', (payload: unknown) => busAlerts.push(payload));
    const notifies: string[] = [];
    runtime.ui.attach({
      id: 'rec',
      notify: (text: string) => notifies.push(text),
      setStatus: () => {},
      confirm: async () => true,
    });

    // 命令面：add（阈值 1 次调用即触发——窗 24h / 冷却 0）
    expect(await runtime.channels.commands.dispatch('/obs-alerts add sum llm.calls >= 1 24 0')).toBe('ok');
    expect(notifies.some((n) => n.includes('已添加告警规则'))).toBe(true);

    // 触发链：会话事件 → 总线 → 摄取 → flush 内联执法
    const session = runtime.session;
    expect(session).toBeDefined();
    session!.append('request/header', {
      config: {},
      systemPrompt: 'x',
      toolSchemas: [],
      reason: 'initial',
      app: 'chat',
    });
    session!.append('llm/usage', {
      callId: 'c-alert',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300); // flush 窗 60ms + 内联执法 + 回调

    // 触发三件断言：①obs/alert 总线载荷（metric/agg/value/threshold/window）②ui.notify
    // 人读文案 ③last_fired_at 回写（经 /obs-alerts list 可见触发时刻非「未触发」）
    expect(busAlerts).toHaveLength(1);
    expect(busAlerts[0]).toMatchObject({ metric: 'llm.calls', agg: 'sum', value: 1, threshold: 1, windowHours: 24 });
    expect(notifies.some((n) => n.includes('观测告警') && n.includes('llm.calls'))).toBe(true);
    expect(await runtime.channels.commands.dispatch('/obs-alerts list')).toBe('ok');
    const listing = notifies.at(-1) ?? '';
    expect(listing).toContain('只通知不执法');
    expect(listing).not.toContain('未触发'); // last_fired_at 已回写

    // 冷却 0 语义：再触发一发（第二次 llm/usage 累计 calls=2 仍过阈）
    session!.append('llm/usage', {
      callId: 'c-alert-2',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);
    expect(busAlerts).toHaveLength(2); // 冷却 0 = 每 flush 可重触
  });
});
