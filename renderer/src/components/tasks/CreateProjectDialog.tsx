import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useCreateProject } from '@/hooks/use-projects';

interface Props {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectDialog({ workspaceId, open, onOpenChange }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const createProject = useCreateProject();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createProject.mutate(
      { workspaceId, name: name.trim(), description: description.trim() || undefined },
      {
        onSuccess: () => {
          setName('');
          setDescription('');
          onOpenChange(false);
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">项目名称</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="输入项目名称" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-desc">描述（可选）</Label>
            <Input id="project-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="简要描述项目" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={!name.trim() || createProject.isPending}>
              {createProject.isPending ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
