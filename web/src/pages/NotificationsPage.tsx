/**
 * 通知管理页面。
 *
 * 支持三栏过滤（未读 / 全部 / 已归档）+ 标记已读 + 全部已读 + 归档操作。
 * Mutations → use-notification-mutations.ts
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, Check, Archive } from "lucide-react";
import { notificationsApi } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Card, CardContent } from "@/components/ui/card";
import { CardListSkeleton } from "@/components/ui/card-list-skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";
import { useNotificationMutations } from "./use-notification-mutations";

type Filter = "unread" | "all" | "archived";

export default function NotificationsPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("notifications.title"));

  const [filter, setFilter] = useState<Filter>("unread");

  // 未读数查询（30 秒轮询）
  const countQuery = useQuery({
    queryKey: ["notification-count"],
    queryFn: () => notificationsApi.count(),
    refetchInterval: 30_000,
  });

  // 通知列表查询（按 filter 参数过滤：unread=未归档且未读优先展示，archived=已归档，all=全部）。
  // unread 态下与 countQuery 一致地 30 秒轮询——避免用户停在页面时新通知不出现（需手动切 tab）。
  // all / archived 态轮询意义不大（被动浏览），保持默认不轮询。
  const archivedParam = filter === "archived" ? true : filter === "unread" ? false : undefined;
  const listQuery = useQuery({
    queryKey: ["notifications", filter],
    queryFn: () => notificationsApi.list({ archived: archivedParam, limit: 100 }),
    refetchInterval: filter === "unread" ? 30_000 : false,
  });

  const { readMut, readAllMut, archiveMut } = useNotificationMutations();

  // 未读数：countQuery 提供；通知列表本身由 QueryBoundary 渲染 prop 提供（listQuery.data）。
  const unread = countQuery.data?.unread ?? 0;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        title={t("notifications.title")}
        subtitle={t("notifications.subtitle")}
        icon={Bell}
        iconClass="text-brand"
        titleExtra={unread > 0 ? <Badge variant="destructive" className="text-[11px]">{unread}</Badge> : undefined}
      >
        {unread > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => readAllMut.mutate()}
            disabled={readAllMut.isPending}
            className="h-11 md:h-9"
          >
            <Check className="mr-1 size-4" />
            {t("notifications.markAllRead")}
          </Button>
        )}
      </PageHeader>

      {/* 过滤 tabs */}
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          <TabsTrigger value="unread">
            {t("notifications.unread")}{unread > 0 ? ` (${unread})` : ""}
          </TabsTrigger>
          <TabsTrigger value="all">{t("common.all")}</TabsTrigger>
          <TabsTrigger value="archived">{t("notifications.archived")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* 通知列表 */}
      <QueryBoundary query={listQuery} skeleton={<CardListSkeleton count={3} bars={["h-4 w-1/3"]} />}>
        {(notifications) => notifications.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={t("notifications.noNotifications")}
            description={
              filter === "unread"
                ? t("notifications.allCaughtUp")
                : filter === "archived"
                  ? t("notifications.noArchived")
                  : t("notifications.noNotificationsDesc")
            }
          />
        ) : (
          <div className="space-y-2">
            {notifications.map((item) => (
              <Card
                key={item.id}
                className={cn(
                  "group transition-colors",
                  !item.read && "bg-accent/50 border-accent",
                )}
              >
                <CardContent className="flex items-start gap-3 py-3">
                  {/* 已读/未读指示点 */}
                  <div className="mt-0.5 shrink-0">
                    {!item.read ? (
                      <div className="size-2 rounded-full bg-brand" />
                    ) : (
                      <div className="size-2 rounded-full bg-muted-foreground/30" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("text-sm", !item.read && "font-medium")}>
                        {item.title}
                      </span>
                      <Badge variant="outline" className="shrink-0 text-[11px]">
                        {/* t() 对未知 key 回退到 key 本身（见 i18n.tsx），无需 ?? item.type 兜底 */}
                        {t(`notifications.type.${item.type}`)}
                      </Badge>
                    </div>
                    {item.body && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {item.body}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground/70">
                      {fmtDT(new Date(item.createdAt))}
                    </p>
                  </div>
                  {/* 操作按钮：移动端常驻，桌面端 hover 显示 */}
                  <div className="flex shrink-0 gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    {!item.read && (
                      <IconButton
                        title={t("notifications.markRead")}
                        onClick={() => readMut.mutate(item.id)}
                      >
                        <Check className="size-3.5" />
                      </IconButton>
                    )}
                    {!item.archived && (
                      <IconButton
                        title={t("notifications.archive")}
                        onClick={() => archiveMut.mutate(item.id)}
                      >
                        <Archive className="size-3.5" />
                      </IconButton>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
