import { AppNav } from "@/components/app-nav"
import { MobileNav } from "@/components/mobile-nav"
import { Providers } from "@/components/providers"
import { LabellerHealthBadge } from "@/components/labeller-health-badge"
import { Logo } from "@/components/logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { HeaderUserChip } from "@/components/user-chip"
import { AgentToggle } from "@/components/agent/agent-toggle"
import { AgentDock } from "@/components/agent/agent-dock"
import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: {
    template: "%s | Geldlage",
    default: "Geldlage",
  },
  description: "Analyse von Bank-CSV-Exporten mit lokalem LLM-Labeling",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body className="font-serif antialiased">
        <Providers>
          <div className="flex min-h-svh flex-col">
            <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-4">
                <div className="flex items-center gap-6">
                  <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                    <Logo className="size-6" />
                    Geldlage
                  </span>
                  <AppNav />
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <AgentToggle />
                  <LabellerHealthBadge />
                  <ThemeToggle />
                  <HeaderUserChip />
                  <MobileNav />
                </div>
              </div>
            </header>
            <div className="mx-auto flex w-full max-w-7xl flex-1 items-stretch">
              <main className="w-full max-w-full flex-1 px-4 py-6">
                {children}
              </main>
              <AgentDock />
            </div>
          </div>
        </Providers>
      </body>
    </html>
  )
}
