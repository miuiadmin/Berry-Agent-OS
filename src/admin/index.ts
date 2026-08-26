/**
 * L4 admin — 官方件 `builtin:admin` 公开面（契约篇 §3.4 平台管理面第一刀，
 * 2026-08-27）：只读面两工具（plugins_list / events_query）+ 管理 Skill 随件
 * 携带。写类动词（install/uninstall/configure/reload）随第二刀导线。
 */

export { createAdminPlugin, createEventsQueryTool, createPluginsListTool } from './plugin.js';
export type { PluginsListFace, PluginRowView, SessionsQueryFace } from './plugin.js';
