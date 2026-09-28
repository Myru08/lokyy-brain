import type { ChatMessage, ChatResult } from "../llm/types.js";

/**
 * Issue #67 — der Judge der Ingest-Time-Synthese.
 *
 * Bewusst dünn: eine Frage, ein JSON, kein Zustand. Die Rolle ist `lint` —
 * dieselbe wie im Nachtlauf, weil es dieselbe Frage ist. Eine neue LLM-Rolle
 * würde nur eine zweite Konfigurationsstelle für dasselbe schaffen.
 *
 * `flag_contradiction` MELDET. Der Judge darf deshalb auch nur melden: er
 * entscheidet nicht, welche Notiz recht hat, und schreibt nichts.
 */

/** Signatur von `LlmProvider.chat` — so injizierbar (und in Tests zählbar). */
export type JudgeChat = (
  messages: ChatMessage[],
  opts?: { maxTokens?: number; temperature?: number },
) => Promise<ChatResult>;

export interface JudgeInput {
  sourceTitle: string;
  sourceBody: string;
  targetTitle: string;
  targetBody: string;
}

export interface JudgeVerdict {
  contradicts: boolean;
  reasoning: string;
}

/** Wie viel Text pro Notiz in den Prompt geht (wie im Lint-Pass). */
const BODY_EXCERPT = 1500;

/**
 * Fragt den Judge, ob sich zwei Notizen widersprechen.
 *
 * Gibt `null` zurück, wenn die Antwort nicht als JSON lesbar war — der Aufrufer
 * MUSS das benennen (Log/Notice), nie still schlucken. Wirft nur, was der
 * Provider selbst wirft; der Aufrufer fängt das und zählt es als Judge-Fehler.
 */
export async function judgeContradiction(
  chat: JudgeChat,
  input: JudgeInput,
): Promise<JudgeVerdict | null> {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content:
        `Widersprechen sich diese zwei Notizen inhaltlich? Antworte NUR mit JSON: ` +
        `{"contradicts": <true|false>, "reasoning": "<ein Satz>"}.\n\n` +
        `Neue Notiz:\n${input.sourceTitle}\n${input.sourceBody.slice(0, BODY_EXCERPT)}\n\n` +
        `Bestehende Notiz:\n${input.targetTitle}\n${input.targetBody.slice(0, BODY_EXCERPT)}`,
    },
  ];

  const result = await chat(messages, { maxTokens: 150, temperature: 0.1 });
  const match = result.text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      contradicts?: unknown;
      reasoning?: unknown;
    };
    if (typeof parsed.contradicts !== "boolean") return null;
    return {
      contradicts: parsed.contradicts,
      reasoning:
        typeof parsed.reasoning === "string" && parsed.reasoning.trim() !== ""
          ? parsed.reasoning.trim()
          : "ohne Begründung",
    };
  } catch {
    return null;
  }
}
