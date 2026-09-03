/**
 * L3 skills — 注册表与渐进披露清单（骨架篇 §9.2 ctx.skills）。
 *
 * 合并语义（§4.4）：提供方注册序 = 优先序；同名 first-wins，落选者记
 * collision 诊断（winner/loser 路径齐备）；同真实路径（symlink 复现）
 * 静默去重不算冲突。清单渲染 §4.3：上下文成本 O(技能数 × 一行)，
 * disable-model-invocation 隐藏。
 */

import { realpathSync } from 'node:fs';
import type { Context, Disposer } from '../context/types.js';
import { chainCaller } from '../context/chain.js';
import { AppError, COMPOSITION_ROW_INVALID, SKILLS_PROVIDER_INVALID } from '../contracts/errors.js';
import type { RowAppProbe } from '../contracts/app.js';
import type { Skill, SkillDiagnostic, SkillsProvider, SkillsService } from './types.js';

/** 安全 realpath（失败原样返回——去重尽力而为，不因怪路径断流） */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** 技能快照数帽（契约篇 §4.3 硬规则 3②；B11 第十一轮遗漏大扫 20260904-b） */
const SKILLS_SNAPSHOT_LIMIT = 100;

/**
 * 注册时点首调形状断言（B12，2026-08-27 第三十三批 P2-1）：对 provider.list()
 * 做一次性形状校验——返回值两键在场（skills/diagnostics 均为数组）+ 元素粗验
 * （技能 name/description/filePath 三串键、诊断 type/code/message 三键）。
 * 防注册时点两路静默：① 返回退化形（缺键）此前要到首次 refresh 才以裸
 * TypeError 炸（栈指向 merge 不指应用，行已 failed 清单难归因）；② list()
 * 自身抛错此前 refresh 期才降 provider-failed 警告——「装上了但永远空」在
 * 注册时点无感。只在注册入口调一次，不随 refresh 重复——运行期退化形由
 * merge 的数组守卫降 warning。注册入口抛错即行 failed（装载器 apply 帧）。
 */
function assertProviderShape(provider: SkillsProvider): void {
  /** 统一报错出口（provider id 进报文帮归因） */
  const fail = (why: string): never => {
    throw new AppError(SKILLS_PROVIDER_INVALID, `技能提供方 ${provider.id} 形状不合：${why}`);
  };
  if (typeof provider?.list !== 'function') fail('list 不是函数');
  let result: ReturnType<SkillsProvider['list']>;
  try {
    result = provider.list();
  } catch (err) {
    // 内联 throw（不走 fail）：definite-assignment 分析不认 never 返回的 helper
    // 调用，catch 内须经 throw 直接落出才能判 result 已赋
    throw new AppError(
      SKILLS_PROVIDER_INVALID,
      `技能提供方 ${provider.id} 形状不合：首调 list() 即抛错——${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (result === null || typeof result !== 'object') {
    fail(`list() 返回 ${result === null ? 'null' : typeof result}（须 { skills, diagnostics }）`);
  }
  const shape = result as { skills?: unknown; diagnostics?: unknown };
  if (!Array.isArray(shape.skills)) fail('返回缺 skills 数组');
  if (!Array.isArray(shape.diagnostics)) fail('返回缺 diagnostics 数组');
  for (const [index, skill] of (shape.skills as unknown[]).entries()) {
    if (skill === null || typeof skill !== 'object') fail(`skills[${index}] 非对象`);
    const record = skill as Record<string, unknown>;
    if (
      typeof record.name !== 'string' ||
      typeof record.description !== 'string' ||
      typeof record.filePath !== 'string'
    ) {
      fail(`skills[${index}] 缺 name/description/filePath 串键`);
    }
  }
  for (const [index, diagnostic] of (shape.diagnostics as unknown[]).entries()) {
    if (diagnostic === null || typeof diagnostic !== 'object') fail(`diagnostics[${index}] 非对象`);
    const record = diagnostic as Record<string, unknown>;
    if (typeof record.type !== 'string' || typeof record.code !== 'string' || typeof record.message !== 'string') {
      fail(`diagnostics[${index}] 缺 type/code/message 键`);
    }
  }
}

/** XML 五实体转义（清单内插用户可控文本，防结构逃逸） */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * 渲染 `<available_skills>` 渐进披露清单（§4.3；契约篇引用的 pi/agentskills
 * 集成格式原样）。隐藏技能排除；按名排序保证确定性；无可见技能 → ''。
 * 提示文案是模型面 prompt 文本，随生态惯例用英文。
 *
 * 渲染层字节帽（B11——第十一轮遗漏大扫 20260904-b，契约篇 §4.3 硬规则 3③）：
 * 清单块以 64KiB 为预算（输出护栏同纪律）——数帽与 description 装载层截断
 * 之外的最后兜底（name 不截断 + 转义膨胀等病态体积由本帽收口）。达限截断
 * 并以块内 XML 注释就地披露（硬规则 2：截断可见——模型与操作者读清单即见，
 * 非静默）。
 */

/** 渐进披露清单块字节预算（64KiB——输出护栏同纪律；B11 渲染层兜底） */
const SKILLS_RENDER_MAX_BYTES = 64 * 1024;

export function renderAvailableSkills(skills: readonly Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return '';
  const sorted = [...visible].sort((a, b) => a.name.localeCompare(b.name));

  const lines = [
    '\nThe following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  // 字节帽裁剪（B11）：逐条累加，预算耗尽即停——尾裁不头裁（排序序 = 确定性）
  let budget = SKILLS_RENDER_MAX_BYTES;
  let shown = 0;
  for (const skill of sorted) {
    const entry =
      `  <skill>\n` +
      `    <name>${escapeXml(skill.name)}</name>\n` +
      `    <description>${escapeXml(skill.description)}</description>\n` +
      `    <location>${escapeXml(skill.filePath)}</location>\n` +
      `  </skill>`;
    if (entry.length + '</available_skills>'.length > budget) break;
    lines.push(entry);
    budget -= entry.length + 1; // +1 = join 换行符
    shown++;
  }
  if (shown < sorted.length) {
    // 块内注释就地披露（硬规则 2 作者侧/模型侧双可见）：shown N of M + 预算
    lines.push(
      `  <!-- available_skills truncated: showing ${shown} of ${sorted.length} skills ` +
        `(${SKILLS_RENDER_MAX_BYTES} byte budget reached; skills beyond this point are not listed -->`,
    );
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

/**
 * 组装技能服务。服务构造后为空快照——装配层须 registerProvider(本地
 * provider) 后 refresh() 才有内容（启动断言的技能面在此之后检查）。
 *
 * 提供方链变更广播（契约篇 §2.2 增补 6，2026-08-25 #17 收口）：onProvidersChange
 * 回调在 registerProvider 与注销时触发，载荷 = 现行 provider id 清单（注册序）。
 * 服务保持纯（不持 ctx）——装配层经此回调桥接 ctx.emit(SKILLS_CHANGE_EVENT)，
 * 装配层订阅重建系统提示词，应用热注册技能来源即时可见（此前装机即隐身：
 * 可见性依赖 /reload //new 或无关应用注册 prompt 段捎带 rebuild 的偶然耦合）。
 *
 * @param opts.onProvidersChange 提供方链变更回调（缺省不广播——纯测试场景）
 * @param opts.rowApp 行挂载目标投影（D1 注册面路由裁死，契约篇 §5.1）：挂应用
 *   组合的行注册技能来源 = 装载期拒绝——skills 无域层（provider 全局注入
 *   systemPrompt），app 行注册即全局漏注入破坏应用隔离。缺省不接 = 不执法
 *   （纯测试/诊断面）。
 */
export function createSkillsService(opts?: {
  onProvidersChange?: (providerIds: readonly string[]) => void;
  rowApp?: RowAppProbe;
}): SkillsService {
  /** 提供方链（注册序即优先序） */
  const providers: SkillsProvider[] = [];
  /** 提供方链变更通知（id 清单快照——注册/注销后现行序） */
  const notifyChange = (): void => {
    opts?.onProvidersChange?.(providers.map((provider) => provider.id));
  };
  /** 最近一次 refresh 的合并快照（list/get/render/diagnostics 的数据源） */
  let snapshot: { skills: readonly Skill[]; diagnostics: readonly SkillDiagnostic[] } = {
    skills: [],
    diagnostics: [],
  };

  /** 拉取全部提供方并按 first-wins 合并（同名落选 → collision 诊断；symlink 同真实路径静默去重） */
  const merge = (): { skills: readonly Skill[]; diagnostics: readonly SkillDiagnostic[] } => {
    const byName = new Map<string, Skill>();
    const seenRealPaths = new Set<string>();
    const skills: Skill[] = [];
    const warnings: SkillDiagnostic[] = [];
    const collisions: SkillDiagnostic[] = [];

    for (const provider of providers) {
      let result: ReturnType<SkillsProvider['list']>;
      try {
        result = provider.list();
      } catch (err) {
        // 单提供方崩溃不断流：记 provider-failed 警告后继续其余提供方
        warnings.push({
          type: 'warning',
          code: 'provider-failed',
          message: `技能提供方 ${provider.id} 拉取失败：${err instanceof Error ? err.message : String(err)}`,
          path: provider.id,
        });
        continue;
      }
      // 运行期退化形守卫（B12 注册时点断言的运行期腿）：list() 返回形在注册后
      // 退化（provider 内部状态翻转等）——skills/diagnostics 任一非数组都会以
      // 裸 TypeError 炸整个 refresh，降为单提供方 warning 不断流
      if (!Array.isArray(result.skills) || !Array.isArray(result.diagnostics)) {
        warnings.push({
          type: 'warning',
          code: 'provider-failed',
          message: `技能提供方 ${provider.id} 返回形退化（skills/diagnostics 须为数组），本轮跳过`,
          path: provider.id,
        });
        continue;
      }
      warnings.push(...result.diagnostics);
      for (const skill of result.skills) {
        // symlink 去重：同一真实文件经多位置出现 → 只保留首个（不算冲突）
        const real = realPath(skill.filePath);
        if (seenRealPaths.has(real)) continue;

        const existing = byName.get(skill.name);
        if (existing) {
          collisions.push({
            type: 'collision',
            code: 'collision',
            message: `同名技能 "${skill.name}" 落选（first-wins）`,
            path: skill.filePath,
            collision: { name: skill.name, winnerPath: existing.filePath, loserPath: skill.filePath },
          });
        } else {
          byName.set(skill.name, skill);
          seenRealPaths.add(real);
          skills.push(skill);
        }
      }
    }
    return { skills, diagnostics: [...warnings, ...collisions] };
  };

  /**
   * 快照数帽（B11——第十一轮遗漏大扫 20260904-b，契约篇 §4.3 硬规则 3②）：
   * 技能快照以 100 为帽（对照工具注册表 REGISTRY_TOTAL_LIMIT=1000 同族——
   * 「技能数量近乎无上限」的装载面承诺由 read 路径保持，渐进披露清单面有界）。
   * provider 注册序即优先序（§4.4 first-wins 同律），超帽裁尾 + warning 诊断
   * 披露被裁计数（硬规则 2 作者侧反馈——被裁技能作者以为已披露、模型看不见）。
   */
  const capSnapshot = (
    merged: ReturnType<typeof merge>,
  ): { skills: readonly Skill[]; diagnostics: readonly SkillDiagnostic[] } => {
    if (merged.skills.length <= SKILLS_SNAPSHOT_LIMIT) return merged;
    const dropped = merged.skills.slice(SKILLS_SNAPSHOT_LIMIT);
    const firstDropped = dropped
      .slice(0, 5)
      .map((skill) => skill.name)
      .join('、');
    const diagnostic: SkillDiagnostic = {
      type: 'warning',
      code: 'skills-over-cap',
      message:
        `渐进披露清单超帽：装载 ${merged.skills.length} 项，仅前 ${SKILLS_SNAPSHOT_LIMIT} 项可见` +
        `（provider 注册序优先；被裁 ${dropped.length} 项，如 ${firstDropped}${dropped.length > 5 ? ' 等' : ''}）`,
    };
    return {
      skills: merged.skills.slice(0, SKILLS_SNAPSHOT_LIMIT),
      diagnostics: [...merged.diagnostics, diagnostic],
    };
  };

  const service: SkillsService = {
    registerProvider(provider) {
      // D1 app 行拒载（契约篇 §5.1 注册面路由裁死，2026-08-27；第三十六批 apps
      // 数组化——探针返回数组）：caller 链带行 id（装载器 apply 帧 / 组合根 seam
      // 显式帧）且该行挂应用作用域（apps 数组非空）→ 拒绝——技能 provider 全局
      // 注入 systemPrompt、无域层，app 行注册 = 全局漏注入破坏应用隔离。抛错即
      // 行失败（装载期拒绝）；域层随首个真实第三方需求
      const rowId = chainCaller();
      const apps = rowId !== undefined ? opts?.rowApp?.get(rowId) : undefined;
      if (apps !== undefined && apps.length > 0) {
        throw new AppError(
          COMPOSITION_ROW_INVALID,
          `技能来源注册被拒：行 ${rowId} 挂应用作用域（apps: ${apps.join('、')}）——应用行的技能注册 v1 裁死拒载` +
            `（provider 全局注入系统提示词、无域层，防全局漏注入破坏应用隔离；契约篇 §5.1 D1 注册面路由）`,
        );
      }
      // 注册时点首调形状断言（B12）：退化 provider 在此即拒（行 failed），不留给
      // 首次 refresh 以裸 TypeError 炸。断言必须先于 providers.push——providers
      // 是服务闭包状态不在行 effect 栈上，push 后抛错会残留条目
      assertProviderShape(provider);
      providers.push(provider);
      notifyChange(); // 链变更即广播（skills_change——装配层订阅重建提示词）
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const index = providers.indexOf(provider);
        if (index >= 0) providers.splice(index, 1);
        notifyChange(); // 注销同广播（幂等注销不触发——done 闸）
      };
    },

    refresh() {
      snapshot = capSnapshot(merge());
      return snapshot;
    },

    list() {
      return snapshot.skills;
    },

    get(name) {
      return snapshot.skills.find((skill) => skill.name === name);
    },

    renderAvailableSkills() {
      return renderAvailableSkills(snapshot.skills);
    },

    diagnostics() {
      return snapshot.diagnostics;
    },
  };
  return service;
}

/** 把技能服务挂进 ctx（ctx.provide('skills')，随作用域 LIFO 回卷） */
export function registerSkillsService(ctx: Context, service: SkillsService): Disposer {
  return ctx.provide('skills', service);
}
