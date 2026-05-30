import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { MessageCircle, Users, ListTodo, Settings } from 'lucide-react';

const navItems = [
  { to: '/chat', label: '对话', icon: MessageCircle },
  { to: '/workspaces', label: '团队', icon: Users },
  { to: '/tasks', label: '任务', icon: ListTodo },
  { to: '/settings', label: '设置', icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen">
      <aside className="w-56 flex-shrink-0 border-r border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-background))] flex flex-col">
        <div className="h-12 flex items-center px-4 font-semibold text-lg border-b border-[hsl(var(--sidebar-border))] drag-region">
          Berry
        </div>
        <nav className="flex-1 py-2 px-2 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-[hsl(var(--sidebar-accent))] text-[hsl(var(--sidebar-accent-foreground))] font-medium'
                    : 'text-[hsl(var(--sidebar-foreground))] hover:bg-[hsl(var(--sidebar-accent))]'
                }`
              }
            >
              <item.icon className="h-4 w-4" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
