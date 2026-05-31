"use client";

import { useWsStore } from "@/lib/stores/ws-store";
import { cn } from "@/lib/utils";

export function ConnectionStatus() {
  const status = useWsStore((s) => s.status);

  return (
    <div className="flex items-center gap-1.5 text-xs sm:text-[11px] text-muted-foreground">
      <span
        className={cn(
          "size-2.5 sm:size-2 rounded-full shrink-0",
          status === "connected" && "bg-success",
          status === "connecting" && "bg-warning animate-pulse",
          status === "disconnected" && "bg-destructive"
        )}
      />
      <span>
        {status === "connected" && "Connected"}
        {status === "connecting" && "Connecting..."}
        {status === "disconnected" && "Disconnected"}
      </span>
    </div>
  );
}
