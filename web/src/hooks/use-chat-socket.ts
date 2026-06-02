
import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useChatStore, genMsgId,
  appendToLast, setLastStatus, setLastProgress, setLastError, appendReasoning, appendToolCall,
  type DelegationRequest, type PermissionConfirmRequest,
} from "@/lib/stores/chat-store";
import { useWsStore } from "@/lib/stores/ws-store";
import type { ServerMessage } from "@/lib/types/ws-messages";

const STREAMING_TIMEOUT_MS = 90_000;
const STREAMING_TIMEOUT_MSG = "Response timed out — backend may be unresponsive. Check backend logs.";

// --- Helpers ---

function toDelegationRequest(msg: Extract<ServerMessage, { type: "delegation.needed" }>): DelegationRequest {
  return {
    delegationId: msg.delegationId, sessionId: msg.sessionId,
    requestedBy: msg.requestedBy, title: msg.title,
    description: msg.description, urgency: msg.urgency, options: msg.options,
  };
}

function toPermissionRequest(msg: Extract<ServerMessage, { type: "permission.confirm_needed" }>): PermissionConfirmRequest {
  return {
    requestId: msg.requestId, sessionId: msg.sessionId,
    agentName: msg.agentName, toolName: msg.toolName,
    toolInput: msg.toolInput, dangerLevel: msg.dangerLevel, brainReason: msg.brainReason,
  };
}

// --- Hook ---

export function useChatSocket() {
  const { sessionId, addMessage, setStreaming, setPendingDelegation, setPendingPermission } = useChatStore();
  const { connect, disconnect, send, onMessage, status } = useWsStore();
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveredRef = useRef(false);

  // --- Timer management (single source of truth) ---
  const resetTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setLastError(STREAMING_TIMEOUT_MSG), STREAMING_TIMEOUT_MS);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  // --- Connection lifecycle ---
  useEffect(() => {
    connect(sessionId ?? undefined);
    return () => { disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { clearTimer(); }, [clearTimer]);

  // --- Session recovery on connect ---
  useEffect(() => {
    if (status !== "connected") return;
    const sid = useChatStore.getState().sessionId;
    if (!sid || recoveredRef.current) return;
    recoveredRef.current = true;

    fetch(`/api/sessions/${sid}/state`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data || useChatStore.getState().sessionId !== sid) return;
        const activeTask = data.activeTasks?.[0];
        const messages = (data.messages ?? []).map((m: { role: string; content: string; createdAt: string; reasoning?: string; thinkingSteps?: Array<{ text: string; ts: number }> }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: new Date(m.createdAt).getTime(),
          reasoning: m.reasoning,
          thinkingSteps: m.thinkingSteps,
        }));
        useChatStore.getState().restoreSession(
          messages,
          activeTask ? { progress: activeTask.progress, thinkingSteps: activeTask.thinkingSteps } : undefined,
        );
        if (activeTask) resetTimer();
      })
      .catch(() => {});
  }, [status, resetTimer]);

  // --- Message dispatch ---
  useEffect(() => {
    const unsub = onMessage((raw) => {
      const data = raw as Record<string, unknown>;

      if (data.type === "event") {
        const event = data.event as string;
        if ((event === "task.failed" || event === "task.timeout") && useChatStore.getState().isStreaming) {
          const payload = data.payload as { error?: string } | undefined;
          setLastError(payload?.error ?? "Task failed");
          clearTimer();
        }
        if ((event === "task.progress" || event === "daemon.task.progress") && useChatStore.getState().isStreaming) {
          const payload = data.payload as { message?: string; from?: string } | undefined;
          if (payload?.message) {
            setLastProgress(payload.message);
            resetTimer();
          }
        }
        return;
      }

      const msg = data as unknown as ServerMessage;
      switch (msg.type) {
        case "text_delta":
          appendToLast(msg.text);
          resetTimer();
          break;
        case "reasoning_delta": {
          const rd = msg as Extract<ServerMessage, { type: "reasoning_delta" }>;
          appendReasoning(rd.text);
          resetTimer();
          break;
        }
        case "progress":
          if (msg.summary) setLastProgress(msg.summary);
          resetTimer();
          break;
        case "tool_call": {
          const tc = msg as Extract<ServerMessage, { type: "tool_call" }>;
          appendToolCall({
            toolName: tc.toolName,
            input: tc.input,
            result: tc.result,
            isError: tc.isError,
            durationMs: tc.durationMs,
            ts: Date.now(),
          });
          resetTimer();
          break;
        }
        case "result": {
          const resultMsg = msg as Extract<ServerMessage, { type: "result" }>;
          const response = resultMsg.content;
          const current = useChatStore.getState().messages;
          const lastMsg = current[current.length - 1];
          if (response && lastMsg && !lastMsg.content.trim()) {
            appendToLast(response);
          }
          setLastStatus("complete");
          setStreaming(false);
          clearTimer();
          break;
        }
        case "error":
          setLastError(msg.error ?? msg.message ?? "Unknown error");
          clearTimer();
          break;
        case "cancelled":
        case "interrupted":
          setLastStatus("complete");
          setStreaming(false);
          clearTimer();
          break;
        case "delegation.needed":
          setPendingDelegation(toDelegationRequest(msg));
          break;
        case "permission.confirm_needed":
          setPendingPermission(toPermissionRequest(msg));
          break;
      }
    });
    return unsub;
  }, [onMessage, setStreaming, setPendingDelegation, setPendingPermission, resetTimer, clearTimer]);

  // --- Send (unified for new + resend) ---
  const sendInternal = useCallback((text: string, attachments?: unknown[]) => {
    addMessage({ id: genMsgId("asst"), role: "assistant", content: "", timestamp: Date.now(), status: "streaming" });
    setStreaming(true);
    resetTimer();
    try {
      send({ type: "message", text, sessionId, attachments, permissionMode: useChatStore.getState().permissionMode });
    } catch {
      setLastError("Failed to send message");
      clearTimer();
    }
  }, [sessionId, addMessage, setStreaming, send, resetTimer, clearTimer]);

  const sendMessage = useCallback(
    async (text: string, attachments?: Array<{ fileId: string; filename: string; mimeType: string; url: string }>) => {
      addMessage({ id: genMsgId("user"), role: "user", content: text, timestamp: Date.now(), status: "complete", attachments });

      // Quick model check — use cached React Query data instead of fetching every time
      const cached = queryClient.getQueryData<{ channels?: Array<{ configured?: boolean; modelCount?: number }> }>(["providers", "channels"]);
      if (cached?.channels && !cached.channels.some((ch) => ch.configured || (ch.modelCount ?? 0) > 0)) {
        setLastError("模型尚未配置。请先在设置页面添加 API 密钥和模型配置。");
        return;
      }

      sendInternal(text, attachments);
    },
    [addMessage, sendInternal],
  );

  const resendMessage = useCallback((text: string) => { sendInternal(text); }, [sendInternal]);

  const cancelGeneration = useCallback(() => {
    send({ type: "interrupt" });
    setLastStatus("complete");
    setStreaming(false);
    clearTimer();
  }, [send, setStreaming, clearTimer]);

  const respondDelegation = useCallback(
    (delegationId: string, response: string | null, approved: boolean) => {
      send({ type: "delegation.respond", delegationId, response, status: approved ? "approved" : "denied" });
      setPendingDelegation(null);
    },
    [send, setPendingDelegation],
  );

  const respondPermission = useCallback(
    (requestId: string, approved: boolean) => {
      send({ type: approved ? "permissions.approve" : "permissions.deny", requestId });
      setPendingPermission(null);
    },
    [send, setPendingPermission],
  );

  return { sendMessage, cancelGeneration, resendMessage, respondDelegation, respondPermission, connectionStatus: status };
}
