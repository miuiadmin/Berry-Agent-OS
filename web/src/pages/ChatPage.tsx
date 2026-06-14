/**
 * 聊天页面 — 侧边栏 + 主窗口布局。
 *
 * 移动端：侧边栏为 overlay 抽屉（点击对话后自动关闭）。
 * 桌面端：侧边栏常驻左侧。
 * 快捷键：Cmd+N 新建对话，Escape 关闭侧边栏。
 */

import { useMemo, useState } from "react";
import { ChatWindow } from "@/components/chat/chat-window";
import { ConversationSidebar } from "@/components/chat/conversation-sidebar";
import { useChatStore } from "@/lib/stores/chat-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export default function ChatPage() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const setSessionId = useChatStore((s) => s.setSessionId);
  const t = useT();

  useDocumentTitle(t("chat.title"));

  // 快捷键：
  //   - Cmd/Ctrl+N：新建对话。焦点在输入框/文本域时不拦截（避免与输入法/扩展冲突）。
  //   - Escape：仅在侧边栏打开时关闭侧边栏；关闭态下不注册该快捷键，避免与
  //     ConfirmDialog / 模态框 / 输入框等组件自身的 Esc 行为冲突（useKeyboardShortcuts
  //     会对匹配的快捷键调用 preventDefault，所以用条件渲染控制注册）。
  const shortcuts = useMemo(() => {
    const list: Array<{ key: string; meta?: boolean; handler: () => void }> = [
      {
        key: "n",
        meta: true,
        handler: () => {
          // 焦点在可编辑控件时不处理（让原生行为/输入法生效）
          const el = document.activeElement;
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) {
            return;
          }
          clearMessages();
          setSessionId(null);
        },
      },
    ];
    // 仅侧边栏打开时才注册 Escape，关闭态下不拦截，让其他组件（模态框/确认框）正常响应 Esc
    if (sidebarOpen) {
      list.push({ key: "Escape", handler: () => setSidebarOpen(false) });
    }
    return list;
  }, [clearMessages, setSessionId, sidebarOpen]);
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
        "fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] transform transition-transform duration-200 md:relative md:w-64 md:max-w-none md:translate-x-0 md:shrink-0",
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
