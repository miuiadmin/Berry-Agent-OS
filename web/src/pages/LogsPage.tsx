import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useT, useDateFormat } from "@/lib/i18n";

interface LogLine {
  time?: number;
  level?: number;
  module?: string;
  msg?: string;
  [key: string]: unknown;
}

const LEVEL_NAMES: Record<number, string> = { 20: "DBG", 30: "INF", 40: "WRN", 50: "ERR" };
const LEVEL_COLORS: Record<number, string> = {
  20: "text-muted-foreground/50",
  30: "text-foreground",
  40: "text-warning",
  50: "text-danger",
};

export default function LogsPage() {
  const t = useT();
  const { formatTime: fmtTime } = useDateFormat();
  const [level, setLevel] = useState("ALL");
  const [module, setModule] = useState("");
  const [lines, setLines] = useState(100);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const params = new URLSearchParams();
  params.set("lines", String(lines));
  if (level !== "ALL") params.set("level", level.toLowerCase());
  if (module) params.set("module", module);

  const { data, refetch, isFetching } = useQuery({
    queryKey: ["logs", level, module, lines],
    queryFn: () => apiGet<{ lines: LogLine[]; total: number }>(`/api/logs?${params.toString()}`),
    refetchInterval: autoRefresh ? 5000 : false,
  });

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 border-b px-4 py-3 flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold mr-auto">{t("logs.title")}</h1>

        <Select
          value={level}
          onValueChange={setLevel}
          ariaLabel={t("logs.logLevel")}
          options={[
            { key: "ALL", label: t("logs.all") },
            { key: "DEBUG", label: t("logs.debug") },
            { key: "INFO", label: t("logs.info") },
            { key: "WARN", label: t("logs.warn") },
            { key: "ERROR", label: t("logs.error") },
          ]}
          className="w-auto"
        />

        <input
          type="text"
          aria-label={t("logs.filterByModule")}
          placeholder={t("logs.modulePlaceholder")}
          value={module}
          onChange={(e) => setModule(e.target.value)}
          className="h-11 md:h-8 w-28 rounded-md border border-input bg-background px-2 text-[16px] md:text-xs min-h-[44px] md:min-h-0"
        />

        <Select
          value={String(lines)}
          onValueChange={(v) => setLines(Number(v))}
          ariaLabel={t("logs.numberOfLines")}
          options={[
            { key: "50", label: "50" },
            { key: "100", label: "100" },
            { key: "200", label: "200" },
            { key: "500", label: "500" },
          ]}
          className="w-auto"
        />

        <Button
          variant="ghost"
          aria-label={t("logs.refreshLogs")}
          onClick={() => refetch()}
          className={cn("size-11 md:size-8", isFetching && "animate-spin")}
        >
          <RefreshCw className="size-3.5" />
        </Button>

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
