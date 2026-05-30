"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { queries, type SearchResult } from "@/lib/api";
import { useChatStore } from "@/lib/stores/chat-store";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  MessageCircle,
  Bot,
  ListTodo,
  MessagesSquare,
  BarChart3,
  Settings,
  Search,
  Moon,
  Sun,
  Plus,
  Keyboard,
} from "lucide-react";

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  action: () => void;
  section: string;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSessionId = useChatStore((s) => s.setSessionId);

  const { data: searchResults } = useQuery({
    ...queries.search(query, 5),
    enabled: open && query.trim().length >= 2,
  });

  const { data: conversations } = useQuery({
    ...queries.conversations({ limit: 5 }),
    enabled: open,
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const navigate = useCallback((href: string) => {
    setOpen(false);
    router.push(href);
  }, [router]);

  const navItems: CommandItem[] = useMemo(() => [
    { id: "nav-home", label: "Home", icon: LayoutDashboard, action: () => navigate("/"), section: "Navigation" },
    { id: "nav-chat", label: "Chat", icon: MessageCircle, action: () => navigate("/chat"), section: "Navigation" },
    { id: "nav-agents", label: "Agents", icon: Bot, action: () => navigate("/agents"), section: "Navigation" },
    { id: "nav-tasks", label: "Tasks", icon: ListTodo, action: () => navigate("/tasks"), section: "Navigation" },
    { id: "nav-conversations", label: "Conversations", icon: MessagesSquare, action: () => navigate("/conversations"), section: "Navigation" },
    { id: "nav-usage", label: "Usage", icon: BarChart3, action: () => navigate("/usage"), section: "Navigation" },
    { id: "nav-settings", label: "Settings", icon: Settings, action: () => navigate("/settings"), section: "Navigation" },
  ], [navigate]);

  const actionItems: CommandItem[] = useMemo(() => [
    {
      id: "action-new-chat", label: "New Conversation", icon: Plus, section: "Actions",
      action: () => { clearMessages(); setSessionId(null); navigate("/chat"); },
    },
    {
      id: "action-theme", label: `Switch to ${theme === "dark" ? "light" : "dark"} mode`, icon: theme === "dark" ? Sun : Moon, section: "Actions",
      action: () => { setTheme(theme === "dark" ? "light" : "dark"); setOpen(false); },
    },
    {
      id: "action-shortcuts", label: "Keyboard Shortcuts", icon: Keyboard, section: "Actions",
      action: () => { setOpen(false); document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })); },
    },
  ], [theme, setTheme, clearMessages, setSessionId, navigate]);

  const conversationItems: CommandItem[] = useMemo(() => {
    if (!conversations) return [];
    return conversations.slice(0, 5).map((conv) => ({
      id: `conv-${conv.sessionId}`,
      label: conv.title || conv.firstMessage?.slice(0, 50) || conv.sessionId.slice(0, 16),
      description: `${conv.messageCount} messages`,
      icon: MessageCircle,
      section: "Recent Conversations",
      action: () => { clearMessages(); setSessionId(conv.sessionId); navigate("/chat"); },
    }));
  }, [conversations, clearMessages, setSessionId, navigate]);

  const searchItems: CommandItem[] = useMemo(() => {
    if (!searchResults?.results?.length) return [];
    return searchResults.results.map((r, i) => ({
      id: `search-${i}`,
      label: r.highlight,
      description: r.sessionId.slice(0, 12),
      icon: Search,
      section: "Search Results",
      action: () => { clearMessages(); setSessionId(r.sessionId); navigate("/chat"); },
    }));
  }, [searchResults, clearMessages, setSessionId, navigate]);

  const allItems = useMemo(() => {
    const q = query.toLowerCase().trim();
    let items: CommandItem[] = [];

    if (q.length >= 2 && searchItems.length > 0) {
      items = [...searchItems];
    }

    const filteredNav = q ? navItems.filter((i) => i.label.toLowerCase().includes(q)) : navItems;
    const filteredActions = q ? actionItems.filter((i) => i.label.toLowerCase().includes(q)) : actionItems;
    const filteredConvs = q
      ? conversationItems.filter((i) => i.label.toLowerCase().includes(q))
      : conversationItems;

    items = [...items, ...filteredNav, ...filteredConvs, ...filteredActions];
    return items;
  }, [query, navItems, actionItems, conversationItems, searchItems]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [allItems.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && allItems[selectedIdx]) {
      e.preventDefault();
      allItems[selectedIdx].action();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.querySelector(`[data-index="${selectedIdx}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIdx]);

  if (!open) return null;

  let currentSection = "";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl mx-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden sm:inline-flex h-5 items-center rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
            Esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[300px] overflow-y-auto p-2">
          {allItems.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No results found
            </p>
          )}
          {allItems.map((item, i) => {
            const showSection = item.section !== currentSection;
            if (showSection) currentSection = item.section;
            const Icon = item.icon;
            return (
              <div key={item.id}>
                {showSection && (
                  <p className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    {item.section}
                  </p>
                )}
                <button
                  data-index={i}
                  onClick={() => item.action()}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    i === selectedIdx ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/50"
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="flex-1 text-left truncate">
                    <span>{item.label}</span>
                    {item.description && (
                      <span className="ml-2 text-xs text-muted-foreground">{item.description}</span>
                    )}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
        <div className="border-t border-border px-4 py-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Navigate with <kbd className="mx-0.5 rounded border border-border bg-muted px-1">↑</kbd><kbd className="mx-0.5 rounded border border-border bg-muted px-1">↓</kbd></span>
          <span>Select <kbd className="mx-0.5 rounded border border-border bg-muted px-1">↵</kbd></span>
        </div>
      </div>
    </div>
  );
}
