/**
 * Issue #67 — Vorfilter der Ingest-Time-Synthese.
 *
 * Reiner Code, keine DB, kein LLM, kein Dateizugriff. Er entscheidet, ob
 * überhaupt gefragt wird: nur Kandidaten dürfen zum Judge.
 *
 * WARUM ES DEN VORFILTER GIBT: nicht wegen der Token. Der Lint-Pass im
 * Nachtlauf deckelt seine LLM-Aufrufe längst selbst (2+ gemeinsame Tags,
 * `MAX_CONTRADICTIONS_PER_RUN`), Kosten sind hier also nicht das Problem.
 * Das Problem ist LATENZ: beim Import wartet der Nutzer. Der Vorfilter ist
 * deshalb auf „schnell entscheiden, ob überhaupt gefragt wird" optimiert und
 * nicht auf Sparsamkeit — er darf großzügig verwerfen.
 *
 * Zwei Signalklassen:
 *
 *   1. **Kontrast-Signale** (Regex auf dem Body der neuen Notiz). Ohne ein
 *      solches Signal gibt es keinen Grund, einen Widerspruch zu vermuten —
 *      und damit keinen LLM-Aufruf.
 *   2. **Bezug zu einer bestehenden Notiz**: entweder ein expliziter
 *      `[[Wikilink]]` auf sie oder mindestens `MIN_SHARED_TAGS` gemeinsame
 *      Tags.
 *
 * Zum Judge geht nur, was BEIDES hat. Ein `[[Wikilink]]` allein erzeugt
 * dagegen einen `link`-Vorschlag — der kostet keinen LLM-Aufruf und ist auch
 * im Modus `prefilter` (CPU-only) noch nützlich.
 *
 * Bekannte Grenze: Tags werden auf beiden Seiten aus Inline-`#tags` gelesen
 * (so wie `notesService` sie in `NoteSummary.tags` liefert). Notizen, die ihre
 * Tags NUR im Frontmatter führen, überlappen hier nicht — dafür müsste der
 * Vorfilter jede Notiz des Vaults einzeln lesen, und das ist im Import-Pfad
 * die falsche Rechnung. Der Wikilink-Pfad fängt den expliziten Bezug ab.
 */

/** Ab so vielen gemeinsamen Tags gilt ein Bezug als gegeben (wie im Lint-Pass). */
export const MIN_SHARED_TAGS = 2;

/** Obergrenze der `link`-Vorschläge pro Import — eine Karte muss lesbar bleiben. */
export const MAX_LINK_PROPOSALS = 5;

/**
 * Kontrast-Signale, deutsch und englisch. Wortgrenzen bzw. Satzzeichen sind
 * Absicht: „universal" darf nicht über „vs." stolpern, „entgegen" nicht in
 * „entgegennehmen" treffen.
 */
export const CONTRAST_PATTERNS: readonly RegExp[] = [
  /\bvs\.?\b/i,
  /\bversus\b/i,
  /\bunlike\b/i,
  /\bcontrary to\b/i,
  /\bin contrast\b/i,
  /\bhowever\b/i,
  /\bim gegensatz\b/i,
  /\bentgegen der\b/i,
  /\bentgegen dem\b/i,
  /\banders als\b/i,
  /\bwiderspricht\b/i,
  /\bwiderspruch\b/i,
  /\bstatt(?:dessen)?\b/i,
  /\bnicht mehr\b/i,
];

/** Alle Kontrast-Signale, die im Text vorkommen (als lesbare Treffer-Strings). */
export function contrastSignals(text: string): string[] {
  const hits: string[] = [];
  for (const re of CONTRAST_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push(m[0].toLowerCase());
  }
  return [...new Set(hits)];
}

/** Die Sicht des Vorfilters auf eine bestehende Notiz. */
export interface CandidateNote {
  id: string;
  title: string;
  tags: string[];
  /** Wikilink-Ziele, die DIESE Notiz enthält — für „verlinkt schon zurück?". */
  links: string[];
}

/** Eingabe: die frisch importierte Notiz plus der Notizbestand. */
export interface PrefilterInput {
  sourceNoteId: string;
  sourceTitle: string;
  /** Body der neuen Notiz (mit Frontmatter, wie der Handler ihn liefert). */
  sourceBody: string;
  /** Inline-Tags der neuen Notiz. */
  sourceTags: string[];
  /** Wikilink-Ziele der neuen Notiz. */
  sourceLinks: string[];
  notes: CandidateNote[];
}

/** Ein Treffer des Vorfilters, inkl. Beweis für das Audit-Log. */
export interface PrefilterHit {
  noteId: string;
  noteTitle: string;
  sharedTags: string[];
  /** Die neue Notiz verweist per `[[…]]` explizit auf diese Notiz. */
  wikilinked: boolean;
}

export interface PrefilterResult {
  /** Kandidaten für einen `link`-Vorschlag (ohne LLM). */
  linkHits: PrefilterHit[];
  /** Kandidaten für den Judge — nur diese dürfen einen LLM-Aufruf kosten. */
  judgeHits: PrefilterHit[];
  /** Kontrast-Signale im Body der neuen Notiz. Leer ⇒ kein Judge-Kandidat. */
  signals: string[];
}

/** Auflösen eines Wikilink-Ziels auf eine Notiz: per id oder per Titel. */
function linkMatches(link: string, note: CandidateNote): boolean {
  const l = link.trim().toLowerCase();
  if (l === "") return false;
  return l === note.id.toLowerCase() || l === note.title.toLowerCase();
}

export function prefilter(input: PrefilterInput): PrefilterResult {
  const signals = contrastSignals(input.sourceBody);
  const sourceTags = new Set(input.sourceTags);
  const linkHits: PrefilterHit[] = [];
  const judgeHits: PrefilterHit[] = [];

  for (const note of input.notes) {
    if (note.id === input.sourceNoteId) continue;

    const sharedTags = note.tags.filter((t) => sourceTags.has(t));
    const wikilinked = input.sourceLinks.some((l) => linkMatches(l, note));
    const related = wikilinked || sharedTags.length >= MIN_SHARED_TAGS;
    if (!related) continue;

    const hit: PrefilterHit = {
      noteId: note.id,
      noteTitle: note.title,
      sharedTags,
      wikilinked,
    };

    // `link`-Vorschlag nur, wenn der Rückverweis wirklich fehlt — sonst wäre
    // der Vorschlag beim Anwenden ein No-Op und in der Karte reines Rauschen.
    const alreadyBackLinked = note.links.some(
      (l) =>
        l.trim().toLowerCase() === input.sourceNoteId.toLowerCase() ||
        l.trim().toLowerCase() === input.sourceTitle.toLowerCase(),
    );
    if (wikilinked && !alreadyBackLinked && linkHits.length < MAX_LINK_PROPOSALS) {
      linkHits.push(hit);
    }

    // Kein Kontrast-Signal ⇒ kein Judge-Kandidat ⇒ kein LLM-Aufruf.
    if (signals.length > 0) judgeHits.push(hit);
  }

  // Stärkster Bezug zuerst: expliziter Wikilink, dann Tag-Überlappung. Der
  // Deckel auf die Judge-Aufrufe schneidet damit die schwächsten Kandidaten ab.
  judgeHits.sort(
    (a, b) =>
      Number(b.wikilinked) - Number(a.wikilinked) ||
      b.sharedTags.length - a.sharedTags.length ||
      a.noteId.localeCompare(b.noteId),
  );

  return { linkHits, judgeHits, signals };
}
