"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BarChart3, Tags, Upload, List } from "lucide-react"
import { cn } from "@/lib/utils"

export const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: BarChart3 },
  { href: "/transactions", label: "Transaktionen", icon: List },
  { href: "/labels", label: "Labels", icon: Tags },
  { href: "/imports", label: "Imports", icon: Upload },
]

export const NAV_LINK_CLASS =
  "flex items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"

export function AppNav() {
  const pathname = usePathname()

  return (
    <nav className="hidden items-center gap-1 sm:flex">
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
