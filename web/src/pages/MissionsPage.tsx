/**
 * Mission 管理页面（多智能体协作）。
 *
 * 左侧列表 + 右侧详情布局。点击 mission 展示 plan.json 任务状态 + squad 组织。
 * 每 10 秒自动刷新（mission 状态可能实时变化）。
 *
 * 与其他列表页（Memory / Notifications / Tasks）一致地使用 QueryBoundary
 * 统一处理 loading / error / empty 三态，避免每个页面各写一份 if-else 分支。
 *
 * 子组件 + 类型 → missions-components.tsx：
 *   - {@link MissionListItem} / {@link MissionDetail} 等
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useT } from "@/lib/i18n";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { CardListSkeleton } from "@/components/ui/card-list-skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Target } from "lucide-react";
import {
  type MissionsListResponse,
  MissionListItem,
  MissionDetail,
} from "./missions-components";

/** 列表 + 详情双栏的响应式网格 className（加载态和正常态共用，保证骨架屏与真实布局对齐） */
const LIST_DETAIL_GRID = "grid gap-4 md:grid-cols-[320px_1fr]";

export default function MissionsPage() {
  const t = useT();
  useDocumentTitle(t("sidebar.missions"));

  /** 当前选中的 mission ID（null = 未选中，右侧显示占位） */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── 数据查询：每 10 秒刷新一次（mission 状态可能实时变化） ──
  const missionsQuery = useQuery({
    queryKey: ["missions"],
    queryFn: (ctx) => apiGet<MissionsListResponse>("/api/missions", ctx.signal),
    refetchInterval: 10_000,
  });

  const missions = missionsQuery.data?.items ?? [];
  const selectedStillExists =
    selectedId == null || missions.some((m) => m.id === selectedId);
  /**
   * 选中态校验：选中的 mission 若从列表消失（完成/被删/后端过滤变化），
   * 用 useEffect 清空 selectedId（而非渲染期内 setTimeout 推出周期——后者是
   * 已知 React 反模式，会逃出批处理、多一帧 stale 渲染）。
   * 渲染期用 effectiveSelectedId 派生值兜底，effect 执行前也不会渲染错误详情。
   */
  useEffect(() => {
    if (!selectedStillExists && selectedId != null) {
      setSelectedId(null);
    }
  }, [selectedStillExists, selectedId]);
  const effectiveSelectedId = selectedStillExists ? selectedId : null;

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      {/* 页面标题（count 文案随数据同步变化；列表为空时隐藏 count，避免与
          下方 EmptyState 的"无活跃 mission"文案重复——EmptyState 已承担空态说明） */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("missions.title")}</h1>
        {missions.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t("missions.count", { count: String(missions.length) })}
          </p>
        )}
      </div>

      {/* 三态统一交给 QueryBoundary：loading → 骨架屏；error → 重试；ok → 列表/空态 */}
      <QueryBoundary
        query={missionsQuery}
        skeleton={<MissionsSkeleton />}
      >
        {(data) => {
          // 注：selectedStillExists / effectiveSelectedId 已在组件体里基于最新 data 计算
          // （此处 data === missionsQuery.data，闭包一致），render-prop 内只负责布局。
          if (data.items.length === 0) {
            return (
              <EmptyState
                icon={Target}
                title={t("missions.noActiveMissions")}
                description={t("missions.noActive")}
              />
            );
          }
          return (
            <div className={LIST_DETAIL_GRID}>
              {/* 左侧：mission 列表 */}
              <div className="space-y-2 overflow-y-auto">
                {data.items.map((m) => (
                  <MissionListItem
                    key={m.id}
                    mission={m}
                    isSelected={selectedId === m.id}
                    onClick={() => setSelectedId(m.id)}
                  />
                ))}
              </div>

              {/* 右侧：选中 mission 的详情（未选中时显示占位） */}
              <Card className="overflow-y-auto">
                <CardContent className="p-4">
                  {effectiveSelectedId ? (
                    <MissionDetail missionId={effectiveSelectedId} />
                  ) : (
                    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                      {t("missions.selectToView")}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

/**
 * 加载骨架屏：复用 LIST_DETAIL_GRID 布局，保证骨架与真实内容对齐不跳动。
 * 左侧 3 行卡片列表用 CardListSkeleton；右侧详情用独立 Skeleton。
 */
function MissionsSkeleton() {
  return (
    <div className={LIST_DETAIL_GRID}>
      <CardListSkeleton count={3} bars={["h-4 w-2/3", "h-3 w-1/2"]} />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
