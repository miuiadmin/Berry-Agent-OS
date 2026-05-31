/**
 * 配置校验诊断报告
 *
 * 替代静默回退到默认值的行为——在启动和重载时提供结构化的校验反馈。
 */

import { AppConfigSchema } from './schema.js';
import { readYamlFile, applyEnvOverrides } from './resolver.js';

export interface DiagnosticIssue {
  /** 字段路径（如 "web.port"） */
  path: string;
  /** 错误描述 */
  message: string;
}

export interface DiagnosticReport {
  /** 是否通过校验 */
  valid: boolean;
  /** 发现的问题列表 */
  issues: DiagnosticIssue[];
}

/**
 * 校验配置并返回结构化报告
 *
 * 不抛异常，不回退——纯粹的诊断工具。
 * 调用方可选择记录警告或中断启动。
 */
export function diagnoseConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticReport {
  const fileData = readYamlFile(configPath);
  const merged = applyEnvOverrides(fileData, env);
  const result = AppConfigSchema.safeParse(merged);

  if (result.success) {
    return { valid: true, issues: [] };
  }

  const issues: DiagnosticIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  return { valid: false, issues };
}
