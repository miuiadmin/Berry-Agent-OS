import { Routes, Route } from "react-router-dom";
import { DashboardLayout } from "./components/layout/dashboard-layout";
import { useRealtimeEvents } from "./hooks/use-realtime-events";

// Lazy-load pages
import { lazy, Suspense } from "react";
const HomePage = lazy(() => import("./pages/HomePage"));
const ChatPage = lazy(() => import("./pages/ChatPage"));
const AgentsPage = lazy(() => import("./pages/AgentsPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const ConversationsPage = lazy(() => import("./pages/ConversationsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const UsagePage = lazy(() => import("./pages/UsagePage"));

export default function App() {
  // Subscribe to WS events for automatic query invalidation
  useRealtimeEvents();

  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center text-muted-foreground">加载中...</div>}>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/usage" element={<UsagePage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
