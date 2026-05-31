"use client";

import { useCallback, useEffect, useRef } from "react";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";
import { useWsStore } from "@/lib/stores/ws-store";

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
    const unsub = onMessage((data) => {
      const type = data.type as string;
      switch (type) {
        case "text_delta": {
          appendToLast(data.text as string);
          break;
        }
        case "progress": {
          const summary = (data as Record<string, unknown>).summary as string | undefined;
          if (summary) setLastProgress(summary);
          break;
        }
        case "result": {
          setLastStatus("complete");
          setStreaming(false);
          if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
          break;
        }
        case "error": {
          const errMsg = (data as Record<string, unknown>).error as string || (data as Record<string, unknown>).message as string || "Unknown error";
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
          setPendingDelegation(data as unknown as DelegationRequest);
          break;
        }
        case "permission.confirm_needed": {
          setPendingPermission(data as unknown as PermissionConfirmRequest);
          break;
        }
      }
    });
    return unsub;
  }, [onMessage, appendToLast, setLastStatus, setLastProgress, setStreaming, setPendingDelegation, setPendingPermission]);

  const sendMessage = useCallback(
    (text: string, attachments?: Array<{ fileId: string; filename: string; mimeType: string; url: string }>) => {
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
        setLastError("Response timed out (30s) — backend may not have LLM configured. Check config.yaml and backend logs.");
      }, 30000);

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
        setLastError("Response timed out (30s)");
      }, 30000);

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
