"use client";

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
import { Button } from "./button";
import zh from "@/locales/zh";
import en from "@/locales/en";

interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** 取消按钮文本，默认"取消" */
  cancelLabel?: string;
  /** 确认按钮文本，默认"继续" */
  actionLabel?: string;
  actionVariant?: "default" | "destructive";
  onAction: () => void;
  children?: ReactNode;
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
  actionVariant = "destructive",
  onAction,
}: AlertDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="default" className="min-h-[44px] md:min-h-0" onClick={() => onOpenChange(false)}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            variant={actionVariant}
            size="default"
            className="min-h-[44px] md:min-h-0"
            onClick={() => {
              onAction();
              onOpenChange(false);
            }}
          >
            {actionLabel ?? t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
