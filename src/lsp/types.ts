/**
 * L3 lsp — 配置面与协议类型（契约篇 §6.7 第一刀，2026-08-30）。
 *
 * 服务器身份 = builtin:lsp 单行 config `servers` 的**键名**（键词法
 * `[A-Za-z0-9-]+`——MCP 同款裁决）；`languages` 是**扩展名路由表**：
 * 路径扩展名 lowercase 归一后匹配，多服务器命中取 config 键声明序首——
 * 路由规则全件唯一（诊断注入与四工具同表同序）。
 *
 * schema 构建走 contracts 再导出面（typebox 单实例纪律——lsp 不在
 * typebox 直连白名单，与应用同路取用）。
 */

import { Type } from '../contracts/typebox.js';

/** 服务器键词法：字母/数字/连字符（MCP 同款） */
export const LSP_SERVER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/** 单服务器配置 schema（拒绝式——未知字段拒绝，overlay 覆盖整体 config） */
export const LSP_SERVER_CONFIG_SCHEMA = Type.Object({
  /** 服务器可执行文件——v1 只认绝对路径（相对路径在 connect 期拦 LSP_CONNECT_FAILED；npx 解析后置） */
  command: Type.String(),
  /** 命令行参数 */
  args: Type.Optional(Type.Array(Type.String())),
  /** set 显式 env 层（用户声明的键值直传子进程——不经宿主翻译） */
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** 扩展名路由表（如 ['.ts', '.tsx']——声明序即路由优先序；缺省空 = 不路由任何路径） */
  languages: Type.Optional(Type.Array(Type.String())),
  /** 启动握手超时秒（缺省 30——只罩 spawn + initialize；LSP 全量索引初始化普遍慢于 MCP 握手） */
  startup_timeout_sec: Type.Optional(Type.Number()),
  /** 单请求超时秒（缺省 15——只计单请求，与握手钟分账：两钟接力非互截） */
  request_timeout_sec: Type.Optional(Type.Number()),
  /** 诊断等待毫秒（缺省 8000——工具面全额等待；post 注入面另有 3500 硬帽） */
  diagnostics_timeout_ms: Type.Optional(Type.Number()),
});

/** 件级配置 schema（行 config——servers 缺省为空 = 行惰性无害零 spawn） */
export const LSP_APP_CONFIG_SCHEMA = Type.Object({
  servers: Type.Optional(Type.Record(Type.String(), LSP_SERVER_CONFIG_SCHEMA)),
});

/** 单服务器配置（schema 校验后的运行时形态） */
export interface LspServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly languages?: readonly string[];
  readonly startup_timeout_sec?: number;
  readonly request_timeout_sec?: number;
  readonly diagnostics_timeout_ms?: number;
}

/* ---------------------------------------------------------------------------------- */
/* LSP 协议消息类型（Content-Length 头帧——只取桥要用的字段）                          */
/* ---------------------------------------------------------------------------------- */

/** publishDiagnostics 载荷（LSP 协议该字段可选——服务器不带 version 视为最新） */
export interface PublishDiagnosticsParams {
  /** 文档 URI（file:// 形态——与桥自持 URI 账同键） */
  readonly uri: string;
  /** 本次诊断集的文档版本（可选——不带 = 服务器不追踪版本，视为最新直接解锁 waiter） */
  readonly version?: number;
  /** 诊断条目（可能为空数组 = 该文档当前无问题） */
  readonly diagnostics: readonly LspDiagnostic[];
}

/** 单条诊断（LSP Diagnostic——只取工具面与注入面要用的字段） */
export interface LspDiagnostic {
  /** 诊断码（如 TS2322——呈现给模型便于检索，可缺） */
  readonly code?: number | string;
  /** 严重度：1 Error / 2 Warning / 3 Information / 4 Hint */
  readonly severity?: number;
  /** 消息正文 */
  readonly message: string;
  /** 来源（如 "ts"——可缺） */
  readonly source?: string;
  /** 范围（0-based 行列——工具面呈现前转 1-based） */
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

/** documentSymbol 返回项（DocumentSymbol 层级形态——v1 展平呈现，children 不递归） */
export interface LspDocumentSymbol {
  readonly name: string;
  readonly kind?: number;
  readonly range?: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  /** 子符号（v1 不递归展开——顶层大纲足够） */
  readonly children?: readonly LspDocumentSymbol[];
  /** 旧协议形态：SymbolInformation 平铺（无 range 有 location） */
  readonly location?: {
    readonly range: {
      readonly start: { readonly line: number; readonly character: number };
    };
  };
}

/** definition/references 返回项（Location 形态——uri + range） */
export interface LspLocation {
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

/**
 * 扩展名 → languageId 内置缺省映射（v1 小表：ts 系/python/go/rust/json/
 * web 常用档；未命中 'plaintext'）。didOpen 的 languageId 字段用——
 * 多数服务器据此选解析器。
 */
export const LANGUAGE_ID_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.md': 'markdown',
  '.yaml': 'yaml',
  '.yml': 'yaml',
});

/** 按扩展名取 languageId（未命中 'plaintext'） */
export function languageIdOf(absPath: string): string {
  const dot = absPath.lastIndexOf('.');
  const ext = dot === -1 ? '' : absPath.slice(dot).toLowerCase();
  return LANGUAGE_ID_BY_EXT[ext] ?? 'plaintext';
}
