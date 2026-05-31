"use client";

import { useCallback, useEffect, useRef } from "react";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";
import { useWsStore } from "@/lib/stores/ws-store";
import type { ServerMessage } from "@/lib/types/ws-messages";

const STREAMING_TIMEOUT_MS = 30_000;
const STREAMING_TIMEOUT_MSG = "Response timed out (30s) — backend may not have LLM configured. Check config.yaml and backend logs.";
const STREAMING_TIMEOUT_RETRY_MSG = "Response timed out (30s)";

function toDelegationRequest(msg: Extract<ServerMessage, { type: "delegation.needed" }>): DelegationRequest {
  return {
    delegationId: msg.delegationId,
    sessionId: msg.sessionId,
    requestedBy: msg.requestedBy,
    title: msg.title,
    description: msg.description,
    urgency: msg.urgency,
    options: msg.options,
  };
}

function toPermissionRequest(msg: Extract<ServerMessage, { type: "permission.confirm_needed" }>): PermissionConfirmRequest {
  return {
    requestId: msg.requestId,
    sessionId: msg.sessionId,
    agentName: msg.agentName,
    toolName: msg.toolName,
    toolInput: msg.toolInput,
    dangerLevel: msg.dangerLevel,
    brainReason: msg.brainReason,
  };
}

export function useChatSocket() {
  const {
    sessionId, addMessage, appendToLast, setLastStatus, setLastProgress, setLastError, setStreaming,
    setPendingDelegation, setPendingPermission,
  } = useChatStore();
  const { connect, disconnect, send, onMessage, status } = useWsStore();

  // Auto-connect on mount, disconnect on unmount
  useEffect(() => {
    connect(sessionId ?? undefined);
    return () => { disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Streaming timeout — if no response within 30s, reset streaming state
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const unsub = onMessage((raw) => {
      const msg = raw as unknown as ServerMessage;
      switch (msg.type) {
        case "text_delta": {
          appendToLast(msg.text);
          break;
        }
        case "progress": {
          if (msg.summary) setLastProgress(msg.summary);
          break;
        }
        case "result": {
          setLastStatus("complete");
          setStreaming(false);
          if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
          break;
        }
        case "error": {
          const errMsg = msg.error ?? msg.message ?? "Unknown error";
          setLastError(errMsg);
          if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
          break;
        }
        case "cancelled":
        case "interrupted": {
          setLastStatus("complete");
          setStreaming(false);
          if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
          break;
        }
        case "delegation.needed": {
          setPendingDelegation(toDelegationRequest(msg));
          break;
        }
        case "permission.confirm_needed": {
          setPendingPermission(toPermissionRequest(msg));
          break;
        }
      }
    });
    return unsub;
  }, [onMessage, appendToLast, setLastStatus, setLastProgress, setStreaming, setPendingDelegation, setPendingPermission]);

  const sendMessage = useCallback(
    async (text: string, attachments?: Array<{ fileId: string; filename: string; mimeType: string; url: string }>) => {
      // Quick check: is a model configured? If not, fail fast instead of waiting 30s
      try {
        const res = await fetch("/api/providers/channels");
        if (res.ok) {
          const data = await res.json();
          const hasConfigured = data.channels?.some((ch: { configured?: boolean; modelCount?: number }) => ch.configured || (ch.modelCount ?? 0) > 0);
          if (!hasConfigured) {
            addMessage({
              id: `err-${crypto.randomUUID().slice(0, 8)}`,
              role: "assistant",
              content: "模型尚未配置。请先在设置页面添加 API 密钥和模型配置。",
              timestamp: Date.now(),
              status: "error",
            });
            return;
          }
        }
      } catch {
        // If check fails, proceed anyway — the timeout will catch it
      }

      // Optimistic UI: add messages first
      const userId = `user-${crypto.randomUUID().slice(0, 8)}`;
      const asstId = `asst-${crypto.randomUUID().slice(0, 8)}`;

      addMessage({
        id: userId,
        role: "user",
        content: text,
        timestamp: Date.now(),
        status: "complete",
        attachments,
      });

      addMessage({
        id: asstId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        status: "streaming",
      });

      setStreaming(true);

      // Safety timeout: reset streaming if no response within 30s
      if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
      streamingTimerRef.current = setTimeout(() => {
        setLastError(STREAMING_TIMEOUT_MSG);
      }, STREAMING_TIMEOUT_MS);

      try {
        send({ type: "message", text, sessionId, attachments });
      } catch {
        setLastError("Failed to send message");
        if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
      }
    },
    [sessionId, addMessage, setStreaming, send, setLastError]
  );

  const cancelGeneration = useCallback(() => {
    send({ type: "interrupt" });
    setLastStatus("complete");
    setStreaming(false);
    if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
  }, [send, setLastStatus, setStreaming]);

  const resendMessage = useCallback(
    (text: string) => {
      addMessage({
        id: `asst-${crypto.randomUUID().slice(0, 8)}`,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        status: "streaming",
      });

      setStreaming(true);

      if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
      streamingTimerRef.current = setTimeout(() => {
        setLastError(STREAMING_TIMEOUT_RETRY_MSG);
      }, STREAMING_TIMEOUT_MS);

      try {
        send({ type: "message", text, sessionId });
      } catch {
        setLastError("Failed to send message");
        if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
      }
    },
    [sessionId, addMessage, setStreaming, send, setLastError]
  );

  const respondDelegation = useCallback(
    (delegationId: string, response: string | null, approved: boolean) => {
      send({ type: "delegation.respond", delegationId, response, status: approved ? "approved" : "denied" });
      setPendingDelegation(null);
    },
    [send, setPendingDelegation]
  );

  const respondPermission = useCallback(
    (requestId: string, approved: boolean) => {
      send({ type: approved ? "permissions.approve" : "permissions.deny", requestId });
      setPendingPermission(null);
    },
    [send, setPendingPermission]
  );

  return { sendMessage, cancelGeneration, resendMessage, respondDelegation, respondPermission, connectionStatus: status };
}
