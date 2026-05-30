import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../../lib/api';
import { useChat } from '../../../hooks/use-chat';
import { MessageList } from '../../../components/chat/MessageList';
import { ChatInput } from '../../../components/chat/ChatInput';
import type { Agent } from '../../../lib/types';

export function AgentChatPage() {
  const { id: workspaceId, agentId } = useParams<{ id: string; agentId: string }>();
  const navigate = useNavigate();
  const [sessionId, setSessionId] = useState<string | null>(null);

  const { data: agent } = useQuery({
    queryKey: ['agent', agentId],
    queryFn: () => apiFetch<Agent>(`/agents/${agentId}`),
    enabled: !!agentId,
  });

  const { messages, isStreaming, progress, sendMessage } = useChat({
    agentId: agentId || '',
    sessionId,
    onSessionCreated: (sid) => setSessionId(sid),
  });

  return (
    <div className="flex flex-col h-full">
      <header className="h-12 flex items-center gap-3 px-6 border-b">
        <button
          onClick={() => navigate(`/workspaces/${workspaceId}`)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          ←
        </button>
        <span className="font-medium">{agent?.name || 'Agent'}</span>
        {progress && (
          <span className="text-xs text-muted-foreground animate-pulse ml-auto">{progress}</span>
        )}
      </header>

      <MessageList messages={messages} isStreaming={isStreaming} />

      <ChatInput
        onSend={sendMessage}
        disabled={isStreaming || !agentId}
        placeholder={`向 ${agent?.name || 'Agent'} 发送消息...`}
      />
    </div>
  );
}
