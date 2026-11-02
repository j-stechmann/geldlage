import { redirect } from "next/navigation"

/**
 * Legacy route: calendar and plan list split into /calendar and /plans.
 * Kept as a redirect so existing bookmarks and links keep working.
 */
export default function PlanungPage() {
  redirect("/plans")
}
