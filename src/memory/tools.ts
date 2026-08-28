/**
 * L3 memory — 工具面九件（记忆篇 §7：模型可见动词；第三十二批 5→9）。
 *
 * memory_write / memory_forget / memory_restore / memory_read / memory_search
 * （pi-memory 六件收窄：scratchpad 砍掉、memory_status 并入 read）
 * + 持有面四件：memory_freeze / memory_unfreeze / memory_ttl / memory_access_log。
 *
 * 纪律落点：
 * - 写路径唯一：memory_write 与 §4 提取共用 guardedAddMemory（§8.1 写前扫描）
 *   + store.addMemory（§5 合并管线）——没有绕过合并/扫描的直通道；
 * - 读出面统一过 sanitizeForModel（§8.2 读出扫描——secret 拦截 + 指令样引述化）；
 * - 工具形态 = ToolDefinition（应用契约篇 §3.1）：应用经 ctx.get('tools').register
 *   注册，执行全走三段管道（守门照走——本文件零旁门）；
 * - parameters 用宿主 typebox 再导出面构建（contracts/typebox.ts——与应用经
 *   berryagent 虚拟面取 typebox 同路，防双实例）；
 * - 检索/引用的访问流水（§3 memory_access）在工具面落账：search 命中记
 *   op='search'（聚合不随——usage_count ≡ cite 行数）。
 */

import { Type } from '../contracts/typebox.js';
import type { AgentToolResult, ToolDefinition } from '../contracts/tools.js';
import { guardedAddMemory, detectSecret, quoteAsCitation, sanitizeForModel } from './scan.js';
import type { SanitizedEntry } from './scan.js';
import { citationMarker } from './citation.js';
import type { MemoryKind, MemoryStore } from './store.js';
import type { SessionFtsHit } from './session-fts.js';

/** 工具五件选项（应用装配注入；owner 解析留在装配层——global + 当前项目） */
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

/**
 * 单条记忆的展示行（引用标记 + kind 标注 + 溯源 id；指令样条目套引述框架——§8.2）。
 * `[m:短id]` = 引用面（§6 引用回写——模型按标记在回答中标注）；`id=完整id` =
 * 操作面（memory_forget/restore 的入参用完整 id）——两把钥匙两种面，不混用。
 */
function entryLine(entry: SanitizedEntry): string {
  const { record, quoted } = entry;
  const summary = quoted ? quoteAsCitation(record.summary) : record.summary;
  return `- ${citationMarker(record.id)} [${record.kind}] ${summary}（id=${record.id}，置信 ${record.confidence.toFixed(2)}，证据 ${record.evidenceCount}，引用 ${record.usageCount}）`;
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
 * 组装记忆工具九件（ToolDefinition 数组——装配层逐个 register）。
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
      ttlDays: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 3650,
          description:
            '留存天数（§3 TTL）：到期自动过期离开一切注入面；被引用即续期。缺省 = 永久。临时性/时效性记忆（如项目阶段约定）建议设置。',
        }),
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
        ttlDays: typeof args.ttlDays === 'number' ? args.ttlDays : undefined,
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

  /* ---------------- memory_forget：用户口信软删（frozen 拒） ---------------- */
  const memoryForget: ToolDefinition = {
    name: 'memory_forget',
    effect: 'write',
    description:
      '软删一条记忆（用户说「忘掉这条」时使用；可经 memory_restore 恢复）。冻结条目拒删——需先 memory_unfreeze。条目 id 从 memory_read/memory_search 获取。',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
    }),
    execute: async (args) => {
      const result = store.forget(String(args.id), 'user');
      if (result === 'frozen') {
        return textResult(`该条目已冻结，拒删（frozen 免覆写义）——先 memory_unfreeze 再 forget。：${args.id}`, true, {
          id: args.id,
          forgotten: false,
          reason: 'frozen',
        });
      }
      return result === 'ok'
        ? textResult(`已软删（status=dismissed，可恢复）：${args.id}`, false, { id: args.id, forgotten: true })
        : textResult(`未找到该条目：${args.id}（id 从 memory_read/memory_search 获取）`, true, {
            id: args.id,
            forgotten: false,
            reason: 'missing',
          });
    },
  };

  /* ---------------- memory_restore：恢复（现行值复活 / 指定版本回滚） ---------------- */
  const memoryRestore: ToolDefinition = {
    name: 'memory_restore',
    effect: 'write',
    description:
      '恢复一条记忆：不带 revision = 现行值复活（软删/被替代/过期皆可——过期条目复活唯此路，复活后按 ttl_days 重算过期钟）；带 revision = 内容面回滚到该历史版本（版本链上的快照，memory_read 带 id 可见链）。',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      revision: Type.Optional(
        Type.Integer({ minimum: 1, description: '目标版本号（memory_read 带 id 列出的 revision；缺省 = 现行值复活）' }),
      ),
    }),
    execute: async (args) => {
      const result =
        typeof args.revision === 'number'
          ? store.restore(String(args.id), Date.now(), args.revision)
          : store.restore(String(args.id));
      if (result.restored) {
        return textResult(
          typeof args.revision === 'number'
            ? `已回滚到版本 ${args.revision} 并复活（回滚版本已入链 cause=rollback）：${args.id}`
            : `已恢复（有留存策略时过期钟已重算）：${args.id}`,
          false,
          { id: args.id, restored: true, ...(typeof args.revision === 'number' ? { revision: args.revision } : {}) },
        );
      }
      return textResult(
        result.reason === 'revision'
          ? `版本 ${args.revision} 不在该条目的版本链上：${args.id}（memory_read 带 id 查看可用版本）`
          : `未找到该条目：${args.id}（id 从 memory_read/memory_search 获取）`,
        true,
        { id: args.id, restored: false, reason: result.reason },
      );
    },
  };

  /* ---------------- memory_read：常驻简报 + 最近变更 + 健康面（带 id = 条目详情+版本链） ---------------- */
  const memoryRead: ToolDefinition = {
    name: 'memory_read',
    effect: 'read',
    description:
      '读取当前生效的记忆（常驻简报选摘 + 最近变更清单 + 条目计数）。带 id = 单条详情（含状态/冻结/留存策略与完整版本链）。轻量读面，不做全文检索——检索用 memory_search。',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ minLength: 1, description: '条目 id——给定时展示单条详情与版本链' })),
    }),
    execute: async (args) => {
      const owners = opts.ownerKeys();
      // 带 id：单条详情 + 版本链（审计深读面——条目可能不在 active 面，全状态直读）
      if (typeof args.id === 'string' && args.id !== '') {
        const record = store.get(String(args.id));
        if (!record) return textResult(`未找到该条目：${args.id}`, true, { id: args.id });
        const sanitized = sanitizeForModel([record]);
        const entry = sanitized.entries[0];
        const versions = store.listVersions(record.id);
        const versionLines = versions.map(
          (v) =>
            `  r${v.revision} [${v.cause}] ${v.summary}（置信 ${v.confidence.toFixed(2)}，${new Date(v.createdAt).toISOString()}）`,
        );
        const lines = [
          entry ? entryLine(entry) : `（条目内容含历史敏感串，不入展示面；id=${record.id}）`,
          `状态：${record.status}${record.frozen ? '（frozen 冻结）' : ''}${record.ttlDays !== null ? `（TTL ${record.ttlDays} 天，${record.expiresAt !== null ? `过期于 ${new Date(record.expiresAt).toISOString()}` : '钟已清（过期物化或冻结）'}）` : '（永久）'}`,
          `计量：证据 ${record.evidenceCount} / 引用 ${record.usageCount} / 被引 ${record.lastUsedAt !== null ? new Date(record.lastUsedAt).toISOString() : '从未'}`,
          `— 版本链（${versions.length} 版）—`,
          ...(versionLines.length > 0 ? versionLines : ['  （无——v11 迁移前的存量条目，现行值即隐式基线）']),
        ];
        return textResult(lines.join('\n'), false, {
          id: record.id,
          status: record.status,
          frozen: record.frozen,
          ttlDays: record.ttlDays,
          versions: versions.length,
          blocked: sanitized.blocked,
        });
      }
      const brief = store.briefing(owners);
      const active = store.list(owners);
      const recent = active.slice(0, 10);
      const dismissedCount = store.list(owners, 'dismissed').length;
      const expiredCount = store.list(owners, 'expired').length;
      const frozenActive = active.filter((r) => r.frozen).length;
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
        `— 常驻简报（top ${briefSanitized.entries.length}${brief.frozenCount > 0 ? `（含冻结常驻 ${brief.frozenCount}）` : ''}${brief.truncated ? '，达限额截断' : ''}）—`,
        ...briefSanitized.entries.map(entryLine),
        `— 最近变更（${recentSanitized.entries.length} 条）—`,
        ...recentSanitized.entries.map(entryLine),
        `— 健康面：active ${active.length}（frozen ${frozenActive}）/ dismissed ${dismissedCount} / expired ${expiredCount}${blocked > 0 ? ` / 读出扫描拦截 ${blocked} 条（历史敏感串，不入展示面）` : ''}—`,
      ];
      return textResult(lines.join('\n'), false, {
        briefCount: briefSanitized.entries.length,
        truncated: brief.truncated,
        blocked,
        activeCount: active.length,
        frozenActive,
        dismissedCount,
        expiredCount,
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
      // 访问流水（§3）：检索命中记 op='search'——只记流水不进聚合（聚合只随 cite，
      // usage_count ≡ cite 行数）；session_id 恒 NULL（工具上下文无会话键）
      if (records.length > 0) {
        store.recordAccess(records.map((r) => ({ memoryId: r.id, op: 'search' as const })));
      }
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

  /* ---------------- memory_freeze：冻结（用户钉住） ---------------- */
  const memoryFreeze: ToolDefinition = {
    name: 'memory_freeze',
    effect: 'write',
    description:
      '冻结一条记忆（用户明确表示「这条永远记住」时使用）：恒驻简报（不再因未用离开）、免 TTL 过期、免合并覆写、免整理降权、拒 forget。冻结条目新证据走独立新条目。',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
    }),
    execute: async (args) => {
      const ok = store.setFrozen(String(args.id), true);
      return ok
        ? textResult(`已冻结（恒驻简报 + 免过期 + 免覆写）：${args.id}`, false, { id: args.id, frozen: true })
        : textResult(`未找到该条目：${args.id}`, true, { id: args.id, reason: 'missing' });
    },
  };

  /* ---------------- memory_unfreeze：解冻（重算钟） ---------------- */
  const memoryUnfreeze: ToolDefinition = {
    name: 'memory_unfreeze',
    effect: 'write',
    description:
      '解冻一条记忆：回到常规竞争面（有过期钟时按留存策略与解冻时点重算）。解冻-再忘是删除冻结条目的唯一路径。',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
    }),
    execute: async (args) => {
      const ok = store.setFrozen(String(args.id), false);
      return ok
        ? textResult(`已解冻（回到常规竞争面，钟已按需重算）：${args.id}`, false, { id: args.id, frozen: false })
        : textResult(`未找到该条目：${args.id}`, true, { id: args.id, reason: 'missing' });
    },
  };

  /* ---------------- memory_ttl：标记/清除留存策略 ---------------- */
  const memoryTtl: ToolDefinition = {
    name: 'memory_ttl',
    effect: 'write',
    description:
      '设置或清除一条记忆的留存天数（TTL）：到期自动过期离开一切注入面（行保留、可 restore 复活）；每次被引用自动续期。days=null 清除策略（永久）。已过期条目不因此复活——复活用 memory_restore。',
    parameters: Type.Object({
      id: Type.String({ minLength: 1 }),
      days: Type.Union([Type.Integer({ minimum: 1, maximum: 3650 }), Type.Null()], {
        description: '留存天数（正整数）；null = 清除策略改永久',
      }),
    }),
    execute: async (args) => {
      const days = args.days === null ? null : Number(args.days);
      const result = store.setTtl(String(args.id), days);
      return result.ok
        ? textResult(
            days !== null
              ? `已设置留存策略：${days} 天（过期钟已按当前时点起算）：${args.id}`
              : `已清除留存策略（改永久）：${args.id}`,
            false,
            { id: args.id, ttlDays: days },
          )
        : textResult(`未找到该条目：${args.id}`, true, { id: args.id, reason: 'missing' });
    },
  };

  /* ---------------- memory_access_log：访问流水与被用聚合 ---------------- */
  const memoryAccessLog: ToolDefinition = {
    name: 'memory_access_log',
    effect: 'read',
    description:
      '查询记忆访问日志：某条目（id 或前缀）被谁何时如何使用（recall 按需注入 / search 检索命中 / cite 引用回写），外加全局被用 top 条目。用户问「你为什么记得这个」「这条记忆哪来的」时使用。',
    parameters: Type.Object({
      memoryId: Type.Optional(Type.String({ minLength: 1, description: '精确条目 id（与 prefix 二选一）' })),
      prefix: Type.Optional(
        Type.String({ minLength: 8, maxLength: 8, description: '条目 id 前 8 位（简报引用标记里的短 id）' }),
      ),
      op: Type.Optional(
        Type.Union([Type.Literal('recall'), Type.Literal('search'), Type.Literal('cite')], {
          description: '操作过滤（缺省全部）',
        }),
      ),
      sinceHours: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 24 * 90, description: '只看最近 N 小时（缺省全部——滚动窗口 90 天）' }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: '流水条数（缺省 50）' })),
    }),
    execute: async (args) => {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const rows = store.accessLog({
        ...(typeof args.memoryId === 'string' ? { memoryId: String(args.memoryId) } : {}),
        ...(typeof args.prefix === 'string' ? { prefix: String(args.prefix) } : {}),
        ...(typeof args.op === 'string' ? { op: args.op as 'recall' | 'search' | 'cite' } : {}),
        ...(typeof args.sinceHours === 'number' ? { sinceMs: Date.now() - args.sinceHours * 3600_000 } : {}),
        limit,
      });
      const top = store.topByUsage(opts.ownerKeys(), 5);
      const topLines = top.map((r) => `- ${citationMarker(r.id)} [${r.kind}] ${r.summary}（引用 ${r.usageCount} 次）`);
      const logLines = rows.map(
        (r) =>
          `- ${new Date(r.ts).toISOString()} ${r.op}${r.sessionId !== null ? `（session=${r.sessionId.slice(0, 8)}）` : ''} → ${r.memoryId}`,
      );
      const lines = [
        `— 被用 top（${top.length}）—`,
        ...(topLines.length > 0 ? topLines : ['（暂无被引用条目）']),
        `— 访问流水（${rows.length} 条）—`,
        ...(logLines.length > 0 ? logLines : ['（窗口内无流水）']),
      ];
      return textResult(lines.join('\n'), false, { rows: rows.length, top: top.length });
    },
  };

  return [
    memoryWrite,
    memoryForget,
    memoryRestore,
    memoryRead,
    memorySearch,
    memoryFreeze,
    memoryUnfreeze,
    memoryTtl,
    memoryAccessLog,
  ];
}
