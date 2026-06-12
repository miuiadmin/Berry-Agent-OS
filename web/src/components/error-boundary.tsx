import React, { type ReactNode } from "react";
import { Button } from "./ui/button";
import { AlertCircle } from "lucide-react";
import { tOutside } from "@/lib/i18n";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * 错误边界组件 — class 组件，无法使用 hook
 * 使用统一的 i18n.tOutside 翻译（每次调用读 localStorage，反映最新语言）
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div className="text-center max-w-sm">
            <AlertCircle className="mx-auto size-10 text-destructive opacity-70" />
            <h2 className="mt-4 text-lg font-semibold">{tOutside("errorBoundary.title")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {this.state.error?.message || tOutside("errorBoundary.description")}
            </p>
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
