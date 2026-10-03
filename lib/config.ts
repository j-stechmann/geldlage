import { z } from "zod"

const envSchema = z.object({
  DATABASE_PATH: z.string().default("./data/geldlage.db"),
  LLM_BASE_URL: z.string().url().default("http://127.0.0.1:8080"),
  LLM_LANGUAGE: z
    .string()
    .regex(/^[a-z]{2}$/)
    .default("de"),
  LLM_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  /**
   * Per-request timeout. Default 900 s, sized for the reference machine
   * (Ryzen 5 5600X + RTX 3070 Ti, ~3.5–4 t/s generation): the theoretical
   * ceiling at the default batch size (1024-token trace reserve + full
   * 96-token/item label JSON ≈ 2944 tokens ≈ 740–840 s) plus prompt eval
   * must fit, because timeouts are never retried — the caller marks the
   * rows failed. A raised LLM_BATCH_SIZE can push the worst case past it.
   */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(900_000),
  LLM_CTX: z.coerce.number().int().min(1024).default(8192),
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LLM_MAX_LABELS_PROMPT: z.coerce.number().int().min(0).default(200),
  /**
   * Whether the llama-server behind LLM_BASE_URL runs with `--reasoning on`.
   * Both spellings are accepted — `true`/`false` (env-boolean convention)
   * and `on`/`off` (the server flag's vocabulary) — and normalized, so an
   * exported `LLM_REASONING=on` works for both the Makefile and the app
   * (the Makefile normalizes the same way onto llama-server's on/off).
   */
  LLM_REASONING: z
    .string()
    .regex(/^(true|false|on|off)$/)
    .default("true")
    .transform((v) => v === "true" || v === "on"),
  /**
   * Thinking tokens reserved per request when LLM_REASONING is enabled: the
   * model's reasoning counts against max_tokens, so the budget must be
   * added on top of the label budget or the JSON truncates deterministically.
   * Default 1024: sized for the reference machine (Ryzen 5 5600X +
   * RTX 3070 Ti, ~3.5–4 t/s) so a worst-case request fits LLM_TIMEOUT_MS
   * (900 s). Enforced per request: the client pins llama-server's
   * thinking cap to this value (`reasoning_budget_tokens` in the request
   * body), so the server's `--reasoning-budget` flag is a fallback cap,
   * not a sync requirement.
   */
  LLM_REASONING_BUDGET: z.coerce.number().int().min(0).default(1024),
  OIDC_ISSUER_URL: z.string().url(),
  /** Pre-rebrand issuer; when set, users still keyed on it are migrated once (lib/db). */
  LEGACY_OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_SCOPES: z.string().default("openid profile email"),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(7 * 24 * 3600),
  SESSION_SECRET: z.string().min(32).optional(),
  APP_ORIGIN: z.string().url().optional(),
})

/**
 * With reasoning on, budget 0 is rejected: as a client-side reserve, 0
 * leaves max_tokens unreserved — the thinking trace eats into the label
 * JSON and truncates it — and a server-side budget of 0 is llama-server's
 * end-thinking-immediately, which LLM_REASONING=false already expresses.
 * (With reasoning off the budget is unused; 0 is then accepted.)
 */
const schemaWithCrossFieldChecks = envSchema.superRefine((cfg, ctx) => {
  if (cfg.LLM_REASONING && cfg.LLM_REASONING_BUDGET < 1) {
    ctx.addIssue({
      code: "custom",
      path: ["LLM_REASONING_BUDGET"],
      message:
        "must be >= 1 when LLM_REASONING=true/on (a 0 reserve lets the thinking trace eat into the label JSON and truncate it; server-side budget 0 ends thinking immediately — set LLM_REASONING=false for that)",
    })
  }
})

export type AppConfig = z.infer<typeof envSchema>

let cached: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!cached) {
    const parsed = schemaWithCrossFieldChecks.safeParse(process.env)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
      throw new Error(`Invalid environment configuration: ${issues}`)
    }
    cached = parsed.data
  }
  return cached
}

export function resetConfigCache() {
  cached = null
}
