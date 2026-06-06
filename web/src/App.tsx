import { Routes, Route, Navigate } from "react-router-dom";
import { DashboardLayout } from "./components/layout/dashboard-layout";
import { useRealtimeEvents } from "./hooks/use-realtime-events";
import { ErrorBoundary } from "./components/error-boundary";

// Lazy-load pages
import { lazy, Suspense } from "react";
const HomePage = lazy(() => import("./pages/HomePage"));
const ChatPage = lazy(() => import("./pages/ChatPage"));
const AgentsPage = lazy(() => import("./pages/AgentsPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const MemoryPage = lazy(() => import("./pages/MemoryPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const SchedulerPage = lazy(() => import("./pages/SchedulerPage"));
const ConversationsPage = lazy(() => import("./pages/ConversationsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const UsagePage = lazy(() => import("./pages/UsagePage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const DriftPage = lazy(() => import("./pages/DriftPage"));

/** 全局 Suspense 加载指示器 */
function LoadingSpinner() {
  return <div className="flex h-screen items-center justify-center"><div className="size-6 rounded-full border-2 border-muted-foreground/30 border-t-brand animate-spin" /></div>;
}

export default function App() {
  // Subscribe to WS events for automatic query invalidation
  useRealtimeEvents();

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<ErrorBoundary><HomePage /></ErrorBoundary>} />
            <Route path="/chat" element={<ErrorBoundary><ChatPage /></ErrorBoundary>} />
            <Route path="/agents" element={<ErrorBoundary><AgentsPage /></ErrorBoundary>} />
            <Route path="/tasks" element={<ErrorBoundary><TasksPage /></ErrorBoundary>} />
            <Route path="/memory" element={<ErrorBoundary><MemoryPage /></ErrorBoundary>} />
            <Route path="/notifications" element={<ErrorBoundary><NotificationsPage /></ErrorBoundary>} />
            <Route path="/scheduler" element={<ErrorBoundary><SchedulerPage /></ErrorBoundary>} />
            <Route path="/conversations" element={<ErrorBoundary><ConversationsPage /></ErrorBoundary>} />
            <Route path="/settings" element={<ErrorBoundary><SettingsPage /></ErrorBoundary>} />
            <Route path="/usage" element={<ErrorBoundary><UsagePage /></ErrorBoundary>} />
            <Route path="/drift" element={<ErrorBoundary><DriftPage /></ErrorBoundary>} />
            <Route path="/logs" element={<ErrorBoundary><LogsPage /></ErrorBoundary>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
