/**
 * 配置校验诊断报告
 *
 * 替代静默回退到默认值的行为，提供结构化的校验问题报告。
 */

import type { ZodError } from 'zod';
import { AppConfigSchema } from './schema.js';
import { readYamlFile, applyEnvOverrides } from './resolver.js';

export interface DiagnosticIssue {
  /** 字段路径（点分格式） */
  path: string;
  /** 问题描述 */
  message: string;
  /** 严重级别 */
  severity: 'error' | 'warning';
}

export interface DiagnosticReport {
  /** 配置是否有效 */
  valid: boolean;
  /** 所有问题列表 */
  issues: DiagnosticIssue[];
}

/**
 * 校验配置并返回结构化报告
 *
 * 不抛出异常，用于启动时和热重载时的诊断输出。
 */
export function diagnoseConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): DiagnosticReport {
  const fileData = readYamlFile(configPath);
  const withEnv = applyEnvOverrides(fileData, env);
  const result = AppConfigSchema.safeParse(withEnv);

  if (result.success) {
    return { valid: true, issues: [] };
  }

  const issues = formatZodIssues(result.error);
  return { valid: false, issues };
}

/**
 * 将 Zod 校验错误格式化为诊断问题列表
 */
export function formatZodIssues(error: ZodError): DiagnosticIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    severity: 'error' as const,
  }));
}

/**
 * 将诊断问题格式化为单行错误字符串（用于 API 响应）
 */
export function formatDiagnostics(report: DiagnosticReport): string {
  if (report.valid) return '';
  return report.issues.map(i => `${i.path}: ${i.message}`).join('; ');
}
