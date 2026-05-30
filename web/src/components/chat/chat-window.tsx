"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useChatSocket } from "@/hooks/use-chat-socket";
import { useChatStore } from "@/lib/stores/chat-store";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { DragOverlay, type Attachment } from "@/components/chat/file-upload";
import { ConnectionStatus } from "@/components/ui/connection-status";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { PanelLeft, AlertCircle, RefreshCw } from "lucide-react";
import { apiGet, uploadFile } from "@/lib/api";

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

function ChatSkeleton() {
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

function HistoryError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircle className="size-5 text-destructive" />
        </div>
        <h3 className="mt-3 text-sm font-medium">Failed to load history</h3>
        <p className="mt-1 text-xs text-muted-foreground max-w-xs">{error}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="mr-1.5 size-3" />
          Retry
        </Button>
      </div>
    </div>
  );
}

interface ChatWindowProps {
  onToggleSidebar?: () => void;
}

export function ChatWindow({ onToggleSidebar }: ChatWindowProps) {
  const { sendMessage, cancelGeneration, resendMessage } = useChatSocket();
  const sessionId = useChatStore((s) => s.sessionId);
  const messages = useChatStore((s) => s.messages);
  const addMessage = useChatStore((s) => s.addMessage);
  const removeMessage = useChatStore((s) => s.removeMessage);
  const removeMessagesAfter = useChatStore((s) => s.removeMessagesAfter);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [droppedAttachments, setDroppedAttachments] = useState<Attachment[]>([]);
  const loadedSessionRef = useRef<string | null>(null);

  const loadHistory = useCallback(() => {
    if (!sessionId || loadedSessionRef.current === sessionId) return;
    setHistoryError(null);
    setLoadingHistory(true);
    loadedSessionRef.current = sessionId;
    apiGet<HistoryMessage[]>(`/api/conversations/${sessionId}?limit=200`)
      .then((history) => {
        if (!history?.length) return;
        for (const msg of history) {
          addMessage({
            id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: msg.role,
            content: msg.content,
            timestamp: new Date(msg.createdAt).getTime(),
            status: "complete",
          });
        }
      })
      .catch((err) => {
        loadedSessionRef.current = null;
        setHistoryError(err instanceof Error ? err.message : "Unknown error");
      })
      .finally(() => {
        setLoadingHistory(false);
      });
  }, [sessionId, addMessage]);

  useEffect(() => {
    if (!sessionId || messages.length > 0) return;
    loadHistory();
  }, [sessionId, messages.length, loadHistory]);

  const handleRetry = useCallback((errorMsgId: string) => {
    const msgs = useChatStore.getState().messages;
    const errorIdx = msgs.findIndex((m) => m.id === errorMsgId);
    if (errorIdx < 0) return;
    const userMsg = msgs[errorIdx - 1];
    if (!userMsg || userMsg.role !== "user") return;
    removeMessage(errorMsgId);
    resendMessage(userMsg.content);
  }, [removeMessage, resendMessage]);

  const handleEdit = useCallback((messageId: string, content: string) => {
    removeMessagesAfter(messageId);
    removeMessage(messageId);
    sendMessage(content);
  }, [removeMessagesAfter, removeMessage, sendMessage]);

  const handleSend = useCallback((text: string, attachments?: Attachment[]) => {
    if (attachments?.length) {
      const attachmentText = attachments.map((a) => `[${a.filename}](${a.url})`).join("\n");
      const fullText = text ? `${text}\n\n${attachmentText}` : attachmentText;
      sendMessage(fullText);
    } else {
      sendMessage(text);
    }
    setDroppedAttachments([]);
  }, [sendMessage]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (!files?.length) return;
    const newAttachments: Attachment[] = [];
    for (const file of Array.from(files)) {
      try {
        const result = await uploadFile(file);
        newAttachments.push({
          fileId: result.fileId,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
          url: result.url,
        });
      } catch (err) {
        console.error("Dropped file upload failed:", err);
      }
    }
    if (newAttachments.length > 0) {
      setDroppedAttachments((prev) => [...prev, ...newAttachments]);
    }
  }, []);

  const renderContent = () => {
    if (loadingHistory) return <ChatSkeleton />;
    if (historyError) return <HistoryError error={historyError} onRetry={loadHistory} />;
    return <ChatMessageList onRetry={handleRetry} onEdit={handleEdit} />;
  };

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DragOverlay visible={dragOver} />
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          {onToggleSidebar && (
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onToggleSidebar}>
              <PanelLeft className="size-4" />
            </Button>
          )}
          <h3 className="text-sm font-medium text-foreground">
            {sessionId ? `Session: ${sessionId.slice(0, 12)}...` : "New Conversation"}
          </h3>
        </div>
        <ConnectionStatus />
      </div>
      {renderContent()}
      <ChatInput
        onSend={(text, attachments) => {
          handleSend(text, attachments);
          setDroppedAttachments([]);
        }}
        onCancel={cancelGeneration}
        externalAttachments={droppedAttachments}
      />
    </div>
  );
}
