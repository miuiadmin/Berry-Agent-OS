/**
 * 文件上传组件集。
 *
 * - FileUploadButton：点击触发文件选择 + 上传到服务端
 * - AttachmentPreview：附件缩略图列表（可移除）
 * - DragOverlay：拖拽上传时的全屏遮罩
 * - toAttachment：UploadResponse → Attachment 映射（file-upload / use-file-drop 共用）
 */

import { useState, useRef, useCallback } from "react";
import { Paperclip, X, FileText, Image as ImageIcon, Loader2 } from "lucide-react";
import { uploadFile, type UploadResponse } from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** 文件上传接受的 MIME / 扩展名 */
const ACCEPTED_TYPES = "image/*,text/*,application/pdf,.md,.json,.csv,.xml,.html";

/** 文件大小单位阈值（用于人类可读展示） */
const KB = 1024;
const MB = 1024 * 1024;

export interface Attachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
}

/** UploadResponse → Attachment 映射（file-upload / use-file-drop 共用） */
export function toAttachment(r: UploadResponse): Attachment {
  return { fileId: r.fileId, filename: r.filename, mimeType: r.mimeType, size: r.size, url: r.url };
}

/** 文件上传按钮（点击触发隐藏 input 的文件选择） */
export function FileUploadButton({ onAttach, disabled }: { onAttach: (a: Attachment) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const t = useT();

  /**
   * 串行上传所有选中文件（避免并发打满连接）。
   * 每个文件独立 try/catch：单个失败不影响其余文件继续上传，
   * 所有失败原因收集后逐个 toast（之前 for-await 任一失败直接 break 到 catch，后续文件静默丢失）。
   */
  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    /** 本批上传失败的文件错误信息（统一 toast） */
    const errors: string[] = [];
    try {
      for (const file of Array.from(files)) {
        try {
          const result = await uploadFile(file);
          onAttach(toAttachment(result));
        } catch (err) {
          // 单文件失败：记录原因，继续上传剩余文件
          const fname = file.name;
          const msg = err instanceof Error ? err.message : t("fileUpload.uploadFailed");
          errors.push(`${fname}: ${msg}`);
        }
      }
      if (errors.length) toast.error(errors.join("\n"));
    } finally {
      setUploading(false);
      // 清空 input.value 让相同文件可再次选择（否则 onChange 不触发）
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
          "min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0",
          "hover:bg-accent hover:text-foreground active:bg-accent",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </>
  );
}

/** 附件预览列表（图片 / 文件图标 + 文件名 + 大小 + 移除按钮） */
export function AttachmentPreview({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (id: string) => void }) {
  const t = useT();
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-4 pt-2">
      {attachments.map((a) => (
        <div
          key={a.fileId}
          // 移动端整 chip 撑到 44px（与内部 44px 移除按钮等高），避免按钮溢出 chip 导致视觉臃肿；
          // 桌面端收回紧凑高度。CLAUDE.md 触控目标规则优先于视觉紧凑。
          className="flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs animate-slide-down md:min-h-0"
        >
          {/* 图标：图片用 ImageIcon，其他用 FileText */}
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
            className="ml-0.5 flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:text-destructive md:min-h-0 md:min-w-0 md:p-0.5">
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 拖拽上传时的全屏遮罩（提示用户可释放） */
export function DragOverlay({ visible }: { visible: boolean }) {
  const t = useT();
  if (!visible) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-ring bg-background/80 backdrop-blur-sm">
      <div className="text-center">
        <Paperclip className="mx-auto size-8 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">{t("fileUpload.dropHere")}</p>
      </div>
    </div>
  );
}

/**
 * 字节数 → 人类可读字符串（B / KB / MB）。
 * KB 与 MB 统一保留 1 位小数（之前 KB 用 toFixed(0) 丢精度、MB 用 toFixed(1)，
 * 两档精度不一致；统一后 500KB 显示「500.0KB」、1.5MB 显示「1.5MB」，策略一致）。
 */
function formatSize(bytes: number): string {
  if (bytes < KB) return `${bytes}B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)}KB`;
  return `${(bytes / MB).toFixed(1)}MB`;
}
