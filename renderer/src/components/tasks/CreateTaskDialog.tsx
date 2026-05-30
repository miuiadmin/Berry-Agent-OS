import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useCreateTask } from '@/hooks/use-tasks';

interface Props {
  projectId: string;
  workspaceId: string;
  columnId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateTaskDialog({ projectId, workspaceId, columnId, open, onOpenChange }: Props) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('none');
  const createTask = useCreateTask();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    createTask.mutate(
      {
        projectId,
        workspaceId,
        columnId,
        title: title.trim(),
        priority,
        creatorType: 'user',
        creatorId: 'default-user',
      },
      {
        onSuccess: () => {
          setTitle('');
          setPriority('none');
          onOpenChange(false);
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-title">任务标题</Label>
            <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="输入任务标题" />
          </div>
          <div className="space-y-2">
            <Label>优先级</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">无</SelectItem>
                <SelectItem value="low">低</SelectItem>
                <SelectItem value="medium">中</SelectItem>
                <SelectItem value="high">高</SelectItem>
                <SelectItem value="urgent">紧急</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={!title.trim() || createTask.isPending}>
              {createTask.isPending ? '创建中...' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
