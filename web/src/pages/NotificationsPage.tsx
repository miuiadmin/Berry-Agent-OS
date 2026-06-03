import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, Archive } from "lucide-react";
import { toast } from "sonner";
import { notificationsApi, type NotificationItem } from "@/lib/api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";

type Filter = "unread" | "all" | "archived";

export default function NotificationsPage() {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  useDocumentTitle(t("notifications.title"));
  const qc = useQueryClient();

  const [filter, setFilter] = useState<Filter>("unread");

  // Unread count
  const countQuery = useQuery({
    queryKey: ["notification-count"],
    queryFn: () => notificationsApi.count(),
    refetchInterval: 30_000,
  });

  // List notifications
  const listQuery = useQuery({
    queryKey: ["notifications", filter],
    queryFn: () =>
      notificationsApi.list({
        archived: filter === "archived" ? true : filter === "unread" ? false : undefined,
        limit: 100,
      }),
  });

  // Mark read
  const readMut = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notification-count"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Mark all read
  const readAllMut = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => {
      toast.success(t("notifications.allMarkedRead"));
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notification-count"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Archive
  const archiveMut = useMutation({
    mutationFn: (id: string) => notificationsApi.archive(id),
    onSuccess: () => {
      toast.success(t("notifications.notificationArchived"));
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notification-count"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const items: NotificationItem[] = listQuery.data ?? [];
  const unread = countQuery.data?.unread ?? 0;

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Bell className="size-5 text-brand" />
            {t("notifications.title")}
            {unread > 0 && (
              <Badge variant="destructive" className="text-[11px]">
                {unread}
              </Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("notifications.subtitle")}
          </p>
        </div>
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
      </div>

      {/* Filter tabs */}
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          <TabsTrigger value="unread">
            {t("notifications.unread")}{unread > 0 ? ` (${unread})` : ""}
          </TabsTrigger>
          <TabsTrigger value="all">{t("common.all")}</TabsTrigger>
          <TabsTrigger value="archived">{t("notifications.archived")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Notification list */}
      <QueryBoundary
        query={listQuery}
        skeleton={<div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Card key={i}><CardContent className="py-3"><div className="h-4 w-1/3 animate-pulse rounded bg-muted" /></CardContent></Card>)}</div>}
      >
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
                        {item.type}
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
                  <div className="flex shrink-0 gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                    {!item.read && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 md:size-8"
                        title={t("notifications.markRead")}
                        aria-label={t("notifications.markRead")}
                        onClick={() => readMut.mutate(item.id)}
                      >
                        <Check className="size-3.5" />
                      </Button>
                    )}
                    {!item.archived && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 md:size-8"
                        title={t("notifications.archive")}
                        aria-label={t("notifications.archive")}
                        onClick={() => archiveMut.mutate(item.id)}
                      >
                        <Archive className="size-3.5" />
                      </Button>
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
