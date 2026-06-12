/**
 * 13.0 多智能体协作 — Squad 组织树可视化组件。
 *
 * 递归渲染 squad.json 的组织结构：
 *   - 树形缩进展示层级（depth 1-3）
 *   - 成员角色用颜色区分（lead=蓝 / work=绿 / check=黄）
 *   - Signal 实时流展示
 *   - Handoff 箭头连接
 *
 * §11 Squad 组织语言：5 概念 / 3 角色 / 3 级裂变
 */

import { useT } from "@/lib/i18n";
import type { Squad, SquadMember, MissionSignal } from "@/lib/stores/mission-store";
import {
  Users,
  UserCog,
  UserCheck,
  Wrench,
  Shield,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  ArrowRightLeft,
} from "lucide-react";

/**
 * 角色样式映射。
 * 用语义 token 区分角色：lead=info / work=success / check=warning，
 * 替代早期硬编码 blue/green/yellow 色板。
 */
const ROLE_STYLES: Record<string, { color: string; bg: string; icon: typeof Users }> = {
  lead:  { color: "text-info", bg: "border-info/30 bg-info/10", icon: UserCog },
  work:  { color: "text-success", bg: "border-success/30 bg-success/10", icon: Wrench },
  check: { color: "text-warning", bg: "border-warning/30 bg-warning/10", icon: UserCheck },
};

/** 信号类型 → 图标 + 语义色（progress=info / blocker=destructive / done=success / question=warning） */
const SIGNAL_STYLES: Record<string, { color: string; icon: typeof Users }> = {
  progress: { color: "text-info", icon: CheckCircle2 },
  blocker:  { color: "text-destructive", icon: AlertTriangle },
  done:     { color: "text-success", icon: CheckCircle2 },
  question: { color: "text-warning", icon: HelpCircle },
};

/** 单个成员卡片 */
function MemberCard({ member }: { member: SquadMember }) {
  const role = member.role ?? "work";
  const style = ROLE_STYLES[role] ?? ROLE_STYLES.work;
  const Icon = style.icon;

  /** 状态指示灯（语义色：working=success / done=中性 / failed=destructive） */
  const statusDot =
    member.status === "working" ? "bg-success animate-pulse" :
    member.status === "done"     ? "bg-muted-foreground" :
    member.status === "failed"   ? "bg-destructive" :
    "bg-muted-foreground/50";

  return (
    <div className={`flex items-center gap-2 rounded border px-2 py-1 ${style.bg}`}>
      <Icon className={`size-3.5 shrink-0 ${style.color}`} />
      <span className="text-[12px] font-medium text-foreground">{member.agent}</span>
      <span className="text-[11px] text-muted-foreground">{role}</span>
      <span className="flex-1 truncate text-[11px] text-muted-foreground">{member.on}</span>
      <span className={`size-2 shrink-0 rounded-full ${statusDot}`} />
    </div>
  );
}

/** 信号列表 */
function SignalFeed({ signals }: { signals: MissionSignal[] }) {
  if (!signals || signals.length === 0) return null;

  return (
    <div className="ml-4 space-y-0.5">
      {signals.slice(0, 5).map((signal, idx) => {
        const style = SIGNAL_STYLES[signal.type] ?? SIGNAL_STYLES.progress;
        const Icon = style.icon;
        return (
          <div key={idx} className="flex items-center gap-1.5 text-[11px]">
            <Icon className={`size-3 shrink-0 ${style.color}`} />
            <span className="text-muted-foreground">{signal.from}</span>
            <span className="text-muted-foreground/70">:</span>
            <span className="max-w-[200px] truncate text-foreground">{signal.msg}</span>
            <span className="ml-auto shrink-0 text-muted-foreground/70">{signal.at}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 递归 squad 树节点 */
function SquadTreeNode({ squad, depth = 1 }: { squad: Squad; depth?: number }) {
  /** 状态左边框色（语义：working=info / done=success / failed=destructive） */
  const statusColor =
    squad.status === "working" ? "border-l-info" :
    squad.status === "done"    ? "border-l-success" :
    squad.status === "failed"  ? "border-l-destructive" :
    "border-l-border";

  /** 状态文字色（与边框语义对应） */
  const statusTextColor =
    squad.status === "working" ? "text-info" :
    squad.status === "done" ? "text-success" :
    squad.status === "failed" ? "text-destructive" :
    "text-muted-foreground";

  return (
    <div className={`${depth > 1 ? "ml-4" : ""}`}>
      <div className={`border-l-2 ${statusColor} py-1.5 pl-3`}>
        {/* Squad 标题 */}
        <div className="mb-1 flex items-center gap-2">
          <Users className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground">{squad.name}</span>
          <span className="rounded bg-muted px-1.5 text-[11px] text-muted-foreground">
            L{squad.depth}
          </span>
          {squad.leader && (
            <span className="text-[11px] text-info">
              🎯 {squad.leader}
            </span>
          )}
          <span className={`text-[11px] ${statusTextColor}`}>
            {squad.status}
          </span>
        </div>

        {/* Squad 目标 */}
        <p className="mb-1.5 text-[12px] text-muted-foreground">{squad.goal}</p>

        {/* 成员列表 */}
        {squad.members && squad.members.length > 0 && (
          <div className="mb-2 space-y-1">
            {squad.members.map((member, idx) => (
              <MemberCard key={idx} member={member} />
            ))}
          </div>
        )}

        {/* Signals */}
        {squad.signals && squad.signals.length > 0 && (
          <SignalFeed signals={squad.signals} />
        )}
      </div>

      {/* 子 squad 递归 */}
      {squad.squads && squad.squads.map((sub) => (
        <SquadTreeNode key={sub.id} squad={sub} depth={depth + 1} />
      ))}
    </div>
  );
}

/** Handoff 列表（交接契约可视化） */
function HandoffList({ handoffs }: { handoffs: Array<{ from: string; to: string; what: string; status?: string }> }) {
  if (!handoffs || handoffs.length === 0) return null;

  return (
    <div className="mt-3 space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        <ArrowRightLeft className="size-3.5" />
        交接契约
      </h4>
      {handoffs.map((h, idx) => (
        <div key={idx} className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5 text-[12px]">
          <span className="text-info">{h.from}</span>
          <ArrowRightLeft className="size-3 text-muted-foreground/70" />
          <span className="text-success">{h.to}</span>
          <span className="flex-1 truncate text-foreground">{h.what}</span>
          <span className={`text-[11px] ${h.status === "completed" ? "text-success" : "text-muted-foreground"}`}>
            {h.status ?? "pending"}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Props */
interface SquadTreeProps {
  /** squad.json 完整数据 */
  squadFile: {
    org?: { squads: Squad[] };
    handoffs?: Array<{ from: string; to: string; what: string; status?: string }>;
    signals?: MissionSignal[];
  } | null;
}

/**
 * Squad 组织树可视化。
 *
 * 递归渲染 squad 层级 + 成员角色 + signal 流 + handoff 箭头。
 */
export function SquadTree({ squadFile }: SquadTreeProps) {
  const t = useT();

  if (!squadFile?.org?.squads?.length) {
    return (
      <div className="py-8 text-center text-[13px] text-muted-foreground">
        {t("squad.empty")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 全局 Signals */}
      {squadFile.signals && squadFile.signals.length > 0 && (
        <div>
          <h4 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
            <Shield className="size-3.5" />
            {t("squad.globalSignals")}
          </h4>
          <SignalFeed signals={squadFile.signals} />
        </div>
      )}

      {/* Squad 树 */}
      <div>
        {squadFile.org.squads.map((squad) => (
          <SquadTreeNode key={squad.id} squad={squad} />
        ))}
      </div>

      {/* Handoffs */}
      <HandoffList handoffs={squadFile.handoffs ?? []} />
    </div>
  );
}
