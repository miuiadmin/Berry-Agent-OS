import { Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDebugCaptureStore } from "@/lib/stores/debug-capture-store";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";

export function DebugCaptureButton({ className }: { className?: string }) {
  const { data: health } = useQuery(queries.health());
  const { isCapturing, loading, start, stop } = useDebugCaptureStore();

  const isDebugMode = health?.debugMode || import.meta.env.DEV;

  if (!isDebugMode) return null;

  const handleClick = () => {
    if (loading) return;
    if (isCapturing) {
      stop();
    } else {
      start();
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      disabled={loading}
      className={cn(
        "size-11 md:size-9 transition-colors",
        isCapturing && "text-red-500",
        className,
      )}
      title={isCapturing ? "Stop capturing logs" : "Start capturing logs"}
    >
      <Bug className={cn("size-5 md:size-4", isCapturing && "animate-pulse")} />
    </Button>
  );
}
