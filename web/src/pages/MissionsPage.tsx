/**
 * Mission 管理页面（13.0 多智能体协作）。
 *
 * 左侧列表 + 右侧详情布局。点击 mission 展示 plan.json 任务状态 + squad 组织。
 * 每 10 秒自动刷新（mission 状态可能实时变化）。
 *
 * 子组件 + 类型在 missions-components.tsx：
 *   - {@link MissionListItem} / {@link MissionDetail} / {@link StatusBadge} /
 *     {@link SquadTab} 等
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Target } from "lucide-react";
import {
  type MissionsListResponse,
  MissionListItem,
  MissionDetail,
} from "./missions-components";

export default function MissionsPage() {
  /** 当前选中的 mission ID（null = 未选中，右侧显示占位） */
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["missions"],
    queryFn: (ctx) => apiGet<MissionsListResponse>("/api/missions", ctx.signal),
    refetchInterval: 10_000, // 每 10 秒刷新一次（mission 状态可能实时变化）
  });

  const missions = data?.items ?? [];

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      {/* 标题 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Missions</h1>
        <p className="text-sm text-muted-foreground">
          {missions.length > 0
            ? `${missions.length} missions`
            : "No active missions"}
        </p>
      </div>

      {isLoading ? (
        // 加载骨架屏
        <div className="grid gap-4 md:grid-cols-[320px_1fr]">
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      ) : missions.length === 0 ? (
        // 空状态
        <EmptyState
          icon={Target}
          title="No Missions Yet"
          description="Missions are created automatically when Brain detects complex multi-agent tasks. Try asking for something that requires multiple agents to collaborate."
        />
      ) : (
        // 列表 + 详情双栏布局
        <div className="grid gap-4 md:grid-cols-[320px_1fr]">
          {/* 左侧：mission 列表 */}
          <div className="space-y-2 overflow-y-auto">
            {missions.map((m) => (
              <MissionListItem
                key={m.id}
                mission={m}
                isSelected={selectedId === m.id}
                onClick={() => setSelectedId(m.id)}
              />
            ))}
          </div>

          {/* 右侧：选中 mission 的详情 */}
          <Card className="overflow-y-auto">
            <CardContent className="p-4">
              {selectedId ? (
                <MissionDetail missionId={selectedId} />
              ) : (
                <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                  Select a mission to view details
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
