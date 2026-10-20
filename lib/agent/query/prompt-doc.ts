import {
  QUERY_DEFAULT_LIMIT,
  QUERY_MAX_CELL_CHARS,
  QUERY_MAX_ROWS,
} from "@/lib/agent/constants"
import { queryTables } from "./catalog"

/**
 * Generates the compact system-prompt reference for `query_data`
 * (ADR-0034) directly from the catalog, so the prompt can never describe
 * a table/column/op the interpreter doesn't accept (they are one
 * whitelist). Kept terse — the agent context (LLM_CTX) is small and the
 * generated block rides along on every prompt.
 */
export function queryDataPromptDoc(): string {
  const lines: string[] = []
  lines.push(
    "query_data: freie Nur-Lese-Abfragen per JSON (kein SQL, keine eigenen Felder). Felder: table (Pflicht), select (Spaltenliste), where (UND-Filter), whereAny (ODER-Gruppe), aggregate, groupBy, having (auf Aliase), orderBy, limit."
  )
  lines.push(
    'Filterform: {"column": Spalte, "op": eq|ne|gt|gte|lt|lte|contains|like|in|isNull|notNull, "value"}. contains = enthält (keine Wildcards nötig); like erwartet eigene % Wildcards; beide nur auf Text-Spalten, Groß-/Kleinschreibung egal (ASCII); in erwartet ein Array. Vergleichs-ops treffen NULL nicht — fehlende Werte mit isNull/notNull prüfen.'
  )
  lines.push(
    `Regeln: Geldbeträge in Cent (Integer; avg kann Nachkommastellen liefern). Zeilenabfragen immer mit explizitem select — ohne select kommen alle Spalten der Tabelle zurück und breite Ergebnisse werden hart gekürzt („Ergebnis gekürzt"). Einzelne Textzellen werden bei ${QUERY_MAX_CELL_CHARS} Zeichen beschnitten („…") — gekürzte Werte nicht als eq-Wert wiederverwenden; filtere stattdessen mit contains auf ein charakteristisches kurzes Stück. Mit Aggregat enthält das Ergebnis die groupBy-Spalten + Aliase (select dort unzulässig). having nur auf numerische Aliase (Text-min/max nur sortierbar); ein NULL-Aggregat (avg/min/max ohne Treffer) fällt durch jeden having-Vergleich. limit max ${QUERY_MAX_ROWS} (Standard ${QUERY_DEFAULT_LIMIT}); bei Ergebnis "limited" die Abfrage weiter einschränken. Ohne orderBy kommen Zeilenabfragen in Erfassungsreihenfolge (stabil über Aufrufe); gruppierte Ergebnisse ohne orderBy haben keine definierte Reihenfolge — bei Aggregaten immer orderBy setzen. Joined Spalten als "alias.spalte".`
  )
  lines.push("Tabellen und Spalten:")
  for (const [name, def] of Object.entries(queryTables)) {
    const cols = Object.entries(def.columns)
      .map(([key, c]) => (c.note ? `${key} (${c.note})` : key))
      .join(", ")
    const joinKeys = Object.keys(def.joins)
    const joins = joinKeys.map((a) => `${a}→${def.joins[a].target}`).join(", ")
    lines.push(
      `- ${name}: ${cols}` + (joinKeys.length > 0 ? `; Joins: ${joins}` : "")
    )
  }
  lines.push(
    'Beispiel "Ausgaben pro Monat 2026": {"table":"transactions","aggregate":[{"fn":"sum","column":"amount_cents","alias":"summe_cents"}],"groupBy":["booking_month"],"where":[{"column":"booking_date","op":"gte","value":"2026-01-01"}],"orderBy":[{"column":"booking_month"}]}'
  )
  lines.push(
    'Beispiel "letzte 10 Buchungen von X mit Kategorie": {"table":"transactions","select":["booking_date","payee","amount_cents","category.name"],"where":[{"column":"payer","op":"contains","value":"X"}],"orderBy":[{"column":"booking_date","direction":"desc"}],"limit":10}'
  )
  return lines.join("\n")
}
