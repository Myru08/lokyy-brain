# Story: Opt-in AI-generated note title from transcript

**Epic:** Mobile/Android UX — voice (nice-to-have)
**Origin:** Oliver — "unter den Standards einstellen, dass der Titel der Notiz per KI aus dem Transkript generiert wird (was am sinnvollsten ist)". Manual title input already shipped (Phase 1).

## Acceptance Criteria

1. **Setting (opt-in, default OFF):** add a boolean `aiTitle` to the voice settings served by `GET/PUT /api/voice/settings` (find the VoiceSettings schema — likely in @lokyy/core; extend it + the GET default + the PUT partial accept). Default `false` (privacy/cost — Oliver is privacy-conscious).
2. **Settings UI:** in `Settings.tsx` Voice tab, add a labelled toggle "Notiz-Titel per KI aus dem Transkript generieren" bound to `aiTitle`, saved through the existing voice-settings PUT path (same pattern as the other voice defaults).
3. **Title-suggestion endpoint:** add `POST /api/voice/suggest-title` `{ text: string, language?: string }` → `{ title: string }`. Reuse the SAME configured LLM that `polishNote` uses (read `polishNote` in @lokyy/core to reuse its LLM client/config). Use a lightweight prompt: produce ONE concise 3–7 word title in the transcript's language, no surrounding quotes, no trailing punctuation. Handle LLM errors gracefully (return a clear error; never 500-crash the note flow).
4. **api.ts:** add `suggestVoiceTitle(text, language?) => Promise<string>`; ensure the voice settings get/put carry `aiTitle`.
5. **Wire into creation (App.tsx `handleVoiceInsert`, no-note-open branch only):** if the user did NOT type a manual title AND `aiTitle` is enabled, call `suggestVoiceTitle(transcript)` and use the result as the note title (via `createNoteUnique`, keep collision suffixing). A MANUAL title always wins. On AI-title error/empty, fall back to the existing timestamped name — never block note creation. App reads the `aiTitle` flag from the voice settings (fetch `/api/voice/settings` or reuse however Settings loads it).
6. Open-note insert path unchanged. Default behaviour (setting off) identical to today.

## Constraints

- Own these files: the @lokyy/core VoiceSettings schema file, `server/src/routes/voice.ts`, `pwa/src/api.ts`, `pwa/src/Settings.tsx`, `pwa/src/App.tsx`. Do NOT touch VoiceReviewSheet.tsx (Phase-1 manual-title field already feeds opts.title), transcriptMerge, or unrelated files.
- pnpm workspace; no npm/bun. If you add a core export, rebuild core happens in the Orchestrator's authoritative build.
- Keep the LLM provider-agnostic (reuse polishNote's client/config — do NOT hardcode OpenAI).

## Verification (paste exact output)

- `pnpm --filter server exec tsc --noEmit` → 0 and `pnpm --filter pwa exec tsc --noEmit` → 0 (use `exec tsc`; symlink main checkout node_modules if needed, then remove). If you change @lokyy/core, run `pnpm --filter @lokyy/core build` first so the server/pwa typecheck sees it.
- `pnpm --filter pwa test` → existing tests green.
- Do NOT run `pnpm -r build` (Orchestrator runs authoritative build).

## Definition of Done

A default-off "AI title" toggle in Voice settings; when on and no manual title, the new voice note's title is LLM-generated from the transcript (provider-agnostic), with graceful fallback; manual title always wins; open-note path + default behaviour unchanged; typechecks + tests green.
