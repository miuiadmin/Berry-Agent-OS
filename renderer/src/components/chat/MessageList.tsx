import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../lib/types';
import { ReviewBadge } from './ReviewBadge';
import { MarkdownContent } from './MarkdownContent';

interface Props {
  messages: ChatMessage[];
  isStreaming: boolean;
}

export function MessageList({ messages, isStreaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!messages.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <div className="text-3xl">💬</div>
          <p>发送消息开始对话</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[75%] rounded-lg px-4 py-2.5 text-sm ${
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground whitespace-pre-wrap'
                : 'bg-muted'
            }`}
          >
            {msg.role === 'assistant' ? (
              <MarkdownContent content={msg.content} />
            ) : (
              msg.content
            )}
            {msg.isStreaming && (
              <span className="inline-block w-1.5 h-4 ml-0.5 bg-current animate-pulse" />
            )}
            {msg.role === 'assistant' && msg.reviewStatus && (
              <ReviewBadge status={msg.reviewStatus} note={msg.reviewNote} />
            )}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
