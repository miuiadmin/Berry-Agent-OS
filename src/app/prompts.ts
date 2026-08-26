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
 *
 * 双入口（exec 纵切拆分，骨架篇 §7.3）：插件面 registerSection 须恰含一个
 * `/`（域前缀形）；宿主面 registerHostSection 只收无 `/` 单段 id（宿主自留地
 * ——environment 披露段即首例），且宿主通道不在 ctx.prompts 服务对象上，
 * 插件经 ctx.get 不可达。
 */

import { AppError, PROMPT_SECTION_DUPLICATE, PROMPT_SECTION_INVALID } from '../contracts/errors.js';
import type { Context, Disposer } from '../context/types.js';
import type { PromptSection, PromptsService } from '../contracts/app.js';

/** 具名段/服务面类型单一来源在 contracts（§1.2 注记④）——本文件实现之，再出口保持既有消费面 */
export type { PromptSection, PromptsService } from '../contracts/app.js';

/** prompts_change 事件名常量（派发点与装配层订阅共用——check-events 字面量比对） */
export const PROMPTS_CHANGE_EVENT = 'prompts_change';

/**
 * 段 id 形状·插件面：小写段式路径，须恰含一个 `/`（插件域前缀/段名——
 * `memory/core` 式；与自定义事件名同形约束，防撞宿主自留地）。
 */
const SECTION_ID_FORMAT = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/**
 * 段 id 形状·宿主面：小写单段（**不含 `/`**——无 `/` 即宿主自留地，
 * 插件面注册无 `/` id 一律 PROMPT_SECTION_INVALID；宿主半边 API 不经
 * ctx.prompts 插件面，即本对双入口正则拆分的意义）。
 */
const HOST_SECTION_ID_FORMAT = /^[a-z][a-z0-9-]*$/;

/**
 * 宿主段注册通道（组合根 boot 装配期专用——environment 披露段即首例）。
 * 刻意不进 PromptsService 插件面：经 ctx.get('prompts') 拿到的服务对象上
 * 没有本方法，宿主自留地词汇对插件不可达。
 */
export interface HostPromptsRegistry {
  /** 注册宿主自留地段（id 无 `/`；与插件段同表同字典序物化） */
  registerHostSection(section: PromptSection): Disposer;
}

/**
 * 建段注册表并挂进 ctx（provide('prompts')）。组合根装配期调用一次；
 * 插件经 ctx.get('prompts') 取用（fork 共享注册表）。
 *
 * 返回值含宿主半边通道（host）——装配层注册宿主自留地段用；插件面只见 service。
 */
export function registerPromptsService(ctx: Context): { service: PromptsService; host: HostPromptsRegistry } {
  /** 段表：id → 定义（Map；物化时按 id 字典序取，与注册序无关） */
  const sections = new Map<string, PromptSection>();

  /** 段集变更广播：载荷 = 现行段 id 清单（字典序） */
  const announce = (): void => {
    ctx.emit(PROMPTS_CHANGE_EVENT, [...sections.keys()].sort());
  };

  /** 双入口共用的登记内核（id 门槛由入口各自把关——词汇纪律在门口执法） */
  const addSection = (section: PromptSection, gate: 'plugin' | 'host'): Disposer => {
    if (typeof section.id !== 'string' || typeof section.render !== 'function') {
      throw new AppError(PROMPT_SECTION_INVALID, `提示词段 ${String(section.id)}：id/render 形状非法`);
    }
    if (gate === 'plugin' && !SECTION_ID_FORMAT.test(section.id)) {
      throw new AppError(
        PROMPT_SECTION_INVALID,
        `提示词段 id 非法（${section.id}）——须小写且恰含一个 /（插件域前缀/段名，如 memory/core；无 / 的单段 id 是宿主自留地，插件不可注册；契约篇 §1.3 落码形态①）`,
      );
    }
    if (gate === 'host' && !HOST_SECTION_ID_FORMAT.test(section.id)) {
      throw new AppError(
        PROMPT_SECTION_INVALID,
        `宿主提示词段 id 非法（${section.id}）——须小写单段且不含 /（含 / 的域前缀形属插件词汇面）`,
      );
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
  };

  const service: PromptsService = {
    registerSection(section) {
      return addSection(section, 'plugin');
    },

    listSections() {
      return [...sections.keys()].sort();
    },

    materialize(sessionId) {
      const ordered = [...sections.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const parts: string[] = [];
      for (const section of ordered) {
        try {
          // 语境参数透传（S2 契约篇 §1.3 落码形态①）：会话键控段（记忆简报）
          // 用 sessionId 冻结该会话基线；undefined = 诊断物化（不冻结）
          const text = section.render(sessionId);
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
  // 宿主半边通道：与插件段同表，但词汇面独立（无 `/` 单段 id 专属宿主）
  const host: HostPromptsRegistry = {
    registerHostSection(section) {
      return addSection(section, 'host');
    },
  };
  return { service, host };
}
