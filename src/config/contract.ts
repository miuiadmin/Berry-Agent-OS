/**
 * ConfigService 契约
 *
 * 统一配置管理的公共接口。其他模块只能依赖此文件。
 */

import type { AppConfig } from './types.js';

/** 配置变更事件 */
export interface ConfigChangeEvent {
  /** 变更的 top-level keys */
  changedKeys: string[];
  /** 变更后的完整配置 */
  config: AppConfig;
}

/** 配置变更监听器 */
export type ConfigChangeListener = (event: ConfigChangeEvent) => void;

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

  /** 注册配置变更监听器，返回取消函数 */
  onChange(listener: ConfigChangeListener): () => void;

  /** 获取配置文件路径 */
  getConfigPath(): string;

  /** 获取应用数据目录 */
  getAppHome(): string;
}
