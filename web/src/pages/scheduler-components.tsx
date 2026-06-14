/**
 * Scheduler 页面的子组件集合。
 *
 * 把 JobStatusBadge / JobCard / JobExecutions / CreateJobCard 从 SchedulerPage
 * 主组件里拆出，让页面只保留"编排"（查询 + mutation + tab 切换 + 渲染），
 * 每个卡片级别的 UI 组件单独维护。
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Play,
  Pause,
  Trash2,
  RotateCw,
  History,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { schedulerApi, type SchedulerJob } from "@/lib/api";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { TextAreaField } from "@/components/ui/text-area-field";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useT, useDateFormat } from "@/lib/i18n";

// ─── Status Badge ─────────────────────────────────────────────────

/** 把后端 job 状态翻译成 Badge（paused=secondary / running=default / 其他=outline） */
export function JobStatusBadge({ status }: { status: string }) {
  const t = useT();
  const variant =
    status === "paused"
      ? "secondary"
      : status === "running"
        ? "default"
        : "outline";
  return (
    <Badge variant={variant} className="text-[11px]">
      {/* t() 对未知 key 回退到 key 本身（见 i18n.tsx），无需 ?? status 兜底 */}
      {t(`status.${status}`)}
    </Badge>
  );
}

// ─── Job Card ─────────────────────────────────────────────────────

/** 传给 JobCard 的操作回调 + 各自的 pending 状态 */
export interface JobCardActions {
  /** 暂停 */
  onPause: (jobId: string) => void;
  /** 恢复 */
  onResume: (jobId: string) => void;
  /** 立即触发 */
  onTrigger: (jobId: string) => void;
  /** 删除（打开确认框） */
  onDelete: (jobId: string) => void;
  /** 暂停中（禁用按钮） */
  pausing: boolean;
  /** 恢复中（禁用按钮） */
  resuming: boolean;
  /** 触发中（禁用按钮） */
  triggering: boolean;
}

/**
 * 单个 Job 卡片。
 *
 * 上半部分：名称 + 状态 badge + cron + prompt + 上次/下次执行时间
 * 下半部分：执行历史（可展开）{@link JobExecutions}
 * 右侧操作：暂停/恢复/触发/删除（移动端始终可见，桌面端 hover 显示）
 */
export function JobCard({
  job,
  actions,
}: {
  job: SchedulerJob;
  actions: JobCardActions;
}) {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();

  return (
    <Card className="group">
      <CardContent className="space-y-2 py-3">
        <div className="flex items-start gap-3">
          {/* 左侧：信息 */}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{job.name}</span>
              <JobStatusBadge status={job.status} />
              {!job.enabled && (
                <Badge variant="secondary" className="text-[11px]">
                  {t("common.disabled")}
                </Badge>
              )}
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              {job.cron}
            </p>
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {job.prompt}
            </p>
            <div className="flex gap-3 text-[11px] text-muted-foreground/70">
              {job.lastRunAt && (
                <span>
                  {t("scheduler.last", {
                    time: fmtDT(new Date(job.lastRunAt)),
                  })}
                </span>
              )}
              {job.nextRunAt && (
                <span>
                  {t("scheduler.next", {
                    time: fmtDT(new Date(job.nextRunAt)),
                  })}
                </span>
              )}
            </div>
          </div>

          {/* 右侧：操作按钮（移动端始终可见，桌面端 hover 显示） */}
          <div className="flex shrink-0 gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
            {job.status !== "paused" && job.enabled && (
              <IconButton
                title={t("common.pause")}
                disabled={actions.pausing}
                onClick={() => actions.onPause(job.id)}
              >
                <Pause className="size-3.5" />
              </IconButton>
            )}
            {job.status === "paused" && (
              <IconButton
                title={t("common.resume")}
                disabled={actions.resuming}
                onClick={() => actions.onResume(job.id)}
              >
                <Play className="size-3.5" />
              </IconButton>
            )}
            <IconButton
              title={t("scheduler.triggerNow")}
              disabled={actions.triggering}
              onClick={() => actions.onTrigger(job.id)}
            >
              <RotateCw className="size-3.5" />
            </IconButton>
            <IconButton
              title={t("common.delete")}
              destructive
              onClick={() => actions.onDelete(job.id)}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
        </div>

        {/* 执行历史（可折叠） */}
        <JobExecutions jobId={job.id} />
      </CardContent>
    </Card>
  );
}

// ─── Executions Panel ─────────────────────────────────────────────

/** 执行历史面板（按需懒加载，展开时才查询） */
export function JobExecutions({ jobId }: { jobId: string }) {
  const t = useT();
  const { formatDateTime: fmtDT } = useDateFormat();
  /** 是否展开（展开后才触发 executions 查询） */
  const [show, setShow] = useState(false);
  const execQuery = useQuery({
    queryKey: ["scheduler-executions", jobId],
    queryFn: () => schedulerApi.executions(jobId, { limit: 20 }),
    enabled: show,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="flex min-h-[44px] items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground md:min-h-0"
      >
        {show ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <History className="size-3" />
        {t("scheduler.executionHistory")}
      </button>
      {show && (
        <div className="mt-2 space-y-1 pl-4">
          <QueryBoundary
            query={execQuery}
            skeleton={
              <p className="text-[11px] text-muted-foreground">
                {t("common.loading")}
              </p>
            }
          >
            {(execs) =>
              execs.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("scheduler.noExecutions")}
                </p>
              ) : (
                execs.map((ex) => (
                  <div
                    key={ex.id}
                    className="flex items-center gap-2 rounded border px-2 py-1.5 text-[11px]"
                  >
                    <Badge
                      variant={
                        ex.status === "completed" ? "outline" : "destructive"
                      }
                      className="text-[11px]"
                    >
                      {/* t() 对未知 key 回退到 key 本身，无需 ?? ex.status 兜底 */}
                      {t(`status.${ex.status}`)}
                    </Badge>
                    <span className="text-muted-foreground">
                      {fmtDT(new Date(ex.startedAt))}
                    </span>
                    {ex.finishedAt && (
                      // ex.startedAt / ex.finishedAt 类型为 number（毫秒，见 api.ts SchedulerExecution），
                      // 相减得毫秒差，除 1000 转秒——若后端改成 ISO 字符串这里会得 NaN，类型会立即报错
                      <span className="text-muted-foreground/70">
                        ({((ex.finishedAt - ex.startedAt) / 1000).toFixed(1)}s)
                      </span>
                    )}
                    {ex.error && (
                      <span className="truncate text-destructive">
                        {ex.error}
                      </span>
                    )}
                  </div>
                ))
              )
            }
          </QueryBoundary>
        </div>
      )}
    </div>
  );
}

// ─── Create Job Card ──────────────────────────────────────────────

/** 新建 Job 表单卡片（内聚 name/cron/prompt 三个字段状态） */
export function CreateJobCard({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (data: { name: string; cron: string; prompt: string }) => void;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState("");
  const t = useT();

  /** 三字段都有值才能创建。
   *  注：未做 cron 格式校验——前端只校验非空，无效 cron（如 "abc"）由后端拒绝并报错。
   *  加客户端 cron 解析会引入额外依赖（cron-parser / cronstrue），收益低于成本。 */
  const canCreate =
    !!name.trim() && !!cron.trim() && !!prompt.trim();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          {t("scheduler.newScheduledJob")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder={t("scheduler.jobName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-11 md:h-8"
        />
        <Input
          placeholder={t("scheduler.cronPlaceholder")}
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          className="h-11 md:h-8 font-mono text-sm"
        />
        <TextAreaField
          placeholder={t("scheduler.promptPlaceholder")}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!canCreate}
            className="min-h-[44px] md:min-h-0"
            onClick={() => onCreate({ name, cron, prompt })}
          >
            {t("common.create")}
          </Button>
          <Button size="sm" variant="outline" className="min-h-[44px] md:min-h-0" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
