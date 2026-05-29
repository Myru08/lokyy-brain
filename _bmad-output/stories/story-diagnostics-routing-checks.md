# Story: Diagnostics — add AI provider + task-routing checks

**Epic:** Observability / diagnostics
**Origin:** Oliver — "warum sind gerade die nicht auch in der Prüfung drin?" The diagnostics test Ollama reachability + embedding round-trip, but NOT whether AI roles are assigned. Result: semantic search showed "0 hits" with no hint that the real cause is the **Embedding role being unassigned** in Task-Routing.

## Acceptance Criteria

1. Add a new check group (service `"ki-routing"` or `"providers"`) to `GET /api/diagnostics` that reads the LLM config (packages/core/src/llm/configStore.ts — read how the config + routing + provider credentials are stored).
2. **Provider credentials check(s):** report which providers have credentials configured vs empty (Anthropic/OpenAI/Google/Cohere/Voyage/Ollama). Ollama-local present = ok; cloud providers empty = `info` (not an error — local-only is a valid choice).
3. **Role-assignment checks**, especially: **Embedding** — if unassigned → `severity: "error"` (or "warn") with a `detail` like "Embedding-Rolle nicht zugewiesen → Tier 2 / semantische Suche bleibt leer. AI → Task-Routing → Embedding zuweisen, dann Migrate Embeddings." If assigned → ok with the provider/model in detail. Report the other key roles (Re-Rank, Topic-Synthesis, Query-Rewrite, HyDE, Self-RAG, NER, intent/mem0 classifiers) as `info` (assigned/unassigned) so the user sees the full routing state.
4. Each check defensive (never 500). Provider-agnostic. The existing Diagnose UI renders any service group generically — no UI change needed (verify the new group's `service` string flows through).

## Constraints

- Own ONLY: `server/src/routes/diagnostics.ts` (and READ packages/core/src/llm/configStore.ts to learn the config shape — do not modify core). Do NOT touch Settings.tsx, search.ts, memory/*, api.ts (other agents own those now).
- pnpm workspace; no npm/bun.

## Verification (paste exact output)

- `pnpm --filter server exec tsc --noEmit` → 0 (use `exec tsc`; symlink node_modules if needed, then remove).
- Do NOT run `pnpm -r build` (Orchestrator runs authoritative build).

## Definition of Done

`/api/diagnostics` includes a provider/routing group that flags an unassigned Embedding role (with an actionable detail) and lists provider-credential + role-assignment state; defensive; typecheck green.
