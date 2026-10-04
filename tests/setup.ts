process.env.DATABASE_PATH = ":memory:"
process.env.LLM_BATCH_SIZE = "100"
process.env.LLM_MAX_RETRIES = "0"
// tests assert reasoning-off max_tokens (floor 1024 / 96 per item); the
// app default is reasoning on, so pin it off and let the reasoning test
// opt back in explicitly
process.env.LLM_REASONING = "false"
process.env.OIDC_ISSUER_URL = "https://issuer.example.com"
process.env.OIDC_CLIENT_ID = "test-client"
process.env.OIDC_CLIENT_SECRET = "test-client-secret-0123456789abcdef"
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef"
process.env.APP_ORIGIN = "https://app.example.com"
