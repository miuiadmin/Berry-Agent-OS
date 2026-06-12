/**
 * 标签页 — 封装 HeroUI v3 Tabs compound 组件。
 *
 * 精简 adapter：直接利用 HeroUI Tabs.Root 的 selectedKey 驱动选中态，
 * Tabs.Tab 与 Tabs.Panel 通过 id 自动匹配（无需自定义 context）。
 *
 * 映射：
 * - value             → selectedKey（HeroUI 用 key 字符串）
 * - onValueChange     → onSelectionChange（Key → string 转换）
 * - TabsTrigger value → Tabs.Tab id
 * - TabsContent value → Tabs.Panel id
 *
 * 关于 props 透传：HeroUI compound 子组件有自己的 props 类型，
 * 与标准 HTML 属性不完全兼容，因此只显式透传 className/children，避免类型冲突。
 */
"use client";

import * as React from "react";
import { Tabs as HeroUITabs } from "@heroui/react";
import { cn } from "@/lib/utils";

/** Tabs 外壳接受的 props */
interface TabsProps {
  /** 受控选中的 tab key */
  value: string;
  /** tab 切换回调 */
  onValueChange: (v: string) => void;
  /** 透传 className */
  className?: string;
  /** tab 子组件（TabsList / TabsContent） */
  children?: React.ReactNode;
}

/**
 * Tabs 外壳。映射到 HeroUI Tabs.Root，
 * 把 value/onValueChange 转成 selectedKey/onSelectionChange。
 */
function Tabs({ value, onValueChange, className, children }: TabsProps) {
  return (
    <HeroUITabs
      selectedKey={value}
      onSelectionChange={(key) => {
        /* Key 可能是 string 或 number，统一转 string */
        if (key != null) onValueChange(String(key));
      }}
      className={cn("flex flex-col", className)}
    >
      {children}
    </HeroUITabs>
  );
}

/** Tab 列表容器 props */
interface TabsListProps {
  /** 透传 className */
  className?: string;
  /** TabsTrigger 子组件 */
  children?: React.ReactNode;
}

/**
 * Tab 列表容器。映射到 HeroUI Tabs.List。
 * 水平排列、居中、圆角背景，移动端触控目标 44px。
 */
function TabsList({ className, children }: TabsListProps) {
  return (
    <HeroUITabs.List
      className={cn(
        "inline-flex h-11 md:h-9 items-center gap-1 rounded-lg bg-muted p-1",
        className
      )}
    >
      {children}
    </HeroUITabs.List>
  );
}

/** 单个 tab 触发器 props */
interface TabsTriggerProps {
  /** 该 tab 的唯一 key（对应 Tabs 的 value） */
  value: string;
  /** 透传 className */
  className?: string;
  /** tab 文案内容 */
  children?: React.ReactNode;
}

/**
 * 单个 tab 触发器。映射到 HeroUI Tabs.Tab。
 * value prop 转为 Tab 的 id（react-aria 用 id 做 key 匹配）。
 * 选中态由 react-aria 的 data-selected 属性驱动，移动端 44px 触控目标。
 */
function TabsTrigger({ value, className, children }: TabsTriggerProps) {
  return (
    <HeroUITabs.Tab
      id={value}
      className={cn(
        "inline-flex items-center justify-center rounded-md px-3 py-2 md:py-1 text-sm font-medium transition-colors min-h-[44px] md:min-h-0",
        /* 选中态：Tailwind v4 data 属性变体语法 */
        "data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow-sm",
        /* 未选中：弱化文字色，hover 恢复前景色 */
        "text-muted-foreground hover:text-foreground",
        className
      )}
    >
      {children}
    </HeroUITabs.Tab>
  );
}

/** Tab 面板 props */
interface TabsContentProps {
  /** 该面板对应的 tab key（与 TabsTrigger value 匹配） */
  value: string;
  /** 透传 className */
  className?: string;
  /** 面板内容 */
  children?: React.ReactNode;
}

/**
 * Tab 面板。映射到 HeroUI Tabs.Panel。
 * HeroUI Panel 内部会根据 selectedKey 自动显隐对应面板。
 */
function TabsContent({ value, className, children }: TabsContentProps) {
  return (
    <HeroUITabs.Panel id={value} className={cn("mt-2", className)}>
      {children}
    </HeroUITabs.Panel>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
