import { createHash } from 'node:crypto';
import type { TokenIssuer, ApprovalManager, RiskLevel, PermissionMode } from '../safety/index.js';
import { checkBlocklist } from '../safety/blocklist.js';
import { PermissionEngine } from '../safety/permissions.js';
import type { PermissionResultPayload } from '../contracts/permissions.js';
import type { DangerLevel } from '../utils/types.js';
import type { StateCache } from './state-cache.js';

/** 13.0 §3.8 第二层: 硬约束 scope（Brain 纠偏时写入，permission 检查时强制） */
export interface ActiveScope {
  /** 禁止访问的路径模式（glob / 精确路径前缀） */
  blockPaths?: string[];
  /** 禁止使用的工具 */
  blockTools?: string[];
  /**
   * 15.0 R4（"委派即授权"）：委派授权的工具白名单。
   * 命中的工具自动放行（签 token），绕过危险类别 requiresReview——
   * 因为委派本身即 Brain 对该 Agent 用自身工具完成任务的授权。
   * 支持通配 '*'（= 委派授权该 Agent 全工具集，受 blockTools/blockPaths 约束）。
   * Brain 纠偏仍可用 blockTools/blockPaths 收窄（block 永远优先于 allow）。
   */
  allowTools?: string[];
  /** 委派授权的路径白名单（glob / 精确路径前缀）；路径在范围内自动放行 */
  allowPaths?: string[];
}

/**
 * 13.0 §3.8: 规范化路径 — 统一正斜杠、合并重复斜杠、去尾部斜杠。
 * 保证比较双方处于同一规范形式，避免 './src/../src' 与 'src' 判定不一致。
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/**
 * 13.0 §3.8: 将 glob 模式编译为正则（不引入外部依赖）。
 *
 * 支持的 glob 语法（覆盖安全约束常见场景）：
 * - `**`  跨目录层级通配（含 `/`），如 `src/**` 匹配 src 下所有文件
 * - `*`   单层通配（不含 `/`），如 `*.env` 匹配根级 .env
 * - `?`   单字符通配（不含 `/`）
 * - 其他字符按字面量匹配（正则元字符自动转义）
 *
 * @param pattern glob 模式（已规范化）
 * @returns 编译后的正则表达式
 */
function compileGlob(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` 匹配任意层级（含路径分隔符）
        regex += '.*';
        i += 2;
        // 吞掉 `**/` 末尾的斜杠，让 `src/**` 同时匹配 `src` 本身和 `src/a/b`
        if (pattern[i] === '/') i++;
        continue;
      }
      // `*` 匹配单层（不含 `/`）
      regex += '[^/]*';
    } else if (c === '?') {
      regex += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
    i++;
  }
  return new RegExp('^' + regex + '$');
}

/**
 * 13.0 §3.8: 精确判定单个文件路径是否被某个 blockPath 模式命中。
 *
 * 三种匹配语义（按优先级）：
 * 1. **glob 模式**（blockPath 含 `*` 或 `?`）→ glob 正则匹配
 * 2. **精确文件匹配**（规范化后完全相等）
 * 3. **目录前缀匹配**（blockPath 是 filePath 的祖先目录）：
 *    `src` 命中 `src/auth.ts`，但不命中 `src-old/auth.ts`（修正旧版子串匹配的误判）
 *
 * @param filePath 待检查的文件路径（规范化后）
 * @param blockPath Brain 纠偏设定的禁止模式（规范化后）
 * @returns true 表示命中（应拦截）
 */
function isPathBlocked(filePath: string, blockPath: string): boolean {
  // ① glob 模式
  if (blockPath.includes('*') || blockPath.includes('?')) {
    return compileGlob(blockPath).test(filePath);
  }
  // ② 精确匹配
  if (filePath === blockPath) return true;
  // ③ 目录前缀：blockPath 必须是 filePath 的某个祖先目录（以 `blockPath/` 开头）
  //    这避免了 'src' 子串误命中 'src-old' —— 'src-old'.startsWith('src/') 为 false
  if (filePath.startsWith(blockPath + '/')) return true;
  return false;
}

/**
 * 13.0 §3.8: 从工具输入中提取所有路径字段。
 *
 * 旧版直接对整个 JSON 字符串做 `includes(blockPath)` 子串匹配，
 * 会在无关字段（如 description、content）上误命中。
 * 本函数解析 JSON 后只取语义为路径的字段，做精确匹配。
 *
 * 支持的输入格式：
 * 1. JSON 对象 → 提取 path/file/filePath 等字段的值
 * 2. 原始路径字符串（以 / 或 ./ 开头，或含 / 和常见文件扩展名）→ 整体作为一个路径
 * 3. 非路径字符串（如 'ls'、'x'）→ 返回空数组（不误判）
 *
 * @param toolInput 工具输入（JSON 字符串或序列化值）
 * @returns 提取出的路径数组（已规范化）
 */
function extractPathsFromInput(toolInput: string): string[] {
  const FIELD_NAMES = new Set([
    'path', 'file', 'filepath', 'filename', 'dirpath', 'directory', 'cwd', 'destination', 'target', 'dest',
  ]);
  const paths: string[] = [];

  // ① 尝试解析为 JSON 对象，提取路径字段
  try {
    const parsed = JSON.parse(toolInput);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (FIELD_NAMES.has(key.toLowerCase()) && typeof value === 'string' && value.length > 0) {
          paths.push(normalizePath(value));
        }
      }
      return paths;
    }
  } catch {
    // JSON 解析失败，继续到下面的原始字符串判断
  }

  // ② 原始路径字符串：看起来像文件路径（以 / ./ ../ 开头，或含 / 和扩展名）
  //    避免 'ls'、'x' 等非路径字符串被误判为路径
  if (toolInput.length > 0) {
    const looksLikePath = /^(?:\/|\.\.?\/)/.test(toolInput)
      || (toolInput.includes('/') && /\.\w{1,10}$/.test(toolInput));
    if (looksLikePath) {
      paths.push(normalizePath(toolInput));
    }
  }

  return paths;
}

/**
 * 15.0 R4：合并两个字符串数组并去重（用于 active_scope 的合并写入）。
 * 任一为 undefined/空则取另一边，保证不丢既有约束。
 */
function mergeUnique(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!a?.length) return b?.length ? [...b] : undefined;
  if (!b?.length) return [...a];
  return [...new Set([...a, ...b])];
}

export interface CheckAndIssueParams {
  agentName: string;
  sessionId: string;
  toolName: string;
  toolInput: string;
  dangerLevel: DangerLevel;
  taskId?: string;
  correlationId?: string;
}

export class PermissionCoordinator {
  private engine: PermissionEngine;
  private tokenIssuer: TokenIssuer;
  private approvalManager: ApprovalManager;
  /** 13.0 §3.8 第二层: StateCache 注入，用于读取 active_scope */
  private stateCache: StateCache | null = null;
  /** 15.0 R2-4：per-session 权限模式（修复进程级单例并发污染——并发会话 last-writer-wins 串改 mode） */
  private defaultMode: PermissionMode;
  private readonly sessionModes = new Map<string, PermissionMode>();
  /** 按 mode 缓存 PermissionEngine（最多 4 个：ask/allow-all/deny-all/yolo），避免每消息重建 */
  private readonly modeEngines = new Map<string, PermissionEngine>();

  constructor(deps: {
    engine: PermissionEngine;
    tokenIssuer: TokenIssuer;
    approvalManager: ApprovalManager;
    /** 可选：注入 StateCache 以支持硬约束 scope 拦截（§3.8 第二层） */
    stateCache?: StateCache;
  }) {
    this.engine = deps.engine;
    this.tokenIssuer = deps.tokenIssuer;
    this.approvalManager = deps.approvalManager;
    this.stateCache = deps.stateCache ?? null;
    this.defaultMode = deps.engine.getMode();
    this.modeEngines.set(this.defaultMode, deps.engine);
  }

  /**
   * 15.0 R2-4：设置某会话的权限模式（替代进程级 updateEngine，避免并发污染）。
   * 按 mode 缓存 engine（4 个上限）。unified-handlers 每条消息按 sessionId 设置。
   */
  setSessionMode(sessionId: string, mode: PermissionMode): void {
    this.sessionModes.set(sessionId, mode);
    if (!this.modeEngines.has(mode)) {
      this.modeEngines.set(mode, new PermissionEngine(mode));
    }
  }

  /** 15.0 R3：清理会话 mode（session GC/teardown 时调用，防 sessionModes 无界增长） */
  clearSessionMode(sessionId: string): void {
    this.sessionModes.delete(sessionId);
  }

  /** 取某会话的权限模式（无则回退默认） */
  getMode(sessionId?: string): PermissionMode {
    const m = sessionId ? this.sessionModes.get(sessionId) : undefined;
    return m ?? this.defaultMode;
  }

  /** 取某会话的 engine（按 session mode 缓存命中；无 session mode 回退默认 engine） */
  private getEngineForSession(sessionId?: string): PermissionEngine {
    const mode = this.getMode(sessionId);
    return this.modeEngines.get(mode) ?? this.engine;
  }

  /**
   * 注入 StateCache（延迟注入，兼容 bootstrap 顺序）。
   * 13.0 §3.8 第二层：Brain 纠偏写入 active_scope 后，permission 检查必须强制拦截。
   */
  setStateCache(stateCache: StateCache): void {
    this.stateCache = stateCache;
  }

  /**
   * 引擎热更新（CoreService config reload 在 permissionMode 变更时调用——见 core-service.ts reload handler）。
   * 15.0 R2-4：per-message 的 mode 不走这里（用 setSessionMode 避免并发污染）；
   * 此处仅同步全局默认 defaultMode + 缓存，影响无显式 per-session mode 的会话。
   */
  updateEngine(engine: PermissionEngine): void {
    this.engine = engine;
    const mode = engine.getMode();
    // 同步默认模式 + 缓存（getMode 无 session 时回退此值）
    this.defaultMode = mode;
    this.modeEngines.set(mode, engine);
  }

  /**
   * 13.0 §3.8 第二层 + 15.0 R4「委派即授权」：评估 active_scope 对当前工具调用的决策。
   *
   * 三态返回（block 永远优先于 grant——Brain 纠偏的硬约束不能被委派授权绕过）：
   * - `{ block }` —— 命中 blockTools / blockPaths / run_command blocklist，硬拦截
   * - `{ grant }` —— 命中 allowTools / allowPaths（委派授权），自动放行（绕过危险类别 requiresReview）
   * - `null`     —— 无 scope 或 block/allow 均未命中，走正常权限流（危险类别 requiresReview 等）
   *
   * @param taskId    - delegation / agent_task ID（active_scope 的 key）
   * @param toolName  - 当前要执行的工具名
   * @param toolInput - 工具输入（用于检查 blockPaths / allowPaths / run_command blocklist）
   */
  evaluateScope(taskId: string | undefined, toolName: string, toolInput: string): { block: string } | { grant: string } | null {
    if (!this.stateCache || !taskId) return null;
    const scope = this.stateCache.get<ActiveScope>('active_scope', taskId);
    if (!scope) return null;

    // ── ① block（硬约束，永远先于授权生效）──────────────────────────────
    if (scope.blockTools && scope.blockTools.length > 0 && scope.blockTools.includes(toolName)) {
      return { block: `active_scope 禁止工具: ${toolName}` };
    }
    // run_command blocklist 永远生效：即使委派授权（allowTools '*'）也不放行 rm -rf 等
    // 不可逆危险命令。注：PermissionEngine.checkPermission 因 run_command 属危险类别会在
    // mode 判断前早返回 requiresReview，反而跳过了 blocklist——此处补上，确保 blocklist 不被绕过。
    if (toolName === 'run_command') {
      const blockResult = checkBlocklist(toolInput);
      if (blockResult.blocked) {
        return { block: blockResult.reason ?? 'run_command 命中危险命令 blocklist' };
      }
    }
    // blockPaths 命中（精确路径 + glob，修正旧版子串匹配的误判：
    // blockPath='src' 不应命中 'src-old'，按路径字段精确匹配）
    if (scope.blockPaths && scope.blockPaths.length > 0) {
      const inputPaths = extractPathsFromInput(toolInput);
      const normalizedBlocks = scope.blockPaths.map(normalizePath);
      for (const inputPath of inputPaths) {
        for (const blockPath of normalizedBlocks) {
          if (isPathBlocked(inputPath, blockPath)) {
            return { block: `active_scope 禁止访问路径: ${blockPath}（命中 ${inputPath}）` };
          }
        }
      }
    }

    // ── ② grant（委派授权）────────────────────────────────────────────
    // allowTools：含本工具或通配 '*' → 自动放行（委派即授权该 Agent 用自身工具）
    const allowTools = scope.allowTools;
    if (allowTools && allowTools.length > 0 && (allowTools.includes(toolName) || allowTools.includes('*'))) {
      return { grant: `委派授权工具: ${toolName}` };
    }
    // allowPaths：工具入参路径落在授权范围内 → 放行
    if (scope.allowPaths && scope.allowPaths.length > 0) {
      const inputPaths = extractPathsFromInput(toolInput);
      const normalizedAllows = scope.allowPaths.map(normalizePath);
      for (const inputPath of inputPaths) {
        for (const allowPath of normalizedAllows) {
          if (isPathBlocked(inputPath, allowPath)) {
            return { grant: `委派授权路径: ${inputPath}` };
          }
        }
      }
    }

    return null;
  }

  /**
   * 写入 active_scope（由 CorrectionFlow / delegation-orchestrator 调用）。
   *
   * 15.0 R4 改为**合并语义**（read-modify-write）：新约束并入既有 scope，而非整体覆盖。
   * 原因——委派时写入 `allowTools:['*']`（委派即授权），随后 CorrectionFlow 纠偏写入
   * `blockTools:[...]`（Brain 收窄）。若用覆盖，纠偏的 blockTools 写入会把 allowTools 抹掉，
   * 委派授权丢失、Code Agent 又回到"无法写文件"。合并让两者共存：allow 放行、block 收窄。
   * block 永远优先于 allow（evaluateScope 中先判 block），所以收窄依然生效。
   *
   * @param taskId - delegation ID（与 evaluateScope 的 key 对应）
   * @param patch  - 要并入的约束（blockTools/blockPaths/allowTools/allowPaths）
   */
  setActiveScope(taskId: string, patch: ActiveScope): void {
    if (!this.stateCache) return;
    const prev = this.stateCache.get<ActiveScope>('active_scope', taskId) ?? {};
    // 数组字段取并集去重；同一 taskId 的多次 setActiveScope 累加而非替换
    this.stateCache.set('active_scope', taskId, {
      blockTools: mergeUnique(prev.blockTools, patch.blockTools),
      blockPaths: mergeUnique(prev.blockPaths, patch.blockPaths),
      allowTools: mergeUnique(prev.allowTools, patch.allowTools),
      allowPaths: mergeUnique(prev.allowPaths, patch.allowPaths),
    });
  }

  /**
   * 清除 task 的 active_scope（task 结束 / 重置时调用）。
   */
  clearActiveScope(taskId: string): void {
    if (!this.stateCache) return;
    this.stateCache.delete('active_scope', taskId);
  }

  /**
   * V-3：委派授权（active_scope allowTools/allowPaths，即「委派即授权」）是否实际生效。
   *
   * grant 可跳过 ask/yolo 的 requiresReview（委派即授权的初衷——Brain 已通过委派授权该 Agent 用自身工具），
   * 但 deny-all 是会话级硬上限：Brain 委派写入的 allowTools:['*'] 不得穿透 deny-all 锁，否则 deny-all 形同虚设
   * （会话被锁死后 Agent 仍可任意用工具）。deny-all 时返回 false——调用方不进入 grant 分支，落到
   * engine.checkPermission（deny-all 必拒），保证硬上限不被委派绕过。
   */
  private delegationGrantEffective(sessionId: string): boolean {
    return this.getMode(sessionId) !== 'deny-all';
  }

  checkAndIssue(params: CheckAndIssueParams): PermissionResultPayload {
    // 13.0 §3.8 第二层 + 15.0 R4「委派即授权」：先做 active_scope 三态决策
    // - block：硬拦截（blockTools / blockPaths / run_command blocklist）
    // - grant：委派授权，签 token 直接放行（绕过危险类别 requiresReview）
    // - null：无 scope，走下方正常权限流
    const scopeDecision = this.evaluateScope(params.taskId, params.toolName, params.toolInput);
    if (scopeDecision && 'block' in scopeDecision) {
      return { allowed: false, reason: scopeDecision.block };
    }
    if (scopeDecision && 'grant' in scopeDecision && this.delegationGrantEffective(params.sessionId)) {
      // 委派即授权：Brain 已通过委派授权该 Agent 用自身工具，直接签 token 放行。
      // deny-all 会话下 grant 不生效（见 delegationGrantEffective）——落到下方 engine 检查必拒，硬上限不被绕过。
      const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
      const token = this.tokenIssuer.issue({ sessionId: params.sessionId, agentName: params.agentName, toolName: params.toolName, inputHash });
      return { allowed: true, tokenId: token.id };
    }

    // engine 硬确定性检查：dangerous_tool 类别 / blocklist / deny-all（不涉及风险路由）
    const blockResult = this.getEngineForSession(params.sessionId).checkPermission(
      params.toolName,
      params.toolInput,
      params.dangerLevel,
    );
    if (!blockResult.allowed && !blockResult.requiresReview) {
      return { allowed: false, reason: blockResult.reason };
    }

    // 15.0 收敛：统一在决策前创建 approval request，保证 requiresReview 一律携带 requestId。
    // 修复历史 quirk —— 之前 engine 路径的 requiresReview 在创建 request 前就 return，
    // 不带 requestId，导致上层 handler 无法 resolve（无法签 token），moderate 实际落到 user_confirm。
    const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
    const riskMap: Record<string, RiskLevel> = { safe: 'low', moderate: 'medium', dangerous: 'high' };
    const riskLevel = riskMap[params.dangerLevel] ?? 'medium';

    const request = this.approvalManager.createRequest({
      sessionId: params.sessionId,
      // ephemeral taskId（dtask_xxx）是 dialogue 模式下的临时 ID，不存在于 agent_tasks 表，
      // 传入会触发 FK 约束失败，因此过滤掉
      taskId: params.taskId?.startsWith('dtask_') ? undefined : params.taskId,
      correlationId: params.correlationId ?? params.sessionId,
      kind: 'tool',
      requester: params.agentName,
      riskLevel,
      requestPayload: { toolName: params.toolName, toolInput: params.toolInput, dangerLevel: params.dangerLevel },
      bindingPayload: { agentName: params.agentName, toolName: params.toolName, inputHash },
    });

    // engine 标记 requiresReview（危险工具类别 / ask 非 safe）→ 带 requestId 返回，供 handler resolve
    if (blockResult.requiresReview) {
      return { allowed: false, requiresReview: true, reason: blockResult.reason, requestId: request.id };
    }

    // 风险路由单一决策点：autoDecide（allow-all 放行 / ask low 放行 / 其余 requiresReview）
    const token = this.approvalManager.autoDecide(request, this.getMode(params.sessionId));

    if (token) {
      return { allowed: true, tokenId: token.id };
    }
    // autoDecide returned null → needs Brain judge or user confirmation
    return { allowed: false, requiresReview: true, reason: '需要 Brain 审批', requestId: request.id };
  }

  /**
   * 简化版权限检查（模块 Agent 用）。
   *
   * 13.0 修复：与 checkAndIssue() 对齐，增加 active_scope 硬拦截。
   * 之前 checkAndIssueSimple() 跳过了 active_scope 评估，导致 Brain 纠偏
   * 设置的 forbiddenTools 对模块 Agent 的工具调用没有硬强制。
   *
   * @param params.agentName Agent 名称
   * @param params.sessionId 会话 ID
   * @param params.toolName 工具名称
   * @param params.toolInput 工具输入
   * @param params.dangerLevel 危险等级
   * @param params.taskId 可选任务 ID（用于 active_scope 检查，§3.8 第二层）
   */
  checkAndIssueSimple(params: { agentName: string; sessionId: string; toolName: string; toolInput: string; dangerLevel: DangerLevel; taskId?: string }): PermissionResultPayload {
    // 13.0 §3.8 第二层 + 15.0 R4：active_scope 三态决策（与 checkAndIssue 对齐）
    const scopeDecision = this.evaluateScope(params.taskId, params.toolName, params.toolInput);
    if (scopeDecision && 'block' in scopeDecision) {
      return { allowed: false, reason: scopeDecision.block };
    }
    if (scopeDecision && 'grant' in scopeDecision && this.delegationGrantEffective(params.sessionId)) {
      // 委派即授权：直接签 token 放行，module agent 同步路径无需异步审核。
      // deny-all 会话下 grant 不生效（见 delegationGrantEffective）——落到下方 engine 检查必拒。
      const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
      const token = this.tokenIssuer.issue({ sessionId: params.sessionId, agentName: params.agentName, toolName: params.toolName, inputHash });
      return { allowed: true, tokenId: token.id };
    }

    const engine = this.getEngineForSession(params.sessionId);
    const blockResult = engine.checkPermission(
      params.toolName,
      params.toolInput,
      params.dangerLevel,
    );
    // 硬拒（!allowed 且非 requiresReview，如 deny-all）：直接拒绝
    if (!blockResult.allowed && !blockResult.requiresReview) {
      return { allowed: false, reason: blockResult.reason };
    }
    // 15.0 R3 F1/F2/F5（修复 R2-2 过度放行）：危险工具类别（write_file/edit_code/run_command 等）
    // 即使 requiresReview 也不自动签 token——这些工具需要用户/Brain 审核，module agent 同步路径无法
    // 做异步审核，应 fail-closed 拒绝。仅 moderate 非类别工具走 delegated trust 自动放行（R2-2 原意）。
    // 修复前：R2-2 的守卫对所有 requiresReview 签 token → 危险工具（含 run_command 的 rm -rf）被放行。
    if (blockResult.requiresReview && engine.isDangerousTool(params.toolName)) {
      return { allowed: false, reason: `危险工具 ${params.toolName} 需用户/Brain 审核（module agent 同步路径无法异步审核）` };
    }

    const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
    const token = this.tokenIssuer.issue({ sessionId: params.sessionId, agentName: params.agentName, toolName: params.toolName, inputHash });
    return { allowed: true, tokenId: token.id };
  }

  validate(params: { tokenId: string; sessionId: string; agentName: string; toolName: string; toolInput: string }): PermissionResultPayload {
    const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
    const result = this.tokenIssuer.validate(params.tokenId, {
      sessionId: params.sessionId,
      agentName: params.agentName,
      toolName: params.toolName,
      inputHash,
    });
    return result.valid
      ? { allowed: true }
      : { allowed: false, reason: result.reason };
  }

  acquire(params: CheckAndIssueParams): PermissionResultPayload {
    const issued = this.checkAndIssue(params);
    if (!issued.allowed && !issued.requiresReview) return issued;
    if (issued.requiresReview) return issued;
    if (!issued.tokenId) return issued;

    const inputHash = createHash('sha256').update(params.toolInput).digest('hex').slice(0, 16);
    const validation = this.tokenIssuer.validate(issued.tokenId, {
      sessionId: params.sessionId,
      agentName: params.agentName,
      toolName: params.toolName,
      inputHash,
    });
    if (!validation.valid) {
      return { allowed: false, reason: validation.reason };
    }

    return { allowed: true, tokenId: issued.tokenId };
  }

  consume(tokenId: string): PermissionResultPayload {
    const consumed = this.tokenIssuer.consume(tokenId);
    return consumed
      ? { allowed: true }
      : { allowed: false, reason: 'permission token 消费失败' };
  }

  getPending(sessionId?: string) {
    return this.approvalManager.getPending(sessionId);
  }

  resolve(requestId: string, decision: Parameters<ApprovalManager['resolve']>[1]) {
    return this.approvalManager.resolve(requestId, decision);
  }

  cancel(requestId: string) {
    return this.approvalManager.cancel(requestId);
  }
}
