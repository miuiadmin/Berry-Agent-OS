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
import { formatDurationMs } from "@/lib/format";
import { useT } from "@/lib/i18n";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DebugCaptureDialog() {
  const t = useT();
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
      toast.success(t("debug.pathCopied"));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("debug.failedToCopy"));
    }
  };

  return (
    <Dialog open={showResultDialog} onOpenChange={(open) => { if (!open) dismissDialog(); }}>
      <DialogContent onClose={dismissDialog}>
        <DialogHeader>
          <DialogTitle>{t("debug.captureSaved")}</DialogTitle>
          <DialogDescription>
            {t("debug.captureDesc", {
              count: lastResult.eventCount.toLocaleString(),
              duration: formatDurationMs(lastResult.durationMs),
              size: formatSize(lastResult.size),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-2">
          <label className="text-xs font-medium text-muted-foreground">{t("debug.logPath")}</label>
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
          <Button variant="outline" onClick={dismissDialog} className="">
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
