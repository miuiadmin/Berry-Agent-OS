/**
 * CardListSkeleton 通用「卡片列表」骨架屏。
 *
 * 多个页面的列表加载态是同构的：N 张 Card，每张里若干 animate-pulse 条
 * （Scheduler 的 Jobs/Webhooks、Memory、Notifications 四处几乎一字不差）。
 * 抽出后调用方只传 count + bars，不再各写一遍 Array.from + Card + 条。
 *
 * 约定布局：外层 space-y-2、CardContent py-3、条间 space-y-2，
 * 与各页面原有骨架一致；bars 为单条时 space-y-2 包裹层无副作用。
 * 每条 bar 复用标准 Skeleton 原语（统一 animate-pulse/bg-muted/圆角）。
 *
 * 用法：
 *   <CardListSkeleton count={5} bars={["h-4 w-1/3", "h-3 w-2/3"]} />
 */

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface CardListSkeletonProps {
  /** 骨架卡片数量 */
  count: number;
  /** 每张卡片内的骨架条尺寸（className，如 "h-4 w-1/3"）；脉冲/背景/圆角由 Skeleton 统一提供 */
  bars: string[];
}

export function CardListSkeleton({ count, bars }: CardListSkeletonProps) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i}>
          <CardContent className="py-3">
            <div className="space-y-2">
              {bars.map((bar, j) => (
                <Skeleton key={j} className={bar} />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
