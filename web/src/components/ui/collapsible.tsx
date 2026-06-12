/**
 * 折叠面板 — 封装 HeroUI v3 Disclosure compound 组件。
 *
 * 单元素展开/收起，支持受控与非受控两种模式：
 *   <Collapsible open={expanded} onOpenChange={setExpanded}>
 *     <CollapsibleTrigger>标题</CollapsibleTrigger>
 *     <CollapsibleContent>内容</CollapsibleContent>
 *   </Collapsible>
 *
 * 映射到 HeroUI Disclosure.Root > Trigger + Content。
 * 自动处理展开动画、ARIA 属性、键盘交互。
 */
"use client";

import * as React from "react";
import { Disclosure as HeroUIDisclosure } from "@heroui/react";
import { cn } from "@/lib/utils";

/** 折叠面板容器 props */
interface CollapsibleProps {
  /** 受控展开状态（与 onOpenChange 配合）；不传则非受控 */
  open?: boolean;
  /** 非受控默认展开 */
  defaultOpen?: boolean;
  /** 展开状态变化回调 */
  onOpenChange?: (open: boolean) => void;
  /** 透传 className */
  className?: string;
  /** 子组件（Trigger + Content） */
  children?: React.ReactNode;
}

/** 折叠面板容器。映射到 HeroUI Disclosure.Root（react-aria 用 isExpanded 命名） */
function Collapsible({ open, defaultOpen, onOpenChange, className, children }: CollapsibleProps) {
  return (
    <HeroUIDisclosure
      isExpanded={open}
      defaultExpanded={defaultOpen}
      onExpandedChange={onOpenChange}
      className={cn(className)}
    >
      {children}
    </HeroUIDisclosure>
  );
}

/** 折叠触发器 props */
interface CollapsibleTriggerProps {
  className?: string;
  children?: React.ReactNode;
}

/** 折叠触发器。映射到 HeroUI Disclosure.Trigger，移动端 44px 触控目标 */
function CollapsibleTrigger({ className, children }: CollapsibleTriggerProps) {
  return (
    <HeroUIDisclosure.Trigger
      className={cn("min-h-[44px] md:min-h-0", className)}
    >
      {children}
    </HeroUIDisclosure.Trigger>
  );
}

/** 折叠内容 props */
interface CollapsibleContentProps {
  className?: string;
  children?: React.ReactNode;
}

/** 折叠内容。映射到 HeroUI Disclosure.Content，自动展开/收起动画 */
function CollapsibleContent({ className, children }: CollapsibleContentProps) {
  return <HeroUIDisclosure.Content className={cn(className)}>{children}</HeroUIDisclosure.Content>;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
