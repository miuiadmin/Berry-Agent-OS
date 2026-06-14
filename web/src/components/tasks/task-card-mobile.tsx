/**
 * 移动端任务卡片组件。
 *
 * 可展开查看详情的卡片：点击展开显示完整 ID / Session / 时间 / 错误 / 输入输出。
 * 运行中的任务可点击取消按钮。
 * 所有触控目标 ≥ 44px（Apple HIG 标准）。
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, XCircle } from "lucide-react";
import type { TaskInfo } from "@/lib/api";
import { useT, useDateFormat } from "@/lib/i18n";
import { formatDuration, formatJson } from "@/lib/format";

/** 已知任务状态集合（与 locales 的 status.* 键一一对应） */
const KNOWN_STATUSES = new Set(["running", "completed", "failed", "cancelled", "pending"]);

/** 状态 → Badge variant 映射（未知状态回落 secondary） */
const STATUS_VARIANT: Record<string, "success" | "destructive" | "warning" | "secondary"> = {
  completed: "success",
  failed: "destructive",
  running: "warning",
  cancelled: "secondary",
  pending: "secondary",
};

/** 详情行：标签 + 内容（展开区域的重复模式） */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="font-medium text-muted-foreground">{label}</span>
      <div className="mt-0.5 text-[11px]">{children}</div>
    </div>
  );
}

/** 详情 pre 块：标签 + 格式化内容（输入/输出/错误复用） */
function DetailPre({ label, content, tone }: { label: string; content: string; tone?: "destructive" }) {
  return (
    <DetailRow label={label}>
      <pre className={cn(
        "mt-1 max-h-24 overflow-auto rounded-lg border p-2 text-[11px] whitespace-pre-wrap",
        tone === "destructive" ? "border-destructive/20 bg-destructive/5 text-destructive" : "bg-background",
      )}>{content}</pre>
    </DetailRow>
  );
}

/**
 * 渲染任务状态徽章文案。
 *
 * - 已知状态（completed/failed/running/cancelled/pending）→ 走 i18n 翻译
 * - 未知状态 → 返回状态原值首字母大写（绝不让用户看到 "status.<unknown>" 这种
 *   字面键——t() 在缺键时返回原 key，原先的 `?? task.status` 因 t() 永不返回
 *   null/undefined 而成为死代码，无法兜底）
 */
function statusLabel(status: string, t: (key: string) => string): string {
  if (KNOWN_STATUSES.has(status)) return t(`status.${status}`);
  // 未知状态：直接用原始值，避免暴露 i18n 键命名
  return status.charAt(0).toUpperCase() + status.slice(1);
}

interface TaskCardMobileProps {
  task: TaskInfo;
  onCancel: () => void;
}

/** 移动端任务卡片（可展开查看详情） */
export function TaskCardMobile({ task, onCancel }: TaskCardMobileProps) {
  const [expanded, setExpanded] = useState(false);
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {/*
       * 头部（点击展开/收起）。显式 min-h-[44px] md:min-h-0 满足 CLAUDE.md 移动端
       * 触控目标硬规则——之前仅靠 p-3 隐式撑高，极端字号缩放下可能跌破 44px。
       */}
      <button type="button" onClick={() => setExpanded((v) => !v)}
        className="flex min-h-[44px] w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted/30 active:bg-muted/40 md:min-h-0">
        <div className="text-muted-foreground">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[task.status] ?? "secondary"} className="text-[11px]">
              {statusLabel(task.status, t)}
            </Badge>
            <span className="truncate text-xs font-medium">{task.taskType}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{task.targetAgent}</span>
            <span>·</span>
            <span>{formatDuration(task.startedAt, task.finishedAt, task.status)}</span>
          </div>
        </div>
        {task.status === "running" && (
          // stopPropagation 防止点击取消按钮误触发卡片展开
          // 移动端类序：min-h/min-w 在前，md: 覆盖在后（CLAUDE.md 移动端硬规则）。
          // 去掉冗余的 h-11（与 min-h-[44px] 重复）和被显式高度覆盖的 size-sm h-7 噪音。
          <Button variant="destructive" size="sm" aria-label={t("taskCard.cancelTask")}
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            className="min-h-[44px] min-w-[44px] shrink-0 px-3 text-xs md:h-6 md:min-h-0 md:px-2">
            <XCircle className="size-3" />
          </Button>
        )}
      </button>

      {/* 展开详情（collapse-wrapper/inner 由 index.css 的 grid-rows 过渡实现高度动画） */}
      <div className="collapse-wrapper" data-open={expanded}>
        <div className="collapse-inner">
          <div className="space-y-2 border-t border-border bg-muted/10 p-3 text-xs">
            <DetailRow label={t("tasks.id")}>
              <p className="font-mono break-all">{task.id}</p>
            </DetailRow>
            {task.sessionId && (
              <DetailRow label={t("taskCard.session")}>
                <p className="font-mono">{task.sessionId}</p>
              </DetailRow>
            )}
            <DetailRow label={t("tasks.created")}>
              <p>{fmtDT(new Date(task.createdAt))}</p>
            </DetailRow>
            {task.status === "failed" && task.error && (
              <DetailPre label={t("common.error")} content={task.error} tone="destructive" />
            )}
            {task.inputPayload && (
              <DetailPre label={t("tools.input")} content={formatJson(task.inputPayload)} />
            )}
            {task.outputPayload && (
              <DetailPre label={t("tools.output")} content={formatJson(task.outputPayload)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
