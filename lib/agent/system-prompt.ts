import { languageDisplay } from "@/lib/llm/prompt"

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
    "Du bist der Geldlage-Assistent, ein Helfer in einer lokalen App zur Analyse von Banktransaktionen. "
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
  return s
}

/**
 * One-shot prompt for chat-thread titles. Used through the same chat
 * endpoint but without tools and with the bare history — the answer is a
 * short title, not a conversation turn (never persisted).
 */
export function titlePrompt(firstMessage: string): string {
  const clean = firstMessage.replace(/\s+/g, " ").trim()
  return `Gib einen kurzen Chat-Titel für die folgende Nachricht an. Nenne 2-5 Wörter auf Deutsch, ohne Anführungszeichen. Nachricht: ${clean}`
}

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}
