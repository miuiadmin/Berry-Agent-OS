/**
 * L3 web — 官方件 `builtin:web` 类型面（契约篇 §1.5.2 定形，2026-08-26 web 刀）。
 *
 * 一批三件的共享词汇：fetch 工具（模型面）与 ctx.fetch 服务（装载面）同一
 * execute 同一卫生件——本文件是两消费面的唯一类型源（骨架篇 §9.3 签名）。
 */

import { Type } from '../contracts/typebox.js';

/* ------------------------------------------------------------------ */
/* 数值面（契约篇 §1.5.2 卫生件③④——全数值规范钉死，代码只落字面）      */
/* ------------------------------------------------------------------ */

/** 网络读硬顶 2 MiB（流式计数超即断流，result.truncated 标注） */
export const WEB_NETWORK_BUDGET_BYTES = 2 * 1024 * 1024;
/**
 * 产出文本 60 KiB 保头截断（与 durable 内容预算**同值对齐、物理各持**——
 * 常量住 chat 未导出而 web 边不含 chat，跨模块 import 即破最窄边；
 * exec spawn OUTPUT_BUDGET_BYTES 自持同款先例，契约篇 §1.5.2 ①）
 */
export const WEB_TEXT_BUDGET_BYTES = 60 * 1024;
/** 重定向上限 5 跳（redirect:'manual' 自跟，每跳重过私网+协议校验；错误码 WEB_REDIRECT_LIMIT 另住 contracts） */
export const WEB_MAX_REDIRECTS = 5;
/** 全局在飞上限（信号量排队不拒绝——防并发打爆不防频次） */
export const WEB_MAX_GLOBAL_INFLIGHT = 8;
/** 每主机在飞上限（同主机串行化，顺带压爬虫形态） */
export const WEB_MAX_PER_HOST_INFLIGHT = 2;
/** 工具/服务单次抓取执行预算（管道 timeoutMs 执法面——DNS+5 跳+抓取总量） */
export const WEB_FETCH_TIMEOUT_MS = 60_000;

/** ctx.fetch 调用选项（骨架篇 §9.3 WebFetchOptions） */
export interface WebFetchOptions {
  /** 应用名归因标注（服务被调时调用方身份结构性不可知——显式声明是唯一诚实形态，进 durable details） */
  readonly caller?: string;
  /** 取消信号（排队中 abort = 立即出队取消，不消耗信号量） */
  readonly signal?: AbortSignal;
}

/** 抓取结果（骨架篇 §9.3 WebFetchResult——九字段全集） */
export interface WebFetchResult {
  /** 原始请求 URL（调用方所给） */
  readonly url: string;
  /** 最终 URL（重定向走完后的落点；未重定向与 url 相同） */
  readonly finalUrl: string;
  /** 最终响应状态码（非 2xx 也是数据面——服务侧正常返回，工具侧标 isError） */
  readonly status: number;
  /** 最终响应 content-type（原样小写化，参数保留——判定剥标签/原文的依据） */
  readonly contentType: string;
  /** 处理后文本（HTML 已剥标签/实体解码/空白压缩；超预算已保头截断） */
  readonly text: string;
  /** 网络读到 的原始字节数（截断前计数） */
  readonly bytes: number;
  /** 截断标注（网络读断流或产出文本截断任一发生即 true） */
  readonly truncated: boolean;
  /** 实际跟随的重定向跳数（0 = 直达） */
  readonly redirects: number;
  /** 总耗时毫秒（含 DNS/排队/重定向全程） */
  readonly durationMs: number;
}

/**
 * ctx.get('fetch') 服务面（契约篇 §1.5 服务表 web 行）。
 * 与 fetch 工具同一 execute 同一卫生件——经 ToolsService.executor 走同一条
 * 三段管道（守门/落账不旁路，ctx.exec 先例同构）；异常面 throw AppError
 * （WEB_* 码族——宿主侧代码异常面比模型面结构化拒绝更有用）。
 */
export interface WebService {
  fetch(url: string, opts?: WebFetchOptions): Promise<WebFetchResult>;
}

/**
 * 件行 config schema（契约篇 §1.5.2 ①）：
 * `fetch: false` = 「有但省」变体二——模型面关（fetch 工具不注册）、服务面在。
 */
export const WEB_PLUGIN_CONFIG_SCHEMA = Type.Object({
  fetch: Type.Optional(Type.Boolean({ description: 'false = 不注册模型面 fetch 工具（ctx.fetch 服务不受影响）' })),
});
