import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pluginManifestSchema } from './manifest.js';
import type { PluginValidationResult } from './types.js';
import { asRecord } from './utils.js';

export function validatePluginDir(pluginDir: string): PluginValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const manifestPath = join(pluginDir, 'plugin.json');
  const entryPath = join(pluginDir, 'entry.ts');
  const fixturePath = join(pluginDir, 'tests', 'basic.fixture.json');

  if (!existsSync(manifestPath)) errors.push('缺少 plugin.json');
  if (!existsSync(entryPath)) errors.push('缺少 entry.ts');
  if (!existsSync(fixturePath)) warnings.push('缺少基础 fixture，建议补充 tests/basic.fixture.json');
  if (errors.length > 0) return { ok: false, errors, warnings, tools: [] };

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return { ok: false, errors: ['plugin.json 不是合法 JSON'], warnings, tools: [] };
  }

  const parsed = pluginManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`plugin.json ${issue.path.join('.') || '根节点'}: ${issue.message}`);
    }
  }

  const tools = Array.isArray(manifest.tools)
    ? manifest.tools.filter((tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null)
    : [];
  if (tools.length === 0) errors.push('plugin.json 至少声明一个工具');

  const normalizedTools = tools.map((tool, index) => {
    if (typeof tool.name !== 'string' || !tool.name) errors.push(`tools[${index}] 缺少 name`);
    if (typeof tool.description !== 'string' || !tool.description) errors.push(`tools[${index}] 缺少 description`);
    if (typeof tool.permissionScope !== 'string' || !tool.permissionScope) errors.push(`tools[${index}] 缺少 permissionScope`);
    return {
      name: String(tool.name ?? ''),
      title: String(tool.title ?? tool.name ?? ''),
      description: String(tool.description ?? ''),
      inputSchema: asRecord(tool.inputSchema),
      outputSchema: asRecord(tool.outputSchema),
      permissionScope: String(tool.permissionScope ?? 'plugin.generated'),
    };
  });

  const entry = readFileSync(entryPath, 'utf-8');
  if (!entry.includes('definePlugin')) warnings.push('entry.ts 未显式使用 definePlugin，后续运行时可能无法加载');
  if (entry.includes('process.env')) errors.push('插件不得直接读取真实环境变量');
  if (entry.includes('../kernel') || entry.includes('src/kernel')) errors.push('插件不得 import 核心系统 内部实现');
  if (entry.includes('@anthropic-ai/sdk') || entry.includes('openai') || entry.includes('ai-sdk')) {
    errors.push('插件不得直接调用模型 SDK');
  }

  return { ok: errors.length === 0, errors, warnings, tools: normalizedTools };
}

