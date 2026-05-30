import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api';
import { useSessions } from '../../hooks/use-sessions';
import { useChat } from '../../hooks/use-chat';
import { MessageList } from '../../components/chat/MessageList';
import { ChatInput } from '../../components/chat/ChatInput';
import type { Agent, Session, SessionMessage } from '../../lib/types';

const USER_ID = 'default-user';

export function ChatPage() {
  const { data: globalAgent } = useQuery({
    queryKey: ['global-agent'],
    queryFn: () => apiFetch<Agent>(`/agents/global/${USER_ID}`).catch(() => null),
  });

  const agentId = globalAgent?.id ?? null;
  const { data: sessions } = useSessions(agentId);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const { messages, isStreaming, progress, sendMessage, setMessages } = useChat({
    agentId: agentId || '',
    sessionId: activeSessionId,
    onSessionCreated: (sid) => setActiveSessionId(sid),
  });

  useEffect(() => {
    if (activeSessionId) {
      apiFetch<SessionMessage[]>(`/sessions/${activeSessionId}/messages`).then((msgs) => {
        setMessages(
          msgs.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })).filter((m) => m.role === 'user' || m.role === 'assistant'),
        );
      });
    } else {
      setMessages([]);
    }
  }, [activeSessionId]);

  const handleNewChat = () => {
    setActiveSessionId(null);
    setMessages([]);
  };

  return (
    <div className="flex h-full">
      <aside className="w-56 border-r flex flex-col">
        <div className="p-3 border-b">
          <button
            onClick={handleNewChat}
            className="w-full px-3 py-1.5 rounded-md border text-sm hover:bg-accent transition-colors"
          >
            + 新对话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sessions?.map((session: Session) => (
            <button
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              className={`w-full text-left px-3 py-2 rounded-md text-sm truncate transition-colors ${
                activeSessionId === session.id
                  ? 'bg-accent font-medium'
                  : 'hover:bg-accent/50 text-muted-foreground'
              }`}
            >
              {session.title || '新对话'}
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 flex flex-col">
        <header className="h-12 flex items-center justify-between px-6 border-b">
          <span className="font-medium">全局助手</span>
          {progress && (
            <span className="text-xs text-muted-foreground animate-pulse">{progress}</span>
          )}
        </header>

        <MessageList messages={messages} isStreaming={isStreaming} />

        <ChatInput
          onSend={sendMessage}
          disabled={isStreaming || !agentId}
          placeholder={agentId ? '输入消息...' : '正在加载助手...'}
        />
      </div>
    </div>
  );
}
