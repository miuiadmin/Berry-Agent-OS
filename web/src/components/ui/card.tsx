/**
 * 卡片 — 封装 HeroUI v3 Card。
 *
 * 保持原有 export 接口不变：
 *   Card / CardHeader / CardTitle / CardDescription / CardContent / CardFooter
 *
 * 内部委托 HeroUI v3 Card 组件（CardRoot / CardHeader / CardTitle /
 * CardDescription / CardContent / CardFooter）。
 *
 * 注意：HeroUI v3 没有 CardBody，已改名为 CardContent，
 * 因此我们的 CardContent 可以直接映射，无需别名。
 */
import * as React from "react";
import {
  Card as HeroUICard,
  CardHeader as HeroUICardHeader,
  CardTitle as HeroUICardTitle,
  CardDescription as HeroUICardDescription,
  CardContent as HeroUICardContent,
  CardFooter as HeroUICardFooter,
} from "@heroui/react";
import { cn } from "@/lib/utils";

/** 卡片容器，委托 HeroUI CardRoot，保持原有边框/背景样式 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <HeroUICard
      ref={ref}
      className={cn("border border-border bg-card text-card-foreground", className)}
      {...props}
    />
  )
);
Card.displayName = "Card";

/** 卡片头部，委托 HeroUI CardHeader，保持原有间距 */
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <HeroUICardHeader
      ref={ref}
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
);
CardHeader.displayName = "CardHeader";

/** 卡片标题，委托 HeroUI CardTitle，保持原有字号 */
const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <HeroUICardTitle
      ref={ref}
      className={cn("text-sm font-semibold leading-none", className)}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

/** 卡片描述，委托 HeroUI CardDescription，保持原有样式 */
const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <HeroUICardDescription
    ref={ref}
    className={cn("text-xs text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

/** 卡片内容区，委托 HeroUI CardContent（v3 已更名为 CardContent），保持原有内边距 */
const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <HeroUICardContent
      ref={ref}
      className={cn("p-4 pt-0", className)}
      {...props}
    />
  )
);
CardContent.displayName = "CardContent";

/** 卡片底部，委托 HeroUI CardFooter */
const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <HeroUICardFooter
      ref={ref}
      className={cn("flex items-center p-4 pt-0", className)}
      {...props}
    />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
