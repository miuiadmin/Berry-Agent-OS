/**
 * Debug 抓包结果对话框。
 *
 * 展示抓取的事件列表 + 附件截图 + 一键复制 JSON / 导出文件。
 * 基于 shadcn Dialog 组件。
 */

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { useDebugCaptureStore } from "@/lib/stores/debug-capture-store";
import { useT } from "@/lib/i18n";

/** 格式化持续时间 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 格式化字节大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DebugCaptureDialog() {
  const t = useT();
  const { showResultDialog, lastResult, dismissDialog } = useDebugCaptureStore();

  if (!lastResult) return null;

  return (
    <Dialog open={showResultDialog} onOpenChange={(open) => { if (!open) dismissDialog(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("debug.captureSaved")}</DialogTitle>
          <DialogDescription>
            {t("debug.captureDesc", {
              count: lastResult.eventCount.toLocaleString(),
              duration: formatDuration(lastResult.durationMs),
              size: formatSize(lastResult.size),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-2">
          <label className="text-xs font-medium text-muted-foreground">{t("debug.logPath")}</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all break-all rounded-md bg-muted px-3 py-2.5 text-xs md:py-2">
              {lastResult.path}
            </code>
            <CopyButton text={lastResult.path} className="shrink-0" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={dismissDialog} className="min-h-[44px] md:min-h-0">
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
