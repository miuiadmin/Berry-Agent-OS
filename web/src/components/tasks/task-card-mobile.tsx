
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, XCircle } from "lucide-react";
import type { TaskInfo } from "@/lib/api";
import { useT, useDateFormat } from "@/lib/i18n";

interface TaskCardMobileProps {
  task: TaskInfo;
  onCancel: () => void;
}

export function TaskCardMobile({ task, onCancel }: TaskCardMobileProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/30 active:bg-muted/40 transition-colors"
      >
        <div className="text-muted-foreground">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Badge
              variant={
                task.status === "completed" ? "success"
                  : task.status === "failed" ? "destructive"
                  : task.status === "running" ? "warning"
                  : "secondary"
              }
              className="text-[11px]"
            >
              {task.status}
            </Badge>
            <span className="text-xs font-medium truncate">{task.taskType}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{task.targetAgent}</span>
            <span>·</span>
            <span>{formatDuration(task.startedAt, task.finishedAt, task.status)}</span>
          </div>
        </div>
        {task.status === "running" && (
          <Button
            variant="destructive"
            size="sm"
            aria-label={t("taskCard.cancelTask")}
            className="h-11 md:h-6 px-3 md:px-2 text-xs shrink-0 min-h-[44px] md:min-h-0 min-w-[44px]"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            <XCircle className="size-3" />
          </Button>
        )}
      </button>
      <div className="collapse-wrapper" data-open={expanded}>
        <div className="collapse-inner">
          <div className="border-t border-border bg-muted/10 p-3 space-y-2 text-xs">
            <div>
              <span className="font-medium text-muted-foreground">{t("tasks.id")}</span>
              <p className="mt-0.5 font-mono break-all text-[11px]">{task.id}</p>
            </div>
            {task.sessionId && (
              <div>
                <span className="font-medium text-muted-foreground">{t("taskCard.session")}</span>
                <p className="mt-0.5 font-mono text-[11px]">{task.sessionId}</p>
              </div>
            )}
            <div>
              <span className="font-medium text-muted-foreground">{t("tasks.created")}</span>
              <p className="mt-0.5 text-[11px]">{fmtDT(new Date(task.createdAt))}</p>
            </div>
            {task.status === "failed" && task.error && (
              <div>
                <span className="font-medium text-destructive">{t("common.error")}</span>
                <pre className="mt-1 max-h-20 overflow-auto rounded-lg bg-destructive/5 border border-destructive/20 p-2 text-[11px] text-destructive whitespace-pre-wrap">
                  {task.error}
                </pre>
              </div>
            )}
            {task.inputPayload && (
              <div>
                <span className="font-medium text-muted-foreground">{t("tools.input")}</span>
                <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-background border p-2 text-[11px] whitespace-pre-wrap">
                  {formatJson(task.inputPayload)}
                </pre>
              </div>
            )}
            {task.outputPayload && (
              <div>
                <span className="font-medium text-muted-foreground">{t("tools.output")}</span>
                <pre className="mt-1 max-h-24 overflow-auto rounded-lg bg-background border p-2 text-[11px] whitespace-pre-wrap">
                  {formatJson(task.outputPayload)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDuration(startedAt?: string, finishedAt?: string, status?: string): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s${status === "running" ? "..." : ""}`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s${status === "running" ? "..." : ""}`;
}

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
