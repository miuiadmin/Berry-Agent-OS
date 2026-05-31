"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useChatSocket } from "@/hooks/use-chat-socket";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { DragOverlay, type Attachment } from "@/components/chat/file-upload";
import { ConnectionStatus } from "@/components/ui/connection-status";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { PanelLeft, AlertCircle, RefreshCw, ShieldAlert, UserCheck } from "lucide-react";
import { apiGet, uploadFile } from "@/lib/api";
import { toast } from "sonner";

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

function DelegationDialog({
  request,
  onRespond,
}: {
  request: DelegationRequest;
  onRespond: (delegationId: string, response: string | null, approved: boolean) => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:absolute md:inset-x-0 md:bottom-20 md:pb-0">
      <div className="rounded-xl border border-border bg-background shadow-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <UserCheck className="size-4 text-warning" />
          <h4 className="text-sm font-medium">{request.title}</h4>
          {request.urgency === "high" && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">Urgent</span>
          )}
        </div>
        {request.description && (
          <p className="text-xs text-muted-foreground">{request.description}</p>
        )}
        <p className="text-[11px] text-muted-foreground/70">Requested by: {request.requestedBy}</p>
        <div className="flex items-center gap-2 justify-end">
          {request.options.includes("deny") && (
            <Button variant="outline" size="sm" onClick={() => onRespond(request.delegationId, null, false)}>
              Deny
            </Button>
          )}
          {request.options.includes("approve") && (
            <Button size="sm" onClick={() => onRespond(request.delegationId, "approved", true)}>
              Approve
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function PermissionConfirmDialog({
  request,
  onRespond,
}: {
  request: PermissionConfirmRequest;
  onRespond: (requestId: string, approved: boolean) => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:absolute md:inset-x-0 md:bottom-20 md:pb-0">
      <div className="rounded-xl border border-destructive/30 bg-background shadow-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-destructive" />
          <h4 className="text-sm font-medium">Permission Required</h4>
        </div>
        <div className="space-y-1 text-xs">
          <p><span className="text-muted-foreground">Agent:</span> {request.agentName}</p>
          <p><span className="text-muted-foreground">Tool:</span> {request.toolName}</p>
          {request.toolInput && (
            <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-muted/50 p-2 text-[11px] font-mono">{request.toolInput}</pre>
          )}
          {request.brainReason && (
            <p className="text-muted-foreground italic">Reason: {request.brainReason}</p>
          )}
        </div>
        <div className="flex items-center gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={() => onRespond(request.requestId, false)}>
            Deny
          </Button>
          <Button size="sm" onClick={() => onRespond(request.requestId, true)}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ChatWindowProps {
  onToggleSidebar?: () => void;
}

export function ChatWindow({ onToggleSidebar }: ChatWindowProps) {
  const { sendMessage, cancelGeneration, resendMessage, respondDelegation, respondPermission } = useChatSocket();
  const sessionId = useChatStore((s) => s.sessionId);
  const messages = useChatStore((s) => s.messages);
  const addMessage = useChatStore((s) => s.addMessage);
  const removeMessage = useChatStore((s) => s.removeMessage);
  const removeMessagesAfter = useChatStore((s) => s.removeMessagesAfter);
  const pendingDelegation = useChatStore((s) => s.pendingDelegation);
  const pendingPermission = useChatStore((s) => s.pendingPermission);
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
    sendMessage(text, attachments);
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
        const msg = err instanceof Error ? err.message : "File upload failed";
        toast.error(msg);
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
      <div className="flex items-center justify-between border-b px-4 py-2 pt-[calc(0.5rem+env(safe-area-inset-top,0px))] md:pt-2">
        <div className="flex items-center gap-2">
          {onToggleSidebar && (
            <Button variant="ghost" size="icon" className="md:hidden" onClick={onToggleSidebar}>
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
      {pendingDelegation && (
        <DelegationDialog request={pendingDelegation} onRespond={respondDelegation} />
      )}
      {pendingPermission && (
        <PermissionConfirmDialog request={pendingPermission} onRespond={respondPermission} />
      )}
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
