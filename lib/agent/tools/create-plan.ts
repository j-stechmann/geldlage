import type { AgentTool } from "@/lib/agent/types"
import { createPlan } from "@/lib/planning/service"
import {
  assertArgsObject,
  planInputFromArgs,
  planView,
  rethrowPlanError,
} from "./plan-shared"

/**
 * The `create_plan` tool (ADR-0036): the agent's first write path. A thin
 * adapter over createPlan (ADR-0035) — the exact service function the
 * POST /api/plans route calls — executed with the asking user's uid, so
 * every validation (integer-cents CHECK, RRULE allowlist + ≥ 1 occurrence,
 * ownership of account/category references) applies unchanged and rows can
 * never leave the caller's scope. The model does NOT convert money here:
 * amounts are integer cents (ADR-0002), and the description keeps the
 * calculator round-trip (€ → cents) explicit the way the system prompt
 * demands.
 */

// `as const` on name keeps the literal type so tool-registry's
// AgentToolName union derives from the registry (see get_category_totals).
export const create_plan = {
  name: "create_plan" as const,
  description:
    "Legt einen Plan für zukünftiges Geld an (geplante Transaktion — das ist KEINE gebuchte Transaktion und berührt transactions nicht). Pflicht: amount_cents (Integer Cent, nie 0; negativ = Ausgabe, positiv = Einnahme — rechne Eurobeträge zuerst mit calculator in Cent um) und dtstart (erster Termin, ISO „JJJJ-MM-TT“). Optional: counterparty (Empfänger/Auftraggeber, freier Text), purpose (Verwendungszweck), rrule (Wiederholung, siehe Feldbeschreibung), status (active|paused|finished, Standard active), account_id/category_id (existierende IDs des Sitzungsbenutzers, über query_data ermitteln) und notes. Liefert den erzeugten Plan inkl. id zurück.",
  parameters: {
    type: "object",
    properties: {
      amount_cents: {
        type: "integer",
        description:
          "Betrag in Cent (Integer, nie 0). Negativ = Ausgabe, positiv = Einnahme. Euro zuerst mit calculator in Cent umrechnen, z. B. 850 € Monatsmiete → -85000.",
      },
      dtstart: {
        type: "string",
        description: 'Erster Termin als ISO-Datum "JJJJ-MM-TT".',
      },
      rrule: {
        type: ["string", "null"],
        description:
          'Bare RFC-5545-RRULE ohne DTSTART-Präfix und ohne "RRULE:", z. B. "FREQ=WEEKLY;BYDAY=MO" oder "FREQ=MONTHLY;BYMONTHDAY=1". Erlaubte Teile: FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL (1–100), COUNT (1–366), UNTIL (JJJJMMTT), BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS, WKST — alles andere (z. B. EXDATE, ein zweites DTSTART) wird abgelehnt. null oder weggelassen = einmalig am dtstart. Monatliche BYMONTHDAY ≥ 29 überspringt kurze Monate (RRULE-Semantik).',
      },
      status: {
        type: "string",
        enum: ["active", "paused", "finished"],
        description: "Startstatus, Standard: active.",
      },
      counterparty: {
        type: ["string", "null"],
        description:
          "Empfänger/in bzw. Auftraggeber/in als freier Text (z. B. „Mietwerk GmbH“) — treibt das spätere Matchen gegen echte Buchungen.",
      },
      purpose: {
        type: ["string", "null"],
        description: "Verwendungszweck als freier Text.",
      },
      account_id: {
        type: ["integer", "null"],
        description:
          "ID eines Kontos des Sitzungsbenutzers (über query_data ermitteln); null/weglassen = gilt für jedes Konto.",
      },
      category_id: {
        type: ["integer", "null"],
        description:
          "ID einer Kategorie des Sitzungsbenutzers (über query_data ermitteln).",
      },
      notes: {
        type: ["string", "null"],
        description: "Freie Notiz.",
      },
    },
    required: ["amount_cents", "dtstart"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx): Promise<unknown> {
    const input = planInputFromArgs(assertArgsObject(args ?? null))
    try {
      const plan = createPlan(ctx.uid, input)
      return { plan: planView(plan) }
    } catch (err) {
      rethrowPlanError(err)
    }
  },
} satisfies AgentTool
