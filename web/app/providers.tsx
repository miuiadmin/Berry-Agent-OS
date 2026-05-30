"use client";

import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRealtimeEvents } from "@/hooks/use-realtime-events";
import { useWsStore } from "@/lib/stores/ws-store";

function ConnectionToastProvider({ children }: { children: React.ReactNode }) {
  const status = useWsStore((s) => s.status);
  const hasConnectedOnce = useRef(false);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastId = useRef<string | number | null>(null);

  useEffect(() => {
    if (status === "connected") {
      hasConnectedOnce.current = true;
      if (disconnectTimer.current) {
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
      if (toastId.current) {
        toast.dismiss(toastId.current);
        toast.success("Reconnected", { duration: 2000 });
        toastId.current = null;
      }
    } else if (status === "disconnected" && hasConnectedOnce.current) {
      if (!disconnectTimer.current) {
        disconnectTimer.current = setTimeout(() => {
          toastId.current = toast.warning("Connection lost. Reconnecting...", {
            duration: Infinity,
          });
          disconnectTimer.current = null;
        }, 3000);
      }
    }
    return () => {
      if (disconnectTimer.current) {
        clearTimeout(disconnectTimer.current);
        disconnectTimer.current = null;
      }
    };
  }, [status]);

  return <>{children}</>;
}

function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const connect = useWsStore((s) => s.connect);

  useEffect(() => {
    connect();
  }, [connect]);

  useRealtimeEvents();
  return (
    <ConnectionToastProvider>
      {children}
    </ConnectionToastProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5000, retry: 2 },
    },
    mutationCache: new MutationCache({
      onError: (error) => {
        const message = error instanceof Error ? error.message : "Operation failed";
        toast.error(message);
      },
    }),
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <RealtimeProvider>{children}</RealtimeProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
