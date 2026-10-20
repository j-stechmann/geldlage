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
          {/* Full-bleed app shell — deliberate (ADR-0033 "UI composition"):
              composing the agent dock as the right column of the content
              row dropped the old centered mx-auto max-w-7xl cap. Header
              and page content render full-width on every viewport, dock
              open or closed; do not re-add a width cap here. `<main>`
              carries the two classes that keep the shell responsive while
              the dock is open: `min-w-0` overrides the flex-item default
              `min-width: auto` (without it main refuses to shrink below
              its content's intrinsic width and the page overflows with a
              horizontal scrollbar instead of reflowing), and `@container`
              turns main into the query container the page grids key off —
              their breakpoints track the width actually left of the dock,
              not the viewport. Caveat: `@container` implies layout
              containment, so `<main>` becomes the containing block for
              `position: fixed` descendants — anything fixed must be
              portaled to body (dialogs/selects already are; overlays like
              the drag scrim and the import pill live in Providers, outside
              main). */}
          <div className="flex min-h-svh flex-col">
            <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <div className="flex h-14 w-full items-center justify-between gap-4 px-4">
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
            <div className="flex w-full flex-1 items-stretch">
              <main className="@container w-full max-w-full min-w-0 flex-1 px-4 py-6">
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
