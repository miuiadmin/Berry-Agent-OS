/**
 * ErrorBoundary React 错误边界组件。
 *
 * 捕获子组件树中的渲染错误，显示友好的错误提示 + 重试按钮，
 * 避免整个应用白屏崩溃。React 错误边界必须是 class 组件（hook 不支持）。
 *
 * 注意：用 tOutside 而非 useT —— class 组件无法用 hook，
 * tOutside 每次调用读 localStorage，反映最新语言设置。
 *
 * 用法：
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 *
 *   // 自定义 fallback
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
  /** 自定义降级 UI（不传则用默认错误页） */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  /** 渲染错误时同步更新 state，触发 fallback 渲染 */
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  /** 错误日志（补充 getDerivedStateFromError 不能有的副作用） */
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      // 调用方提供自定义 fallback 时优先使用
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <AlertCircle className="mx-auto size-10 text-destructive opacity-70" />
            <h2 className="mt-4 text-lg font-semibold">{tOutside("errorBoundary.title")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {/* 优先展示具体错误信息，缺失时用通用描述 */}
              {this.state.error?.message || tOutside("errorBoundary.description")}
            </p>
            {/* 重试：清空 state 让子树重新渲染（移动端 44px 触控目标） */}
            <Button
              variant="outline"
              size="sm"
              className="mt-4 h-10 md:h-7 px-4 md:px-2.5"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              {tOutside("errorBoundary.tryAgain")}
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
