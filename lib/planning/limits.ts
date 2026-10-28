/**
 * Free-text byte limits for plan fields, shared by the server validation
 * (lib/planning/service.ts validatePlanInput) and the plan dialog's
 * client-side pre-check: HTML maxLength counts JS characters, never UTF-8
 * bytes, so an input allowing 128 characters would admit multi-byte values
 * (umlauts, emoji) the server must reject. Both sides read the same numbers
 * and stay in sync by construction.
 */
export const MAX_COUNTERPARTY = 128
export const MAX_TEXT = 500
