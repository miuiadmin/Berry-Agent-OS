"use client";

import { useCallback, useEffect } from "react";
import { useChatStore } from "@/lib/stores/chat-store";
import { useWsStore } from "@/lib/stores/ws-store";

export function useChatSocket() {
  const { sessionId, addMessage, appendToLast, setLastStatus, setLastProgress, setStreaming } = useChatStore();
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
      }
    });
    return unsub;
  }, [onMessage, appendToLast, setLastStatus, setLastProgress, setStreaming]);

  const sendMessage = useCallback(
    (text: string) => {
      if (status !== "connected") {
        connect(sessionId ?? undefined);
      }

      addMessage({
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: Date.now(),
        status: "complete",
      });

      addMessage({
        id: `asst-${Date.now()}`,
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

  const cancelGeneration = useCallback(() => {
    send({ type: "interrupt" });
    setLastStatus("complete");
    setStreaming(false);
  }, [send, setLastStatus, setStreaming]);

  const resendMessage = useCallback(
    (text: string) => {
      if (status !== "connected") {
        connect(sessionId ?? undefined);
      }

      addMessage({
        id: `asst-${Date.now()}`,
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

  return { sendMessage, cancelGeneration, resendMessage, connectionStatus: status };
}
