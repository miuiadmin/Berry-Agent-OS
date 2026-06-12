
import { useCallback, useEffect, useState, useRef } from "react";
import { useChatSocket } from "@/hooks/use-chat-socket";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";
import { ChatMessageList } from "@/components/chat/chat-message-list";
import { ChatInput } from "@/components/chat/chat-input";
import { DragOverlay, type Attachment } from "@/components/chat/file-upload";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { PanelLeft, AlertCircle, RefreshCw, ShieldAlert, UserCheck, ChevronDown } from "lucide-react";
import { apiGet, apiPut, uploadFile, queries } from "@/lib/api";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n";

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
  const t = useT();
  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-danger/10">
          <AlertCircle className="size-5 text-danger" />
        </div>
        <h3 className="mt-3 text-sm font-medium">{t("chat.failedToLoadHistory")}</h3>
        <p className="mt-1 text-xs text-muted-foreground max-w-xs">{error}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RefreshCw className="mr-1.5 size-3" />
          {t("common.retry")}
        </Button>
      </div>
    </div>
  );
}

/** 委派请求对话框 — 使用 Dialog adapter 自动处理遮罩/ESC/聚焦陷阱 */
function DelegationDialog({
  request,
  onRespond,
}: {
  request: DelegationRequest;
  onRespond: (delegationId: string, response: string | null, approved: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onRespond(request.delegationId, null, false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="size-4 text-warning" />
            {request.title}
            {request.urgency === "high" && (
              <Badge variant="danger" className="text-[11px]">{t("chat.urgent")}</Badge>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 px-6 pb-2">
          {request.description && (
            <p className="text-xs text-muted-foreground">{request.description}</p>
          )}
          <p className="text-[11px] text-muted-foreground/70">{t("chat.requestedBy")}: {request.requestedBy}</p>
        </div>
        <DialogFooter>
          {request.options.includes("deny") && (
            <Button variant="outline" size="sm" onClick={() => onRespond(request.delegationId, null, false)}>
              {t("chat.deny")}
            </Button>
          )}
          {request.options.includes("approve") && (
            <Button size="sm" onClick={() => onRespond(request.delegationId, "approved", true)}>
              {t("chat.approve")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 权限确认对话框 — 使用 Dialog adapter 自动处理遮罩/ESC/聚焦陷阱 */
function PermissionConfirmDialog({
  request,
  onRespond,
}: {
  request: PermissionConfirmRequest;
  onRespond: (requestId: string, approved: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onRespond(request.requestId, false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-danger" />
            {t("chat.permissionRequired")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-1 text-xs px-6 pb-2">
          <p><span className="text-muted-foreground">{t("chat.agent")}:</span> {request.agentName}</p>
          <p><span className="text-muted-foreground">{t("chat.tool")}:</span> {request.toolName}</p>
          {request.toolInput && (
            <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-muted/50 p-2 text-[11px] font-mono">{request.toolInput}</pre>
          )}
          {request.brainReason && (
            <p className="text-muted-foreground italic">{t("chat.reason")}: {request.brainReason}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onRespond(request.requestId, false)}>
            {t("chat.deny")}
          </Button>
          <Button size="sm" onClick={() => onRespond(request.requestId, true)}>
            {t("chat.approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const t = useT();
  const currentModel = (llm?.model as string) || t("chat.notConfigured");

  // Flatten all enabled channels' models into one list
  const channels = channelsData?.channels?.filter(c => c.enabled) ?? [];
  const allModels = channels.flatMap(ch =>
    ch.models.map(m => ({ ...m, channelId: ch.id, channelName: ch.name, kind: ch.kind }))
  );

  const switchModel = useCallback(async (model: string, channelId?: string) => {
    try {
      // 从查询缓存读取最新 llm 配置，避免闭包捕获过期快照覆盖服务端变更
      const currentConfig = queryClient.getQueryData<Record<string, unknown>>(["config"]);
      const currentLlm = (currentConfig?.llm ?? llm) as Record<string, unknown>;
      const update: Record<string, unknown> = { ...currentLlm, model };
      if (channelId) {
        update.channel = channelId;
      }
      await apiPut("/api/config", { llm: update });
      queryClient.invalidateQueries({ queryKey: ["config"] });
      toast.success(t("chat.switchedToModel", { model }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("chat.failedToSwitch"));
    }
  }, [llm, queryClient, t]);

  return { currentModel, channels, allModels, switchModel };
}

function PermissionModeSelector() {
  const t = useT();
  const mode = useChatStore((s) => s.permissionMode);
  const setMode = useChatStore((s) => s.setPermissionMode);
  return (
    <Select
      value={mode}
      onValueChange={(v) => setMode(v as 'ask' | 'allow-all' | 'deny-all')}
      ariaLabel={t("chat.permissionMode")}
      options={[
        { key: "ask", label: t("chat.permissionAsk") },
        { key: "allow-all", label: t("chat.permissionAuto") },
        { key: "deny-all", label: t("chat.permissionDeny") },
      ]}
      className="w-auto"
    />
  );
}

function ModelSelector() {
  const { currentModel, channels, allModels, switchModel } = useModelConfig();
  const t = useT();
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
      <Button
        variant="ghost"
        type="button"
        onClick={handleOpen}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors min-h-[44px] md:min-h-0 h-auto"
      >
        <span className="max-w-[100px] md:max-w-[140px] truncate text-[11px] md:text-xs">{currentModel}</span>
        <ChevronDown className="size-3" />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} aria-hidden="true" />
          {/* Mobile: bottom sheet | Desktop: dropdown */}
          <div className="fixed inset-x-0 bottom-0 z-50 md:absolute md:right-0 md:top-full md:bottom-auto md:inset-x-auto md:mt-1 md:w-80 rounded-t-2xl md:rounded-lg border border-border bg-background shadow-lg max-h-[70vh] md:max-h-[400px] flex flex-col">
            {/* Mobile drag handle */}
            <div className="flex justify-center pt-2 md:hidden">
              <div className="w-8 h-1 rounded-full bg-muted-foreground/30" />
            </div>
            {/* Header */}
            <div className="px-4 md:px-3 pt-2 md:pt-3 pb-1 shrink-0">
              <div className="text-sm font-medium">{t("chat.switchModel")}</div>
              <div className="text-[11px] text-muted-foreground">{t("chat.currentModel")}: {currentModel}</div>
            </div>
            {/* Search */}
            <div className="px-4 md:px-3 pb-2 shrink-0">
              <Input
                type="text"
                placeholder={t("chat.searchModels")}
                aria-label={t("chat.searchModels")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="text-[16px] md:text-xs"
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
                      <Button
                        key={m.id}
                        variant="ghost"
                        type="button"
                        onClick={() => handleSwitch(m.id, ch.id)}
                        className="w-full text-left px-3 py-2 md:py-1.5 rounded-md text-sm hover:bg-accent transition-colors flex items-center justify-between min-h-[44px] md:min-h-0 h-auto"
                      >
                        <div className="min-w-0">
                          <div className="truncate">{m.name}</div>
                          <div className="text-[11px] text-muted-foreground font-mono truncate">{m.id}</div>
                        </div>
                        {m.id === currentModel && (
                          <span className="size-1.5 rounded-full bg-accent shrink-0 ml-2" />
                        )}
                      </Button>
                    ))}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {t("chat.noModels")}
                </div>
              )}
            </div>
            {/* Manual input */}
            <div className="border-t border-border px-4 md:px-3 py-2 shrink-0">
              <div className="flex gap-1.5">
                <Input
                  type="text"
                  placeholder={t("chat.orEnterModelId")}
                  value={editModel}
                  onChange={(e) => setEditModel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleManualSwitch(); }}
                  className="flex-1 text-[16px] md:text-xs"
                />
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  onClick={handleManualSwitch}
                  disabled={!editModel.trim()}
                  className="min-h-[44px] md:min-h-0"
                >
                  {t("common.apply")}
                </Button>
              </div>
            </div>
            {/* Settings link */}
            <div className="border-t border-border px-4 md:px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:pb-2 shrink-0">
              <a href="/settings?tab=providers" className="text-[11px] text-accent hover:underline">
                {t("chat.configureProviders")}
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
  const { sendMessage, cancelGeneration, resendMessage, respondDelegation, respondPermission } = useChatSocket();
  const sessionId = useChatStore((s) => s.sessionId);
  const messagesLength = useChatStore((s) => s.messages.length);
  const addMessage = useChatStore((s) => s.addMessage);
  const removeMessage = useChatStore((s) => s.removeMessage);
  const removeMessagesAfter = useChatStore((s) => s.removeMessagesAfter);
  const pendingDelegation = useChatStore((s) => s.pendingDelegation);
  const pendingPermission = useChatStore((s) => s.pendingPermission);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [droppedAttachments, setDroppedAttachments] = useState<Attachment[]>([]);
  const loadedSessionRef = useRef<string | null>(null);
  /** 文件拖放上传的 AbortController，卸载时中止所有进行中的上传 */
  const uploadAbortRef = useRef<AbortController | null>(null);
  const t = useT();

  // 是否已配置至少一个可用的 provider/model channel
  // 用 React Query 缓存（与 sendMessage 中的快查保持一致）
  const channelsQuery = useQuery({
    queryKey: ["providers", "channels"],
    queryFn: async () => {
      const res = await fetch("/api/providers/channels");
      if (!res.ok) return { channels: [] as Array<{ configured?: boolean; modelCount?: number }> };
      return res.json() as Promise<{ channels?: Array<{ configured?: boolean; modelCount?: number }> }>;
    },
    staleTime: 30_000,
  });
  const isModelConfigured = !!channelsQuery.data?.channels?.some(
    (ch) => ch.configured || (ch.modelCount ?? 0) > 0,
  );

  /**
   * 输入框可用条件（H4 修复）：
   * - 不在流式中（避免重入）
   * - 模型已配置（否则根本发不出去）
   * 不再硬绑 connectionStatus：断线时输入框仍可输入，send 走 ws-store.sendQueue 暂存
   */
  const canSend = !isStreaming && isModelConfigured;

  /**
   * 统一的历史恢复入口。
   *
   * 合并了原先的 loadHistory（chat-window 独立 effect）和 sharedSessionRestore
   * （use-chat-socket 的 status effect）两条路径，消除了两条路径并发触发时的竞态。
   *
   * 触发条件：sessionId 变化且当前无消息。
   * sharedSessionRestore 内部有 restoringSessionId 锁，即使 use-chat-socket 的
   * status effect 也同时触发，也不会重复拉取。
   */
  const loadHistory = useCallback(async () => {
    if (!sessionId || loadedSessionRef.current === sessionId) return;
    if (useChatStore.getState().messages.length > 0) {
      loadedSessionRef.current = sessionId;
      return;
    }
    setHistoryError(null);
    setLoadingHistory(true);
    try {
      const msgs = await useChatStore.getState().sharedSessionRestore(sessionId);
      loadedSessionRef.current = sessionId;
      // sharedSessionRestore 在 sessionId 已切换时返回旧消息，忽略
      if (useChatStore.getState().sessionId !== sessionId) return;
      // 没有消息也是正常情况（新对话）
      if (!msgs?.length) return;
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : t("chat.unknownError"));
    } finally {
      setLoadingHistory(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    if (!sessionId || messagesLength > 0) return;
    loadHistory();
  }, [sessionId, messagesLength, loadHistory]);

  // If no session after mount, restore the most recent conversation
  // 跳过条件：用户刚删除对话（skipAutoRestore=true）时不要自动拉回
  useEffect(() => {
    if (sessionId || messagesLength > 0) return;
    if (useChatStore.getState().skipAutoRestore) return;
    apiGet<Array<{ sessionId: string }>>("/api/conversations?limit=1")
      .then((list) => {
        if (list?.length && !useChatStore.getState().sessionId) {
          useChatStore.getState().setSessionId(list[0].sessionId);
        }
      })
      .catch((err) => {
        if (import.meta.env.DEV) console.warn("[chat] auto-restore failed:", err);
      });
  }, [sessionId, messagesLength]);

  const handleRetry = useCallback((errorMsgId: string) => {
    const msgs = useChatStore.getState().messages;
    const errorIdx = msgs.findIndex((m) => m.id === errorMsgId);
    if (errorIdx < 0) return;
    const userMsg = msgs[errorIdx - 1];
    // 先移除错误助手消息和原始失败的用户消息，避免重发后出现重复
    if (userMsg?.role === "user") {
      removeMessage(userMsg.id);
    }
    removeMessage(errorMsgId);
    resendMessage(userMsg?.content ?? "");
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
    // 每次拖放创建新的 AbortController，旧的自动失效
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const newAttachments: Attachment[] = [];
    for (const file of Array.from(files)) {
      // 检查是否已被中止（如组件卸载）
      if (controller.signal.aborted) break;
      try {
        const result = await uploadFile(file, controller.signal);
        newAttachments.push({
          fileId: result.fileId,
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
          url: result.url,
        });
      } catch (err) {
        // 中止导致的中断不算错误，不提示
        if (controller.signal.aborted) break;
        const msg = err instanceof Error ? err.message : t("chat.fileUploadFailed");
        toast.error(msg);
      }
    }
    if (newAttachments.length > 0) {
      setDroppedAttachments((prev) => [...prev, ...newAttachments]);
    }
  }, [t]);

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
            <Button variant="ghost" size="icon" aria-label={t("chat.toggleSidebar")} className="md:hidden shrink-0" onClick={onToggleSidebar}>
              <PanelLeft className="size-4" />
            </Button>
          )}
          <h3 className="text-sm font-medium text-foreground truncate">
            {sessionId ? `${t("chat.session")}: ${sessionId.slice(0, 12)}...` : t("chat.newConversation")}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <PermissionModeSelector />
          <ModelSelector />
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
        disabled={!canSend}
      />
    </div>
  );
}
