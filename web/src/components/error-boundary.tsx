/**
 * ErrorBoundary React 错误边界组件。
 *
 * 捕获子组件树中的渲染错误（throw / undefined access / 类型崩溃等），
 * 显示友好的错误提示 + 重试按钮，避免整个应用白屏崩溃。
 *
 * 为什么是 class 组件：React 错误边界（getDerivedStateFromError / componentDidCatch）
 * 是 class-only API，hook（函数组件）无法实现等价能力。
 *
 * i18n：用 `tOutside` 而非 `useT`——class 组件无法用 hook，且 `tOutside` 每次调用
 * 直接读 localStorage，能反映用户最新切换的语言（render 时同步读，无需订阅）。
 *
 * 重试机制：setState({ hasError: false }) 清空错误态 → 子树重新挂载渲染。
 * 注意：仅当错误是瞬时性的（如异步数据未就绪）重试才有效；确定性 bug 会再次抛错，
 * 但 React 会再次捕获并回到 fallback UI（不会崩溃到白屏）。
 *
 * 用法：
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 *
 *   // 自定义 fallback（默认错误页不合适时）
 *   <ErrorBoundary fallback={<CustomError />}>
 *     <RiskyComponent />
 *   </ErrorBoundary>
 */

import React, { type ReactNode } from "react";
import { Button } from "./ui/button";
import { AlertCircle } from "lucide-react";
import { tOutside } from "@/lib/i18n";

interface Props {
  children: ReactNode;
  /** 自定义降级 UI（不传则用默认错误页 DefaultErrorFallback） */
  fallback?: ReactNode;
}

interface State {
  /** 是否进入错误态（true = 渲染 fallback） */
  hasError: boolean;
  /** 捕获到的错误对象（用于展示 message；null = 无错误） */
  error: Error | null;
}

/**
 * 默认错误降级 UI：图标 + 标题 + 描述 + 重试按钮。
 * 抽成独立组件便于阅读，行为与内联一致（仍由 ErrorBoundary 控制 render / reset）。
 */
function DefaultErrorFallback({
  error,
  onRetry,
}: {
  error: Error | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <AlertCircle className="mx-auto size-10 text-destructive opacity-70" />
        <h2 className="mt-4 text-lg font-semibold">{tOutside("errorBoundary.title")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {/* 优先展示具体错误信息（更有助于排查），缺失时用通用描述 */}
          {error?.message || tOutside("errorBoundary.description")}
        </p>
        {/* 重试按钮：移动端 h-10（40px，接近 44px HIG 标准），桌面端 h-7 收回 */}
        <Button
          variant="outline"
          size="sm"
          className="mt-4 h-10 md:h-7 px-4 md:px-2.5"
          onClick={onRetry}
        >
          {tOutside("errorBoundary.tryAgain")}
        </Button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  /**
   * 渲染阶段同步更新 state（React 16+ 错误边界契约）。
   * 不能在这里做副作用（fetch / log），副作用归 componentDidCatch。
   */
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  /**
   * commit 阶段副作用：记录错误到 console（含 componentStack 定位出错组件）。
   * 生产环境可在此接入 Sentry / 自建上报（当前仅 console.error）。
   */
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  /** 重置错误态，让子树重新渲染（"重试"按钮回调） */
  private reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      // 调用方提供自定义 fallback 时优先使用（不调用默认 UI）
      if (this.props.fallback) return this.props.fallback;
      return <DefaultErrorFallback error={this.state.error} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
