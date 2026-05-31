/**
 * 配置中心公共出口
 *
 * 其他模块通过此文件访问配置服务。
 */

export type { IConfigService, ConfigChangeEvent, ConfigChangeListener } from './contract.js';
export type { AppConfig } from './types.js';
