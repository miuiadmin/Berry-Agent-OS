/**
 * 狗粮应用集成测试（2026-08-31 技术债批）——「第一个第三方视角应用」的落码形态：
 * entry 源码**只依据 docs/应用开发指南** 写成（作者视角——只 import 虚拟面
 * `typebox` 键，零宿主内部知识），经 local 源（overlay pkg 绝对路径）+ jiti
 * 装载期 import 门禁 + 形状校验 + config schema 校验 + Kahn 轮次全真路径装载。
 *
 * 验证面 = 作者按公开文档能做到什么：工具贡献 / 自定义总线词汇 / 自定义
 * durable 词汇 / config 注入 / ctx.fork 组织原语（子作用域注册面等价性）。
 *
 * 随写发现的文档缺口（已回写指南）：prompts/skills/命令三注册面 v1 全局
 * 作用域行专属——第三方行（挂 apps）装载期注册即拒载（COMPOSITION_ROW_
 * INVALID，D1/D3 注册面收口），指南原表格未标注。
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from './assembly.js';
import { getSessionEventType } from '../contracts/session-events.js';
import type { ToolDefinition } from '../contracts/tools.js';

/**
 * 狗粮 entry 源码（字符串形态随测试落盘 tmpdir——house 先例同款）。作者视角
 * 纪律：只用指南记载的面——typebox 虚拟键、inject 硬依赖、events 声明、
 * config schema、tools.register、registerSessionEventType、ctx.fork。
 */
const ENTRY_SOURCE = `
import { Type } from 'typebox';

export const name = 'dogfood';

// 硬依赖：tools（注册表服务——Kahn 轮次等它就绪）
export const inject = ['tools'];

// 行配置 schema（启动一次性校验；指南 §4）
export const config = Type.Object({
  marker: Type.Optional(Type.String()),
});

// 自定义总线词汇声明（装载阶段①统一登记——跨应用订阅无顺序洞）
export const events = [
  { name: 'dogfood/tick', mode: 'emit', note: '狗粮心跳' },
];

export default async function apply(ctx, cfg) {
  const tools = ctx.get('tools');
  const marker = typeof cfg?.marker === 'string' ? cfg.marker : 'dogfood';

  // 工具贡献（指南 §3）：参数 schema 同 typebox；effect 声明读性
  ctx.effect(() =>
    tools.register({
      name: 'dogfood_echo',
      description: '回显入参（狗粮应用）',
      parameters: Type.Object({ text: Type.String() }),
      effect: 'read',
      execute: async (args) => ({
        content: [{ type: 'text', text: String(args['text']) }],
      }),
    }),
  );

  // ctx.fork 组织原语（指南 §2）：子作用域持完整 ctx 面——其注册的工具
  // 同样进全局注册表（注册面等价性），行归属随父级联（execute 内可验 rowId）
  const panel = ctx.fork({ name: 'panel' });
  panel.effect(() =>
    tools.register({
      name: 'dogfood_panel',
      description: '由 fork 子作用域注册（组织原语狗粮）',
      parameters: Type.Object({}),
      effect: 'read',
      execute: async () => ({
        content: [{ type: 'text', text: 'row=' + String(ctx.rowId) }],
      }),
    }),
  );

  // 自定义 durable 词汇注册（指南 §3——appendEvent 的钥匙；ignorable 纪律）
  ctx.registerSessionEventType({
    type: 'dogfood/note',
    category: 'log-only',
    ignorable: true,
  });

  // config 注入可见性（marker 进闭包——由系统提示词外的工具面回显验证）
  ctx.effect(() =>
    tools.register({
      name: 'dogfood_marker',
      description: '披露行 config 注入的 marker（狗粮）',
      parameters: Type.Object({}),
      effect: 'read',
      execute: async () => ({
        content: [{ type: 'text', text: 'marker=' + marker }],
      }),
    }),
  );
}
`;

describe('狗粮应用：第三方视角全真装载（docs/应用开发指南 为唯一知识源）', () => {
  /** 活运行时清单（afterEach 逐个优雅关停——write-behind/:memory: 无悬挂） */
  const runtimes: Awaited<ReturnType<typeof createRuntime>>[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  });

  it('local 源装载：形状/词汇/工具三件/fork 子作用域注册/config 注入全通', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'dogfood-')));
    const appDir = join(root, 'dogfood-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'index.ts'), ENTRY_SOURCE);
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    // overlay 第三方行：pkg 绝对路径（local 源）+ apps 必填（挂应用作用域）+
    // carrier main（显式降格——registerSessionEventType 是 main 域同步编排面）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: dogfood\n    pkg: ${appDir}\n    apps: [chat]\n    sandbox: { carrier: main }\n    config: { marker: '狗粮-甲' }\n`,
    );

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      compositionDir,
    });
    runtimes.push(runtime);

    // 行激活：第三方行走 jiti 全真路径（import 门禁/形状校验/轮次激活）
    const row = runtime.appsService.list().find((r) => r.id === 'dogfood');
    expect(row?.status).toBe('activated');

    // 工具三件：主作用域两件 + fork 子作用域一件（注册面等价性）。挂 apps 的行
    // 注册落**应用域层**（D1 隐式路由）——读面 = listFor(appId)（全局层 ∪ 该域层）
    const chatTools = new Map(runtime.tools.listFor('chat').map((t) => [t.name, t]));
    const echo = chatTools.get('dogfood_echo') as ToolDefinition;
    const panel = chatTools.get('dogfood_panel') as ToolDefinition;
    const marker = chatTools.get('dogfood_marker') as ToolDefinition;
    expect(echo).toBeDefined();
    expect(panel).toBeDefined();
    expect(marker).toBeDefined();
    // execute 面直调（作者 API 契约：AgentToolResult.content 文本块）
    const panelResult = await panel.execute({}, { toolCallId: 'dogfood-panel' });
    expect(panelResult.content[0]).toMatchObject({ type: 'text', text: 'row=dogfood' }); // fork 继承律
    const echoResult = await echo.execute({ text: '你好' }, { toolCallId: 'dogfood-echo' });
    expect(echoResult.content[0]).toMatchObject({ type: 'text', text: '你好' });
    const markerResult = await marker.execute({}, { toolCallId: 'dogfood-marker' });
    expect(markerResult.content[0]).toMatchObject({ type: 'text', text: 'marker=狗粮-甲' }); // config 注入

    // 自定义总线词汇在册：emit 不抛 = 声明装载成功（拼错名会 EVENT_UNKNOWN）
    expect(() => runtime.ctx.emit('dogfood/tick')).not.toThrow();

    // 自定义 durable 词汇在册（注册钥匙可用——ignorable 重盖章形态）
    expect(getSessionEventType('dogfood/note')).toMatchObject({ category: 'log-only', ignorable: true });
  });
});
