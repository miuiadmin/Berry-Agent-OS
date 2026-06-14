/**
 * DebugCaptureDialog Debug 抓包结果对话框。
 *
 * 抓包停止后弹出，展示本次抓包的统计摘要：
 *  - 事件数（eventCount）
 *  - 持续时间（durationMs）
 *  - 日志文件大小（size bytes）
 *  - 日志文件路径（path，支持一键复制）
 *
 * 状态来源：useDebugCaptureStore（showResultDialog / lastResult / dismissDialog）。
 * lastResult 为 null 时（首次加载 / 从未抓包过）整组件不渲染。
 *
 * 基于 shadcn Dialog；移动端硬规则：关闭按钮 min-h-[44px] 触控目标。
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

/* ============================================================
 * 抓包结果的本地格式化（仅 debug 用，不外提）
 * ========================================================== */

/** 一秒的毫秒数（避免裸 1000 魔法数字） */
const MS_PER_SECOND = 1000;
/** 一分钟的秒数 */
const SEC_PER_MINUTE = 60;
/** 1KB 的字节数 */
const BYTES_PER_KB = 1024;
/** 1MB 的字节数 */
const BYTES_PER_MB = BYTES_PER_KB * 1024;

/**
 * 格式化持续时间（毫秒 → 人类可读）。
 *
 * - <1s → "420ms"
 * - <1min → "12s"
 * - ≥1min → "2m 34s"
 *
 * @param ms 毫秒数
 */
function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  const totalSec = Math.floor(ms / MS_PER_SECOND);
  if (totalSec < SEC_PER_MINUTE) return `${totalSec}s`;
  const min = Math.floor(totalSec / SEC_PER_MINUTE);
  const sec = totalSec % SEC_PER_MINUTE;
  return `${min}m ${sec}s`;
}

/**
 * 格式化字节数（B / KB / MB 三档）。
 *
 * @param bytes 字节数
 */
function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

export function DebugCaptureDialog() {
  const t = useT();
  const { showResultDialog, lastResult, dismissDialog } = useDebugCaptureStore();

  // 无抓包结果（首次加载 / 从未触发过）→ 整组件不渲染
  if (!lastResult) return null;

  return (
    <Dialog
      open={showResultDialog}
      onOpenChange={(open) => {
        // 用户点遮罩 / Esc / 关闭按钮 → open 变 false → 关闭对话框
        if (!open) dismissDialog();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("debug.captureSaved")}</DialogTitle>
          <DialogDescription>
            {t("debug.captureDesc", {
              // 事件数加千分位（1,234 比 1234 易读）
              count: lastResult.eventCount.toLocaleString(),
              duration: formatDuration(lastResult.durationMs),
              size: formatSize(lastResult.size),
            })}
          </DialogDescription>
        </DialogHeader>

        {/* 日志路径展示 + 复制 */}
        <div className="mt-4 space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t("debug.logPath")}
          </label>
          <div className="flex items-center gap-2">
            {/* 路径文本：select-all 让用户也能手动选中；移动端 py-2.5 增大触控命中区 */}
            <code className="flex-1 select-all break-all rounded-md bg-muted px-3 py-2.5 text-xs md:py-2">
              {lastResult.path}
            </code>
            <CopyButton text={lastResult.path} className="shrink-0" />
          </div>
        </div>

        <DialogFooter>
          {/* 关闭按钮：移动端 min-h-[44px] 触控目标，桌面端收回 */}
          <Button
            variant="outline"
            onClick={dismissDialog}
            className="min-h-[44px] md:min-h-0"
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
