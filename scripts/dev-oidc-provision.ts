/**
 * Provisions the geldlage OIDC client in the dev Authentik instance
 * (compose.dev.yaml) via its API. Idempotent: existing provider/application
 * are detected and left alone, so re-running after `make oidc` restarts or
 * `make oidc-stop` is safe.
 *
 * Run: bun scripts/dev-oidc-provision.ts
 * Env: OIDC_CLIENT_ID / OIDC_CLIENT_SECRET (defaults match .env),
 *      AUTHENTIK_BOOTSTRAP_TOKEN (must match compose.dev.env)
 *
 * First boot runs database migrations and can take a minute — the script
 * polls /-/health/ready/ before talking to the API.
 */
import { getConfig } from "../lib/config"

const HOST = "http://localhost:8081"
const API = `${HOST}/api/v3`
// compose.dev.yaml sources AUTHENTIK_BOOTSTRAP_TOKEN from the gitignored
// compose.dev.env — no token default here, a mismatch fails loudly at the
// first API call instead of silently provisioning against the wrong stack.
const TOKEN = process.env.AUTHENTIK_BOOTSTRAP_TOKEN
const APP_SLUG = "geldlage"
// Must stay in sync with .env (the app reads the same values). Kept as a
// module-level default so findProvider() works before main() loads config.
let clientId = process.env.OIDC_CLIENT_ID ?? "geldlage"
// Both hosts (localhost / 127.0.0.1) plus 3001: `make dev` may pick a
// fallback port when 3000 is taken (e.g. `make app` while another dev
// server runs).
const REDIRECT_URIS = [3000, 3001].flatMap((port) =>
  ["localhost", "127.0.0.1"].map(
    (host) => `http://${host}:${port}/auth/callback`
  )
)

function die(message: string): never {
  console.error(`[dev-oidc] ${message}`)
  process.exit(1)
}

/** Authentik list endpoints return DRF paginated responses. */
interface Paginated<T> {
  results: T[]
  next: string | null
}

async function api<T>(
  path: string,
  init?: RequestInit
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  if (res.status === 204) return { status: res.status, data: null }
  const text = await res.text()
  let data: T | null = null
  if (text) {
    try {
      data = JSON.parse(text) as T
    } catch {
      data = null
    }
  }
  return { status: res.status, data }
}

/** GET a paginated list endpoint, transparently following `next` pages. */
async function apiList<T>(path: string): Promise<T[]> {
  const out: T[] = []
  let url: string | null = path
  while (url) {
    const current: string = url
    const { status, data }: { status: number; data: Paginated<T> | null } =
      await api<Paginated<T>>(current)
    if (status !== 200 || !data || !Array.isArray(data.results)) {
      // thrown (not die) so the waitFor lookups catch a transient API
      // failure during first boot as "not yet" instead of exiting mid-poll
      throw new Error(`listing ${current} failed (status ${status})`)
    }
    out.push(...data.results)
    url = data.next
      ? new URL(data.next, API).pathname + new URL(data.next, API).search
      : null
  }
  return out
}

async function waitForReady(): Promise<void> {
  process.stdout.write("[dev-oidc] waiting for Authentik to become ready")
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${HOST}/-/health/ready/`)
      if (res.ok) {
        console.log(" ready")
        return
      }
    } catch {
      // not up yet
    }
    process.stdout.write(".")
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log("")
  die("Authentik did not become ready within 120s — see: make oidc-logs")
}

interface PropertyMapping {
  pk: string
  name: string
  scope_name: string
}

/**
 * First-boot race: /-/health/ready/ answers 200 while Authentik is still
 * applying the system blueprints that create the default flows and scope
 * property mappings — the very first (fresh volume) provisioning run found
 * its lookups empty and died, while every re-run passed. Poll until the
 * object appears (blueprints apply within seconds of readiness) instead of
 * trusting a single successful HTTP status; a genuinely absent object (or
 * a broken tenant) only fails after the timeout.
 */
async function waitFor<T>(
  label: string,
  lookup: () => Promise<T | null>,
  timeoutSeconds = 120
): Promise<T> {
  process.stdout.write(`[dev-oidc] waiting for ${label}`)
  const deadline = Date.now() + timeoutSeconds * 1000
  for (;;) {
    try {
      const found = await lookup()
      if (found !== null) {
        console.log(" ok")
        return found
      }
    } catch {
      // transient network/API hiccups during first boot count as "not yet"
    }
    if (Date.now() >= deadline) {
      console.log("")
      die(`${label} not found within ${timeoutSeconds}s`)
    }
    process.stdout.write(".")
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** All three scopes mapped, or null (during blueprint application). */
async function scopeMappingPkLookup(): Promise<string[] | null> {
  const scopes = ["openid", "profile", "email"]
  const mappings = await apiList<PropertyMapping>(
    "/propertymappings/provider/scope/"
  )
  const pks: string[] = []
  for (const scope of scopes) {
    const found = mappings.find((m) => m.scope_name === scope)
    if (!found) return null
    pks.push(found.pk)
  }
  return pks
}

interface Provider {
  pk: number
  name: string
  authorization_flow: string
  property_mappings: string[]
}

async function findProvider(): Promise<Provider | null> {
  const providers = await apiList<Provider>(
    `/providers/oauth2/?client_id=${encodeURIComponent(clientId)}`
  )
  return providers[0] ?? null
}

async function findApplication(): Promise<{ slug: string } | null> {
  const apps = await apiList<{ slug: string }>(
    `/core/applications/?slug=${APP_SLUG}`
  )
  return apps[0] ?? null
}

async function main(): Promise<void> {
  const cfg = getConfig()
  clientId = cfg.OIDC_CLIENT_ID
  const clientSecret = cfg.OIDC_CLIENT_SECRET
  await waitForReady()

  // Authorization flow: default "implicit consent" — one login screen, no
  // extra consent prompt (dev convenience; explicit consent is a
  // homelab-hardening choice, not a dev requirement).
  const authorizationFlow = await waitFor(
    "implicit-consent authorization flow",
    async () => {
      const flows = await apiList<{ pk: string; slug: string }>(
        "/flows/instances/?designation=authorization"
      )
      return flows.find((f) => f.slug.includes("implicit-consent")) ?? null
    }
  )
  const invalidationFlow = await waitFor(
    "default invalidation flow",
    async () => {
      const flows = await apiList<{ pk: string; slug: string }>(
        "/flows/instances/?designation=invalidation"
      )
      return flows.find((f) => f.slug === "default-invalidation-flow") ?? null
    }
  )

  const mappings = await waitFor(
    "scope property mappings",
    scopeMappingPkLookup
  )
  const providerPayload = {
    name: "geldlage",
    client_id: clientId,
    client_secret: clientSecret,
    authorization_flow: authorizationFlow.pk,
    invalidation_flow: invalidationFlow.pk,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: REDIRECT_URIS.map((url) => ({
      matching_mode: "strict",
      url,
      redirect_uri_type: "authorization",
    })),
    sub_mode: "user_username",
    property_mappings: mappings,
  }
  let provider = await findProvider()
  if (!provider) {
    const { status, data } = await api<Provider>("/providers/oauth2/", {
      method: "POST",
      body: JSON.stringify(providerPayload),
    })
    if (status !== 201 || !data) {
      die(`creating OAuth2 provider failed (status ${status})`)
    }
    provider = data
    console.log(`[dev-oidc] provider created (pk ${provider.pk})`)
  } else {
    // Reconcile: keep the provider in sync with .env (secret rotation,
    // redirect URIs) so a changed config can't silently break login with
    // `invalid_client` / `invalid_request`.
    const { status } = await api<Provider>(
      `/providers/oauth2/${provider.pk}/`,
      {
        method: "PATCH",
        body: JSON.stringify(providerPayload),
      }
    )
    if (status !== 200) {
      die(`updating existing provider failed (status ${status})`)
    }
    console.log(`[dev-oidc] provider exists (pk ${provider.pk}) — reconciled`)
  }

  if (!(await findApplication())) {
    const { status } = await api("/core/applications/", {
      method: "POST",
      body: JSON.stringify({
        name: "geldlage",
        slug: APP_SLUG,
        provider: provider.pk,
      }),
    })
    if (status !== 201) {
      die(`creating application failed (status ${status})`)
    }
    console.log("[dev-oidc] application created")
  } else {
    console.log("[dev-oidc] application exists — left as is")
  }

  console.log(
    `[dev-oidc] ready — issuer: ${HOST}/application/o/${APP_SLUG}/\n` +
      `           login as akadmin (bootstrap password from compose.dev.env)\n` +
      `           admin UI: ${HOST}/if/admin/`
  )
}

main()
