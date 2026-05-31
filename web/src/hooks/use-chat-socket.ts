"use client";

import { useCallback, useEffect } from "react";
import { useChatStore, type DelegationRequest, type PermissionConfirmRequest } from "@/lib/stores/chat-store";
import { useWsStore } from "@/lib/stores/ws-store";

export function useChatSocket() {
  const {
    sessionId, addMessage, appendToLast, setLastStatus, setLastProgress, setStreaming,
    setPendingDelegation, setPendingPermission,
  } = useChatStore();
  const { connect, send, onMessage, status } = useWsStore();

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
          break;
        }
        case "error": {
          setLastStatus("error");
          setStreaming(false);
          break;
        }
        case "cancelled":
        case "interrupted": {
          setLastStatus("complete");
          setStreaming(false);
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
      if (status !== "connected") {
        connect(sessionId ?? undefined);
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
      try {
        send({ type: "message", text, sessionId, attachments });
      } catch {
        // If send fails, mark assistant message as error
        setLastStatus("error");
        setStreaming(false);
      }
    },
    [status, connect, sessionId, addMessage, setStreaming, send, setLastStatus]
  );

  const cancelGeneration = useCallback(() => {
    if (status === "connected") {
      send({ type: "interrupt" });
    }
    setLastStatus("complete");
    setStreaming(false);
  }, [send, status, setLastStatus, setStreaming]);

  const resendMessage = useCallback(
    (text: string) => {
      if (status !== "connected") {
        connect(sessionId ?? undefined);
      }

      addMessage({
        id: `asst-${crypto.randomUUID().slice(0, 8)}`,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        status: "streaming",
      });

      setStreaming(true);
      send({ type: "message", text, sessionId });
    },
    [status, connect, sessionId, addMessage, setStreaming, send]
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
