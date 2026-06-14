/**
 * DebugCaptureButton Debug 抓包触发按钮。
 *
 * 悬浮 / 工具栏图标按钮，点击切换开始/停止抓包。抓包中图标脉冲 + 染红。
 * 仅在 DEV 模式或 config.debugEnabled=true 时渲染（生产环境隐藏）。
 *
 * 状态来源：useDebugCaptureStore（isCapturing / loading / start / stop / sync）。
 * 挂载时 sync 一次，确保 UI 与后端真实抓包状态一致（防刷新后状态丢失）。
 *
 * 移动端硬规则：size-11 触控目标，桌面端 md:size-9。
 */

import { Bug } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useDebugCaptureStore } from "@/lib/stores/debug-capture-store";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function DebugCaptureButton({ className }: { className?: string }) {
  const t = useT();
  const { data: health } = useQuery(queries.health());
  const { isCapturing, loading, start, stop, sync } = useDebugCaptureStore();

  // 后端 debugMode 开关 或 Vite DEV 模式才显示
  const isDebugMode = health?.debugMode || import.meta.env.DEV;

  // 进入 debug 模式时同步一次真实状态
  useEffect(() => { if (isDebugMode) sync(); }, [isDebugMode, sync]);

  if (!isDebugMode) return null;

  const handleClick = () => {
    // loading 中禁止重复点击
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
        // 抓包中染红提示破坏性状态
        isCapturing && "text-destructive",
        className,
      )}
      title={isCapturing ? t("debug.stopCapturing") : t("debug.startCapturing")}
      aria-label={isCapturing ? t("debug.stopCapturing") : t("debug.startCapturing")}
    >
      <Bug className={cn("size-5 md:size-4", isCapturing && "animate-pulse")} />
    </Button>
  );
}
