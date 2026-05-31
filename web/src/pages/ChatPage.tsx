
import { useMemo, useState } from "react";
import { ChatWindow } from "@/components/chat/chat-window";
import { ConversationSidebar } from "@/components/chat/conversation-sidebar";
import { useChatStore } from "@/lib/stores/chat-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { cn } from "@/lib/utils";

export default function ChatPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSessionId = useChatStore((s) => s.setSessionId);

  useDocumentTitle("Chat");

  const shortcuts = useMemo(() => [
    { key: "n", meta: true, handler: () => { clearMessages(); setSessionId(null); } },
    { key: "Escape", handler: () => setSidebarOpen(false) },
  ], [clearMessages, setSessionId]);
  useKeyboardShortcuts(shortcuts);

  return (
    <div className="relative flex h-full overflow-hidden">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 animate-overlay-in md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div className={cn(
        "fixed inset-y-0 left-0 z-40 w-72 transform transition-transform duration-200 md:relative md:w-64 md:translate-x-0 md:shrink-0",
        sidebarOpen ? "translate-x-0 animate-sidebar-in" : "-translate-x-full"
      )}>
        <ConversationSidebar onSelect={() => setSidebarOpen(false)} />
      </div>
      <div className="flex-1 min-w-0 h-full">
        <ChatWindow onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      </div>
    </div>
  );
}
