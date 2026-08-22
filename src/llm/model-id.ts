/**
 * L1 llm — 模型标识解析（骨架篇 §2.2：model 为字符串 id，解析归 llm 模块）。
 *
 * 约定形式：`"provider/model-id"`，**首斜杠分割**——provider 不得含斜杠，
 * model-id 允许再含斜杠（openrouter 路径式 id 如 `openrouter/qwen/qwen3-coder`
 * → provider=openrouter、id=qwen/qwen3-coder）。agent loop 全程只传字符串，
 * Model 对象在 LLM 调用边界才解析。
 */

import { LLM_MODEL_NOT_FOUND, LLM_MODEL_SPEC_INVALID, AppError } from '../contracts/errors.js';
import type { Model, Models } from '@earendil-works/pi-ai';

/** 解析产物：provider 名 + 该 provider 目录内的模型 id */
export interface ModelSpec {
  provider: string;
  id: string;
}

/**
 * 解析模型标识字符串（纯语法层，不查目录）。
 * @param spec 形如 "provider/model-id"；provider 段与 id 段均须非空
 * @throws AppError(LLM_MODEL_SPEC_INVALID) 格式非法时
 */
export function parseModelSpec(spec: string): ModelSpec {
  const slashIndex = spec.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= spec.length - 1) {
    throw new AppError(
      LLM_MODEL_SPEC_INVALID,
      `模型标识格式非法："${spec}"——必须是 "provider/model-id" 形式（如 anthropic/claude-sonnet-4-5）`,
    );
  }
  return { provider: spec.slice(0, slashIndex), id: spec.slice(slashIndex + 1) };
}

/**
 * 组回标准形式（与 parseModelSpec 互逆；目录清单展示用）。
 */
export function formatModelId(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/**
 * 在 Models 目录中解析模型标识为具体 Model 对象（fail-loud 路径，供 UI/装配层用）。
 * @throws AppError(LLM_MODEL_NOT_FOUND) provider 未注册或模型不在目录时
 */
export function resolveModel(models: Models, spec: string): Model<string> {
  const { provider, id } = parseModelSpec(spec);
  if (!models.getProvider(provider)) {
    throw new AppError(LLM_MODEL_NOT_FOUND, `provider 未注册：${provider}（标识 "${spec}"）`);
  }
  const model = models.getModel(provider, id);
  if (!model) {
    throw new AppError(LLM_MODEL_NOT_FOUND, `模型不存在：${spec}——该 provider 目录中的模型 id 无此条目`);
  }
  return model;
}
