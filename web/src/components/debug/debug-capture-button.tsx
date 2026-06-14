/**
 * DebugCaptureButton Debug 抓包触发按钮（悬浮 / 工具栏图标）。
 *
 * 行为：
 *  - 点击切换开始 / 停止抓包；抓包中图标脉冲 + 染红提示"破坏性进行中"状态
 *  - loading 中（请求未返回）禁止重复点击，避免连点产生并发 start/stop
 *  - 仅在 DEV 模式或后端 config.debugMode=true 时渲染（生产环境隐藏）
 *
 * 状态来源：useDebugCaptureStore（isCapturing / loading / start / stop / sync）。
 * 挂载时（且仅在进入 debug 模式后）sync 一次真实状态，确保 UI 与后端一致
 * （防页面刷新后 store 还停在旧状态，而抓包其实已被后端停止）。
 *
 * 移动端硬规则：size-11 触控目标（44×44），桌面端 md:size-9 收回紧凑尺寸。
 */

import { Bug } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useDebugCaptureStore } from "@/lib/stores/debug-capture-store";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/api";
import { useT } from "@/lib/i18n";

interface DebugCaptureButtonProps {
  /** 容器额外 className（用于在工具栏里定位 / 调整间距） */
  className?: string;
}

export function DebugCaptureButton({ className }: DebugCaptureButtonProps) {
  const t = useT();
  // 后端 health.debugMode：runtime 是否开启了 debug 级别抓包能力
  const { data: health } = useQuery(queries.health());
  const { isCapturing, loading, start, stop, sync } = useDebugCaptureStore();

  /**
   * 是否显示按钮：后端 debugMode 开启 或 Vite DEV 模式（本地开发）。
   * 两个条件任一满足即显示；都为 false（生产 + 非 debug）返回 null 不渲染。
   */
  const isDebugMode = Boolean(health?.debugMode || import.meta.env.DEV);

  // 进入 debug 模式时同步一次后端真实抓包状态（防刷新后状态不一致）
  useEffect(() => {
    if (isDebugMode) sync();
  }, [isDebugMode, sync]);

  if (!isDebugMode) return null;

  /** 点击处理：loading 阻断 + 当前状态决定 start / stop */
  const handleClick = () => {
    if (loading) return;
    if (isCapturing) stop();
    else start();
  };

  // title / aria-label 文案随状态切换（无障碍 + tooltip 一致）
  const labelKey = isCapturing ? "debug.stopCapturing" : "debug.startCapturing";

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      disabled={loading}
      className={cn(
        // 移动端 size-11（44px）触控目标，桌面端 md:size-9 收回
        "size-11 md:size-9 transition-colors",
        // 抓包中染红：提示这是"破坏性进行中"状态（类似录制按钮）
        isCapturing && "text-destructive",
        className,
      )}
      title={t(labelKey)}
      aria-label={t(labelKey)}
    >
      {/* 抓包中图标脉冲动画，进一步强化"进行中"视觉信号 */}
      <Bug className={cn("size-5 md:size-4", isCapturing && "animate-pulse")} />
    </Button>
  );
}
