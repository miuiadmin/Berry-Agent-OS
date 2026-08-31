/**
 * examples/ 目录装载冒烟（应用契约篇 §6.2 三件套纪律的验证面，2026-08-31
 * 第四十四批灵感 9）——examples 是全仓唯一不经 tsconfig/vitest/check-topology
 * 覆盖的 TS 目录，教学例腐化（API 演进后落盘例悄悄失效）只能靠装载面挡：
 * 本测试动态发现 examples/* 每一子目录，经**真装载器**（jiti 直载 + import
 * 门禁 + 形状校验 + config 校验 + Kahn 轮次）全量装载——新例入目录即自动
 * 纳管，无登记面可漏。
 *
 * 断言层次：形状装载收麦（行 activated）+ 例自述工具面真执行（行为级物证）+
 * 域路由正确（挂 chat 域非全局层）+ dispose 回卷零残骸（shutdown 后工具出册）。
 * 例自带 README 的两形态装载命令链由 docs 锚点与发布面（package.json files +
 * release 检视 must-in）共同担保，不在本测试面。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime } from './assembly.js';
import { getSessionEventType } from '../contracts/session-events.js';
import type { ToolDefinition } from '../contracts/tools.js';

/** 文件级数据目录钉扎（daemon-fullstack 先例 / G1 教训：防污染真实 ~/.berry） */
const dataRoot = mkdtempSync(join(realpathSync(tmpdir()), 'examples-smoke-data-'));
process.env['APP_DATA_DIR'] = dataRoot;

/** 仓库根（本文件在 src/app/ 下——上溯两级） */
const REPO_ROOT = realpathSync(join(import.meta.dirname, '..', '..'));

/** 全仓 examples 目录（三件套纪律的物产地） */
const EXAMPLES_DIR = join(REPO_ROOT, 'examples');

/** 发现全部教学例（有 index.ts 的子目录——新例入目录即被本测试纳管） */
function discoverExamples(): string[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(EXAMPLES_DIR, entry.name, 'index.ts')))
    .map((entry) => entry.name)
    .sort();
}

describe('examples/ 装载冒烟（教学例全量经真装载器——腐化即红）', () => {
  /** 活运行时清单（afterEach 逐个优雅关停——write-behind/:memory: 无悬挂） */
  const runtimes: Awaited<ReturnType<typeof createRuntime>>[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  });

  it('目录非空（首例 tool-echo 在册——目录被清空时本测试响亮）', () => {
    expect(discoverExamples()).toContain('tool-echo');
  });

  /** 全量装载一例：overlay 行挂官方 chat 应用域（教学例标准形态，README 命令链同款） */
  async function loadExample(exampleName: string) {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'examples-smoke-')));
    const compositionDir = join(root, 'composition');
    mkdirSync(compositionDir, { recursive: true });
    // overlay 第三方行：pkg 绝对路径（local 源直引）+ apps [chat] + carrier main
    // （教学例是 main 域同步编排面——与 dogfood 先例同形态）
    writeFileSync(
      join(compositionDir, 'overlay.yaml'),
      `rows:\n  - id: ${exampleName}\n    pkg: ${join(EXAMPLES_DIR, exampleName)}\n    apps: [chat]\n    sandbox: { carrier: main }\n`,
    );
    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace: root,
      compositionDir,
    });
    runtimes.push(runtime);
    return runtime;
  }

  it('每例装载收麦：行 activated 零失败（形状/门禁/config/轮次全过）', async () => {
    for (const exampleName of discoverExamples()) {
      const runtime = await loadExample(exampleName);
      const row = runtime.appsService.list().find((r) => r.id === exampleName);
      expect(row?.status, `例 ${exampleName} 应激活`).toBe('activated');
    }
  });

  it('tool-echo 三面物证：工具执行 + config 注入 + durable 词汇在册 + 域路由', async () => {
    const runtime = await loadExample('tool-echo');
    const tool = runtime.tools.listFor('chat').find((t) => t.name === 'tool_echo') as ToolDefinition | undefined;
    expect(tool).toBeDefined();
    // 域路由：挂 apps 行注册落应用域层——全局层不见（隔离正确的行为级物证）
    expect(runtime.tools.list().some((t) => t.name === 'tool_echo')).toBe(false);
    // 执行面：缺省前缀回显 + 总线广播不炸（词汇装载阶段①已登记）
    const result = await tool!.execute({ text: '你好' }, { toolCallId: 'examples-smoke-1' });
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'echo:你好' });
    // durable 词汇注册钥匙可用（ignorable 重盖章形态与 dogfood 同款）
    expect(getSessionEventType('tool-echo/note')).toMatchObject({ category: 'log-only', ignorable: true });
  });

  it('dispose 回卷零残骸：shutdown 后例工具出册（ctx.effect 挂注册的机制源验证）', async () => {
    const runtime = await loadExample('tool-echo');
    expect(runtime.tools.listFor('chat').some((t) => t.name === 'tool_echo')).toBe(true);
    const toolsRef = runtime.tools; // 服务对象引用存活于 ctx 之外——回卷后仍可读
    await runtime.shutdown(); // 内部 ctx.dispose → apps 锚 LIFO 回卷 → effect 注销
    expect(toolsRef.listFor('chat').some((t) => t.name === 'tool_echo')).toBe(false);
  });
});
