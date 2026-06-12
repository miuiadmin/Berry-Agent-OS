/**
 * 标签页 — 封装 HeroUI Tabs/Tab。
 *
 * 保持原有 export 接口（Tabs/TabsList/TabsTrigger/TabsContent），
 * 内部委托 HeroUI Tabs + Tab。
 *
 * 映射：
 * - value → selectedKey（HeroUI 用 key 字符串）
 * - onValueChange → onSelectionChange
 * - TabsTrigger value prop → Tab key prop
 * - TabsContent value → 条件渲染（仅渲染匹配的 tab 内容）
 */
import * as React from "react";
import { Tabs as HeroUITabs, Tab } from "@heroui/react";
import { cn } from "@/lib/utils";

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue>({ value: "", onValueChange: () => {} });

function Tabs({
  value,
  onValueChange,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { value: string; onValueChange: (v: string) => void }) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={cn("flex flex-col", className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  /* 从 children（TabsTrigger）中读取 context value 用于高亮 */
  return (
    <div
      role="tablist"
      className={cn("inline-flex h-11 md:h-9 items-center gap-1 rounded-lg bg-muted p-1", className)}
      {...props}
    />
  );
}

function TabsTrigger({
  value,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const ctx = React.useContext(TabsContext);
  const isActive = ctx.value === value;

  return (
    <button
      role="tab"
      aria-selected={isActive}
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        "inline-flex items-center justify-center rounded-md px-3 py-2 md:py-1 text-sm font-medium transition-colors min-h-[44px] md:min-h-0",
        isActive ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function TabsContent({
  value,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const ctx = React.useContext(TabsContext);
  if (ctx.value !== value) return null;
  return <div key={value} className={cn("mt-2 animate-tab-in", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
