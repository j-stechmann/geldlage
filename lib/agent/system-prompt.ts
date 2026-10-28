import { languageDisplay } from "@/lib/llm/prompt"
import { queryDataPromptDoc } from "@/lib/agent/query/prompt-doc"

/**
 * System prompt for the agent chat (ADR-0033). Persona, hard facts
 * (today's date, answer language) and the anti-hallucination contract for
 * money questions: the model must pull numbers through the tool system
 * instead of inventing them, because a local-first finance app loses all
 * trust the moment it makes up a number. Tool results are scoped to the
 * asking user — stated explicitly so shared-thread participants are not
 * misled into thinking the assistant sees their data too.
 */
export function agentSystemPrompt(
  lang: string,
  now: Date,
  toolNames: string[]
): string {
  const langName = languageDisplay(lang)
  const today = isoDate(now)
  let s = ""
  s +=
    "Du bist der Geldlage-Assistent, ein Helfer in einer lokalen App zur Analyse von Banktransaktionen und zur Verwaltung geplanter Transaktionen. "
  s += `Antworte auf ${langName}.\n`
  s += `Heutiges Datum: ${today}.\n`
  s += "\nRegeln:\n"
  s +=
    "- Erfinde niemals Transaktionsdaten, Beträge oder Kategorien. Zu allen Fragen nach Geldbeträgen oder Kategorien nutze stattdessen das Tools-System.\n"
  s +=
    "- Tool-Daten gehören zu der Person, die gerade fragt: in geteilten Chats zeigen die Resultate die eigenen Daten des Anfragenden, nicht die anderer Teilnehmer.\n"
  s +=
    "- Geldbeträge sind in Cent angegeben (Integer); negative Cent = Ausgabe, positive = Einnahme.\n"
  s += "- halte deine Antwort kurz (schmales Bedienfeld).\n"
  if (toolNames.length > 0) {
    s += "\nVerfügbare Tools: "
    s += toolNames.join(", ") + ".\n"
  }
  // Plan write tools (ADR-0036): the quartet ships together in the
  // registry, so the block gates on its read tool — the rules (id lookup
  // before mutation, delete confirmation, cent contract) load exactly
  // when the model can actually act on them.
  if (toolNames.includes("list_plans")) {
    s += "\nPläne (geplante Transaktionen):\n"
    s +=
      "- Für update_plan/delete_plan die Plan-ID immer über list_plans oder query_data ermitteln — erfinde niemals eine ID.\n"
    s +=
      "- Beträge in Cent (Integer; negativ = Ausgabe) — rechne Eurobeträge zuerst mit calculator in Cent um.\n"
    s +=
      "- delete_plan löscht endgültig: bitte kurz bestätigen, bevor du löschst; zum nur-Beenden genügt update_plan mit status „finished“.\n"
    s +=
      "- Melde nach jedem Schreibvorgang knapp, was getan wurde (Betrag, Termin, Rhythmus/Status).\n"
  }
  // query_data reference: generated from the query catalog so the prompt
  // can never describe a table/column/op the interpreter rejects. Only
  // embedded when the tool is actually advertised (registry-driven).
  if (toolNames.includes("query_data")) {
    s += "\n" + queryDataPromptDoc() + "\n"
  }
  return s
}

/**
 * One-shot prompt for chat-thread titles. Used through the same chat
 * endpoint but without tools and with the bare history — the answer is a
 * short title, not a conversation turn (never persisted).
 */
export function titlePrompt(firstMessage: string): string {
  const clean = firstMessage
    .replace(/\s+/g, " ")
    .trim()
    // A title needs only the gist: cap the embedded message so a long
    // first turn cannot crowd a small LLM context (the answer is 2-5
    // words regardless).
    .slice(0, 200)
  return `Gib einen kurzen Chat-Titel für die folgende Nachricht an. Nenne 2-5 Wörter auf Deutsch, ohne Anführungszeichen. Nachricht: ${clean}`
}

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}
