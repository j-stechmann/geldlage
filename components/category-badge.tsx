"use client"

import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { resolveCategoryColor } from "@/lib/category-colors"
import { cn } from "@/lib/utils"

/** Resolved category badge shared by the transactions row and plans list. */
export function CategoryBadge({
  categoryId,
  name,
  color,
  className,
}: {
  categoryId: number | null
  name: string
  color: string | null
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn("category-badge font-normal", className)}
      style={
        {
          "--category-color": resolveCategoryColor(categoryId, color),
        } as React.CSSProperties
      }
    >
      {name}
    </Badge>
  )
}
