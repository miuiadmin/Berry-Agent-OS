import { useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '../lib/types';

const API_BASE = 'http://localhost:3721/api';

interface UseChatOptions {
  agentId: string;
  sessionId?: string | null;
  onSessionCreated?: (sessionId: string) => void;
}

interface UseChatReturn {
  messages: ChatMessage[];
  isStreaming: boolean;
  progress: string | null;
  sendMessage: (text: string) => void;
  setMessages: (msgs: ChatMessage[]) => void;
}

export function useChat({ agentId, sessionId, onSessionCreated }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const qc = useQueryClient();

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);
    setProgress(null);

    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      isStreaming: true,
    };
    setMessages((prev) => [...prev, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_BASE}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, sessionId, message: text }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error('Stream failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
            continue;
          }
          if (!line.startsWith('data: ')) continue;

          const raw = line.slice(6);
          if (!raw) continue;

          try {
            const data = JSON.parse(raw);

            if (currentEvent === 'session' || 'sessionId' in data) {
              if (!sessionId && data.sessionId) {
                onSessionCreated?.(data.sessionId as string);
              }
            }
            if (currentEvent === 'progress' || ('status' in data && 'summary' in data)) {
              setProgress(data.summary as string);
            }
            if (currentEvent === 'text_delta' || ('text' in data && !('response' in data))) {
              fullText += data.text as string;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: fullText };
                }
                return updated;
              });
            }
            if (currentEvent === 'result' || 'response' in data) {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: data.response as string, isStreaming: false };
                }
                return updated;
              });
            }
          } catch {
            // skip malformed data
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: '发生错误，请重试。', isStreaming: false };
          }
          return updated;
        });
      }
    } finally {
      setIsStreaming(false);
      setProgress(null);
      abortRef.current = null;
      qc.invalidateQueries({ queryKey: ['sessions'] });
    }
  }, [agentId, sessionId, isStreaming, onSessionCreated, qc]);

  return { messages, isStreaming, progress, sendMessage, setMessages };
}
