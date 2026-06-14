/**
 * 聊天输入框组件。
 *
 * 底部固定的输入区域：textarea + 附件管理 + 工具栏（上传/图片/设置/停止）+ 发送按钮。
 * - 自适应高度（最大 MAX_HEIGHT）
 * - 超过 500 字符时显示字数统计
 * - Enter 发送 / Shift+Enter 换行
 */

import { useState, useMemo } from "react";
import { Square, ImagePlus, Settings } from "lucide-react";
import { useChatStore } from "@/lib/stores/chat-store";
import { FileUploadButton, AttachmentPreview, type Attachment } from "@/components/chat/file-upload";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { useAutoResizeTextarea } from "@/hooks/use-auto-resize-textarea";

/** textarea 自适应高度上限（像素） */
const MAX_HEIGHT = 300;
/** 超过此字数显示字数统计 */
const CHAR_COUNT_THRESHOLD = 500;

/** 工具栏按钮（共享尺寸 / hover 样式，移动端 44px 触控目标） */
function ToolbarButton({
  children, onClick, disabled, variant, "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive";
  "aria-label"?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}
      className={cn(
        "inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-2 transition-all duration-150 active:scale-90 md:min-h-0 md:min-w-0 md:p-1.5",
        variant === "destructive"
          ? "text-destructive hover:bg-destructive/10 active:bg-destructive/20"
          : "text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent",
        "disabled:pointer-events-none disabled:opacity-40",
      )}>
      {children}
    </button>
  );
}

interface ChatInputProps {
  onSend: (text: string, attachments?: Attachment[]) => void;
  onCancel?: () => void;
  externalAttachments?: Attachment[];
  disabled?: boolean;
}

export function ChatInput({ onSend, onCancel, externalAttachments, disabled }: ChatInputProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // 自适应高度 textarea（封顶 MAX_HEIGHT，超过后内容滚动）
  const { textareaRef, resize } = useAutoResizeTextarea(MAX_HEIGHT);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const t = useT();

  /** 合并内部上传 + 外部拖拽进来的附件 */
  const allAttachments = useMemo(
    () => [...attachments, ...(externalAttachments ?? [])],
    [attachments, externalAttachments],
  );
  /** 是否有可发送内容（文本非空 或 有附件） */
  const hasContent = text.trim().length > 0 || allAttachments.length > 0;
  /** 发送按钮禁用条件：无内容 / 流式中 / 外部禁用（断线 / 未配置模型） */
  const sendDisabled = !hasContent || isStreaming || disabled;

  /** 提交发送：清空文本 / 附件并重置 textarea 高度 */
  const handleSubmit = () => {
    // 父组件禁用（断线 / 未配置模型）时弹提示，避免用户以为按钮坏了。
    // 注意：发送按钮虽然 visually disabled，但 Enter 键仍会触发 handleSubmit（键盘不读 disabled 态），
    // 因此此分支可达——断线时按 Enter 会弹"未连接"提示。
    if (disabled) { toast.error(t("chat.notConnected")); return; }
    if (!hasContent || isStreaming) return;
    const trimmed = text.trim();
    onSend(trimmed, allAttachments.length > 0 ? allAttachments : undefined);
    setText("");
    setAttachments([]);
    resize();
  };

  /** Enter 发送 / Shift+Enter 换行 */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  /** 输入时同步内容并触发自适应高度（hook 内部处理 reset→set + maxHeight 封顶） */
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    resize();
  };

  return (
    <div className="border-t border-border bg-background p-3 md:p-4">
      <div className="mx-auto max-w-3xl">
        <div className="input-focus-glow overflow-hidden rounded-2xl border border-input bg-muted/50 transition-all duration-200">
          {/* 附件预览（有附件时显示） */}
          {allAttachments.length > 0 && (
            <AttachmentPreview
              attachments={allAttachments}
              onRemove={(fileId) => setAttachments((prev) => prev.filter((a) => a.fileId !== fileId))}
            />
          )}

          {/* 文本输入 */}
          <div className="relative">
            <textarea ref={textareaRef} value={text} onChange={handleInput} onKeyDown={handleKeyDown}
              placeholder={t("chat.typePlaceholder")} aria-label={t("chat.typePlaceholder")} rows={1}
              className="w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[16px] leading-relaxed outline-none placeholder:text-muted-foreground md:text-sm" />
            {/* 字数统计（超过阈值才显示，避免短文本噪音） */}
            {text.length > CHAR_COUNT_THRESHOLD && (
              <span className="absolute bottom-2 right-3 text-[11px] text-muted-foreground/60">{text.length}</span>
            )}
          </div>

          {/* 工具栏：附件按钮 + 占位按钮 + 停止生成 + 发送 */}
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-0.5">
              <FileUploadButton onAttach={(a) => setAttachments((prev) => [...prev, a])} disabled={isStreaming} />
              {/* TODO(图片上传): 占位按钮——上传图片功能未实现。disabled 且无 onClick，仅作 UI 占位提示。落地后接 FileUploadButton 同款上传逻辑。 */}
              <ToolbarButton disabled aria-label={t("chat.uploadImage")}>
                <ImagePlus className="size-4" />
              </ToolbarButton>
              {/* TODO(输入设置): 占位按钮——输入相关设置（如温度/max_tokens）未实现。disabled 且无 onClick，仅作 UI 占位。 */}
              <ToolbarButton disabled aria-label={t("chat.settings")}>
                <Settings className="size-4" />
              </ToolbarButton>
              {/* 流式中显示停止生成按钮 */}
              {isStreaming && (
                <ToolbarButton onClick={onCancel} variant="destructive" aria-label={t("chat.stopGeneration")}>
                  <Square className="size-3.5 fill-current" />
                </ToolbarButton>
              )}
            </div>
            {/* 发送按钮（移动端 44px 触控目标） */}
            <button type="button" onClick={handleSubmit} disabled={sendDisabled}
              className={cn(
                "btn-press min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 md:min-h-0 md:px-3 md:py-1.5 md:text-xs",
                sendDisabled
                  ? "cursor-not-allowed bg-muted text-muted-foreground"
                  : "bg-foreground text-background hover:bg-foreground/90 active:scale-[0.97] active:bg-foreground/80 animate-send-ready",
              )}>
              {t("chat.send")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
