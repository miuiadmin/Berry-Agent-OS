/**
 * 13.0 多智能体协作 — Mission API 路由。
 *
 * 提供 REST API 给前端查询 mission 状态：
 *   GET  /api/missions          — 列出所有 mission
 *   GET  /api/missions/:id      — 获取单个 mission 详情（含 plan.json）
 *   GET  /api/missions/:id/squad — 获取 squad 组织结构
 *   POST /api/missions/:id/signal — 手动发送信号
 */

import type { MissionManager } from '../kernel/mission-manager.js';

/** 路由注册函数类型（与 api-routes.ts 的 route 函数签名一致） */
type RouteFn = (method: string, path: string, handler: (req: any, res: any, url?: URL, params?: Record<string, string>) => void) => void;
type ReadBodyFn = (req: any) => Promise<Record<string, unknown> | unknown>;
type JsonFn = (res: any, data: unknown, status?: number) => void;

/**
 * 注册 mission 相关 API 路由。
 *
 * @param route - 路由注册函数
 * @param getManager - 获取 MissionManager 实例的函数（延迟求值，因为 init 后才可用）
 * @param readBody - 读取请求体的辅助函数
 * @param json - 写 JSON 响应的辅助函数
 */
export function registerMissionRoutes(
  route: RouteFn,
  getManager: () => MissionManager | null,
  readBody: ReadBodyFn,
  json: JsonFn,
): void {

  /** 安全获取 MissionManager（未初始化时返回 503） */
  function requireManager(res: any): MissionManager | null {
    const mgr = getManager();
    if (!mgr) {
      json(res, { error: 'Mission system not initialized' }, 503);
      return null;
    }
    return mgr;
  }

  // ─── GET /api/missions — 列出所有 mission ───

  route('GET', '/missions', (_req, res, url) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missions = mgr.listMissions();
    // 支持按状态过滤
    const statusFilter = url?.searchParams.get('status');
    const filtered = statusFilter
      ? missions.filter(m => m.status === statusFilter)
      : missions;

    json(res, { items: filtered, total: filtered.length });
  });

  // ─── GET /api/missions/:id — 获取 mission 详情（plan.json） ───

  route('GET', '/missions/:id', (_req, res, _url, params) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missionId = params?.id;
    if (!missionId) {
      json(res, { error: 'Missing mission ID' }, 400);
      return;
    }

    const plan = mgr.readPlan(missionId);
    if (!plan) {
      json(res, { error: `Mission ${missionId} not found` }, 404);
      return;
    }

    json(res, plan);
  });

  // ─── GET /api/missions/:id/summary — 获取 mission 摘要（用于 system prompt 注入） ───

  route('GET', '/missions/:id/summary', (_req, res, _url, params) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missionId = params?.id;
    if (!missionId) {
      json(res, { error: 'Missing mission ID' }, 400);
      return;
    }

    const summary = mgr.readSummary(missionId);
    if (!summary) {
      json(res, { error: `Mission ${missionId} not found` }, 404);
      return;
    }

    json(res, { missionId, summary });
  });

  // ─── GET /api/missions/:id/squad — 获取 squad 组织结构 ───

  route('GET', '/missions/:id/squad', (_req, res, _url, params) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const missionId = params?.id;
    if (!missionId) {
      json(res, { error: 'Missing mission ID' }, 400);
      return;
    }

    const squad = mgr.readSquad(missionId);
    if (!squad) {
      json(res, { error: `Squad for mission ${missionId} not found` }, 404);
      return;
    }

    json(res, squad);
  });

  // ─── GET /api/missions/templates — 列出可用模板 ───

  route('GET', '/missions/templates', (_req, res) => {
    const mgr = requireManager(res);
    if (!mgr) return;

    const templates = mgr.loadTemplates();
    json(res, { items: templates.map(t => ({ name: t.name, taskCount: t.plan.tasks.length })) });
  });
}
