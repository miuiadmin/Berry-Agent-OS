/**
 * L0 contracts — 错误码族（内核篇 §5.3，第八批拍板 #11：单一路线钉死）。
 *
 * 四条规则：
 * 1. SCREAMING_SNAKE + 模块前缀的**字符串码**是唯一错误词汇（TOOL_/FS_/SESSION_/CONTEXT_/…）；
 * 2. 所有码在 contracts 显式注册（与事件类型同纪律，CI 可校验）；
 * 3. 进程内统一 AppError 单基类 `{code, message, cause?}`——**类名层级废弃**，
 *    catch 一律按 code 分派（不 instanceof 具体子类）；
 * 4. durable 事件里错误一律写码（不写本地化文案）。
 */

/**
 * 进程内唯一错误基类。
 *
 * 用法：`throw new AppError('FS_NOT_OBSERVED', '文件未读过，拒绝修改', { cause: err })`
 * 捕获：`catch (e) { if (e instanceof AppError && e.code === 'FS_NOT_OBSERVED') … }`
 * 禁止为具体错误场景派生子类——场景差异全部体现在 code 上。
 */
export class AppError extends Error {
  /** 机器可分派的错误码（唯一判据，注册于下方注册表） */
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'AppError';
    this.code = code;
  }
}

/** 已注册错误码集合（注册即词汇表，listErrorCodes 供 CI / dump 诊断枚举） */
const registry = new Set<string>();

/** 错误码格式：大写字母开头，仅大写字母/数字/下划线，至少含一个下划线（模块前缀分隔） */
const CODE_FORMAT = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

/**
 * 注册一个错误码并返回它（注册即使用，`const X = registerErrorCode('X')`）。
 * 重复注册或格式非法直接抛错——错误词汇必须在编译/测试期就钉死，不留运行时漂移。
 */
export function registerErrorCode(code: string): string {
  if (!CODE_FORMAT.test(code)) {
    throw new AppError('CONTRACT_BAD_ERROR_CODE', `错误码格式非法：${code}（应为 SCREAMING_SNAKE + 模块前缀）`);
  }
  if (registry.has(code)) {
    throw new AppError('CONTRACT_DUPLICATE_ERROR_CODE', `错误码重复注册：${code}`);
  }
  registry.add(code);
  return code;
}

/** 枚举全部已注册错误码（CI 校验 / 诊断输出用） */
export function listErrorCodes(): string[] {
  return [...registry].sort();
}

/* ------------------------------------------------------------------ */
/* 首批注册码——仅收录规范已拍板命名的码，后续模块落地时随用随注册。 */
/* 命名出处：内核篇 §5.3 / 会话篇 §4（恢复合成）/ 第七批（fs CAS）。 */
/* ------------------------------------------------------------------ */

/** context：通过 ctx.get 取用未注册的服务 */
export const CONTEXT_SERVICE_NOT_FOUND = registerErrorCode('CONTEXT_SERVICE_NOT_FOUND');
/** context：ctx.provide 同名服务重复注册（组合树装配错误，响亮失败不静默覆盖） */
export const CONTEXT_SERVICE_EXISTS = registerErrorCode('CONTEXT_SERVICE_EXISTS');
/** context：作用域已销毁后仍调用其 API（stale ctx 护栏，/reload 必然配套） */
export const CONTEXT_DISPOSED = registerErrorCode('CONTEXT_DISPOSED');
/** contracts：错误码注册表自身的护栏违规（格式/重复） */
export const CONTRACT_BAD_ERROR_CODE = registerErrorCode('CONTRACT_BAD_ERROR_CODE');
export const CONTRACT_DUPLICATE_ERROR_CODE = registerErrorCode('CONTRACT_DUPLICATE_ERROR_CODE');

/** tools：工具调用被取消时工具尚未开始执行（恢复 reducer 合成终态用，会话篇 §4） */
export const TOOL_NOT_STARTED = registerErrorCode('TOOL_NOT_STARTED');
/** tools：工具已启动但结果未知（超时/崩溃后的合成终态） */
export const TOOL_OUTCOME_UNKNOWN = registerErrorCode('TOOL_OUTCOME_UNKNOWN');
/** tools：工具执行超时（三段管道 execute 段的时长上限触发） */
export const TOOL_TIMEOUT = registerErrorCode('TOOL_TIMEOUT');

/** fs：观察态 CAS——文件未读过（无观察版本）即拒绝修改（第七批安全四件之一） */
export const FS_NOT_OBSERVED = registerErrorCode('FS_NOT_OBSERVED');
/** fs：写入时文件版本与观察版本不符（并发修改守卫） */
export const FS_VERSION_CONFLICT = registerErrorCode('FS_VERSION_CONFLICT');

/** session：会话格式/版本不支持（升级后的旧库拒绝打开，不迁移，会话篇拍板） */
export const SESSION_FORMAT_UNSUPPORTED = registerErrorCode('SESSION_FORMAT_UNSUPPORTED');
/** session：同一会话同一时刻只允许单写者——第二写者追加即响亮拒绝（第八批 #13 护栏） */
export const SESSION_WRITE_CONFLICT = registerErrorCode('SESSION_WRITE_CONFLICT');
