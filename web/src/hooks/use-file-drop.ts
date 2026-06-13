/**
 * 文件拖拽上传 hook。
 *
 * 封装拖拽事件处理（dragover / dragleave / drop）和文件上传逻辑，
 * 从 ChatWindow 组件中分离以降低复杂度。支持 AbortController 中止上传。
 */

import { useState, useCallback, useRef } from "react";
import { toAttachment, type Attachment } from "@/components/chat/file-upload";
import { uploadFile } from "@/lib/api";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";

/** hook 返回值：拖拽状态 + 事件处理器 + 已上传附件 + 清空方法 */
export interface UseFileDropReturn {
  /** 当前是否处于拖拽悬停状态 */
  dragOver: boolean;
  /** 拖拽上传后的附件列表 */
  attachments: Attachment[];
  /** 追加外部附件（如文件选择器上传） */
  appendAttachments: (items: Attachment[]) => void;
  /** 清空附件列表 */
  clearAttachments: () => void;
  /** 绑定到容器的拖拽事件处理器 */
  handlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

/**
 * 文件拖拽上传 hook。
 *
 * 用法：
 * ```tsx
 * const drop = useFileDrop();
 * <div {...drop.handlers}><DragOverlay visible={drop.dragOver} />...</div>
 * <ChatInput onSend={(text) => { send(text, drop.attachments); drop.clearAttachments(); }} />
 * ```
 */
export function useFileDrop(): UseFileDropReturn {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** 文件上传中止控制器，组件卸载或新拖放时自动中止旧的 */
  const abortRef = useRef<AbortController | null>(null);

  const appendAttachments = useCallback((items: Attachment[]) => {
    setAttachments((prev) => [...prev, ...items]);
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  /** 仅当鼠标真正离开容器时才关闭拖拽态（排除进入子元素） */
  const onDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setDragOver(false);
  }, []);

  /** 处理文件拖放：逐个上传，中止安全 */
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer.files;
      if (!files?.length) return;

      /** 每次拖放创建新的 AbortController，旧的自动失效 */
      const controller = new AbortController();
      abortRef.current = controller;

      const uploaded: Attachment[] = [];
      for (const file of Array.from(files)) {
        if (controller.signal.aborted) break;
        try {
          const result = await uploadFile(file, controller.signal);
          uploaded.push(toAttachment(result));
        } catch (err) {
          if (controller.signal.aborted) break;
          const msg = err instanceof Error ? err.message : t("chat.fileUploadFailed");
          toast.error(msg);
        }
      }

      if (uploaded.length > 0) {
        setAttachments((prev) => [...prev, ...uploaded]);
      }
    },
    [t],
  );

  return {
    dragOver,
    attachments,
    appendAttachments,
    clearAttachments,
    handlers: { onDragOver, onDragLeave, onDrop },
  };
}
