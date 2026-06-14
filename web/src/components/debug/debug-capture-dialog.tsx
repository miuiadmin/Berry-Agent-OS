/**
 * DebugCaptureDialog Debug 抓包结果对话框。
 *
 * 抓包停止后弹出，展示：事件数 / 持续时间 / 文件大小 / 日志路径。
 * 日志路径支持一键复制（CopyButton）。基于 shadcn Dialog 组件。
 *
 * 状态来源：useDebugCaptureStore（showResultDialog / lastResult / dismissDialog）。
 * lastResult 为 null 时不渲染（首次加载 / 未抓包过）。
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

/** 格式化持续时间：< 1s 显示 ms，< 1min 显示 s，否则 m+s */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 格式化字节大小：B / KB / MB 三档 */
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
            {/* 日志路径：可选择全部文本；移动端 py-2.5 增大触控 */}
            <code className="flex-1 select-all break-all rounded-md bg-muted px-3 py-2.5 text-xs md:py-2">
              {lastResult.path}
            </code>
            <CopyButton text={lastResult.path} className="shrink-0" />
          </div>
        </div>

        <DialogFooter>
          {/* 关闭按钮：移动端 44px 触控目标 */}
          <Button variant="outline" onClick={dismissDialog} className="min-h-[44px] md:min-h-0">
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
