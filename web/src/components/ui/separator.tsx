/**
 * 分隔线 — 封装 HeroUI Separator。
 *
 * 保持原有 export 接口（orientation, className），
 * 内部委托 HeroUI Separator 组件。
 */
import { Separator as HeroUISeparator } from "@heroui/react";
import { cn } from "@/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }) {
  return (
    <HeroUISeparator
      orientation={orientation}
      className={cn(className)}
      {...props}
    />
  );
}

export { Separator };
