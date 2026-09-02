/**
 * L1 llm — Models 宿主包装（骨架篇 §5.1 L6：llm 模块 = Models 接口的宿主包装 +
 * StreamFn 适配，对应 pi model-runtime.ts 形态）。
 *
 * 职责边界：
 * - 包装 pi-ai `createModels`（凭证/模型目录经注入——L4：CredentialStore/ModelsStore
 *   的 SQLite 实现归 persist 模块，app 组合根适配后注入；llm 不 import persist）；
 * - 内置 provider 全家桶默认注册（Anthropic-first 体现在默认模型约定与文档，不在
 *   provider 注册面做裁剪——未配置凭证的 provider 天然不可用）；
 * - `registerProvider` 即应用钩 `ctx.llm.registerProvider` 的实现底座（地基篇应用清单）。
 */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type {
  AuthOperationOptions,
  CredentialStore,
  Model,
  ModelsRefreshOptions,
  ModelsRefreshResult,
  ModelsStore,
  MutableModels,
  Provider,
} from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai';
import { resolveModel } from './model-id.js';

/** 运行时构造选项（全部可注入——测试用 faux provider，产品用 persist 适配的 store） */
export interface LlmRuntimeOptions {
  /** 凭证存储（pi-ai CredentialStore 接口；app 由 persist 的凭证表适配注入） */
  credentials?: CredentialStore;
  /** 模型目录存储（pi-ai ModelsStore 接口；app 由 persist 的模型目录表适配注入） */
  modelsStore?: ModelsStore;
  /**
   * 初始 provider 集合。缺省 = pi-ai 内置全家桶（anthropic/openai/google/…静态目录）。
   * 测试传 faux provider；应用后期经 registerProvider 增补。
   */
  providers?: readonly Provider[];
}

/** Models 宿主（组合根持有单例；StreamFn 适配层经此取 Model） */
export interface LlmRuntime {
  /** 底层 pi-ai Models 集合（高级用法直通；常规路径走下方包装方法） */
  readonly models: MutableModels;
  /** 模型标识 → Model（fail-loud：LLM_MODEL_SPEC_INVALID / LLM_MODEL_NOT_FOUND） */
  resolveModel(spec: string): Model<string>;
  /** 列目录（供 UI/补全；可选按 provider 过滤） */
  listModels(provider?: string): readonly Model<string>[];
  /** 刷新动态 provider 目录（网络操作，app 启动期/手动触发） */
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
  /** 查某 provider 凭证是否配置完整（不触发 OAuth 刷新） */
  checkAuth(providerId: string, options?: AuthOperationOptions): Promise<unknown>;
  /**
   * 注册/替换一个 provider（按 id upsert）。
   * @returns 注销函数——调用即从集合移除该 provider（应用卸载路径）
   */
  registerProvider(provider: Provider): () => void;
  /** 按 id 移除 provider（ctx.llm.unregisterProvider 的底座；缺省 upsert 的对面） */
  unregisterProvider(id: string): void;
}

/**
 * 创建 llm 运行时（宿主包装本体）。
 * 不做网络访问：createModels 只装配；目录刷新是显式 refresh 调用。
 */
export function createLlmRuntime(options: LlmRuntimeOptions = {}): LlmRuntime {
  const models: MutableModels = createModels({
    credentials: options.credentials,
    modelsStore: options.modelsStore,
  });
  for (const provider of options.providers ?? builtinProviders()) {
    // 按 id upsert——测试/装配显式传入的集合整体生效，不与内置目录叠加
    models.setProvider(provider);
  }
  return {
    models,
    resolveModel: (spec) => resolveModel(models, spec),
    listModels: (provider) => models.getModels(provider),
    refresh: (refreshOptions) => models.refresh(refreshOptions),
    checkAuth: (providerId, checkOptions) => models.checkAuth(providerId, checkOptions),
    registerProvider(provider) {
      models.setProvider(provider);
      return () => {
        // 简单移除语义：不比对是否仍是本 provider（卸载期竞态由应用系统自身串行化）
        models.deleteProvider(provider.id);
      };
    },
    unregisterProvider: (id) => models.deleteProvider(id),
  };
}
