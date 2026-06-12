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

/** 角色样式映射 */
const ROLE_STYLES: Record<string, { color: string; bg: string; icon: typeof Users }> = {
  lead:  { color: "text-info", bg: "bg-info/10 border-info/30", icon: UserCog },
  work:  { color: "text-success", bg: "bg-success/10 border-success/30", icon: Wrench },
  check: { color: "text-warning", bg: "bg-warning/10 border-warning/30", icon: UserCheck },
};

/** 信号类型 → 图标 + 样式 */
const SIGNAL_STYLES: Record<string, { color: string; icon: typeof Users }> = {
  progress: { color: "text-info", icon: CheckCircle2 },
  blocker:  { color: "text-danger", icon: AlertTriangle },
  done:     { color: "text-success", icon: CheckCircle2 },
  question: { color: "text-warning", icon: HelpCircle },
};

/** 单个成员卡片 */
function MemberCard({ member }: { member: SquadMember }) {
  const role = member.role ?? "work";
  const style = ROLE_STYLES[role] ?? ROLE_STYLES.work;
  const Icon = style.icon;

  /** 状态指示灯 */
  const statusDot =
    member.status === "working" ? "bg-success animate-pulse" :
    member.status === "done"     ? "bg-zinc-500" :
    member.status === "failed"   ? "bg-danger" :
    "bg-zinc-600";

  return (
    <div className={`flex items-center gap-2 px-2 py-1 rounded border ${style.bg}`}>
      <Icon className={`w-3.5 h-3.5 ${style.color} flex-shrink-0`} />
      <span className="text-[12px] text-zinc-300 font-medium">{member.agent}</span>
      <span className="text-[11px] text-zinc-500">{role}</span>
      <span className="flex-1 text-[11px] text-zinc-500 truncate">{member.on}</span>
      <span className={`w-2 h-2 rounded-full ${statusDot} flex-shrink-0`} />
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
            <Icon className={`w-3 h-3 ${style.color} flex-shrink-0`} />
            <span className="text-zinc-500">{signal.from}</span>
            <span className="text-zinc-600">:</span>
            <span className="text-zinc-400 truncate max-w-[200px]">{signal.msg}</span>
            <span className="text-zinc-600 ml-auto flex-shrink-0">{signal.at}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 递归 squad 树节点 */
function SquadTreeNode({ squad, depth = 1 }: { squad: Squad; depth?: number }) {
  /** 状态样式 */
  const statusColor =
    squad.status === "working" ? "border-l-blue-500" :
    squad.status === "done"    ? "border-l-green-500" :
    squad.status === "failed"  ? "border-l-red-500" :
    "border-l-zinc-600";

  return (
    <div className={`${depth > 1 ? "ml-4" : ""}`}>
      <div className={`border-l-2 ${statusColor} pl-3 py-1.5`}>
        {/* Squad 标题 */}
        <div className="flex items-center gap-2 mb-1">
          <Users className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          <span className="text-[13px] font-medium text-zinc-200">{squad.name}</span>
          <span className="text-[11px] text-zinc-500 bg-zinc-800 rounded px-1.5">
            L{squad.depth}
          </span>
          {squad.leader && (
            <span className="text-[11px] text-info">
              🎯 {squad.leader}
            </span>
          )}
          <span className={`text-[11px] ${
            squad.status === "working" ? "text-info" :
            squad.status === "done" ? "text-success" :
            squad.status === "failed" ? "text-danger" :
            "text-zinc-500"
          }`}>
            {squad.status}
          </span>
        </div>

        {/* Squad 目标 */}
        <p className="text-[12px] text-zinc-400 mb-1.5">{squad.goal}</p>

        {/* 成员列表 */}
        {squad.members && squad.members.length > 0 && (
          <div className="space-y-1 mb-2">
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

/** Handoff 列表 */
function HandoffList({ handoffs }: { handoffs: Array<{ from: string; to: string; what: string; status?: string }> }) {
  if (!handoffs || handoffs.length === 0) return null;

  return (
    <div className="space-y-1.5 mt-3">
      <h4 className="text-[12px] text-zinc-500 font-medium flex items-center gap-1.5">
        <ArrowRightLeft className="w-3.5 h-3.5" />
        交接契约
      </h4>
      {handoffs.map((h, idx) => (
        <div key={idx} className="flex items-center gap-2 text-[12px] bg-zinc-800/50 rounded px-2 py-1.5">
          <span className="text-info">{h.from}</span>
          <ArrowRightLeft className="w-3 h-3 text-zinc-600" />
          <span className="text-success">{h.to}</span>
          <span className="text-zinc-400 flex-1 truncate">{h.what}</span>
          <span className={`text-[11px] ${h.status === "completed" ? "text-success" : "text-zinc-500"}`}>
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
      <div className="text-center text-zinc-600 text-[13px] py-8">
        {t("squad.empty")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 全局 Signals */}
      {squadFile.signals && squadFile.signals.length > 0 && (
        <div>
          <h4 className="text-[12px] text-zinc-500 font-medium mb-1 flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5" />
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
