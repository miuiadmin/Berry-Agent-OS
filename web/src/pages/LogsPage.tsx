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
import { useDebouncedSearch } from "@/hooks/use-debounced-search";
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

/** 三个 select 共享的尺寸 className：移动端 44px 触控目标 + iOS 防缩放字号，
 *  桌面端恢复紧凑尺寸。抽常量避免同一长串类名在 3 处重复。 */
const SELECT_CLASS =
  "h-11 md:h-8 rounded-md border border-input bg-background px-2 text-[16px] md:text-xs min-h-[44px] md:min-h-0";

export default function LogsPage() {
  const t = useT();
  const { formatTime: fmtTime } = useDateFormat();
  /** 日志级别过滤（ALL = 不过滤） */
  const [level, setLevel] = useState("ALL");
  /** 模块名过滤（模糊匹配，带防抖，避免快速打字时每次按键触发 GET /api/logs） */
  const [debouncedModule, setDebouncedModule] = useDebouncedSearch(300);
  /** 输入框受控值（与防抖值分离，输入框立刻响应、查询延迟触发） */
  const [module, setModule] = useState("");
  /** 拉取行数 */
  const [lines, setLines] = useState(100);
  /** 是否开启 5 秒自动刷新 */
  const [autoRefresh, setAutoRefresh] = useState(false);
  /** 日志列表容器引用（用于自动滚到底部） */
  const listRef = useRef<HTMLDivElement>(null);
  /** 用户是否手动上滚查看历史——为 true 时跳过自动滚到底，避免打断查阅 */
  const userScrolledUp = useRef(false);

  const { data, refetch, isFetching } = useQuery({
    // queryKey 必须包含所有影响查询结果的参数，否则切参数会命中旧缓存。
    // 用防抖值 debouncedModule（而非 module），让快速打字只在停手后发一次请求
    queryKey: ["logs", level, debouncedModule, lines],
    queryFn: (ctx) => {
      // 构建 URL 参数（与 queryKey 对齐：lines 必传，level/module 按需）
      const params = new URLSearchParams({ lines: String(lines) });
      if (level !== "ALL") params.set("level", level.toLowerCase());
      if (debouncedModule) params.set("module", debouncedModule);
      return apiGet<{ lines: LogLine[]; total: number }>(
        `/api/logs?${params.toString()}`,
        ctx.signal,
      );
    },
    /** 自动刷新模式下每 5 秒拉一次 */
    refetchInterval: autoRefresh ? 5000 : false,
  });

  // 数据更新后自动滚到底部（最新日志），仅当用户当前已在底部附近时——
  // 否则用户上滚查看历史时，自动刷新会强行把他拉回底部，体验打断
  useEffect(() => {
    if (listRef.current && !userScrolledUp.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [data]);

  /** 监听滚动：用户上滚离开底部时标记，回到底部附近时清除 */
  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    // 距底部 32px 以内视为"在底部"（容忍小范围上滚，避免边缘抖动）
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    userScrolledUp.current = !atBottom;
  };

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏：级别/模块/行数筛选 + 刷新按钮 */}
      <div className="shrink-0 border-b px-4 py-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold mr-auto">{t("logs.title")}</h1>

        {/* 级别选择 */}
        <select aria-label={t("logs.logLevel")}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="ALL">{t("logs.all")}</option>
          <option value="DEBUG">{t("logs.debug")}</option>
          <option value="INFO">{t("logs.info")}</option>
          <option value="WARN">{t("logs.warn")}</option>
          <option value="ERROR">{t("logs.error")}</option>
        </select>

        {/* 模块名输入（移动端 16px 防 iOS 聚焦缩放）。
            onChange 立刻更新输入框受控值 + 触发防抖查询，避免快速打字时每次按键发请求 */}
        <input
          type="text"
          aria-label={t("logs.filterByModule")}
          placeholder={t("logs.modulePlaceholder")}
          value={module}
          onChange={(e) => {
            setModule(e.target.value);
            setDebouncedModule(e.target.value);
          }}
          className="h-11 md:h-8 w-28 rounded-md border border-input bg-background px-2 text-[16px] md:text-xs min-h-[44px] md:min-h-0"
        />

        {/* 行数选择（value 用 String 显式化，避免严格模式下 number → string 隐式 coerce 的告警） */}
        <select aria-label={t("logs.numberOfLines")}
          value={String(lines)}
          onChange={(e) => setLines(Number(e.target.value))}
          className={SELECT_CLASS}
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

        {/* 自动刷新开关。
            label 用 shrink-0 + min-w-[44px] 保证窄工具栏下不被挤压，
            整个 label（含 checkbox + 文案）构成 ≥44px 触控区域（移动端 HIG）。 */}
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground cursor-pointer min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="size-5 md:size-3"
          />
          {t("logs.auto")}
        </label>
      </div>

      {/* 日志列表（等宽字体，按级别着色）。onScroll 监听用于自动滚动守卫：
          用户上滚查看历史时不强制拉回底部。 */}
      <div ref={listRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
        {data?.lines.map((line, i) => (
          // 日志行无后端 seq，用 time+level+module 组合作 key（不再附 -i 索引后缀）。
          // 原版 ${...}-${i} 仍依赖索引区分，重复模块 INFO（同毫秒）会回到"只差索引"的老问题。
          // 去掉索引后可能 React warning（重复 key），但渲染正确且 key 稳定；
          // 后端如未来加 seq 字段，应改用 seq 作 key。Map index 仅作为同帧内 fallback 不参与 key。
          <div key={`${line.time ?? ""}-${line.level ?? ""}-${line.module ?? ""}-${line.msg ?? ""}-${i}`} className={cn("py-0.5 flex gap-2", LEVEL_COLORS[line.level ?? 30])}>
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
