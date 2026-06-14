/**
 * ChatWindow 的辅助子组件。
 *
 * 把 ChatSkeleton / HistoryError / DelegationDialog /
 * PermissionConfirmDialog / PermissionModeSelector 从 chat-window.tsx 拆出，
 * 让 ChatWindow 主文件只保留编排逻辑。
 *
 * DelegationDialog 与 PermissionConfirmDialog 共享 BottomSheet + ConfirmButtons。
 */

import { useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AlertCircle, RefreshCw, ShieldAlert, UserCheck } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";

/** 权限模式联合类型（与 chat-store 同步） */
type PermissionMode = ReturnType<typeof useChatStore.getState>["permissionMode"];

// ─── 共享：底部弹窗 + 确认按钮组 ───────────────────────────────────

/** 弹窗色调（destructive 用于权限请求；default 用于委派） */
type SheetTone = "default" | "destructive";

/**
 * 底部弹窗容器（移动端底部固定 / 桌面端浮层）。
 * DelegationDialog 与 PermissionConfirmDialog 共用定位与卡片样式。
 *
 * a11y：role=alertdialog + aria-modal=true 承诺了模态行为——
 * 因此实现 Escape 关闭 + 遮罩点击关闭（onDismiss 回调，由调用方决定是 deny 还是取消），
 * 让屏幕阅读器 / 键盘用户能正常退出，兑现 aria-modal 承诺。
 *
 * 注意：未实现完整 focus trap（焦点受限在弹窗内）——这两类弹窗（委派/权限）内容极少、
 * 且是阻塞性交互（用户必须 approve/deny 才能继续），focus trap 收益有限，暂不引入。
 */
function BottomSheet({ label, tone = "default", onDismiss, children }: {
  label: string;
  tone?: SheetTone;
  /** 关闭回调（Escape / 遮罩点击触发）——调用方映射为 deny 或取消 */
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  // Escape 键关闭（aria-modal=true 的模态行为承诺）
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <>
      {/* 透明遮罩：点击关闭（兑现 aria-modal 模态行为——click outside 可退出） */}
      {onDismiss && (
        <div
          className="fixed inset-0 z-40 md:absolute"
          onClick={onDismiss}
          aria-hidden="true"
        />
      )}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={label}
        className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:absolute md:inset-x-0 md:bottom-20 md:z-20 md:pb-0"
      >
        <div className={cn(
          "space-y-3 rounded-xl border bg-background p-4 shadow-lg",
          tone === "destructive" ? "border-destructive/30" : "border-border",
        )}>
          {children}
        </div>
      </div>
    </>
  );
}

/** 拒绝 / 批准按钮组（移动端 44px 触控目标）。去掉 size=sm —— 其默认 height 会被 h-11 覆盖，class 顺序依赖脆弱，统一用 h 类控制高度。 */
function ConfirmButtons({ denyLabel, approveLabel, onDeny, onApprove }: {
  denyLabel: string;
  approveLabel: string;
  onDeny: () => void;
  onApprove: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button variant="outline" className="h-11 px-4 md:h-7 md:px-2.5" onClick={onDeny}>
        {denyLabel}
      </Button>
      <Button className="h-11 px-4 md:h-7 md:px-2.5" onClick={onApprove}>
        {approveLabel}
      </Button>
    </div>
  );
}

// ─── Loading / Error ──────────────────────────────────────────────

/** 骨架屏气泡配置（用户右对齐 / 助手左对齐交替） */
const SKELETON_BUBBLES = [
  { align: "items-end", cls: "h-10 w-48" },
  { align: "items-start", cls: "h-16 w-64" },
  { align: "items-end", cls: "h-10 w-36" },
  { align: "items-start", cls: "h-24 w-72" },
] as const;

/** 聊天页面加载骨架屏 */
export function ChatSkeleton() {
  return (
    <div className="flex-1 p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        {SKELETON_BUBBLES.map((b, i) => (
          <div key={i} className={cn("flex flex-col", b.align)}>
            <Skeleton className={cn("rounded-2xl", b.cls)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 历史消息加载失败提示 + 重试按钮 */
export function HistoryError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-5 text-destructive" />
        </div>
        <h3 className="mt-3 text-sm font-medium">{t("chat.failedToLoadHistory")}</h3>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="mr-1.5 size-3" />
          {t("common.retry")}
        </Button>
      </div>
    </div>
  );
}

// ─── Dialogs ──────────────────────────────────────────────────────

/**
 * Agent 委派请求对话框。
 * approve → 允许委派；deny → 拒绝。基于 options 动态显示按钮。
 */
export function DelegationDialog({
  request,
  onRespond,
}: {
  request: DelegationRequest;
  onRespond: (delegationId: string, response: string | null, approved: boolean) => void;
}) {
  const t = useT();

  return (
    <BottomSheet label={request.title} onDismiss={() => onRespond(request.delegationId, null, false)}>
      {/* 标题 + 紧急标识 */}
      <div className="flex items-center gap-2">
        <UserCheck className="size-4 text-warning" />
        <h4 className="text-sm font-medium">{request.title}</h4>
        {request.urgency === "high" && (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
            {t("chat.urgent")}
          </span>
        )}
      </div>
      {request.description && <p className="text-xs text-muted-foreground">{request.description}</p>}
      <p className="text-[11px] text-muted-foreground/70">
        {t("chat.requestedBy")}: {request.requestedBy}
      </p>
      <ConfirmButtons
        denyLabel={t("chat.deny")}
        approveLabel={t("chat.approve")}
        onDeny={() => onRespond(request.delegationId, null, false)}
        onApprove={() => onRespond(request.delegationId, "approved", true)}
      />
    </BottomSheet>
  );
}

/**
 * 权限确认对话框（Agent 请求使用高风险工具）。
 * 展示 agent / 工具 / 输入预览 / Brain 审核理由。approve → 授权；deny → 拒绝。
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
    <BottomSheet label={t("chat.permissionRequired")} tone="destructive" onDismiss={() => onRespond(request.requestId, false)}>
      {/* 标题 */}
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-destructive" />
        <h4 className="text-sm font-medium">{t("chat.permissionRequired")}</h4>
      </div>
      {/* 详情：agent / 工具 / 输入预览 / 理由 */}
      <div className="space-y-1 text-xs">
        <p><span className="text-muted-foreground">{t("chat.agent")}:</span> {request.agentName}</p>
        <p><span className="text-muted-foreground">{t("chat.tool")}:</span> {request.toolName}</p>
        {request.toolInput && (
          <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-muted/50 p-2 font-mono text-[11px]">
            {request.toolInput}
          </pre>
        )}
        {request.brainReason && (
          <p className="italic text-muted-foreground">{t("chat.reason")}: {request.brainReason}</p>
        )}
      </div>
      <ConfirmButtons
        denyLabel={t("chat.deny")}
        approveLabel={t("chat.approve")}
        onDeny={() => onRespond(request.requestId, false)}
        onApprove={() => onRespond(request.requestId, true)}
      />
    </BottomSheet>
  );
}

// ─── Permission Mode Selector ─────────────────────────────────────

/** 权限模式选项（value 与 store 同步） */
const PERMISSION_MODES: Array<{ value: PermissionMode; labelKey: string }> = [
  { value: "ask", labelKey: "chat.permissionAsk" },
  { value: "allow-all", labelKey: "chat.permissionAuto" },
  { value: "yolo", labelKey: "chat.permissionYolo" },
  { value: "deny-all", labelKey: "chat.permissionDeny" },
];

/** 权限模式选择器（ask / allow-all / deny-all / yolo） */
export function PermissionModeSelector() {
  const t = useT();
  const mode = useChatStore((s) => s.permissionMode);
  const setMode = useChatStore((s) => s.setPermissionMode);

  return (
    <select
      value={mode}
      onChange={(e) => setMode(e.target.value as typeof mode)}
      // h-11=44px 即触控目标最小尺寸，无需再叠 min-h-[44px]（之前冗余）
      className="h-11 rounded-md border border-input bg-background px-1.5 text-[16px] text-muted-foreground md:h-7 md:text-[11px]"
      title={t("chat.permissionMode")}
    >
      {PERMISSION_MODES.map((opt) => (
        <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
      ))}
    </select>
  );
}
