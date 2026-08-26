/**
 * L4 admin 单元测试——写类动词六工具的工具层行为：
 * 审批对形态（schema 必填钉死成对 / 值 ∈ 目标档闭集）、统一闸三态（拒绝 →
 * isError 不调服务 / allowed-once → 调服务）、六工具各自渲染与导线（含
 * uninstall_inspect 的 read 档无审批 + 指引尾行）。
 *
 * 服务面与审批面均用本件消费面接口（PluginsManageFace/ApprovalAskFace）的
 * 测试替身——形状由宿主装配保证，本文件只锁工具层闸序与呈现语义。升权目标
 * 词汇的单一归宿锁（admin 镜像常量 ≡ safety ESCALATION_TARGETS）住在
 * app/plugins.test.ts——admin 边只有 contracts，app 是两侧唯一合法会师点。
 */

import { describe, expect, it } from 'vitest';
import { SANDBOX_ESCALATION_INVALID, TOOL_ARGUMENTS_INVALID } from '../contracts/errors.js';
import { Value } from '../contracts/typebox.js';
import type { ToolCtx } from '../contracts/tools.js';
import {
  type ApprovalAskFace,
  type InstallReportView,
  type PluginsManageFace,
  createPluginsConfigureTool,
  createPluginsInstallTool,
  createPluginsReloadTool,
  createPluginsToggleTool,
  createPluginsUninstallInspectTool,
  createPluginsUpdateTool,
} from './write-tools.js';

/** 最小工具执行上下文（toolCallId 透传进审批请求——审计腿的关联键） */
const CTX: ToolCtx = { toolCallId: 'tc-1' };

/** 合法审批对（五写词共用的最小放行面） */
const PAIR = { sandbox_permissions: 'workspace-write', justification: '为测试而装' };

/** 取纯文本结果（本件工具均单文本块） */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  return result.content[0]!.text ?? '';
}

/** 服务面测试替身：六面全记录调用；返回值可逐面脚本覆盖 */
function fakeManage(scripted: {
  install?: InstallReportView;
  toggle?: boolean;
  configure?: { config: Record<string, unknown>; ring1RestartRequired?: boolean };
  reload?: 'queued' | 'done-clean' | 'done-failed' | 'error';
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const plugins: PluginsManageFace = {
    async install(ref, opts) {
      calls.push({ method: 'install', args: [ref, opts] });
      return scripted.install ?? { id: 'demo', source: 'npm', pluginRef: 'demo', message: 'npm 源已安装（fake）' };
    },
    toggle(id) {
      calls.push({ method: 'toggle', args: [id] });
      return scripted.toggle ?? true;
    },
    async update(id) {
      calls.push({ method: 'update', args: [id] });
      return { id, source: 'npm', pluginRef: id, message: 'npm 源已重装（fake）' };
    },
    async configure(id, patch) {
      calls.push({ method: 'configure', args: [id, patch] });
      return {
        id,
        config: scripted.configure?.config ?? { ...patch },
        appliedKeys: Object.keys(patch),
        ring1RestartRequired: scripted.configure?.ring1RestartRequired ?? false,
        message: '配置已写入 overlay（fake）',
      };
    },
    async requestReload() {
      calls.push({ method: 'requestReload', args: [] });
      switch (scripted.reload) {
        case 'queued':
          return { status: 'queued' as const };
        case 'done-failed':
          return { status: 'done' as const, failed: ['bad-row'] };
        case 'error':
          return { status: 'error' as const, message: 'overlay 解析失败' };
        default:
          return { status: 'done' as const, failed: [] };
      }
    },
    async uninstall(id, opts) {
      calls.push({ method: 'uninstall', args: [id, opts] });
      return {
        id,
        source: 'npm',
        status: 'activated',
        pluginRef: id,
        sharedRows: [],
        dataDir: '/data/plugins/demo',
        events: { origin: 'ledger' as const, names: [] },
        warnings: [],
      };
    },
  };
  return { plugins, calls };
}

/** 审批面测试替身：记录 ask 实参，outcome 可脚本 */
function fakeApproval(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') {
  const asks: Array<{ summary: string; reason?: string; toolName?: string; toolCallId?: string }> = [];
  const approval: ApprovalAskFace = {
    async ask(req) {
      asks.push(req);
      return outcome;
    },
  };
  return { approval, asks };
}

/* ---------------- 审批对：schema 必填钉死成对 ---------------- */

describe('审批对 schema 形态（五写词共面）', () => {
  it('五写词参数面：缺审批对任一键 / justification 空串 → 守门段即拒（必填钉死「成对」）', () => {
    const { plugins } = fakeManage({});
    const { approval } = fakeApproval('allowed-once');
    const tools = [
      createPluginsInstallTool(plugins, approval),
      createPluginsUpdateTool(plugins, approval),
      createPluginsToggleTool(plugins, approval),
      createPluginsConfigureTool(plugins, approval),
      createPluginsReloadTool(plugins, approval),
    ];
    for (const tool of tools) {
      // 完整实参面（各工具自己的业务键 + 审批对）全部过 schema
      const fullArgs: Record<string, unknown>[] = [
        { source: 'demo-pkg', ...PAIR },
        { id: 'demo', ...PAIR },
        { id: 'demo', ...PAIR },
        { id: 'demo', config: { a: 1 }, ...PAIR },
        { ...PAIR },
      ];
      const idx = tools.indexOf(tool);
      expect(Value.Check(tool.parameters!, fullArgs[idx]!), `${tool.name} 完整实参应过 schema`).toBe(true);
      // 缺 sandbox_permissions / 缺 justification / 空串 justification 全拒
      const bare = { ...fullArgs[idx]! } as Record<string, unknown>;
      delete bare.sandbox_permissions;
      expect(Value.Check(tool.parameters!, bare), `${tool.name} 缺 sandbox_permissions 应拒`).toBe(false);
      const noJust = { ...fullArgs[idx]! } as Record<string, unknown>;
      delete noJust.justification;
      expect(Value.Check(tool.parameters!, noJust), `${tool.name} 缺 justification 应拒`).toBe(false);
      const emptyJust = { ...fullArgs[idx]!, justification: '' };
      expect(Value.Check(tool.parameters!, emptyJust), `${tool.name} 空串 justification 应拒`).toBe(false);
    }
  });
});

/* ---------------- 统一闸：值校验 + 审批三态 ---------------- */

describe('生命周期档统一闸', () => {
  it('目标档值 ∉ 闭集：SANDBOX_ESCALATION_INVALID 响亮拒绝——审批未问、服务未调', async () => {
    const { plugins, calls } = fakeManage({});
    const { approval, asks } = fakeApproval('allowed-once');
    const tool = createPluginsInstallTool(plugins, approval);
    await expect(
      tool.execute({ source: 'demo-pkg', sandbox_permissions: 'read-only', justification: 'x' }, CTX),
    ).rejects.toMatchObject({ code: SANDBOX_ESCALATION_INVALID });
    expect(asks).toEqual([]); // 值非法在问人之前响
    expect(calls).toEqual([]); // 动作未发生
  });

  it('审批请求载荷：summary 带动作与对象、reason 带目标档与理由、toolName/toolCallId 透传（审计腿关联键）', async () => {
    const { plugins } = fakeManage({});
    const { approval, asks } = fakeApproval('allowed-once');
    await createPluginsInstallTool(plugins, approval).execute(
      { source: 'demo-pkg', sandbox_permissions: 'danger-full-access', justification: '装官方新件' },
      CTX,
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]!.summary).toContain('plugins_install');
    expect(asks[0]!.summary).toContain('demo-pkg');
    expect(asks[0]!.reason).toContain('danger-full-access');
    expect(asks[0]!.reason).toContain('装官方新件');
    expect(asks[0]!.toolName).toBe('plugins_install');
    expect(asks[0]!.toolCallId).toBe('tc-1');
  });

  it('审批三拒态（rejected/cancelled/unavailable）：isError 结果 + 不重试指引——服务面零调用', async () => {
    for (const outcome of ['rejected', 'cancelled', 'unavailable'] as const) {
      const { plugins, calls } = fakeManage({});
      const { approval } = fakeApproval(outcome);
      const result = await createPluginsInstallTool(plugins, approval).execute({ source: 'demo-pkg', ...PAIR }, CTX);
      expect(result.isError, `outcome=${outcome}`).toBe(true);
      const text = textOf(result);
      expect(text).toContain(outcome);
      expect(text).toContain('未执行');
      expect(text).toContain('不要重试');
      expect(calls).toEqual([]); // 拒绝 = 动作未发生
    }
  });
});

/* ---------------- 六工具各面 ---------------- */

describe('plugins_install', () => {
  it('allowed-once：服务调用透传（source + gitRef 可选省略）+ 渲染带行 id 与 reload 链提示', async () => {
    const { plugins, calls } = fakeManage({});
    const { approval } = fakeApproval('allowed-once');
    const text = textOf(
      await createPluginsInstallTool(plugins, approval).execute(
        { source: 'git+https://example.com/a/b.git', gitRef: 'v2', ...PAIR },
        CTX,
      ),
    );
    expect(calls).toEqual([{ method: 'install', args: ['git+https://example.com/a/b.git', { gitRef: 'v2' }] }]);
    expect(text).toContain('npm 源已安装（fake）');
    expect(text).toContain('行 id：demo');
    expect(text).toContain('plugins_reload'); // 装好 ≠ 生效——链式提示
  });
});

describe('plugins_update / plugins_toggle', () => {
  it('update：allowed-once 后调 update(id)，渲染带重载提示', async () => {
    const { plugins, calls } = fakeManage({});
    const { approval } = fakeApproval('allowed-once');
    const text = textOf(await createPluginsUpdateTool(plugins, approval).execute({ id: 'demo', ...PAIR }, CTX));
    expect(calls).toEqual([{ method: 'update', args: ['demo'] }]);
    expect(text).toContain('已重装');
    expect(text).toContain('plugins_reload');
  });

  it('toggle 两分支渲染：回传 true = 现已禁用（真·可卸提示）/ false = 现已启用', async () => {
    for (const [nowDisabled, marker] of [
      [true, '现已禁用'],
      [false, '现已启用'],
    ] as const) {
      const { plugins } = fakeManage({ toggle: nowDisabled });
      const { approval } = fakeApproval('allowed-once');
      const text = textOf(await createPluginsToggleTool(plugins, approval).execute({ id: 'demo', ...PAIR }, CTX));
      expect(text).toContain(marker);
      expect(text).toContain('plugins_reload');
    }
  });
});

describe('plugins_configure', () => {
  it('空 patch 先于审批响：TOOL_ARGUMENTS_INVALID 且审批未问（不浪费一次人批）', async () => {
    const { plugins, calls } = fakeManage({});
    const { approval, asks } = fakeApproval('allowed-once');
    await expect(
      createPluginsConfigureTool(plugins, approval).execute({ id: 'demo', config: {}, ...PAIR }, CTX),
    ).rejects.toMatchObject({ code: TOOL_ARGUMENTS_INVALID });
    expect(asks).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('allowed-once：configure(id, patch) 透传 + 渲染合并后全量配置；Ring 1 行带重启提示分支', async () => {
    const { plugins, calls } = fakeManage({
      configure: { config: { keep: 1, changed: 2 }, ring1RestartRequired: true },
    });
    const { approval } = fakeApproval('allowed-once');
    const text = textOf(
      await createPluginsConfigureTool(plugins, approval).execute({ id: 'demo', config: { changed: 2 }, ...PAIR }, CTX),
    );
    expect(calls).toEqual([{ method: 'configure', args: ['demo', { changed: 2 }] }]);
    expect(text).toContain('{"keep":1,"changed":2}'); // 合并后全量（未列出键保持）
    expect(text).toContain('重启'); // Ring 1 分支
  });
});

describe('plugins_reload', () => {
  it('三态渲染：queued 排队说明 / done 失败行点名 / done 干净 / error isError 且旧装配未动', async () => {
    // queued：run 进行中排队
    const q = fakeManage({ reload: 'queued' });
    const qText = textOf(
      await createPluginsReloadTool(q.plugins, fakeApproval('allowed-once').approval).execute({ ...PAIR }, CTX),
    );
    expect(qText).toContain('排队');
    expect(qText).toContain('无需再次请求');
    // done 带失败行：逐行点名 + 修复指引
    const f = fakeManage({ reload: 'done-failed' });
    const fText = textOf(
      await createPluginsReloadTool(f.plugins, fakeApproval('allowed-once').approval).execute({ ...PAIR }, CTX),
    );
    expect(fText).toContain('bad-row');
    expect(fText).toContain('plugins_list');
    // done 干净
    const ok = fakeManage({ reload: 'done-clean' });
    const okText = textOf(
      await createPluginsReloadTool(ok.plugins, fakeApproval('allowed-once').approval).execute({ ...PAIR }, CTX),
    );
    expect(okText).toContain('重载完成');
    expect(okText).not.toContain('失败行');
    // error：isError + 旧装配未动
    const e = fakeManage({ reload: 'error' });
    const eResult = await createPluginsReloadTool(e.plugins, fakeApproval('allowed-once').approval).execute(
      { ...PAIR },
      CTX,
    );
    expect(eResult.isError).toBe(true);
    expect(textOf(eResult)).toContain('overlay 解析失败');
    expect(textOf(eResult)).toContain('旧装配未动');
  });
});

describe('plugins_uninstall_inspect（read 档——无审批面）', () => {
  it('无审批直接查：uninstall(id, {mode:"inspect"}) 实参 + 报告渲染 + 执行权在人指引尾行', async () => {
    const { plugins, calls } = fakeManage({});
    const tool = createPluginsUninstallInspectTool(plugins);
    expect(tool.effect).toBe('read'); // 只读零副作用——审批不适用于本件
    const text = textOf(await tool.execute({ id: 'demo' }, CTX));
    expect(calls).toEqual([{ method: 'uninstall', args: ['demo', { mode: 'inspect' }] }]);
    expect(text).toContain('卸载预检');
    expect(text).toContain('数据域');
    expect(text).toContain('/plugin-uninstall demo --confirm'); // 指令可照抄
    expect(text).toContain('你不可执行卸载'); // 边界明示（模型知道 execute 不归它）
  });
});
