/**
 * L3 memory — 工具面五件（记忆篇 §7：模型可见动词）。
 *
 * memory_write / memory_forget / memory_restore / memory_read / memory_search
 * （pi-memory 六件收窄：scratchpad 砍掉、memory_status 并入 read）。
 *
 * 纪律落点：
 * - 写路径唯一：memory_write 与 §4 提取共用 guardedAddMemory（§8.1 写前扫描）
 *   + store.addMemory（§5 合并管线）——没有绕过合并/扫描的直通道；
 * - 读出面统一过 sanitizeForModel（§8.2 读出扫描——secret 拦截 + 指令样引述化）；
 * - 工具形态 = ToolDefinition（插件契约篇 §3.1）：插件经 ctx.get('tools').register
 *   注册，执行全走三段管道（守门照走——本文件零旁门）；
 * - parameters 用宿主 typebox 再导出面构建（contracts/typebox.ts——与插件经
 *   berryagent 虚拟面取 typebox 同路，防双实例）。
 */

import { Type } from '../contracts/typebox.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import { guardedAddMemory, detectSecret, quoteAsCitation, sanitizeForModel } from './scan.js';
import type { SanitizedEntry } from './scan.js';
import type { MemoryKind, MemoryStore } from './store.js';
import type { SessionFtsHit } from './session-fts.js';

/** 工具五件选项（插件装配注入；owner 解析留在装配层——global + 当前项目） */
export interface MemoryToolsOptions {
  /** 记忆库 DAO */
  readonly store: MemoryStore;
  /** 生效归属键（global + project:<hash>；活取值——cwd 变更/多会话时按调取时为准） */
  readonly ownerKeys: () => readonly string[];
  /**
   * 跨会话检索面（记忆篇 §10 union 的另一半）：给了 = memory_search 联合检索
   * session_fts（返回带来源标记）；缺省纯记忆库检索——DAO 独立于工具面可测。
   */
  readonly searchSessions?: (query: string, limit: number) => readonly SessionFtsHit[];
}

/** 纯文本结果快捷构造 */
function textResult(text: string, isError = false, details?: Record<string, unknown>): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}), ...(details ? { details } : {}) };
}

/** 单条记忆的展示行（kind 标注 + 溯源 id；指令样条目套引述框架——§8.2） */
function entryLine(entry: SanitizedEntry): string {
  const { record, quoted } = entry;
  const summary = quoted ? quoteAsCitation(record.summary) : record.summary;
  return `- [${record.kind}] ${summary}（id=${record.id}，置信 ${record.confidence.toFixed(2)}，证据 ${record.evidenceCount}）`;
}

/** kind 七值字面量并集（schema 枚举面——TypeBox Union of Literals → JSON Schema anyOf/const） */
const KIND_VALUES = [
  'preference',
  'fact',
  'convention',
  'correction',
  'failure',
  'insight',
  'profile',
] as const satisfies readonly MemoryKind[];

/**
 * 组装记忆工具五件（ToolDefinition 数组——装配层逐个 register）。
 */
export function createMemoryTools(opts: MemoryToolsOptions): ToolDefinition[] {
  const { store } = opts;

  /* ---------------- memory_write：模型主动记（唯一写入口） ---------------- */
  const memoryWrite: ToolDefinition = {
    name: 'memory_write',
    effect: 'write',
    description:
      '记录一条长期记忆（用户偏好/事实/约定/教训等）。写入会与已有记忆自动合并去重（同义合并、矛盾按置信度裁决）。注意：不要记录任何密钥/token/凭证——写前扫描会直接拒绝。',
    parameters: Type.Object({
      kind: Type.Union(KIND_VALUES.map((k) => Type.Literal(k))),
      summary: Type.String({ minLength: 1, maxLength: 200, description: '一句话摘要（判重与简报展示面）' }),
      content: Type.String({ minLength: 1, maxLength: 4000, description: '全文（注入时用）' }),
      confidence: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1, description: '置信度 0..1（缺省 0.5；矛盾裁决时高者胜）' }),
      ),
    }),
    execute: async (args) => {
      // 写入归属 = ownerKeys() 首键（装配层约定首键 = global）：注入取并集、
      // 写入落 global——项目级记忆由提取管线按信封/会话判定，工具面不猜项目
      const ownerKey = opts.ownerKeys()[0] ?? 'global';
      const result = guardedAddMemory(store, {
        ownerKey,
        kind: args.kind as MemoryKind,
        summary: String(args.summary),
        content: String(args.content),
        confidence: typeof args.confidence === 'number' ? args.confidence : undefined,
      });
      if (result.status === 'blocked') {
        // §8.1：拒写 + log-only 诊断——模式名进 details，疑似密钥内容不回显
        return textResult(
          `写前扫描命中疑似密钥（模式：${result.pattern}），已拒写——记忆库不存任何凭证。请去掉敏感串后重写。`,
          true,
          { secretPattern: result.pattern },
        );
      }
      const outcome = result.outcome;
      switch (outcome.outcome) {
        case 'inserted':
          return textResult(
            `已记录新记忆（${outcome.memory.kind}）：${outcome.memory.summary}\n条目 id：${outcome.memory.id}`,
            false,
            {
              id: outcome.memory.id,
              outcome: 'inserted',
            },
          );
        case 'merged':
          return textResult(
            `与已有记忆合并（${outcome.via} 匹配，证据 ${outcome.memory.evidenceCount} 次）：${outcome.memory.summary}`,
            false,
            { id: outcome.memory.id, outcome: 'merged', via: outcome.via },
          );
        case 'superseded':
          return textResult(
            `极性冲突裁决：新记忆胜出，旧条已软删（${outcome.supersededId}）、证据已继承。新条：${outcome.memory.summary}`,
            false,
            { id: outcome.memory.id, outcome: 'superseded', supersededId: outcome.supersededId },
          );
        case 'rejected':
          // 域内裁决结果（非执行错误）：明确告知模型为何未入库与两条出路
          return textResult(
            `极性冲突裁决：已有更高置信条目（${outcome.existingId}），本次候选未入库。如确认新说法成立，可用更高 confidence 重写，或请用户先 forget 旧条。`,
            false,
            { outcome: 'rejected', existingId: outcome.existingId },
          );
      }
    },
  };

  /* ---------------- memory_forget：用户口信软删 ---------------- */
  const memoryForget: ToolDefinition = {
    name: 'memory_forget',
    effect: 'write',
    description:
      '软删一条记忆（用户说「忘掉这条」时使用；可经 memory_restore 恢复）。条目 id 从 memory_read/memory_search 获取。',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
    }),
    execute: async (args) => {
      const ok = store.forget(String(args.id), 'user');
      return ok
        ? textResult(`已软删（status=dismissed，可恢复）：${args.id}`, false, { id: args.id, forgotten: true })
        : textResult(`未找到该条目：${args.id}（id 从 memory_read/memory_search 获取）`, true, {
            id: args.id,
            forgotten: false,
          });
    },
  };

  /* ---------------- memory_restore：恢复软删 ---------------- */
  const memoryRestore: ToolDefinition = {
    name: 'memory_restore',
    effect: 'write',
    description: '恢复一条软删记忆（用户说「把刚才那条加回来」时使用）。',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
    }),
    execute: async (args) => {
      const ok = store.restore(String(args.id));
      return ok
        ? textResult(`已恢复：${args.id}`, false, { id: args.id, restored: true })
        : textResult(`未找到该条目（或本就在册）：${args.id}`, true, { id: args.id, restored: false });
    },
  };

  /* ---------------- memory_read：常驻简报 + 最近变更 + 健康面 ---------------- */
  const memoryRead: ToolDefinition = {
    name: 'memory_read',
    effect: 'read',
    description:
      '读取当前生效的记忆（常驻简报选摘 + 最近变更清单 + 条目计数）。轻量读面，不做全文检索——检索用 memory_search。',
    parameters: Type.Object({}),
    execute: async () => {
      const owners = opts.ownerKeys();
      const brief = store.briefing(owners);
      const active = store.list(owners);
      const recent = active.slice(0, 10);
      const dismissedCount = store.list(owners, 'dismissed').length;
      // 读出消毒（§8.2）：secret 命中条剔除 + 指令样引述化——两读面都过；
      // 拦截计数按条目 id 去重（同一记录同时出现在简报与最近面只计一次）
      const briefSanitized = sanitizeForModel(brief.records);
      const recentSanitized = sanitizeForModel(recent);
      const blockedIds = new Set(
        [...brief.records, ...recent]
          .filter((r) => detectSecret(r.summary) !== undefined || detectSecret(r.content) !== undefined)
          .map((r) => r.id),
      );
      const blocked = blockedIds.size;
      const lines = [
        `— 常驻简报（top ${briefSanitized.entries.length}${brief.truncated ? '，达限额截断' : ''}）—`,
        ...briefSanitized.entries.map(entryLine),
        `— 最近变更（${recentSanitized.entries.length} 条）—`,
        ...recentSanitized.entries.map(entryLine),
        `— 健康面：active ${active.length} / dismissed ${dismissedCount}${blocked > 0 ? ` / 读出扫描拦截 ${blocked} 条（历史敏感串，不入展示面）` : ''}—`,
      ];
      return textResult(lines.join('\n'), false, {
        briefCount: briefSanitized.entries.length,
        truncated: brief.truncated,
        blocked,
        activeCount: active.length,
        dismissedCount,
      });
    },
  };

  /* ---------------- memory_search：FTS 检索（唯一跨会话检索入口） ---------------- */
  const memorySearch: ToolDefinition = {
    name: 'memory_search',
    effect: 'read',
    description:
      '按关键词检索记忆库与历史会话（中英混排子串匹配；记忆条目 + [历史会话] 引用两路联合）。回答涉及用户偏好/历史教训/项目约定的问题前先检索——记忆比本轮上下文更了解用户。',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: '返回条数（缺省 5）' })),
    }),
    execute: async (args) => {
      const query = String(args.query);
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const records = store.search(query, opts.ownerKeys(), limit);
      const sanitized = sanitizeForModel(records);
      // 跨会话 union（§10）：session_fts 命中行——snippet 过读出扫描（secret 串以
      // 拦截计数披露不回显），行带 sessionId+seq 定位（模型可提示用户跳转回放）
      const sessionHits = opts.searchSessions ? opts.searchSessions(query, limit) : [];
      const sessionLines: string[] = [];
      let sessionBlocked = 0;
      for (const hit of sessionHits) {
        if (detectSecret(hit.snippet) !== undefined) {
          sessionBlocked += 1;
          continue;
        }
        sessionLines.push(`- [历史会话] ${hit.snippet}（session=${hit.sessionId}，seq=${hit.seq}）`);
      }
      if (sanitized.entries.length === 0 && sessionLines.length === 0) {
        return textResult('无匹配结果（记忆库与历史会话均未命中）。', false, {
          hits: 0,
          sessionHits: 0,
          blocked: sanitized.blocked + sessionBlocked,
        });
      }
      return textResult([...sanitized.entries.map(entryLine), ...sessionLines].join('\n'), false, {
        hits: sanitized.entries.length,
        sessionHits: sessionLines.length,
        blocked: sanitized.blocked + sessionBlocked,
      });
    },
  };

  return [memoryWrite, memoryForget, memoryRestore, memoryRead, memorySearch];
}
