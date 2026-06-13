/**
 * ChatWindow 的辅助子组件与 hooks。
 *
 * 把 ChatSkeleton / HistoryError / DelegationDialog / PermissionConfirmDialog /
 * ModelSelector / PermissionModeSelector / useModelConfig 从 chat-window.tsx 拆出，
 * 让 ChatWindow 主文件只保留编排逻辑（发送消息 / 接收流式响应 / 附件拖拽 / 恢复历史）。
 */

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, ShieldAlert, UserCheck, ChevronDown } from "lucide-react";
import { apiGet, apiPut, queries } from "@/lib/api";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";

// ─── Types ────────────────────────────────────────────────────────

/** 模型条目（渠道内的单个模型） */
export interface ChannelModel {
  id: string;
  name: string;
}

/** Provider 渠道（含模型列表） */
export interface ProviderChannel {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  modelCount: number;
  models: ChannelModel[];
}

// ─── Loading / Error ──────────────────────────────────────────────

/** 聊天页面加载骨架屏（4 个占位气泡） */
export function ChatSkeleton() {
  return (
    <div className="flex-1 p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex flex-col items-end">
          <Skeleton className="h-10 w-48 rounded-2xl" />
        </div>
        <div className="flex flex-col items-start">
          <Skeleton className="h-16 w-64 rounded-2xl" />
        </div>
        <div className="flex flex-col items-end">
          <Skeleton className="h-10 w-36 rounded-2xl" />
        </div>
        <div className="flex flex-col items-start">
          <Skeleton className="h-24 w-72 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

/** 历史消息加载失败提示 + 重试按钮 */
export function HistoryError({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-5 text-destructive" />
        </div>
        <h3 className="mt-3 text-sm font-medium">
          {t("chat.failedToLoadHistory")}
        </h3>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="mr-1.5 size-3" />
          {t("common.retry")}
        </Button>
      </div>
    </div>
  );
}

// ─── Delegation Dialog ────────────────────────────────────────────

/**
 * Agent 委派请求对话框。
 *
 * 移动端：底部固定弹窗；桌面端：底部浮层。
 * approve → 允许委派；deny → 拒绝。
 */
export function DelegationDialog({
  request,
  onRespond,
}: {
  request: DelegationRequest;
  onRespond: (
    delegationId: string,
    response: string | null,
    approved: boolean,
  ) => void;
}) {
  const t = useT();
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={request.title}
      className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:absolute md:inset-x-0 md:bottom-20 md:z-20 md:pb-0"
    >
      <div className="space-y-3 rounded-xl border border-border bg-background p-4 shadow-lg">
        <div className="flex items-center gap-2">
          <UserCheck className="size-4 text-warning" />
          <h4 className="text-sm font-medium">{request.title}</h4>
          {request.urgency === "high" && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
              {t("chat.urgent")}
            </span>
          )}
        </div>
        {request.description && (
          <p className="text-xs text-muted-foreground">{request.description}</p>
        )}
        <p className="text-[11px] text-muted-foreground/70">
          {t("chat.requestedBy")}: {request.requestedBy}
        </p>
        <div className="flex items-center justify-end gap-2">
          {request.options.includes("deny") && (
            <Button
              variant="outline"
              size="sm"
              className="h-11 px-4 md:h-7 md:px-2.5"
              onClick={() => onRespond(request.delegationId, null, false)}
            >
              {t("chat.deny")}
            </Button>
          )}
          {request.options.includes("approve") && (
            <Button
              size="sm"
              className="h-11 px-4 md:h-7 md:px-2.5"
              onClick={() =>
                onRespond(request.delegationId, "approved", true)
              }
            >
              {t("chat.approve")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Permission Confirm Dialog ────────────────────────────────────

/**
 * 权限确认对话框（Agent 请求使用高风险工具）。
 *
 * 展示 agent 名称 + 工具名称 + 输入预览 + Brain 审核理由。
 * approve → 授权；deny → 拒绝。
 */
export function PermissionConfirmDialog({
  request,
  onRespond,
}: {
  request: PermissionConfirmRequest;
  onRespond: (requestId: string, approved: boolean) => void;
}) {
  const t = useT();
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={t("chat.permissionRequired")}
      className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:absolute md:inset-x-0 md:bottom-20 md:z-20 md:pb-0"
    >
      <div className="space-y-3 rounded-xl border border-destructive/30 bg-background p-4 shadow-lg">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-destructive" />
          <h4 className="text-sm font-medium">
            {t("chat.permissionRequired")}
          </h4>
        </div>
        <div className="space-y-1 text-xs">
          <p>
            <span className="text-muted-foreground">{t("chat.agent")}:</span>{" "}
            {request.agentName}
          </p>
          <p>
            <span className="text-muted-foreground">{t("chat.tool")}:</span>{" "}
            {request.toolName}
          </p>
          {request.toolInput && (
            <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-muted/50 p-2 font-mono text-[11px]">
              {request.toolInput}
            </pre>
          )}
          {request.brainReason && (
            <p className="italic text-muted-foreground">
              {t("chat.reason")}: {request.brainReason}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-11 px-4 md:h-7 md:px-2.5"
            onClick={() => onRespond(request.requestId, false)}
          >
            {t("chat.deny")}
          </Button>
          <Button
            size="sm"
            className="h-11 px-4 md:h-7 md:px-2.5"
            onClick={() => onRespond(request.requestId, true)}
          >
            {t("chat.approve")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Model Config Hook ────────────────────────────────────────────

/**
 * 模型配置 hook：拉取当前模型 + channels + 切换模型。
 *
 * switchModel 先从 queryClient 读最新缓存，避免闭包捕获过期快照覆盖服务端变更。
 */
export function useModelConfig() {
  const { data: config } = useQuery(queries.config());
  const { data: channelsData } = useQuery({
    queryKey: ["providers", "channels"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/providers/channels");
        if (!res.ok) return null;
        return (await res.json()) as { ok: boolean; channels: ProviderChannel[] };
      } catch {
        return null;
      }
    },
  });
  const queryClient = useQueryClient();
  const llm = config?.llm as Record<string, unknown> | undefined;
  const t = useT();
  const currentModel = (llm?.model as string) || t("chat.notConfigured");

  /** 所有启用渠道的模型列表（扁平化） */
  const channels = channelsData?.channels?.filter((c) => c.enabled) ?? [];
  const allModels = channels.flatMap((ch) =>
    ch.models.map((m) => ({
      ...m,
      channelId: ch.id,
      channelName: ch.name,
      kind: ch.kind,
    })),
  );

  /** 切换模型（更新 llm 配置 → 刷新缓存 → toast） */
  const switchModel = useCallback(
    async (model: string, channelId?: string) => {
      try {
        const currentConfig =
          queryClient.getQueryData<Record<string, unknown>>(["config"]);
        const currentLlm = (currentConfig?.llm ?? llm) as Record<
          string,
          unknown
        >;
        const update: Record<string, unknown> = { ...currentLlm, model };
        if (channelId) {
          update.channel = channelId;
        }
        await apiPut("/api/config", { llm: update });
        queryClient.invalidateQueries({ queryKey: ["config"] });
        toast.success(t("chat.switchedToModel", { model }));
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : t("chat.failedToSwitch"),
        );
      }
    },
    [llm, queryClient, t],
  );

  return { currentModel, channels, allModels, switchModel };
}

// ─── Permission Mode Selector ─────────────────────────────────────

/** 权限模式选择器（ask/allow-all/deny-all/yolo） */
export function PermissionModeSelector() {
  const t = useT();
  const mode = useChatStore((s) => s.permissionMode);
  const setMode = useChatStore((s) => s.setPermissionMode);
  return (
    <select
      value={mode}
      onChange={(e) =>
        setMode(e.target.value as "ask" | "allow-all" | "deny-all" | "yolo")
      }
      className="h-11 rounded-md border border-input bg-background px-1.5 text-[16px] text-muted-foreground min-h-[44px] md:h-7 md:min-h-0 md:text-[11px]"
      title={t("chat.permissionMode")}
    >
      <option value="ask">{t("chat.permissionAsk")}</option>
      <option value="allow-all">{t("chat.permissionAuto")}</option>
      <option value="yolo">{t("chat.permissionYolo")}</option>
      <option value="deny-all">{t("chat.permissionDeny")}</option>
    </select>
  );
}

// ─── Model Selector ───────────────────────────────────────────────

/**
 * 模型切换选择器。
 *
 * 移动端：底部 sheet（可拖拽手柄）；桌面端：下拉浮层。
 * 支持搜索过滤 + 手动输入 model ID + 跳转 Provider 设置。
 */
export function ModelSelector() {
  const { currentModel, channels, allModels, switchModel } = useModelConfig();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editModel, setEditModel] = useState("");
  const [filter, setFilter] = useState("");

  const handleOpen = () => {
    setEditModel("");
    setFilter("");
    setOpen(true);
  };

  const handleSwitch = (model: string, channelId?: string) => {
    switchModel(model, channelId);
    setOpen(false);
  };

  const handleManualSwitch = () => {
    const trimmed = editModel.trim();
    if (!trimmed) return;
    switchModel(trimmed);
    setOpen(false);
  };

  /** 根据搜索词过滤模型（匹配 name 或 id） */
  const filtered = filter
    ? allModels.filter(
        (m) =>
          m.name.toLowerCase().includes(filter.toLowerCase()) ||
          m.id.toLowerCase().includes(filter.toLowerCase()),
      )
    : allModels;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className="flex min-h-[44px] items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:min-h-0"
      >
        <span className="max-w-[100px] truncate text-[11px] md:max-w-[140px] md:text-xs">
          {currentModel}
        </span>
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <>
          {/* 透明遮罩（点击关闭） */}
          <div
            className="fixed inset-0 z-50"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          {/* Mobile: bottom sheet | Desktop: dropdown */}
          <div className="fixed inset-x-0 bottom-0 z-50 flex max-h-[70vh] flex-col rounded-t-2xl border border-border bg-background shadow-lg md:absolute md:bottom-auto md:inset-x-auto md:right-0 md:top-full md:mt-1 md:w-80 md:rounded-lg md:max-h-[400px]">
            {/* 移动端拖拽手柄 */}
            <div className="flex justify-center pt-2 md:hidden">
              <div className="h-1 w-8 rounded-full bg-muted-foreground/30" />
            </div>
            {/* 标题 */}
            <div className="shrink-0 px-4 pb-1 pt-2 md:px-3 md:pt-3">
              <div className="text-sm font-medium">{t("chat.switchModel")}</div>
              <div className="text-[11px] text-muted-foreground">
                {t("chat.currentModel")}: {currentModel}
              </div>
            </div>
            {/* 搜索框 */}
            <div className="shrink-0 px-4 pb-2 md:px-3">
              <input
                type="text"
                placeholder={t("chat.searchModels")}
                aria-label={t("chat.searchModels")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full rounded-md border border-input bg-muted/50 px-3 py-2 text-[16px] outline-none focus:border-ring focus:ring-1 focus:ring-ring/30 md:py-1.5 md:text-xs"
                autoFocus
              />
            </div>
            {/* 模型列表（按渠道分组） */}
            <div className="flex-1 overscroll-contain overflow-y-auto px-2 md:px-1">
              {channels.map((ch) => {
                const chModels = filtered.filter(
                  (m) => m.channelId === ch.id,
                );
                if (chModels.length === 0) return null;
                return (
                  <div key={ch.id} className="mb-1">
                    <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                      {ch.name}
                    </div>
                    {chModels.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        onClick={() => handleSwitch(m.id, ch.id)}
                        className="flex w-full min-h-[44px] items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent md:min-h-0 md:py-1.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate">{m.name}</div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground">
                            {m.id}
                          </div>
                        </div>
                        {m.id === currentModel && (
                          <span className="ml-2 size-1.5 shrink-0 rounded-full bg-brand" />
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {t("chat.noModels")}
                </div>
              )}
            </div>
            {/* 手动输入 model ID */}
            <div className="shrink-0 border-t border-border px-4 py-2 md:px-3">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  placeholder={t("chat.orEnterModelId")}
                  value={editModel}
                  onChange={(e) => setEditModel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleManualSwitch();
                  }}
                  className="flex-1 rounded-md border border-input bg-muted/50 px-2.5 py-2 text-[16px] outline-none focus:border-ring focus:ring-1 focus:ring-ring/30 md:py-1.5 md:text-xs"
                />
                <button
                  type="button"
                  onClick={handleManualSwitch}
                  disabled={!editModel.trim()}
                  className="min-h-[44px] rounded-md px-3 py-2 text-xs font-medium text-background bg-foreground transition-colors hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-0 md:px-2.5 md:py-1.5"
                >
                  {t("common.apply")}
                </button>
              </div>
            </div>
            {/* Provider 设置跳转 */}
            <div className="shrink-0 border-t border-border px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:px-3 md:pb-2">
              <a
                href="/settings?tab=providers"
                className="text-[11px] text-brand hover:underline"
              >
                {t("chat.configureProviders")}
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
