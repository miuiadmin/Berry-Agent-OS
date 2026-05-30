import { useState } from 'react';
import { useCreateWorkspace } from '../../hooks/use-workspaces';

interface Props {
  open: boolean;
  onClose: () => void;
  userId: string;
}

export function CreateWorkspaceDialog({ open, onClose, userId }: Props) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const createWorkspace = useCreateWorkspace();

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createWorkspace.mutate(
      { ownerId: userId, name, slug: slug || name.toLowerCase().replace(/\s+/g, '-'), description: description || undefined },
      {
        onSuccess: () => {
          setName('');
          setSlug('');
          setDescription('');
          onClose();
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-card border rounded-lg shadow-lg w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold">创建工作空间</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium">名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="我的团队"
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">标识 (slug)</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-team"
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">描述</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="团队的简要描述..."
              rows={3}
              className="w-full px-3 py-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md border text-sm hover:bg-accent transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!name || createWorkspace.isPending}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {createWorkspace.isPending ? '创建中...' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
