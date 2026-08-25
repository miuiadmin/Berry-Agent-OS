/**
 * L5 app — 具名提示词段服务（ctx.prompts，契约篇 §1.3 pi-4(a) 拍板落码形态①/②/③，
 * 2026-08-24 M2 记忆插件纵切）。
 *
 * 词汇 = registerSection({ id, render() }) → Disposer；分节序宿主拥有且固定：
 * 基座 → 技能渐进披露 → 具名段（id 字典序——/reload 稳定，与激活轮次解耦）；
 * 组装一次随会话冻结——render() 只在重建时点（boot / /reload / /new）求值物化，
 * 段内容随快照冻结。禁令（⑤）：整串 systemPrompt 替换、per-run 重写永不提供。
 *
 * Disposer 纪律与 tools.register 同款：返回裸 Disposer，插件侧书写
 * `ctx.effect(() => ctx.prompts.registerSection(...))`——作用域 LIFO 回卷即注销段
 * （装载锚 dispose → 段集变化 → prompts_change 广播 → 装配层重建）。
 */

import { AppError, PROMPT_SECTION_DUPLICATE, PROMPT_SECTION_INVALID } from '../contracts/errors.js';
import type { PromptSection, PromptsService } from '../contracts/app.js';
import type { Context } from '../context/types.js';

/** 具名段/服务面类型单一来源在 contracts（§1.2 注记④）——本文件实现之，再出口保持既有消费面 */
export type { PromptSection, PromptsService } from '../contracts/app.js';

/** prompts_change 事件名常量（派发点与装配层订阅共用——check-events 字面量比对） */
export const PROMPTS_CHANGE_EVENT = 'prompts_change';

/**
 * 段 id 形状：小写段式路径，须恰含一个 `/`（插件域前缀/段名——`memory/core` 式；
 * 与自定义事件名同形约束，防撞宿主自留地——宿主段永不走本词汇）。
 */
const SECTION_ID_FORMAT = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/**
 * 建段注册表并挂进 ctx（provide('prompts')）。组合根装配期调用一次；
 * 插件经 ctx.get('prompts') 取用（fork 共享注册表）。
 */
export function registerPromptsService(ctx: Context): PromptsService {
  /** 段表：id → 定义（Map；物化时按 id 字典序取，与注册序无关） */
  const sections = new Map<string, PromptSection>();

  /** 段集变更广播：载荷 = 现行段 id 清单（字典序） */
  const announce = (): void => {
    ctx.emit(PROMPTS_CHANGE_EVENT, [...sections.keys()].sort());
  };

  const service: PromptsService = {
    registerSection(section) {
      if (typeof section.id !== 'string' || !SECTION_ID_FORMAT.test(section.id)) {
        throw new AppError(
          PROMPT_SECTION_INVALID,
          `提示词段 id 非法（${String(section.id)}）——须小写且恰含一个 /（插件域前缀/段名，如 memory/core；契约篇 §1.3 落码形态①）`,
        );
      }
      if (typeof section.render !== 'function') {
        throw new AppError(PROMPT_SECTION_INVALID, `提示词段 ${section.id}：render 缺失或非函数`);
      }
      if (sections.has(section.id)) {
        // 撞名 = 装配冲突（两段同位），响亮失败不静默覆盖（与 TOOL_DUPLICATE 同纪律）
        throw new AppError(PROMPT_SECTION_DUPLICATE, `提示词段重复注册：${section.id}`);
      }
      sections.set(section.id, section);
      announce();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        // 仅当仍是本定义时删除（防误撤他者后来的同位注册——与 tools.register 同款护栏）
        if (sections.get(section.id) === section) {
          sections.delete(section.id);
          announce();
        }
      };
    },

    listSections() {
      return [...sections.keys()].sort();
    },

    materialize() {
      const ordered = [...sections.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const parts: string[] = [];
      for (const section of ordered) {
        try {
          const text = section.render();
          // 渲染产物为空 = 段当前无内容（如记忆库空）：跳过而非留空壳分节
          if (text.trim() !== '') parts.push(text);
        } catch (err) {
          // 插件 bug 不杀重建：诊断占位进提示词（模型可见 + 可排查），错误细节进日志
          ctx.logger.error('提示词段渲染失败，已置诊断占位', {
            section: section.id,
            error: err instanceof Error ? err.message : String(err),
          });
          parts.push(`<!-- 提示词段 ${section.id} 渲染失败：内容缺席（宿主日志有详细错误） -->`);
        }
      }
      return parts.join('\n\n');
    },
  };

  ctx.provide('prompts', service);
  return service;
}
