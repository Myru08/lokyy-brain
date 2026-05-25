# Story 1.9: Docker Compose Stack

Status: done

## Dev Notes (post-impl)
- 5 services: lokyy-brain, forgejo, postgres (pgvector/pgvector:pg16), ollama, ollama-init (one-shot pull nomic-embed-text).
- Healthcheck on postgres → lokyy-brain `depends_on` with `condition: service_healthy`.
- ollama-init pulls model on first compose-up; subsequent ups skip (model cached in volume).
- Volumes: vault-data, forgejo-data, postgres-data, ollama-data.
- Required env: GIT_REMOTE. Optional: POSTGRES_PASSWORD, GIT_AUTHOR_*, SUPADATA_API_KEY.
- `docker compose config --quiet` exits 0 with GIT_REMOTE provided.
- Dockerfile is multi-stage (build → runtime, node:22-bookworm-slim + git + openssh-client).
- Playwright not re-run for this story — no app behavior change, dev server is still pointing at the dev pgvector container (5439), not the compose stack.

## Story

As an admin, I want `docker compose up -d` to start lokyy-brain + Forgejo + Postgres + Ollama as a single self-contained stack.

## Acceptance Criteria

1. `docker-compose.yml` at repo root defines four services: `lokyy-brain`, `forgejo`, `postgres`, `ollama`.
2. Postgres uses `pgvector/pgvector:pg16` image (pgvector pre-installed).
3. Ollama auto-pulls `nomic-embed-text` on first start via a sidecar init.
4. All services on a named bridge network.
5. Named volumes persist Forgejo repos + Postgres data.
6. `docker compose config` validates (no YAML errors).
7. Documented in `README.md` "Deployment" section.

## Dev Agent Record
