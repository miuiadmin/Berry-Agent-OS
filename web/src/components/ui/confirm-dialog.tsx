/**
 * ConfirmDialog 确认对话框组件。
 *
 * 基于 shadcn AlertDialog 原语的谓词式包装。项目中所有"确认删除/禁用"对话框
 * 共享同一结构，此处封装为谓词式 API（open/onAction），
 * 避免 6 处消费侧重复书写 AlertDialog 组合 JSX。内部仍使用官方 AlertDialog compound 原语。
 *
 * 默认 actionVariant=destructive，适配删除/禁用等破坏性场景；
 * 其他场景（如确认提交）调用方覆盖为 default/secondary。
 *
 * 用法：
 *   <ConfirmDialog
 *     open={showDelete}
 *     onOpenChange={setShowDelete}
 *     title={t("common.confirmDelete")}
 *     description={t("memory.deleteConfirm")}
 *     actionLabel={t("common.delete")}
 *     onAction={handleDelete}
 *   />
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import type { VariantProps } from "class-variance-authority";
import { useT } from "@/lib/i18n";

/** Button variant 类型，用于确认按钮样式（默认 destructive） */
type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

interface ConfirmDialogProps {
  /** 是否打开 */
  open: boolean;
  /** 开关回调（关闭时底层自动调用） */
  onOpenChange: (open: boolean) => void;
  /** 对话框标题 */
  title: string;
  /** 对话框描述 */
  description: string;
  /** 确认按钮文字 */
  actionLabel: string;
  /** 点击确认的回调（点击后对话框自动关闭） */
  onAction: () => void;
  /** 取消按钮文字（默认 i18n common.cancel） */
  cancelLabel?: string;
  /** 确认按钮 variant（默认 destructive，适配删除/禁用场景） */
  actionVariant?: ButtonVariant;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  onAction,
  cancelLabel,
  actionVariant = "destructive",
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel ?? t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant={actionVariant} onClick={onAction}>
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
