
import { useCallback, useEffect, useState, useRef } from "react";
import { useChatSocket } from "@/hooks/use-chat-socket";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { DragOverlay, type Attachment } from "@/components/chat/file-upload";
import { ConnectionStatus } from "@/components/ui/connection-status";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { PanelLeft, AlertCircle, RefreshCw, ShieldAlert, UserCheck, ChevronDown } from "lucide-react";
import { apiGet, apiPut, uploadFile, queries } from "@/lib/api";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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
    <div className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:absolute md:inset-x-0 md:bottom-20 md:z-20 md:pb-0">
      <div className="rounded-xl border border-border bg-background shadow-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <UserCheck className="size-4 text-warning" />
          <h4 className="text-sm font-medium">{request.title}</h4>
          {request.urgency === "high" && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">Urgent</span>
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
    <div className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md px-4 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:absolute md:inset-x-0 md:bottom-20 md:z-20 md:pb-0">
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

// --- Model Selector ---

interface ChannelModel {
  id: string;
  name: string;
}

interface ProviderChannel {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  modelCount: number;
  models: ChannelModel[];
}

function useModelConfig() {
  const { data: config } = useQuery(queries.config());
  const { data: channelsData } = useQuery({
    queryKey: ["providers", "channels"],
    queryFn: async () => {
      try {
        const res = await fetch("/api/providers/channels");
        if (!res.ok) return null;
        return (await res.json()) as { ok: boolean; channels: ProviderChannel[] };
      } catch { return null; }
    },
  });
  const queryClient = useQueryClient();
  const llm = config?.llm as Record<string, unknown> | undefined;
  const currentModel = (llm?.model as string) || "not configured";

  // Flatten all enabled channels' models into one list
  const channels = channelsData?.channels?.filter(c => c.enabled) ?? [];
  const allModels = channels.flatMap(ch =>
    ch.models.map(m => ({ ...m, channelId: ch.id, channelName: ch.name, kind: ch.kind }))
  );

  const switchModel = useCallback(async (model: string, channelId?: string) => {
    try {
      const update: Record<string, unknown> = { ...llm, model };
      // Update channel if provided
      if (channelId) {
        update.channel = channelId;
      }
      await apiPut("/api/config", { llm: update });
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast.success(`Switched to ${model}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch model");
    }
  }, [llm, queryClient]);

  return { currentModel, channels, allModels, switchModel };
}

function PermissionModeSelector() {
  const mode = useChatStore((s) => s.permissionMode);
  const setMode = useChatStore((s) => s.setPermissionMode);
  return (
    <select
      value={mode}
      onChange={(e) => setMode(e.target.value as 'ask' | 'allow-all' | 'deny-all')}
      className="h-11 md:h-7 rounded-md border border-input bg-background px-1.5 text-[16px] md:text-[11px] text-muted-foreground min-h-[44px] md:min-h-0"
      title="Permission mode"
    >
      <option value="ask">Ask</option>
      <option value="allow-all">Auto</option>
      <option value="deny-all">Deny</option>
    </select>
  );
}

function ModelSelector() {
  const { currentModel, channels, allModels, switchModel } = useModelConfig();
  const [open, setOpen] = useState(false);
  const [editModel, setEditModel] = useState("");
  const [filter, setFilter] = useState("");

  const handleOpen = () => {
    setEditModel("");
    setFilter("");
    setOpen(true);
  };

  const handleSwitch = (model: string, channelId?: string) => {
    switchModel(model, channelId);
    setOpen(false);
  };

  const handleManualSwitch = () => {
    const trimmed = editModel.trim();
    if (!trimmed) return;
    switchModel(trimmed);
    setOpen(false);
  };

  const filtered = filter
    ? allModels.filter(m =>
        m.name.toLowerCase().includes(filter.toLowerCase()) ||
        m.id.toLowerCase().includes(filter.toLowerCase())
      )
    : allModels;

  return (
    <div className="relative">
      <button
        onClick={handleOpen}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors min-h-[44px] md:min-h-0"
      >
        <span className="max-w-[100px] md:max-w-[140px] truncate text-[11px] md:text-xs">{currentModel}</span>
        <ChevronDown className="size-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          {/* Mobile: bottom sheet | Desktop: dropdown */}
          <div className="fixed inset-x-0 bottom-0 z-50 md:absolute md:right-0 md:top-full md:bottom-auto md:inset-x-auto md:mt-1 md:w-80 rounded-t-2xl md:rounded-lg border border-border bg-background shadow-lg max-h-[70vh] md:max-h-[400px] flex flex-col">
            {/* Mobile drag handle */}
            <div className="flex justify-center pt-2 md:hidden">
              <div className="w-8 h-1 rounded-full bg-muted-foreground/30" />
            </div>
            {/* Header */}
            <div className="px-4 md:px-3 pt-2 md:pt-3 pb-1 shrink-0">
              <div className="text-sm font-medium">Switch Model</div>
              <div className="text-[11px] text-muted-foreground">Current: {currentModel}</div>
            </div>
            {/* Search */}
            <div className="px-4 md:px-3 pb-2 shrink-0">
              <input
                type="text"
                placeholder="Search models..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full rounded-md border border-input bg-muted/50 px-3 py-2 md:py-1.5 text-[16px] md:text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
                autoFocus
              />
            </div>
            {/* Model list */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-2 md:px-1">
              {channels.map(ch => {
                const chModels = filtered.filter(m => m.channelId === ch.id);
                if (chModels.length === 0) return null;
                return (
                  <div key={ch.id} className="mb-1">
                    <div className="px-2 py-1 text-[11px] text-muted-foreground font-medium">{ch.name}</div>
                    {chModels.map(m => (
                      <button
                        key={m.id}
                        onClick={() => handleSwitch(m.id, ch.id)}
                        className="w-full text-left px-3 py-2 md:py-1.5 rounded-md text-sm hover:bg-accent transition-colors flex items-center justify-between min-h-[44px] md:min-h-0"
                      >
                        <div className="min-w-0">
                          <div className="truncate">{m.name}</div>
                          <div className="text-[11px] text-muted-foreground font-mono truncate">{m.id}</div>
                        </div>
                        {m.id === currentModel && (
                          <span className="size-1.5 rounded-full bg-brand shrink-0 ml-2" />
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No models found
                </div>
              )}
            </div>
            {/* Manual input */}
            <div className="border-t border-border px-4 md:px-3 py-2 shrink-0">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  placeholder="Or enter model ID..."
                  value={editModel}
                  onChange={(e) => setEditModel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleManualSwitch(); }}
                  className="flex-1 rounded-md border border-input bg-muted/50 px-2.5 py-2 md:py-1.5 text-[16px] md:text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring/30"
                />
                <button
                  onClick={handleManualSwitch}
                  disabled={!editModel.trim()}
                  className="rounded-md px-3 py-2 md:px-2.5 md:py-1.5 text-xs font-medium bg-foreground text-background hover:bg-foreground/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors min-h-[44px] md:min-h-0"
                >
                  Apply
                </button>
              </div>
            </div>
            {/* Settings link */}
            <div className="border-t border-border px-4 md:px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:pb-2 shrink-0">
              <a href="/settings?tab=providers" className="text-[11px] text-brand hover:underline">
                Configure providers & API keys → Settings
              </a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Chat Window ---

interface ChatWindowProps {
  onToggleSidebar?: () => void;
}

export function ChatWindow({ onToggleSidebar }: ChatWindowProps) {
  const { sendMessage, cancelGeneration, resendMessage, respondDelegation, respondPermission, connectionStatus } = useChatSocket();
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
    const targetSession = sessionId;
    apiGet<{ messages: Array<{ role: string; content: string; createdAt: string; reasoning?: string; thinkingSteps?: Array<{ text: string; ts: number }> }> }>(`/api/sessions/${targetSession}/state?limit=200`)
      .then((data) => {
        if (useChatStore.getState().sessionId !== targetSession) return;
        loadedSessionRef.current = targetSession;
        if (!data?.messages?.length) return;
        for (const msg of data.messages) {
          addMessage({
            id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: msg.role as "user" | "assistant",
            content: msg.content,
            timestamp: msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now(),
            status: "complete",
            reasoning: msg.reasoning,
            thinkingSteps: msg.thinkingSteps,
          });
        }
      })
      .catch((err) => {
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

  // If no session after mount, restore the most recent conversation
  useEffect(() => {
    if (sessionId || messages.length > 0) return;
    apiGet<Array<{ sessionId: string }>>("/api/conversations?limit=1")
      .then((list) => {
        if (list?.length && !useChatStore.getState().sessionId) {
          useChatStore.getState().setSessionId(list[0].sessionId);
        }
      })
      .catch(() => {});
  }, [sessionId, messages.length]);

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
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
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
      className="relative grid h-full grid-rows-[auto_1fr_auto] overflow-x-hidden"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <DragOverlay visible={dragOver} />
      <div className="flex items-center justify-between border-b px-4 py-2 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          {onToggleSidebar && (
            <Button variant="ghost" size="icon" aria-label="Toggle sidebar" className="md:hidden shrink-0" onClick={onToggleSidebar}>
              <PanelLeft className="size-4" />
            </Button>
          )}
          <h3 className="text-sm font-medium text-foreground truncate">
            {sessionId ? `Session: ${sessionId.slice(0, 12)}...` : "New Conversation"}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <PermissionModeSelector />
          <ModelSelector />
          <ConnectionStatus />
        </div>
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
        disabled={connectionStatus !== "connected"}
      />
    </div>
  );
}
