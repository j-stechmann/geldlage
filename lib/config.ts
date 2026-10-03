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
   * Per-request timeout. Default 600 s, sized for the reference machine
   * (Ryzen 5 5600X + RTX 3070 Ti, ~3.5–4 t/s generation): a reasoning-on
   * worst case (full thinking trace + label JSON + prompt eval) must fit,
   * because timeouts are never retried — the caller marks the rows failed.
   */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(600_000),
  LLM_CTX: z.coerce.number().int().min(1024).default(8192),
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LLM_MAX_LABELS_PROMPT: z.coerce.number().int().min(0).default(200),
  /** Whether the llama-server behind LLM_BASE_URL runs with `--reasoning on`. */
  LLM_REASONING: z
    .string()
    .regex(/^(true|false)$/)
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Thinking tokens reserved per request when LLM_REASONING is enabled: the
   * model's reasoning counts against max_tokens, so the budget must be
   * added on top of the label budget or the JSON truncates deterministically.
   * Default 1024: sized for the reference machine (Ryzen 5 5600X +
   * RTX 3070 Ti, ~3.5–4 t/s) so a worst-case request fits LLM_TIMEOUT_MS
   * (600 s); must match the server's --reasoning-budget.
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

export type AppConfig = z.infer<typeof envSchema>

let cached: AppConfig | null = null

export function getConfig(): AppConfig {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env)
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
