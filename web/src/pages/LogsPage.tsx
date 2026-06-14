/**
 * 日志查看页面。
 *
 * 提供服务端日志的实时查看能力：
 *   - 按级别（DEBUG/INFO/WARN/ERROR）过滤
 *   - 按模块名模糊搜索
 *   - 行数选择（50/100/200/500）
 *   - 手动刷新 + 5 秒自动刷新
 *
 * 数据来源：GET /api/logs
 */

import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { useT, useDateFormat } from "@/lib/i18n";

/** 单条日志行（对应服务端 JSON） */
interface LogLine {
  /** 时间戳（毫秒） */
  time?: number;
  /** 日志级别（20=DEBUG, 30=INFO, 40=WARN, 50=ERROR） */
  level?: number;
  /** 模块名 */
  module?: string;
  /** 日志消息 */
  msg?: string;
  /** 其他字段（透传） */
  [key: string]: unknown;
}

/** 日志级别 → 缩写标签 */
const LEVEL_NAMES: Record<number, string> = { 20: "DBG", 30: "INF", 40: "WRN", 50: "ERR" };

/** 日志级别 → 语义色（warn=warning, error=destructive） */
const LEVEL_COLORS: Record<number, string> = {
  20: "text-muted-foreground/50",
  30: "text-foreground",
  40: "text-warning",
  50: "text-destructive",
};

export default function LogsPage() {
  const t = useT();
  const { formatTime: fmtTime } = useDateFormat();
  /** 日志级别过滤（ALL = 不过滤） */
  const [level, setLevel] = useState("ALL");
  /** 模块名过滤（模糊匹配） */
  const [module, setModule] = useState("");
  /** 拉取行数 */
  const [lines, setLines] = useState(100);
  /** 是否开启 5 秒自动刷新 */
  const [autoRefresh, setAutoRefresh] = useState(false);
  /** 日志列表容器引用（用于自动滚到底部） */
  const listRef = useRef<HTMLDivElement>(null);

  const { data, refetch, isFetching } = useQuery({
    // queryKey 必须包含所有影响查询结果的参数，否则切参数会命中旧缓存
    queryKey: ["logs", level, module, lines],
    queryFn: (ctx) => {
      // 构建 URL 参数（与 queryKey 对齐：lines 必传，level/module 按需）
      const params = new URLSearchParams({ lines: String(lines) });
      if (level !== "ALL") params.set("level", level.toLowerCase());
      if (module) params.set("module", module);
      return apiGet<{ lines: LogLine[]; total: number }>(
        `/api/logs?${params.toString()}`,
        ctx.signal,
      );
    },
    /** 自动刷新模式下每 5 秒拉一次 */
    refetchInterval: autoRefresh ? 5000 : false,
  });

  // 数据更新后自动滚到底部（最新日志）
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏：级别/模块/行数筛选 + 刷新按钮 */}
      <div className="shrink-0 border-b px-4 py-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold mr-auto">{t("logs.title")}</h1>

        {/* 级别选择 */}
        <select aria-label={t("logs.logLevel")}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="h-11 md:h-8 rounded-md border border-input bg-background px-2 text-[16px] md:text-xs min-h-[44px] md:min-h-0"
        >
          <option value="ALL">{t("logs.all")}</option>
          <option value="DEBUG">{t("logs.debug")}</option>
          <option value="INFO">{t("logs.info")}</option>
          <option value="WARN">{t("logs.warn")}</option>
          <option value="ERROR">{t("logs.error")}</option>
        </select>

        {/* 模块名输入（移动端 16px 防 iOS 聚焦缩放） */}
        <input
          type="text"
          aria-label={t("logs.filterByModule")}
          placeholder={t("logs.modulePlaceholder")}
          value={module}
          onChange={(e) => setModule(e.target.value)}
          className="h-11 md:h-8 w-28 rounded-md border border-input bg-background px-2 text-[16px] md:text-xs min-h-[44px] md:min-h-0"
        />

        {/* 行数选择 */}
        <select aria-label={t("logs.numberOfLines")}
          value={lines}
          onChange={(e) => setLines(Number(e.target.value))}
          className="h-11 md:h-8 rounded-md border border-input bg-background px-2 text-[16px] md:text-xs min-h-[44px] md:min-h-0"
        >
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
          <option value={500}>500</option>
        </select>

        {/* 刷新按钮（加载中旋转） */}
        <IconButton
          title={t("logs.refreshLogs")}
          onClick={() => refetch()}
          className={isFetching ? "animate-spin" : undefined}
        >
          <RefreshCw className="size-3.5" />
        </IconButton>

        {/* 自动刷新开关 */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="size-5 md:size-3"
          />
          {t("logs.auto")}
        </label>
      </div>

      {/* 日志列表（等宽字体，按级别着色） */}
      <div ref={listRef} className="flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
        {data?.lines.map((line, i) => (
          <div key={i} className={cn("py-0.5 flex gap-2", LEVEL_COLORS[line.level ?? 30])}>
            <span className="shrink-0 text-muted-foreground/40 w-16">{line.time ? fmtTime(new Date(line.time), { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "??:??:??"}</span>
            <span className="shrink-0 w-7">{LEVEL_NAMES[line.level ?? 30] ?? "?"}</span>
            <span className="shrink-0 text-muted-foreground/60 w-24 truncate">{line.module ?? ""}</span>
            <span className="break-all">{line.msg}</span>
          </div>
        ))}
        {!data?.lines.length && (
          <div className="text-center text-muted-foreground py-8">{t("logs.noLogs")}</div>
        )}
      </div>
    </div>
  );
}
