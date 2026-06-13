/**
 * ChatWindow 的辅助子组件。
 *
 * 把 ChatSkeleton / HistoryError / DelegationDialog / PermissionConfirmDialog /
 * PermissionModeSelector 从 chat-window.tsx 拆出，
 * 让 ChatWindow 主文件只保留编排逻辑。
 *
 * ModelSelector → model-selector.tsx
 * useModelConfig → use-model-config.ts
 */

import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, ShieldAlert, UserCheck } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";

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
