/**
 * 文件上传组件集。
 *
 * - FileUploadButton：点击触发文件选择 + 上传到服务端
 * - AttachmentPreview：附件缩略图列表（可移除）
 * - DragOverlay：拖拽上传时的全屏遮罩
 * - uploadFile：上传 API 封装（支持 AbortController 取消）
 */

import { useState, useRef, useCallback } from "react";
import { Paperclip, X, FileText, Image as ImageIcon, Loader2 } from "lucide-react";
import { uploadFile, type UploadResponse } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export interface Attachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
}

interface FileUploadProps {
  attachments: Attachment[];
  onAttach: (attachment: Attachment) => void;
  onRemove: (fileId: string) => void;
  disabled?: boolean;
}

export function FileUploadButton({ onAttach, disabled }: { onAttach: (a: Attachment) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const t = useT();

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const result = await uploadFile(file);
        onAttach({
          fileId: result.fileId,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
          url: result.url,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("fileUpload.uploadFailed");
      toast.error(msg);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [onAttach, t]);

  return (
    <>
      <button
        type="button"
        aria-label={t("fileUpload.attach")}
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "shrink-0 rounded-lg p-2.5 md:p-2 text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-foreground active:bg-accent",
          "disabled:opacity-50 disabled:cursor-not-allowed"
        )}
      >
        {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,text/*,application/pdf,.md,.json,.csv,.xml,.html"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </>
  );
}

export function AttachmentPreview({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (id: string) => void }) {
  const t = useT();
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 pt-2">
      {attachments.map((a) => (
        <div
          key={a.fileId}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs animate-slide-down"
        >
          {a.mimeType.startsWith("image/") ? (
            <ImageIcon className="size-3 text-muted-foreground" />
          ) : (
            <FileText className="size-3 text-muted-foreground" />
          )}
          <span className="max-w-[100px] sm:max-w-[120px] truncate">{a.filename}</span>
          <span className="text-muted-foreground/60">{formatSize(a.size)}</span>
          <button type="button"
            onClick={() => onRemove(a.fileId)}
            aria-label={t("fileUpload.remove", { filename: a.filename })}
            className="ml-0.5 rounded p-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 md:p-0.5 text-muted-foreground hover:text-destructive transition-colors flex items-center justify-center"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function DragOverlay({ visible }: { visible: boolean }) {
  const t = useT();
  if (!visible) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-ring rounded-lg">
      <div className="text-center">
        <Paperclip className="mx-auto size-8 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">{t("fileUpload.dropHere")}</p>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
