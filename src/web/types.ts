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
/**
 * 装机下载独立字节预算 512 MiB（契约篇 §6.10 downloadToFile——与抓取 2 MiB 内存
 * 预算分账：CfT chrome zip 150-250MB 量级留裕量；超即断流删档抛错不截断交付）
 */
export const WEB_DOWNLOAD_BUDGET_BYTES = 512 * 1024 * 1024;
/** 装机下载执行帽 600s（150MB 慢网 60s 必不够——抓取帽与下载帽数值面分离） */
export const WEB_DOWNLOAD_TIMEOUT_MS = 600_000;

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
  /**
   * 受控 fetch 原语：与 fetch 工具同一 execute 同一卫生件（SSRF 五卫生件同面
   * ——守门/落账不旁路；异常面 throw AppError，WEB_* 码族）。
   */
  fetch(url: string, opts?: WebFetchOptions): Promise<WebFetchResult>;
  /**
   * 装机下载原语（契约篇 §6.10——流式落盘不整读内存，独立预算/白名单；
   * 不走三段管道 durable 落账〔装机命令面非模型面〕，模型工具面不暴露）。
   */
  downloadToFile(url: string, opts: WebDownloadOptions): Promise<WebDownloadResult>;
}

/** downloadToFile 调用选项（契约篇 §6.10——白名单参数钉死非全局） */
export interface WebDownloadOptions {
  /** 落盘目标绝对路径（调用方给——zip 临时档/install 直装均由调用方编排） */
  readonly destPath: string;
  /**
   * 域白名单（hostname 精确匹配——每跳重定向都重过；装机调用方钉官方发行域，
   * 白名单外首跳/重定向跳一律 WEB_DOWNLOAD_FAILED）
   */
  readonly allowedHosts: readonly string[];
  /** 取消信号（排队/传输中 abort = 删档取消） */
  readonly signal?: AbortSignal;
  /** 归因标注（无 durable 管道——走 logger 记账面） */
  readonly caller?: string;
}

/** downloadToFile 产物（六字段——SHA256 记档供人工核，v1 不对照远端 checksum） */
export interface WebDownloadResult {
  /** 原始请求 URL */
  readonly url: string;
  /** 最终 URL（重定向走完后的落点） */
  readonly finalUrl: string;
  /** 落盘路径（与 opts.destPath 同值——回执自述） */
  readonly filePath: string;
  /** 落盘字节数 */
  readonly bytes: number;
  /** 全文 SHA256（流式随下载计算——hex 小写） */
  readonly sha256: string;
  /** 总耗时毫秒（含排队/重定向全程） */
  readonly durationMs: number;
}

/**
 * 件行 config schema（契约篇 §1.5.2 ①）：
 * `fetch: false` = 「有但省」变体二——模型面关（fetch 工具不注册）、服务面在。
 */
export const WEB_APP_CONFIG_SCHEMA = Type.Object({
  fetch: Type.Optional(Type.Boolean({ description: 'false = 不注册模型面 fetch 工具（ctx.fetch 服务不受影响）' })),
});
