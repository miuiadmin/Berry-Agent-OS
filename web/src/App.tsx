import { Routes, Route, Navigate } from "react-router-dom";
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
const LogsPage = lazy(() => import("./pages/LogsPage"));

export default function App() {
  // Subscribe to WS events for automatic query invalidation
  useRealtimeEvents();

  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center"><div className="size-6 rounded-full border-2 border-muted-foreground/30 border-t-brand animate-spin" /></div>}>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
