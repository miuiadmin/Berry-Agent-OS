import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  40: "text-orange-500",
  50: "text-red-500",
};

function formatTime(ts?: number): string {
  if (!ts) return "??:??:??";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function LogsPage() {
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
        <h1 className="text-lg font-semibold mr-auto">Logs</h1>

        <select aria-label="Log level"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="h-11 md:h-8 rounded-md border border-input bg-background px-2 text-xs min-h-[44px] md:min-h-0"
        >
          <option value="ALL">ALL</option>
          <option value="DEBUG">DEBUG</option>
          <option value="INFO">INFO</option>
          <option value="WARN">WARN</option>
          <option value="ERROR">ERROR</option>
        </select>

        <input
          type="text"
          aria-label="Filter by module"
          placeholder="Module..."
          value={module}
          onChange={(e) => setModule(e.target.value)}
          className="h-11 md:h-8 w-28 rounded-md border border-input bg-background px-2 text-[16px] md:text-xs min-h-[44px] md:min-h-0"
        />

        <select aria-label="Number of lines"
          value={lines}
          onChange={(e) => setLines(Number(e.target.value))}
          className="h-11 md:h-8 rounded-md border border-input bg-background px-2 text-xs min-h-[44px] md:min-h-0"
        >
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={200}>200</option>
          <option value={500}>500</option>
        </select>

        <Button
          variant="ghost"
          aria-label="Refresh logs"
          onClick={() => refetch()}
          className={cn("size-11 md:size-8", isFetching && "animate-spin")}
        >
          <RefreshCw className="size-3.5" />
        </Button>

        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="size-3"
          />
          Auto
        </label>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
        {data?.lines.map((line, i) => (
          <div key={i} className={cn("py-0.5 flex gap-2", LEVEL_COLORS[line.level ?? 30])}>
            <span className="shrink-0 text-muted-foreground/40 w-16">{formatTime(line.time)}</span>
            <span className="shrink-0 w-7">{LEVEL_NAMES[line.level ?? 30] ?? "?"}</span>
            <span className="shrink-0 text-muted-foreground/60 w-24 truncate">{line.module ?? ""}</span>
            <span className="break-all">{line.msg}</span>
          </div>
        ))}
        {!data?.lines.length && (
          <div className="text-center text-muted-foreground py-8">No logs found</div>
        )}
      </div>
    </div>
  );
}
