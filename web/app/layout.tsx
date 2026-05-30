import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import { Providers } from "./providers";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { ErrorBoundary } from "@/components/error-boundary";
import { KeyboardShortcutsDialog } from "@/components/ui/keyboard-shortcuts-dialog";
import { CommandPalette } from "@/components/ui/command-palette";

export const metadata: Metadata = {
  title: "Berry Dashboard",
  description: "BerryAgent Web Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <Providers>
          <ErrorBoundary>
            <DashboardLayout>{children}</DashboardLayout>
          </ErrorBoundary>
          <KeyboardShortcutsDialog />
          <CommandPalette />
        </Providers>
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
