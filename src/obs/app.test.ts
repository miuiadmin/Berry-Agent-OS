/**
 * L3 obs — 组合根全栈测试（契约篇 §6.9 刀一：obs 行默认层装载 + session/event
 * 真总线摄取 + flush 落库 + obs_query 工具回执——mock 零介入：宿主侧直接向
 * 聚焦会话 append 核心事件，onLiveEvent 总线镜像驱动全链）。
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppSqliteFace } from '../persist/index.js';
import { createRuntime, type AppRuntime } from '../app/assembly.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';

const runtimes: AppRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
});

/** 等待 obs flush 窗（overlay config flushMs=60——测试缝） */
const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 捕获 stderr 结构化日志行（warn 留痕断言面——child logger 共享根 sink 闭包，
 * 行作用域的 warn 也走同一 process.stderr.write）。
 */
const captureStderr = (): { lines: string[]; restore: () => void } => {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
};

/** 递归定位 runtime 数据域里的 rollup.db（行 rowId 推法不进测试——文件面实证） */
const findRollupDb = (dir: string): string => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findRollupDb(path);
      if (found !== '') return found;
    } else if (entry.name === 'rollup.db') return path;
  }
  return '';
};

/**
 * obs_query 文本表 → 首度量格（llm 表 groupBy 空 = 无维列，数据行首格即 calls；
 * 渲染面见 renderRollupTable：header 与数据行均 ' | ' 连接）。
 */
const llmCallsCell = (result: AgentToolResult): string => {
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? '';
  return (text.split('\n')[1] ?? '').split(' | ')[0] ?? '';
};

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

  it('刀二告警全栈：/obs-alerts add → 事件摄取 → 内联执法 → obs/alert 总线 + ui 通知（规范触发四件）', async () => {
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

    // 触发四件断言：①obs/alert 总线载荷（metric/agg/value/threshold/window）②ui.notify
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

describe('obs 观测件：复盘 20260901 批回归锁（畸形信封 / 通知面异常隔离 / 停摄取纪律 / 无头冷却）', () => {
  it('畸形信封防御：time 缺失信封在门口拦下（warn 留痕）——不毒化整批 flush、不误触停摄取', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-badenv-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);
    const captured = captureStderr();

    // 总线直发畸形信封（无 time——发射方契约违规形态；goal.test 类 harness 直发同款）
    runtime.ctx.emit('session/event', {
      sessionId: 's-bad',
      event: {
        type: 'llm/usage',
        seq: 1,
        data: { callId: 'c', model: 'm', priority: 'foreground', usage: { input: 1, output: 1 } },
      },
    });
    // 正常事件照常摄取（真会话事件——time 恒在）
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
      callId: 'c-good',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);
    captured.restore();

    // 门口拦下：warn 留痕 + 正常事件已落库（HEAD：NaN 小时桶毒化整批 → 停摄取 → 全丢）
    expect(captured.lines.some((l) => l.includes('跳过畸形信封'))).toBe(true);
    expect(captured.lines.some((l) => l.includes('停摄取'))).toBe(false);
    const obsQuery = runtime.tools.get('obs_query') as ToolDefinition;
    const result = await obsQuery.execute({ metric: 'llm', groupBy: [] }, { toolCallId: 'obs-badenv' });
    expect(llmCallsCell(result)).toBe('1');
  });

  it('T-1 通知面异常隔离（3b952b9 回归锁）：ui.notify 通道面炸 → warn 留痕 + 事务照常提交 + 摄取续流', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-notify-boom-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);

    const busAlerts: unknown[] = [];
    runtime.ctx.on('obs/alert', (payload: unknown) => busAlerts.push(payload));
    const notifies: string[] = [];
    runtime.ui.attach({
      id: 'rec',
      notify: (text: string) => notifies.push(text),
      setStatus: () => {},
      confirm: async () => true,
    });
    // 规则先行（spy 安装前——命令面 notify 走真通道）
    expect(await runtime.channels.commands.dispatch('/obs-alerts add sum llm.calls >= 1 24 0')).toBe('ok');

    // 通道面故障注入：ui.notify 整面抛错（fireAlert 的 try/catch 文档位——兜通道实现炸）
    const boom = vi.spyOn(runtime.ui, 'notify').mockImplementation(() => {
      throw new Error('notify 通道面炸');
    });
    const captured = captureStderr();

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
      callId: 'c-boom',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);
    // 第二发：摄取续流 + 冷却 0 再触发（每次触发独立隔离——一次炸不停机）
    session!.append('llm/usage', {
      callId: 'c-boom-2',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);
    captured.restore();
    boom.mockRestore();

    // 三断言：①warn 留痕（隔离不静默）②emit 与 last_fired_at 照常（事务提交）③摄取续流（二连发）
    expect(captured.lines.some((l) => l.includes('告警通知面异常'))).toBe(true);
    expect(captured.lines.some((l) => l.includes('停摄取'))).toBe(false);
    expect(busAlerts.length).toBeGreaterThanOrEqual(2);
    expect(await runtime.channels.commands.dispatch('/obs-alerts list')).toBe('ok');
    expect(notifies.at(-1) ?? '').not.toContain('未触发'); // last_fired_at 已回写
  });

  it('T-1 停摄取纪律锁：自管库写失败（写锁被占）→ 停摄取 + warn——此前已提交批次不丢、后续事件不进', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-stop-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    // flushBatch=1：每信封同步 flush（定时器不介入）+ flushMs 长窗；
    // busyTimeoutMs=50（基建大扫 #17）：撞锁等待从缺省 5s 降档毫秒级——场景
    // 路径不变（等 busy_timeout 到点 BUSY → 停摄取），慢机 CI 不再被硬等拖向
    // testTimeout 帽（修偏前实测单测 9.54s = 全量壁钟最大单项）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      'rows:\n  - id: obs\n    config: { flushBatch: 1, flushMs: 600000, busyTimeoutMs: 50 }\n',
    );

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);
    // 通知录音后端（#15 三面披露断言面——/obs 与 /obs-alerts list 的 notify 文案）
    const notifies: string[] = [];
    runtime.ui.attach({
      id: 'rec',
      notify: (text: string) => notifies.push(text),
      setStatus: () => {},
      confirm: async () => true,
    });
    const session = runtime.session;
    expect(session).toBeDefined();
    session!.append('request/header', {
      config: {},
      systemPrompt: 'x',
      toolSchemas: [],
      reason: 'initial',
      app: 'chat',
    });
    // 第一笔：无锁正常提交（同步链：append → 总线 → flush → apply 落库——首笔成功
    // 即 lastFlushAt 已立，#15 披露条的「数据截至」有时刻可标）
    session!.append('llm/usage', {
      callId: 'c-ok',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });

    // 占写锁（同进程第二连接持写事务跨整个断言窗——apply 撞锁等 busy_timeout
    // 到点 BUSY〔已降档 50ms〕；raw 句柄经 persist 正路 face 取——
    // better-sqlite3 裸导入仅 persist 允许）
    const dbPath = findRollupDb(root);
    expect(dbPath).not.toBe('');
    const holder = createAppSqliteFace().openDatabase(dbPath);
    holder.pragma('busy_timeout = 100');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('UPDATE alerts SET enabled = enabled').run();

    const captured = captureStderr();
    // 第二笔：flush → apply → 写锁等待 50ms（#17 降档）→ BUSY → 停摄取 + warn
    session!.append('llm/usage', {
      callId: 'c-busy',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    captured.restore();
    holder.exec('COMMIT');
    holder.close();

    // 第三笔：已停摄取——静默丢弃（不再撞锁也不再落库）
    session!.append('llm/usage', {
      callId: 'c-after',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(100);

    expect(captured.lines.some((l) => l.includes('停摄取'))).toBe(true);
    // 快赢#3 处置可行动锁：停摄取 warn 必须指向真实库文件（既有处置 = 删库
    // 重建——运维手册 §1 同源；文案回退到引用挂账未落码的 /obs-rebuild 即红）
    expect(captured.lines.some((l) => l.includes(dbPath))).toBe(true);
    const obsQuery = runtime.tools.get('obs_query') as ToolDefinition;
    const result = await obsQuery.execute({ metric: 'llm', groupBy: [] }, { toolCallId: 'obs-stop' });
    // 恰 1 次：第一笔在；第二笔事务回滚不在；第三笔停摄取后不进
    expect(llmCallsCell(result)).toBe('1');

    // #15 停摄取披露三面：①obs_query 回执尾行 ②/obs 总览头部 ③/obs-alerts list
    // ——停态对消费面可见（首笔已成功落账 →「数据截至」标时刻而非「未落账」）
    expect(JSON.stringify(result.content)).toContain('摄取已停');
    expect(JSON.stringify(result.content)).toContain('数据截至');
    expect(JSON.stringify(result.content)).not.toContain('未落账');
    expect(await runtime.channels.commands.dispatch('/obs')).toBe('ok');
    expect(notifies.at(-1) ?? '').toContain('摄取已停');
    expect(notifies.at(-1) ?? '').toContain('数据截至');
    expect(await runtime.channels.commands.dispatch('/obs-alerts list')).toBe('ok');
    expect(notifies.at(-1) ?? '').toContain('摄取已停');
  }, 20_000);

  it('R-2 无头不耗冷却：无 ui 后端（headless）→ 整笔跳过（不回写/不 emit/不 notify）；观众到场后下次 flush 重发', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-headless-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);
    // 无任何 ui 后端（headless run/tick 形态）——notify 广播空转

    const busAlerts: unknown[] = [];
    runtime.ctx.on('obs/alert', (payload: unknown) => busAlerts.push(payload));
    expect(await runtime.channels.commands.dispatch('/obs-alerts add sum llm.calls >= 1 24 0')).toBe('ok');

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
      callId: 'c-headless',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);

    // 无头：整笔跳过——零 emit、冷却未消耗（HEAD：先评先写 → 观众缺席的静默丢警）
    expect(busAlerts).toHaveLength(0);

    // 观众到场（后端 attach——fire 时点探针，晚到不误事）
    const notifies: string[] = [];
    runtime.ui.attach({
      id: 'rec',
      notify: (text: string) => notifies.push(text),
      setStatus: () => {},
      confirm: async () => true,
    });
    expect(await runtime.channels.commands.dispatch('/obs-alerts list')).toBe('ok');
    expect(notifies.at(-1) ?? '').toContain('未触发'); // last_fired_at 仍未写

    // 再进一发（calls=2 仍过阈）→ 观众在场 → 正常触发四件
    session!.append('llm/usage', {
      callId: 'c-audience',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);
    expect(busAlerts).toHaveLength(1);
    expect(notifies.some((n) => n.includes('观测告警'))).toBe(true);
  });
});

describe('obs 告警留账（成熟度扫描 20260901 P1-12）：触发第四件 alerts.jsonl', () => {
  /** 递归定位 runtime 数据域里的 alerts.jsonl（findRollupDb 同款——文件面实证） */
  const findAlertsJsonl = (dir: string): string => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findAlertsJsonl(path);
        if (found !== '') return found;
      } else if (entry.name === 'alerts.jsonl') return path;
    }
    return '';
  };

  it('触发即追写一行 JSON：信封字段 + firedAt + op 齐备（观众在场形态）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-ledger-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);
    const notifies: string[] = [];
    runtime.ui.attach({
      id: 'rec',
      notify: (text: string) => notifies.push(text),
      setStatus: () => {},
      confirm: async () => true,
    });
    expect(await runtime.channels.commands.dispatch('/obs-alerts add sum llm.calls >= 1 24 0')).toBe('ok');

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
      callId: 'c-ledger',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);

    // 留账第四件：alerts.jsonl 一行 JSON——obs/alert 信封负载 + firedAt + op
    const ledgerPath = findAlertsJsonl(root);
    expect(ledgerPath).not.toBe('');
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1); // 单触发单行
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      metric: 'llm.calls',
      agg: 'sum',
      value: 1,
      threshold: 1,
      windowHours: 24,
      op: '>=',
    });
    expect(typeof record.ruleId).toBe('number'); // 规则 id = 库生成整数（AlertRule.id）
    expect(typeof record.firedAt).toBe('string'); // ISO 时刻——事后取证的锚
  });

  it('留账 best-effort：追写炸（路径被目录占位）→ warn 留痕 + 事务照常（emit 与 last_fired_at 不丢）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-ledger-boom-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);
    const busAlerts: unknown[] = [];
    runtime.ctx.on('obs/alert', (payload: unknown) => busAlerts.push(payload));
    const notifies: string[] = [];
    runtime.ui.attach({
      id: 'rec',
      notify: (text: string) => notifies.push(text),
      setStatus: () => {},
      confirm: async () => true,
    });
    expect(await runtime.channels.commands.dispatch('/obs-alerts add sum llm.calls >= 1 24 0')).toBe('ok');

    // 故障注入：alerts.jsonl 路径被目录占位——appendFileSync 必炸（写文件遇目录）
    const ledgerDir = findRollupDb(root).replace(/rollup\.db$/, 'alerts.jsonl');
    mkdirSync(ledgerDir, { recursive: true });
    const captured = captureStderr();

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
      callId: 'c-ledger-boom',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);
    captured.restore();

    // best-effort 语义：留账炸不炸事务——①emit 照常 ②last_fired_at 照常（非「未触发」）③warn 留痕
    expect(busAlerts).toHaveLength(1);
    expect(await runtime.channels.commands.dispatch('/obs-alerts list')).toBe('ok');
    expect(notifies.at(-1) ?? '').not.toContain('未触发');
    expect(captured.lines.some((l) => l.includes('留账'))).toBe(true);
  });

  it('无头整笔跳过不写账（R-2 整笔一致——留账是第四件同生共死）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-ledger-headless-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);
    // 无 ui 后端（headless）——触发件整笔跳过
    expect(await runtime.channels.commands.dispatch('/obs-alerts add sum llm.calls >= 1 24 0')).toBe('ok');

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
      callId: 'c-ledger-headless',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);

    // 无观众：零留账文件（整笔跳过含第四件——operator 回屏后重发时补账）
    expect(findAlertsJsonl(root)).toBe('');
  });
});

describe('obs 观测健康面（成熟度扫描 20260901 P1-11）：obs-health 服务与停摄取态', () => {
  it('装载即 provide：ingesting true；首笔 flush 后 lastFlushAt 立值；行禁用 → tryGet 缺席', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-health-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    writeFileSync(join(compositionDir, 'overlay.yaml'), 'rows:\n  - id: obs\n    config: { flushMs: 60 }\n');

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);

    // 默认层第十五行装载 → 官方名位单段名 obs-health 经系统区表对宿主读链可见
    const face = runtime.ctx.tryGet<{ ingesting(): boolean; lastFlushAt(): number | undefined }>('obs-health');
    expect(face).toBeDefined();
    expect(face!.ingesting()).toBe(true); // 摄取中
    expect(face!.lastFlushAt()).toBeUndefined(); // 未 flush 过 = '(未落账)' 语义的数据源

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
      callId: 'c-health',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    await settle(300);
    expect(typeof face!.lastFlushAt()).toBe('number'); // 首笔落账 → 数据截至锚立值

    // 行禁用形态：provide 随行作用域回卷缺席（键缺席 = 无信息不报红——webui/doctor 判读语义）。
    // 先显式收首个 runtime 再起新形——roleRegistry 单例禁同进程双活（daemon 批
    // M8 定型纪律）；从 runtimes 摘除防 afterEach 双 shutdown
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await runtime.shutdown();
    const root2 = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-health-off-')));
    const compositionDir2 = join(root2, 'composition');
    mkdirSync(compositionDir2, { recursive: true });
    writeFileSync(join(compositionDir2, 'overlay.yaml'), 'rows:\n  - id: obs\n    disabled: true\n');
    const runtime2 = await createRuntime({ dbPath: ':memory:', workspace: root2, compositionDir: compositionDir2 });
    runtimes.push(runtime2);
    expect(runtime2.ctx.tryGet('obs-health')).toBeUndefined();
  });

  it('停摄取后健康面翻转：ingesting false + lastFlushAt 冻结在末次成功 flush（T-1 占锁手法复用）', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'obs-health-stop-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    // flushBatch=1 同步 flush + busyTimeoutMs=50（撞锁等待毫秒级降档——停摄取场景路）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      'rows:\n  - id: obs\n    config: { flushBatch: 1, flushMs: 600000, busyTimeoutMs: 50 }\n',
    );

    const runtime = await createRuntime({ dbPath: ':memory:', workspace: root, compositionDir });
    runtimes.push(runtime);
    const face = runtime.ctx.tryGet<{ ingesting(): boolean; lastFlushAt(): number | undefined }>('obs-health');
    expect(face).toBeDefined();

    const session = runtime.session;
    expect(session).toBeDefined();
    session!.append('request/header', {
      config: {},
      systemPrompt: 'x',
      toolSchemas: [],
      reason: 'initial',
      app: 'chat',
    });
    // 第一笔：无锁正常提交（lastFlushAt 立值）
    session!.append('llm/usage', {
      callId: 'c-hok',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    const before = face!.lastFlushAt();
    expect(typeof before).toBe('number');

    // 占写锁 → 第二笔 flush 撞 BUSY → 停摄取（闩置位）
    const dbPath = findRollupDb(root);
    const holder = createAppSqliteFace().openDatabase(dbPath);
    holder.pragma('busy_timeout = 100');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('UPDATE alerts SET enabled = enabled').run();
    session!.append('llm/usage', {
      callId: 'c-hbusy',
      model: 'faux/m1',
      priority: 'foreground',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    holder.exec('COMMIT');
    holder.close();
    await settle(100);

    // 健康面翻转：ingesting false（doctor 判读红项的数据源）+ lastFlushAt 停在末次成功
    expect(face!.ingesting()).toBe(false);
    expect(face!.lastFlushAt()).toBe(before);
  }, 20_000);
});
