"use client"

/**
 * fetch wrapper: a 401 (expired/tampered session) bounces the browser to
 * /auth/login to start a fresh OIDC round-trip. All API calls go through
 * this so a mid-session expiry recovers without a manual reload.
 */
export async function apiFetch(
  input: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(input, init)
  if (res.status === 401) {
    const ct = res.headers.get("content-type") ?? ""
    if (ct.includes("application/json")) {
      // Full-page load is intentional: /auth/login is a route handler that
      // starts a fresh OIDC round-trip, so client-side router navigation
      // (unavailable in this non-component wrapper) is not what we want.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/auth/login"
    }
  }
  return res
}
