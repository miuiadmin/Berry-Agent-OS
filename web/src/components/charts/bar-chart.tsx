"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface BarItem {
  label: string;
  value: number;
  color?: string;
}

interface BarChartProps {
  data: BarItem[];
  className?: string;
  formatValue?: (v: number) => string;
}

export function BarChart({ data, className, formatValue = (v) => String(v) }: BarChartProps) {
  const maxVal = useMemo(() => Math.max(...data.map((d) => d.value), 1), [data]);

  if (data.length === 0) {
    return (
      <div className={cn("flex items-center justify-center text-sm text-muted-foreground py-4", className)}>
        No data
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      {data.map((item, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground truncate max-w-[50%] md:max-w-[60%]">{item.label}</span>
            <span className="font-medium tabular-nums">{formatValue(item.value)}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${(item.value / maxVal) * 100}%`,
                backgroundColor: item.color ?? "var(--chart-1)",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
