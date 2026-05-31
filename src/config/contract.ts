/**
 * ConfigService 契约
 *
 * 统一配置管理的公共接口。其他模块只能依赖此文件。
 */

import type { AppConfig } from './schema.js';

/** 配置变更事件 */
export interface ConfigChangeEvent {
  /** 变更的 top-level keys */
  changedKeys: string[];
  /** 变更后的完整配置 */
  config: AppConfig;
}

/** 全局配置变更监听器 */
export type ConfigChangeListener = (event: ConfigChangeEvent) => void;

/** Section 级变更监听器：只在指定 key 变更时触发 */
export type SectionChangeListener<K extends keyof AppConfig> = (newValue: AppConfig[K], config: AppConfig) => void;

/** 校验诊断信息 */
export interface ValidationDiagnostics {
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
}

/** 配置服务接口 */
export interface IConfigService {
  /** 获取当前完整配置 */
  get(): AppConfig;

  /** 获取指定 section */
  getSection<K extends keyof AppConfig>(key: K): AppConfig[K];

  /**
   * 更新配置（合并写入 config.yaml，触发热重载）
   * @returns 成功返回 { ok: true }，失败返回 { ok: false, error }
   */
  updateSection(partial: Partial<AppConfig>): { ok: boolean; error?: string };

  /** 手动触发重载（从文件重新读取） */
  reload(): void;

  /** 释放资源（关闭文件监听等） */
  dispose(): void;

  /** 注册全局配置变更监听器，返回取消函数 */
  onChange(listener: ConfigChangeListener): () => void;

  /** 注册 section 级变更监听器，只在指定 key 变更时触发 */
  onSectionChange<K extends keyof AppConfig>(key: K, listener: SectionChangeListener<K>): () => void;

  /** 获取配置文件路径 */
  getConfigPath(): string;

  /** 获取应用数据目录 */
  getAppHome(): string;

  /** 获取当前配置的校验诊断 */
  diagnostics(): ValidationDiagnostics;
}
