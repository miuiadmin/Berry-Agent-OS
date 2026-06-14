/**
 * 任务板全板视图（架构升级 16.0 §14——次要/调试深入入口）。
 *
 * 任务进展卡（§14.5）是对话流里的「会生长的 block」（主界面）；本页是点进任务卡后的「完整协作记录」
 * 深入视图：板元数据（goal/status/leader/花名册/预算）+ 协作发言流（BoardMessage thread 按序）。
 * 数据走 GET /api/tasks/:tid/board（board-repo.getBoardThread + getBoardMeta + getBoardMembers）。
 *
 * 定位：power user / 调试多 agent 协作。普通用户在对话流里看任务卡即可，不必进本页。
 */
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getTaskBoard } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 板发言的 loose 渲染类型（前端不镜像完整 BoardMessage 7-type 判别联合，按需取字段渲染） */
interface BoardMessageLike {
  type: string;
  from: string;
  to: string;
  subTaskGoal?: string;
  summary?: string;
  status?: string;
  text?: string;
  question?: string;
  toolName?: string;
  ok?: boolean;
  intent?: string;
  instruction?: string;
}

/** 按 type 提取一行摘要（delegate→subTaskGoal / report→summary / ...） */
function summarizeMessage(m: BoardMessageLike): string {
  switch (m.type) {
    case "delegate":
      return `@指派 ${m.to}：${m.subTaskGoal ?? ""}`;
    case "report":
      return `@成果(${m.status ?? "?"}) ${m.to}：${m.summary ?? ""}`;
    case "tell":
      return `@发言 ${m.to}：${m.text ?? ""}`;
    case "ask":
      return `@求助(${m.to})：${m.question ?? ""}`;
    case "tool_request":
      return `@工具 ${m.toolName ?? ""}`;
    case "tool_result":
      return `@工具结果 ok=${m.ok}`;
    case "command":
      return `@指令(${m.intent ?? "?"}) ${m.to}：${m.instruction ?? ""}`;
    default:
      return `[${m.type}]`;
  }
}

/** 板状态配色（与 TaskProgressCard 一致） */
const STATUS_COLOR: Record<string, string> = {
  in_progress: "text-success",
  completed: "text-success",
  failed: "text-destructive",
  awaiting_review: "text-amber-600 dark:text-amber-500",
  awaiting_user: "text-amber-600 dark:text-amber-500",
  interrupted: "text-muted-foreground",
  created: "text-muted-foreground",
};

export default function BoardPage() {
  const { tid = "" } = useParams<{ tid: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["board", tid],
    queryFn: () => getTaskBoard(tid),
    enabled: !!tid,
  });

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">加载任务板…</div>;
  }
  if (error || !data) {
    return <div className="p-4 text-sm text-destructive">任务板加载失败（可能不是协作任务，或已不存在）</div>;
  }

  const { meta, members, thread } = data;
  const msgs = thread as BoardMessageLike[];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      {/* 板头：目标 + 状态 + leader + 预算 + 花名册 */}
      <div>
        <h1 className="text-lg font-semibold text-foreground">{meta.goal ?? "(无目标)"}</h1>
        <div className="mt-1 text-sm text-muted-foreground">
          <span className={cn("font-medium", STATUS_COLOR[meta.boardStatus] ?? "text-muted-foreground")}>
            {meta.boardStatus}
          </span>
          {" · "}leader: {meta.leader ?? "?"}
          {" · "}深度 {meta.spawnDepth}/{meta.maxSpawnDepth}
          {" · "}发言 {meta.turnCount}/{meta.maxTurns}
          {meta.parentTaskId ? ` · 父板 ${meta.parentTaskId.slice(0, 8)}` : ""}
        </div>
        {members.length > 0 && (
          <div className="mt-1 text-sm text-muted-foreground">
            成员: {members.map((m) => (m.role === "leader" ? `${m.agentId}(leader)` : m.agentId)).join(", ")}
          </div>
        )}
      </div>

      {/* 协作发言流：BoardMessage thread 按序 */}
      <div className="space-y-1.5">
        <h2 className="text-sm font-medium text-muted-foreground">协作发言流（{msgs.length}）</h2>
        {msgs.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无发言</div>
        ) : (
          msgs.map((m, i) => (
            <div
              key={i}
              className="rounded border border-border bg-muted/30 px-3 py-1.5 text-[13px]"
            >
              <span className="font-mono text-[11px] text-muted-foreground/70">[{m.type}]</span>{" "}
              <span className="font-medium text-foreground">{m.from}</span>
              <span className="text-muted-foreground">→{m.to}</span>: {summarizeMessage(m)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
