"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  BarChart3,
  CalendarDays,
  ListChecks,
  Tags,
  Upload,
  List,
} from "lucide-react"
import { cn } from "@/lib/utils"

export const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: BarChart3 },
  { href: "/transactions", label: "Transaktionen", icon: List },
  { href: "/calendar", label: "Kalender", icon: CalendarDays },
  { href: "/plans", label: "Planung", icon: ListChecks },
  { href: "/labels", label: "Labels", icon: Tags },
  { href: "/imports", label: "Imports", icon: Upload },
]

export const NAV_LINK_CLASS =
  "flex shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"

export function AppNav() {
  const pathname = usePathname()

  return (
    // min-w-0 + overflow-x-auto: six top-level entries must not push the
    // header wider than the viewport between sm and ~md — the nav scrolls
    // inside its own box instead of overflowing the page (the mobile sheet
    // still takes over below sm).
    <nav className="hidden min-w-0 items-center gap-1 overflow-x-auto sm:flex">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              NAV_LINK_CLASS,
              "py-1.5",
              active && "bg-accent text-foreground"
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
