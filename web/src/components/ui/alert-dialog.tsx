/**
 * 确认对话框 — 封装 HeroUI v3 AlertDialog compound（react-aria-components）。
 *
 * 替代原 Dialog+Button 手写组合，获得原生 AlertDialog 语义：
 * alertdialog role、聚焦陷阱、ESC 关闭、遮罩点击关闭、状态图标。
 *
 * HeroUI AlertDialog compound 结构：
 *   Root > Backdrop > Container > Dialog > [Icon + Header(Heading) + Body + Footer]
 *
 * actionVariant="danger" 时显示警告状态图标（AlertTriangle）。
 */
import { AlertTriangle } from "lucide-react";
import {
  AlertDialog as HeroUIAlertDialog,
} from "@heroui/react";
import { Button } from "./button";
import { cn } from "@/lib/utils";
import zh from "@/locales/zh";
import en from "@/locales/en";

export interface AlertDialogProps {
  /** 受控开关 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 标题 */
  title: string;
  /** 正文描述 */
  description: string;
  /** 取消按钮文本，默认"取消" */
  cancelLabel?: string;
  /** 确认按钮文本，默认"继续" */
  actionLabel?: string;
  /** 确认按钮变体，默认 danger */
  actionVariant?: "primary" | "danger";
  /** 确认回调（点击后自动关闭） */
  onAction: () => void;
  /** 子内容（可选，追加到 Body 下方） */
  children?: React.ReactNode;
}

/** 直接查翻译表（非 hook 环境） */
function t(key: string): string {
  const locale = (typeof window !== "undefined" && localStorage.getItem("locale")) || "zh";
  const translations = locale === "en" ? en : zh;
  return translations[key] ?? key;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  cancelLabel,
  actionLabel,
  actionVariant = "danger",
  onAction,
  children,
}: AlertDialogProps) {
  /** 危险操作显示警告状态图标 */
  const isDanger = actionVariant === "danger";

  return (
    <HeroUIAlertDialog isOpen={open} onOpenChange={onOpenChange}>
      <HeroUIAlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50 data-[entering]:animate-overlay-in data-[exiting]:animate-overlay-out" />
      <HeroUIAlertDialog.Container className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <HeroUIAlertDialog.Dialog
          className={cn(
            "w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl",
            "data-[entering]:animate-sheet-in data-[exiting]:animate-sheet-out"
          )}
        >
          <div className="flex gap-3">
            {/* 状态图标（仅危险操作显示） */}
            {isDanger && (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-danger/10">
                <AlertTriangle className="size-5 text-danger" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <HeroUIAlertDialog.Heading className="text-base font-semibold text-foreground">
                {title}
              </HeroUIAlertDialog.Heading>
              <HeroUIAlertDialog.Body className="mt-1 text-sm text-muted-foreground">
                {description}
                {children}
              </HeroUIAlertDialog.Body>
            </div>
          </div>
          {/* 操作按钮区 */}
          <HeroUIAlertDialog.Footer className="mt-5 flex justify-end gap-2">
            <HeroUIAlertDialog.CloseTrigger>
              <Button
                variant="outline"
                size="sm"
                className="min-h-[44px] md:min-h-0"
                onClick={() => onOpenChange(false)}
              >
                {cancelLabel ?? t("common.cancel")}
              </Button>
            </HeroUIAlertDialog.CloseTrigger>
            <Button
              variant={actionVariant}
              size="sm"
              className="min-h-[44px] md:min-h-0"
              onClick={() => {
                onAction();
                onOpenChange(false);
              }}
            >
              {actionLabel ?? t("common.delete")}
            </Button>
          </HeroUIAlertDialog.Footer>
        </HeroUIAlertDialog.Dialog>
      </HeroUIAlertDialog.Container>
    </HeroUIAlertDialog>
  );
}
