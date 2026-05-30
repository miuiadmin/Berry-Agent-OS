"use client";

import { MessageCircle, User, Bot } from "lucide-react";
import type { SearchResult } from "@/lib/api";
import { cn } from "@/lib/utils";

interface SearchResultsProps {
  results: SearchResult[];
  onSelect: (result: SearchResult) => void;
  className?: string;
}

export function SearchResults({ results, onSelect, className }: SearchResultsProps) {
  if (results.length === 0) return null;

  return (
    <div className={cn("space-y-1", className)}>
      {results.map((result, i) => (
        <button
          key={i}
          onClick={() => onSelect(result)}
          className="w-full flex items-start gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent transition-colors"
        >
          <div className="shrink-0 mt-0.5">
            {result.role === "user" ? (
              <User className="size-3.5 text-muted-foreground" />
            ) : (
              <Bot className="size-3.5 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-foreground line-clamp-2">{result.highlight}</p>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <MessageCircle className="size-3" />
              <span>{result.sessionId.slice(0, 12)}</span>
              <span>{new Date(result.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
