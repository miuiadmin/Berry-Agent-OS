"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface ShortcutEntry {
  keys: string[];
  description: string;
}

const SHORTCUTS: { section: string; items: ShortcutEntry[] }[] = [
  {
    section: "Navigation",
    items: [
      { keys: ["⌘", "K"], description: "Open command palette" },
      { keys: ["?"], description: "Show keyboard shortcuts" },
    ],
  },
  {
    section: "Chat",
    items: [
      { keys: ["⌘", "N"], description: "New conversation" },
      { keys: ["Enter"], description: "Send message" },
      { keys: ["Shift", "Enter"], description: "New line" },
      { keys: ["Esc"], description: "Close sidebar / cancel" },
    ],
  },
  {
    section: "General",
    items: [
      { keys: ["⌘", "\\"], description: "Toggle sidebar" },
    ],
  },
];

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card shadow-lg mx-4">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Keyboard Shortcuts</h2>
          <button
            onClick={() => setOpen(false)}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-5 space-y-5">
          {SHORTCUTS.map((group) => (
            <div key={group.section}>
              <h3 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {group.section}
              </h3>
              <div className="space-y-2">
                {group.items.map((item) => (
                  <div key={item.description} className="flex items-center justify-between">
                    <span className="text-sm text-foreground">{item.description}</span>
                    <div className="flex items-center gap-1">
                      {item.keys.map((key) => (
                        <kbd
                          key={key}
                          className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-border px-5 py-3">
          <p className="text-[11px] text-muted-foreground text-center">
            Press <kbd className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-border bg-muted px-1 text-[9px] font-medium">?</kbd> to toggle this dialog
          </p>
        </div>
      </div>
    </div>
  );
}
