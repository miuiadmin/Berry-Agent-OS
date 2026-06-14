/**
 * Tasks 页面的桌面端子组件。
 *
 * 从 TasksPage 拆出：表格行（TaskRow）和展开详情（TaskDetail）。
 * 移动端卡片视图使用 TaskCardMobile（components/tasks/task-card-mobile.tsx）。
 */

import type { TaskInfo } from "@/lib/api";
import { formatDuration, formatJson, taskStatusVariant } from "@/lib/format";
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
          {/* t() 对未知 key 回退到 key 本身（见 i18n.tsx），无需 ?? task.status 兜底 */}
          <Badge variant={taskStatusVariant(task.status)}>
            {t(`status.${task.status}`)}
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
              className="h-9 px-2 text-xs md:h-6"
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
        <PayloadBlock
          label={t("common.error")}
          content={task.error}
          tone="destructive"
        />
      )}

      {/* 输入 payload */}
      {task.inputPayload && (
        <PayloadBlock label={t("tools.input")} content={formatJson(task.inputPayload)} />
      )}

      {/* 输出 payload */}
      {task.outputPayload && (
        <PayloadBlock label={t("tools.output")} content={formatJson(task.outputPayload)} />
      )}
    </div>
  );
}

/** payload 块的配色基调：neutral=中性灰、destructive=错误红 */
type PayloadTone = "neutral" | "destructive";

interface PayloadBlockProps {
  /** 区块标题（如「错误」「输入」「输出」） */
  label: string;
  /** pre 内展示的文本内容（调用方负责 formatJson） */
  content: string;
  /** 配色基调，默认 neutral */
  tone?: PayloadTone;
}

/**
 * 任务详情里的「标签 + <pre> 代码块」组合。
 *
 * TaskDetail 的错误 / 输入 / 输出三处是同构的 label+pre 结构，仅配色基调不同
 * （错误用红、输入输出用中性灰）。抽出后三处共用一套样式，加一处只改一处。
 */
function PayloadBlock({ label, content, tone = "neutral" }: PayloadBlockProps) {
  const destructive = tone === "destructive";
  return (
    <div>
      <span
        className={cn(
          "font-medium",
          destructive ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <pre
        className={cn(
          "mt-1 overflow-auto rounded-lg border p-3 text-[11px]",
          destructive
            ? "max-h-24 bg-destructive/5 border-destructive/20 text-destructive"
            : "max-h-40 bg-background",
        )}
      >
        {content}
      </pre>
    </div>
  );
}
