/**
 * app — 系统助手官方件测试（第八十五批批 E，价值主张篇/核心命题篇 §3.5）。
 *
 * 应答三路（mock 只停在模型/状态边界——结构窄面假身）：①凭证缺失零 LLM 直答
 * 引导（describeProviderFailure 同源转述）②凭证在位 complete 单发（内嵌手册
 * 进系统提示词）③模型失败/空应答诚实回落（指路 dump-config 与 docs/）。
 *
 * carve-out 四条执法（核心命题篇 §3.5 助手条款）：
 * 1. 非中枢——静态 import 图断言：本件源码 import 说明符只许 ../contracts/*；
 * 2. 无仲裁权——服务面键形断言：恰 answer/guide 两键，无任何仲裁/路由入口；
 * 3. 纯清单应用——行注册断言（默认层行 + builtins 注册表 + 官方清单在册），
 *    不在 RING1_REQUIRED_ROW_IDS（Ring 2 真·可卸）；
 * 4. 默认应答者——缺席回落在壳侧测试（desktop-shell.test：无 assistant dep
 *    的无前缀文本 → 帮助文案卡）；本文件锁「行缺席 = 服务面缺席」的结构前提。
 */
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createAssistantApp,
  createAssistantService,
  type AssistantLlmFace,
  type AssistantStatusFace,
} from './assistant-app.js';
import { loadComposition, RING1_REQUIRED_ROW_IDS } from './composition.js';
import type { BuiltinAppModule, AppContext } from '../contracts/app.js';

/* ---------------- 测试替身（结构窄面假身——mock 停在模型/状态边界） ---------------- */

/** 模型面假身：调用计数 + 请求捕获 + 可脚本结果（文本 / 抛错 / 空应答） */
function fakeLlm(script: { text?: string; throwMsg?: string }) {
  const calls: Array<{ systemPrompt?: string; messages: unknown[] }> = [];
  const face: AssistantLlmFace = {
    async complete(req) {
      calls.push({
        ...(req.systemPrompt !== undefined ? { systemPrompt: req.systemPrompt } : {}),
        messages: req.messages,
      });
      if (script.throwMsg !== undefined) throw new Error(script.throwMsg);
      return { message: { content: script.text ?? '' } };
    },
  };
  return { face, calls };
}

/** 状态面假身：快照钉值（credentialIssue 在场与否两形态） */
function fakeStatus(issue?: { provider: string; guidance: string }): AssistantStatusFace {
  return {
    snapshot: () => (issue === undefined ? {} : { credentialIssue: issue }),
  };
}

/** 凭证警示样本（guidance 形状与 describeProviderFailure 产出同构——多行） */
const ISSUE = {
  provider: 'anthropic',
  guidance: '模型 provider「anthropic」未配置凭证。\n配置途径：export ANTHROPIC_API_KEY=…（或凭证表）',
};

/* ---------------- 应答三路 ---------------- */

describe('assistant-app：应答三路', () => {
  it('路 ① 凭证缺失：零 LLM 调用直答引导（guidance 同源转述 + 配置后指路）', async () => {
    const llm = fakeLlm({ text: '不应被调用的模型应答' });
    const service = createAssistantService({ llm: llm.face, status: fakeStatus(ISSUE) });
    const res = await service.answer('有哪些命令');
    expect(res.kind).toBe('guidance');
    // 零 LLM 调用（零配置首启可用——凭证缺失路的结构性执法点）
    expect(llm.calls).toHaveLength(0);
    // guidance 同源转述：原文按行在场（不抄写不改写）
    expect(res.lines).toContain('模型 provider「anthropic」未配置凭证。');
    expect(res.lines).toContain('配置途径：export ANTHROPIC_API_KEY=…（或凭证表）');
    expect(res.lines.join('\n')).toContain('再次提问即得模型应答');
  });

  it('路 ② 凭证在位：complete 单发（内嵌手册进 systemPrompt + 问句进 messages）', async () => {
    const llm = fakeLlm({ text: '答：桌面输入框无前缀文本即问系统助手。\n第二行。' });
    const service = createAssistantService({ llm: llm.face, status: fakeStatus() });
    const res = await service.answer('桌面怎么用');
    expect(res.kind).toBe('model');
    expect(res.lines).toEqual(['答：桌面输入框无前缀文本即问系统助手。', '第二行。']);
    // 恰一次调用；请求面：手册做系统提示词（含诚实纪律与命令族锚）+ 问句为唯一用户消息
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.systemPrompt).toContain('系统助手');
    expect(llm.calls[0]!.systemPrompt).toContain('berry dump-config');
    expect(llm.calls[0]!.systemPrompt).toContain('不编造');
    expect(llm.calls[0]!.messages).toEqual([expect.objectContaining({ role: 'user', content: '桌面怎么用' })]);
  });

  it('路 ③ 模型失败：诚实回落（错误转述 + 指路 dump-config 与 docs/）', async () => {
    const llm = fakeLlm({ throwMsg: 'LLM_COMPLETE_FAILED：provider 无凭证' });
    const service = createAssistantService({ llm: llm.face, status: fakeStatus() });
    const res = await service.answer('随便问');
    expect(res.kind).toBe('fallback');
    expect(res.lines.join('\n')).toContain('LLM_COMPLETE_FAILED');
    expect(res.lines.join('\n')).toContain('berry dump-config');
    expect(res.lines.join('\n')).toContain('docs/');
  });

  it('路 ③ 空应答同判：模型返回空文本 → 诚实回落（不把空输出当好答案）', async () => {
    const llm = fakeLlm({ text: '   ' });
    const service = createAssistantService({ llm: llm.face, status: fakeStatus() });
    const res = await service.answer('问个空的');
    expect(res.kind).toBe('fallback');
    expect(res.lines.join('\n')).toContain('空应答');
  });
});

/* ---------------- 引导面（/guide 与 g 热键的真身） ---------------- */

describe('assistant-app：guide 引导面', () => {
  it('警示在场：首启引导头行 + guidance 同源行 + 重启生效注记', () => {
    const service = createAssistantService({ llm: fakeLlm({}).face, status: fakeStatus(ISSUE) });
    const lines = service.guide();
    expect(lines[0]).toContain('首启引导——模型凭证未配置');
    expect(lines).toContain('配置途径：export ANTHROPIC_API_KEY=…（或凭证表）');
    expect(lines.join('\n')).toContain('重启进程生效');
  });

  it('警示缺席：已配置说明 + 无前缀提问指路（引导不只在警示态可达）', () => {
    const service = createAssistantService({ llm: fakeLlm({}).face, status: fakeStatus() });
    const lines = service.guide();
    expect(lines[0]).toContain('模型凭证已配置');
    expect(lines.join('\n')).toContain('无前缀文本即询问系统助手');
    expect(lines.join('\n')).toContain('docs/使用指南');
  });
});

/* ---------------- carve-out 四条执法 ---------------- */

describe('assistant-app：carve-out 四条（核心命题篇 §3.5）', () => {
  it('① 非中枢：静态 import 图只许 ../contracts/*（不 import 路由/分派/壳面）', () => {
    const source = readFileSync(fileURLToPath(new URL('./assistant-app.ts', import.meta.url)), 'utf8');
    // 全部 ESM import 说明符（from 加引号形——type-only 与值 import 同律；注释里不写字面引号形防自匹配）
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0); // 有 import 才有断言面
    for (const spec of specifiers) {
      expect(spec.startsWith('../contracts/')).toBe(true); // 违例即红：非中枢不许引任何宿主实现面
    }
  });

  it('② 无仲裁权：服务面键形恰 [answer, guide]（无仲裁/路由/装载序入口）', () => {
    const service = createAssistantService({ llm: fakeLlm({}).face, status: fakeStatus() });
    expect(Object.keys(service).sort()).toEqual(['answer', 'guide']);
  });

  it('③ 纯清单应用：行模块名/inject 声明 + 默认层行在册（Ring 2——不在 Ring 1 必备清单）', () => {
    const module = createAssistantApp();
    expect(module.name).toBe('assistant');
    expect(module.inject).toEqual(['llm', 'desktop-status']);
    // 组合树默认层末行 = assistant（真 loadComposition + stub 注册表——注册命中非 unresolved）
    const dataDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'assistant-app-')));
    const report = loadComposition(dataDir, createBuiltinRegistryForTest());
    expect(report.rows.at(-1)).toEqual({ id: 'assistant', pkg: 'builtin:assistant' });
    expect(report.plan.at(-1)!.unresolved).toBeUndefined();
    expect(RING1_REQUIRED_ROW_IDS).not.toContain('assistant'); // Ring 2 真·可卸
  });

  it('行 apply：provide `assistant` 服务面（answer/guide 两键随行装载）', () => {
    const module = createAssistantApp() as BuiltinAppModule;
    // 假 ctx：get 回放注入面 + provide 记账（AppContext 宽面经 unknown 收窄——测试替身）
    const provided: Array<[string, unknown]> = [];
    const ctx = {
      get: (name: string) => {
        if (name === 'llm') return fakeLlm({}).face;
        if (name === 'desktop-status') return fakeStatus();
        throw new Error(`测试未注入服务：${name}`);
      },
      provide: (name: string, impl: unknown) => {
        provided.push([name, impl]);
        return () => undefined;
      },
    } as unknown as AppContext;
    module.apply(ctx);
    expect(provided).toHaveLength(1);
    expect(provided[0]![0]).toBe('assistant');
    const face = provided[0]![1] as { answer: unknown; guide: unknown };
    expect(typeof face.answer).toBe('function');
    expect(typeof face.guide).toBe('function');
  });
});

/** 测试注册表（③ 用——真 builtins 需装配期闭包，此处以 stub 全键集同构替换） */
function createBuiltinRegistryForTest(): Record<string, BuiltinAppModule> {
  const stub = (name: string): BuiltinAppModule => ({ name, apply: () => undefined });
  return {
    'builtin:chat': stub('chat'),
    'builtin:memory': stub('memory'),
    'builtin:subagent': stub('subagent'),
    'builtin:goal': stub('goal'),
    'builtin:scheduler': stub('scheduler'),
    'builtin:mcp': stub('mcp'),
    'builtin:tools': stub('tools'),
    'builtin:web': stub('web'),
    'builtin:compaction': stub('compaction'),
    'builtin:admin': stub('admin'),
    'builtin:checkpoint': stub('checkpoint'),
    'builtin:lsp': stub('lsp'),
    'builtin:channels': stub('channels'),
    'builtin:webui': stub('webui'),
    'builtin:obs': stub('obs'),
    'builtin:browser': stub('browser'),
    'builtin:desktop': stub('desktop'),
    'builtin:assistant': createAssistantApp(),
  };
}
