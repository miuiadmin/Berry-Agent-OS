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
import { useLocale, useT } from "@/lib/i18n";
import { useEffect, useRef } from "react";

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
/** 1GB 的字节数（长时间 debug 抓包可能超过 1GB） */
const BYTES_PER_GB = BYTES_PER_MB * 1024;

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
 * 格式化字节数（B / KB / MB / GB 四档）。
 * GB 档用于长时间 debug 抓包可能产生的超大日志文件。
 *
 * @param bytes 字节数
 */
function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  if (bytes < BYTES_PER_GB) return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

export function DebugCaptureDialog() {
  const t = useT();
  const { locale } = useLocale();
  const { showResultDialog, lastResult, dismissDialog } = useDebugCaptureStore();

  /**
   * 本地缓存最近一次抓包结果：store 的 dismissDialog 会同时清 showResultDialog
   * 和 lastResult，但 Dialog 的关闭动画（data-closed:fade-out-0 zoom-out-95）需要
   * 内容在 open=false 过渡期间仍挂载才能播放。若直接 `if (!lastResult) return null`，
   * 关闭瞬间 DOM 被卸载，用户看到的是"瞬间消失"而非淡出。
   *
   * 解决：用 ref 锁存最近一次非 null 的 lastResult，关闭动画期间仍渲染该快照；
   * 仅当对话框既已关闭（showResultDialog=false）且 store 也清空 lastResult 时
   * 才真正卸载。
   */
  const keepResultRef = useRef<typeof lastResult>(lastResult);
  if (lastResult) {
    // store 有最新结果 → 同步到本地缓存（覆盖关闭期间残留的旧快照）
    keepResultRef.current = lastResult;
  } else if (showResultDialog) {
    // store 已清 lastResult 但对话框还开着（过渡中）→ 保留上一次快照让动画跑完
    // 不更新 ref，沿用之前的值
  } else {
    // 对话框已关 + store 已清 → 卸载，清掉本地缓存
    keepResultRef.current = null;
  }
  const result = keepResultRef.current;

  // 当 store 彻底关闭且本地快照非空 → 同步清空（保持引用一致，避免下次再闪一下旧内容）
  useEffect(() => {
    if (!showResultDialog && !lastResult && keepResultRef.current) {
      keepResultRef.current = null;
    }
  }, [showResultDialog, lastResult]);

  // 完全没有内容可展示（首次加载 / 从未触发过 / 已彻底关闭）→ 不渲染
  if (!result) return null;

  /**
   * 数值本地化映射：把项目的 zh/en locale 转成 Intl 可识别的 BCP 47 tag，
   * 让千分位分隔符与界面语言一致（zh → "1,234" 空格无关，en → "1,234"），
   * 而非依赖浏览器/系统 locale（欧洲 locale 会显示 "1.234" 用点作千分位）。
   */
  const intlLocale: Intl.UnicodeBCP47LocaleIdentifier = locale === "zh" ? "zh-CN" : "en-US";

  return (
    <Dialog
      open={showResultDialog}
      onOpenChange={(open) => {
        // 用户点遮罩 / Esc / 关闭按钮 → open 变 false → 关闭对话框（store 会清状态）
        if (!open) dismissDialog();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("debug.captureSaved")}</DialogTitle>
          <DialogDescription>
            {t("debug.captureDesc", {
              // 事件数加千分位：用项目 locale 而非系统 locale，与界面语言一致
              count: result.eventCount.toLocaleString(intlLocale),
              duration: formatDuration(result.durationMs),
              size: formatSize(result.size),
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
              {result.path}
            </code>
            <CopyButton text={result.path} className="shrink-0" />
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
