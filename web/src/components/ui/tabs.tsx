"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TabsContextValue {
  value: string;
  onValueChange: (value: string) => void;
}

const TabsContext = React.createContext<TabsContextValue>({ value: "", onValueChange: () => {} });

function Tabs({ value, onValueChange, className, children, ...props }: React.HTMLAttributes<HTMLDivElement> & { value: string; onValueChange: (v: string) => void }) {
  return (
    <TabsContext.Provider value={{ value, onValueChange }}>
      <div className={cn("flex flex-col", className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex h-11 md:h-9 items-center gap-1 rounded-lg bg-muted p-1", className)}
      {...props}
    />
  );
}

function TabsTrigger({ value, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
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
    />
  );
}

function TabsContent({ value, className, ...props }: React.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const ctx = React.useContext(TabsContext);
  if (ctx.value !== value) return null;
  return <div key={value} className={cn("mt-2 animate-tab-in", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
