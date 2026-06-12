
import { useMemo, useState } from "react";
import { ChatWindow } from "@/components/chat/chat-window";
import { ConversationSidebar } from "@/components/chat/conversation-sidebar";
import { useChatStore } from "@/lib/stores/chat-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { Drawer } from "@/components/ui/drawer";
import { useT } from "@/lib/i18n";

export default function ChatPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const t = useT();

  useDocumentTitle(t("chat.title"));

  const shortcuts = useMemo(() => [
    { key: "n", meta: true, handler: () => { clearMessages(); setSessionId(null); } },
    { key: "Escape", handler: () => setSidebarOpen(false) },
  ], [clearMessages, setSessionId]);
  useKeyboardShortcuts(shortcuts);

  return (
    <div className="relative flex h-full overflow-hidden">
      {/* 移动端：Drawer adapter 自动处理遮罩、滑入/滑出动画、ESC 关闭、聚焦陷阱 */}
      <Drawer open={sidebarOpen} onOpenChange={setSidebarOpen} placement="left">
        <ConversationSidebar onSelect={() => setSidebarOpen(false)} />
      </Drawer>
      {/* 桌面端：侧边栏始终可见 */}
      <div className="hidden md:block md:w-64 md:shrink-0">
        <ConversationSidebar onSelect={() => setSidebarOpen(false)} />
      </div>
      <div className="flex-1 min-w-0 h-full">
        <ChatWindow onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      </div>
    </div>
  );
}
