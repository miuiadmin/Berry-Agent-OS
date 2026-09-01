/**
 * L5 app — 结构自治验收轨（第四十三批「自写应用指路收口」验收判据的机器化）。
 *
 * 全链 = apps-quickstart 技能教的模型路逐段走真：写 workspace 应用 →
 * appsService.install（local 源，仓库态零生效）→ mount（写组合行）→
 * reload（激活）→ 新工具注册且可调（试调）。与 dogfood.test 的分野：
 * dogfood 验 overlay 直写装载（文件面），本轨验**服务面全链**（install→
 * mount→reload 三动词经真 AppsManageFace——模型在真会话里走的正是这条路）。
 *
 * carrier 取缺省（闰一 = external 进程墙）：模型路的真实缺省档——验收轨
 * 必须验产品真形态，不为测试便利降格 main。
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../contracts/tools.js';
import { createRuntime } from './assembly.js';
import type { AppRuntime } from './assembly.js';

/** 最小工具应用入口（apps-quickstart 骨架同款——只 import 虚拟面，AgentToolResult 正形） */
const APP_ENTRY = `
import { Type } from 'typebox';

export const name = 'selfbuild-demo';
export const inject = ['tools'];

export default async function apply(ctx: any) {
  const tools = ctx.get('tools');
  ctx.effect(() =>
    tools.register({
      name: 'selfbuild_echo',
      description: '结构自治验收回显',
      parameters: Type.Object({ text: Type.String() }),
      effect: 'read',
      async execute(args: Record<string, unknown>) {
        return { content: [{ type: 'text', text: '自写应用已上岗：' + String(args['text']) }] };
      },
    }),
  );
}
`;

/** chat 域工具表（listFor 读面 = 全局层 ∪ 该应用域层） */
function chatTools(runtime: AppRuntime): Map<string, ToolDefinition> {
  return new Map(runtime.tools.listFor('chat').map((t) => [t.name, t]));
}

describe('结构自治全链（自写应用验收轨——写 workspace → install → mount → reload → 试调）', () => {
  /** 活运行时清单（afterEach 逐个优雅关停——write-behind/:memory: 无悬挂） */
  const runtimes: Awaited<ReturnType<typeof createRuntime>>[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  });

  it('模型路全链：仓库态零生效 → 挂载写行 → reload 激活 → 工具注册可调（缺省 external 载体）', async () => {
    // 布景：workspace（模型可写根）+ compositionDir（overlay/装机账本/装机子树根，全隔离）
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'selfbuild-')));
    const workspace = join(root, 'ws');
    const appDir = join(workspace, 'my-tool-app'); // workspace 子目录 = 模型路第一步的落点
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'index.ts'), APP_ENTRY);

    const runtime = await createRuntime({
      dbPath: ':memory:',
      workspace,
      compositionDir: join(root, 'data'),
    });
    runtimes.push(runtime);

    // ---- 0. 装机前基线：工具不在 chat 域 ----
    expect(chatTools(runtime).has('selfbuild_echo')).toBe(false);

    // ---- 1. install（local 源）：仓库态零生效——行不进装载，工具不出场 ----
    const report = await runtime.appsService.install(appDir);
    expect(report.source).toBe('local');
    expect(report.appRef).toBe(appDir); // local 直引（绝对化归一）
    expect(chatTools(runtime).has('selfbuild_echo')).toBe(false); // 零生效的硬判据

    // ---- 2. mount：写组合行（apps 必填——挂 chat 应用域）----
    const mountReport = await runtime.appsService.mount(report.id, { apps: ['chat'] });
    expect(mountReport.id).toBe(report.id); // 行 id 缺省 = 装机推导 id

    // ---- 3. reload：激活（两态闭环的生效腿——缺省 external 载体 = 进程墙真形态）----
    const reloadResult = await runtime.reload();
    expect(reloadResult.payload?.failed ?? []).not.toContain(report.id);
    const row = runtime.appsService.list().find((r) => r.id === report.id);
    expect(row?.status).toBe('activated');

    // ---- 4. 试调：新工具注册在 chat 域且真能调（验收判据最后一步）----
    const tool = chatTools(runtime).get('selfbuild_echo');
    expect(tool).toBeDefined();
    const result = await tool!.execute({ text: '验收' }, { toolCallId: 'tc-selfbuild' });
    expect(
      result.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    ).toContain('自写应用已上岗：验收');

    // ---- 5. 卸载半边回卷：unmount + reload 后工具离场（可逆性——反熵律的机制面）----
    await runtime.appsService.unmount(report.id);
    await runtime.reload();
    expect(chatTools(runtime).has('selfbuild_echo')).toBe(false);
  }, 60_000); // external 载体 fork + 装载全链——放宽单测超时（缺省 5s 不够进程墙起落）
});
