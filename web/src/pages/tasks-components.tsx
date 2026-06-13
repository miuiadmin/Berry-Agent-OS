/**
 * Tasks 页面的桌面端子组件。
 *
 * 从 TasksPage 拆出：表格行（TaskRow）和展开详情（TaskDetail）。
 * 移动端卡片视图使用 TaskCardMobile（components/tasks/task-card-mobile.tsx）。
 */

import type { TaskInfo } from "@/lib/api";
import { formatDuration, formatJson } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronRight, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, useDateFormat } from "@/lib/i18n";

// ─── 桌面端表格行 ──────────────────────────────────────────────────

interface TaskRowProps {
  /** 任务数据 */
  task: TaskInfo;
  /** 是否展开详情 */
  expanded: boolean;
  /** 切换展开/收起 */
  onToggle: () => void;
  /** 取消运行中的任务 */
  onCancel: () => void;
}

/**
 * 桌面端任务表格行：点击展开详情，运行中任务可取消。
 * 配合 CSS Grid 7 列布局（序号 / ID / 类型 / Agent / 状态 / 时长 / 操作）。
 */
export function TaskRow({ task, expanded, onToggle, onCancel }: TaskRowProps) {
  const t = useT();

  return (
    <>
      <tr
        className={cn(
          "border-b border-border cursor-pointer hover:bg-muted/30 active:bg-muted/40 transition-colors",
          expanded && "bg-muted/20",
        )}
        onClick={onToggle}
      >
        {/* 展开箭头 */}
        <td className="px-2 text-muted-foreground">
          <ChevronRight
            className={cn(
              "size-4 transition-transform duration-200",
              expanded && "rotate-90",
            )}
          />
        </td>
        {/* ID（截取前 8 位） */}
        <td className="px-4 py-2.5 font-mono text-xs">{task.id.slice(0, 8)}</td>
        {/* 任务类型 */}
        <td className="px-4 py-2.5">{task.taskType}</td>
        {/* 目标 Agent */}
        <td className="px-4 py-2.5">{task.targetAgent}</td>
        {/* 状态 Badge */}
        <td className="px-4 py-2.5">
          <Badge
            variant={
              task.status === "completed"
                ? "success"
                : task.status === "failed"
                  ? "destructive"
                  : task.status === "running"
                    ? "warning"
                    : "secondary"
            }
          >
            {t(`status.${task.status}`) ?? task.status}
          </Badge>
        </td>
        {/* 执行时长 */}
        <td className="px-4 py-2.5 text-xs text-muted-foreground">
          {formatDuration(task.startedAt, task.finishedAt, task.status)}
        </td>
        {/* 操作（仅运行中可取消） */}
        <td className="px-4 py-2.5">
          {task.status === "running" && (
            <Button
              variant="destructive"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
            >
              <XCircle className="size-3" />
              {t("tasks.cancel")}
            </Button>
          )}
        </td>
      </tr>

      {/* 展开详情行 */}
      <tr
        className={cn(
          "border-b border-border last:border-0",
          !expanded && "border-0",
        )}
      >
        <td colSpan={7} className="p-0">
          <div className="collapse-wrapper" data-open={expanded}>
            <div className="collapse-inner">
              <div className="bg-muted/10 px-3 md:px-6 py-3 md:py-4">
                <TaskDetail task={task} />
              </div>
            </div>
          </div>
        </td>
      </tr>
    </>
  );
}

// ─── 展开后的任务详情 ─────────────────────────────────────────────

interface TaskDetailProps {
  /** 任务数据 */
  task: TaskInfo;
}

/**
 * 任务展开详情：完整 ID / Session / 时间 / 错误 / 输入输出。
 * 仅在桌面端 TaskRow 展开时渲染（移动端用 TaskCardMobile 内联展示）。
 */
export function TaskDetail({ task }: TaskDetailProps) {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();

  return (
    <div className="space-y-3 text-xs">
      {/* 基础信息三列 */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div>
          <span className="font-medium text-muted-foreground">
            {t("tasks.fullId")}
          </span>
          <p className="mt-0.5 font-mono break-all">{task.id}</p>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">
            {t("tasks.session")}
          </span>
          <p className="mt-0.5 font-mono">{task.sessionId ?? "—"}</p>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">
            {t("tasks.created")}
          </span>
          <p className="mt-0.5">{fmtDT(new Date(task.createdAt))}</p>
        </div>
      </div>

      {/* 失败任务：错误信息 */}
      {task.status === "failed" && task.error && (
        <div>
          <span className="font-medium text-destructive">
            {t("common.error")}
          </span>
          <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-destructive/5 border border-destructive/20 p-3 text-[11px] text-destructive">
            {task.error}
          </pre>
        </div>
      )}

      {/* 输入 payload */}
      {task.inputPayload && (
        <div>
          <span className="font-medium text-muted-foreground">
            {t("tools.input")}
          </span>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-background border p-3 text-[11px]">
            {formatJson(task.inputPayload)}
          </pre>
        </div>
      )}

      {/* 输出 payload */}
      {task.outputPayload && (
        <div>
          <span className="font-medium text-muted-foreground">
            {t("tools.output")}
          </span>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-background border p-3 text-[11px]">
            {formatJson(task.outputPayload)}
          </pre>
        </div>
      )}
    </div>
  );
}
