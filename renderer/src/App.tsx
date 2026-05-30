import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { ChatPage } from './pages/chat';
import { WorkspacesPage } from './pages/workspaces';
import { WorkspaceDetailPage } from './pages/workspaces/detail';
import { AgentChatPage } from './pages/workspaces/detail/chat';
import { TasksPage } from './pages/tasks';
import { SettingsPage } from './pages/settings';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/workspaces" element={<WorkspacesPage />} />
        <Route path="/workspaces/:id" element={<WorkspaceDetailPage />} />
        <Route path="/workspaces/:id/chat/:agentId" element={<AgentChatPage />} />
        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </AppShell>
  );
}
