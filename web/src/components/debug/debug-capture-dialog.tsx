import { Copy, Check } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useDebugCaptureStore } from "@/lib/stores/debug-capture-store";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DebugCaptureDialog() {
  const { showResultDialog, lastResult, dismissDialog } = useDebugCaptureStore();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  if (!lastResult) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(lastResult.path);
      setCopied(true);
      toast.success("Path copied to clipboard");
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <Dialog open={showResultDialog} onOpenChange={(open) => { if (!open) dismissDialog(); }}>
      <DialogContent onClose={dismissDialog}>
        <DialogHeader>
          <DialogTitle>Capture Saved</DialogTitle>
          <DialogDescription>
            Captured {lastResult.eventCount.toLocaleString()} events
            in {formatDuration(lastResult.durationMs)} ({formatSize(lastResult.size)})
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-2">
          <label className="text-xs font-medium text-muted-foreground">Log Path</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-muted px-3 py-2.5 md:py-2 text-xs break-all select-all">
              {lastResult.path}
            </code>
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
              className="shrink-0 size-11 md:size-8"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={dismissDialog} className="min-h-[44px] md:min-h-0">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
