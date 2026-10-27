import type { AgentTool } from "@/lib/agent/types"
import { updatePlan, type PlanRow } from "@/lib/planning/service"
import {
  assertArgsObject,
  planIdFromArgs,
  planInputFromArgs,
  planView,
  rethrowPlanError,
} from "./plan-shared"

/**
 * The `update_plan` tool (ADR-0036): partial patch over the exact
 * updatePlan service function the PATCH /api/plans/[id] route calls —
 * only provided keys change (validatePlanInput's key-presence semantics),
 * explicit null clears a clearable field, and dtstart/rule changes
 * re-check occurrence productivity against the effective combination.
 * Also the way the model pauses/finishes a plan (`status`), which the
 * delete-guard guidance steers toward instead of hard deletes.
 */

export const update_plan = {
  name: "update_plan" as const,
  description:
    "Ändert einen bestehenden Plan teilweise: nur die mitgegebenen Felder werden geändert, alle übrigen bleiben. Pflicht: id — ermittele sie immer zuerst über list_plans oder query_data, erfinde niemals eine ID. Leerbare Felder (counterparty, purpose, notes, rrule, account_id, category_id) werden mit null geleert; rrule null = einmalig am dtstart. status: „paused“ pausiert (Termine bleiben sichtbar, geplant-gestrichelt), „finished“ schließt den Plan endgültig ab — bevorzuge das gegenüber dem Löschen. amount_cents: Integer Cent, nie 0, negativ = Ausgabe (Euro vorher mit calculator umrechnen); dtstart: ISO-JJJJ-MM-TT. Fehler (z. B. invalid_rrule, account_not_found): Feldwert korrigieren und erneut aufrufen. Liefert den aktualisierten Plan zurück.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Plan-ID (UUID) aus list_plans, create_plan oder einer query_data-Abfrage auf planned_transactions.",
      },
      amount_cents: {
        type: "integer",
        description:
          "Neuer Betrag in Cent (Integer, nie 0); negativ = Ausgabe, positiv = Einnahme.",
      },
      dtstart: {
        type: "string",
        description: 'Neuer erster Termin als ISO-Datum "JJJJ-MM-TT".',
      },
      rrule: {
        type: ["string", "null"],
        description:
          "Neue Bare-RFC-5545-RRULE ohne DTSTART-Präfix (gleiche Regeln wie bei create_plan); null = einmalig am dtstart.",
      },
      status: {
        type: "string",
        enum: ["active", "paused", "finished"],
        description:
          "„paused“ pausiert, „finished“ schließt endgültig ab (kein nächster Termin mehr).",
      },
      counterparty: {
        type: ["string", "null"],
        description: "Neuer Empfänger/Auftraggeber; null = Feld leeren.",
      },
      purpose: {
        type: ["string", "null"],
        description: "Neuer Verwendungszweck; null = Feld leeren.",
      },
      account_id: {
        type: ["integer", "null"],
        description:
          "Neue Konto-ID (muss dem Sitzungsbenutzer gehören); null = gilt wieder für jedes Konto.",
      },
      category_id: {
        type: ["integer", "null"],
        description:
          "Neue Kategorie-ID (muss dem Sitzungsbenutzer gehören); null = ohne Kategorie.",
      },
      notes: {
        type: ["string", "null"],
        description: "Neue Notiz; null = Feld leeren.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async execute(args: unknown, ctx): Promise<unknown> {
    const raw = assertArgsObject(args ?? null)
    const id = planIdFromArgs(raw)
    const rest = { ...raw }
    delete rest.id
    if (Object.keys(rest).length === 0) {
      throw new Error("invalid args: provide at least one field to update")
    }
    let plan: PlanRow | null
    try {
      plan = updatePlan(ctx.uid, id, planInputFromArgs(rest))
    } catch (err) {
      rethrowPlanError(err)
    }
    // not_found is a TOOL-level outcome, decided OUTSIDE the plan-error
    // normalizer: rethrowPlanError is only for the PlanValidationErrors the
    // service throws. Throwing the sentinel inside the try would reach that
    // catch and be re-passed unchanged — correct, but reads like an accident
    // (a foreign/error path silently routed through the wrong normalizer).
    if (!plan) {
      throw new Error(
        "not_found: no plan with this id (look up ids via list_plans or query_data first)"
      )
    }
    return { plan: planView(plan) }
  },
} satisfies AgentTool
