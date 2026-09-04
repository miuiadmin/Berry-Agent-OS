/**
 * 虚拟模块 `berryagent/llm` 的类型面（第五虚拟键——pi-ai provider 工厂族）。
 *
 * 运行时注入物 = llm 模块 providerApiFace 对象（键即导出面）；类型面以 indexed
 * access 从同一对象派生——单源不重抄签名。宿主类型锚 = dist/llm/provider-face.d.ts
 * （tsconfig.api.json 发射；其 pi-ai 类型引用经宿主依赖链解析）。
 *
 * 本文件由 tools/generate-api-decls.mjs 生成（declare 行从面快照 Face 键集派生）——勿手编。
 */
import type { providerApiFace } from '../llm/provider-face.js';

type Face = typeof providerApiFace;

export declare const anthropicMessagesApi: Face['anthropicMessagesApi'];
export declare const createProvider: Face['createProvider'];
export declare const hasApi: Face['hasApi'];
export declare const lazyApi: Face['lazyApi'];
