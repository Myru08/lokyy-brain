# Story: MCP OAuth 2.1 layer for claude.ai Custom Connector

**Epic:** 5 (MCP Server workspace)
**Branch:** `feat/mcp-oauth`
**Status:** Dev in progress

## Problem

The deployed MCP HTTP server (`mcp/src/httpServer.ts`) authenticates with a single
static Bearer token (`LOKYY_MCP_TOKEN`). claude.ai's web/desktop **Custom Connector**
flow only supports **OAuth** (auto-registration via Dynamic Client Registration, or a
manually pasted Client ID/Secret) — there is no field for a static bearer header.
Result: claude.ai POSTs `/mcp`, gets a bare `401`, tries to register with an OAuth
"sign-in service" that does not exist, and fails:
`"Couldn't register with Lokyy Brain's sign-in service"` (ref `ofid_4a4ef9ed7ccb3225`).

`mcp/src/setup.ts:269` prints stale guidance (`Auth: Bearer / Token: <LOKYY_MCP_TOKEN>`)
that the current claude.ai UI no longer accepts.

## Goal

The MCP HTTP server exposes a minimal, spec-compliant OAuth 2.1 authorization layer
so that claude.ai's "Add custom connector" completes the login flow end-to-end and the
five lokyy tools appear — **without breaking** the existing static-Bearer path used by
Claude Code / Desktop header configs.

## Out of Scope

- Multi-user / multi-tenant OAuth. This is a single-owner brain.
- OpenID Connect ID tokens, userinfo, scopes beyond a single `mcp` resource.
- Replacing the static-Bearer path (it must keep working for CLI header clients).
- Forgejo-as-IdP (a different option that was rejected for this story).

## Constraints

- TypeScript, ESM, Node — match existing `mcp/` style. Build via `tsc -p tsconfig.json`.
- Auth endpoints live in the **MCP HTTP server** process (`mcp/`), reachable on the
  same origin as `/mcp`. Base URL MUST be derived from `X-Forwarded-Proto` +
  `X-Forwarded-Host` (Caddy sets these), falling back to `Host`; overridable via
  env `LOKYY_PUBLIC_MCP_URL`. Never hardcode a domain.
- DB access is available in the MCP process (`initDb(LOKYY_DB_URL)` already runs in
  `binHttp.ts`). Migrations run in the `lokyy-brain` server which starts first
  (compose `depends_on: service_healthy`), so new tables exist before MCP serves.
- PKCE `S256` is mandatory. `redirect_uri` exact-match validation (no open redirect).
- The `/authorize` consent step MUST require proof of ownership (a password gate) —
  otherwise anyone who finds the URL can mint a token to the personal vault.

## Auth design (canonical contract — both agents build to this)

Endpoints (all on the MCP origin, NOT under `/mcp`):

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/.well-known/oauth-protected-resource` | RFC 9728. `{ resource, authorization_servers:[issuer] }`. Also answer `/.well-known/oauth-protected-resource/mcp`. |
| GET  | `/.well-known/oauth-authorization-server` | RFC 8414 metadata: `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `response_types_supported:["code"]`, `grant_types_supported:["authorization_code","refresh_token"]`, `code_challenge_methods_supported:["S256"]`, `token_endpoint_auth_methods_supported:["none","client_secret_post"]`. |
| POST | `/register` | RFC 7591 DCR. Accept `{redirect_uris, client_name, ...}`, persist, return `{client_id, redirect_uris, ...}`. Public client → no secret (or issue one; echo `token_endpoint_auth_method`). |
| GET  | `/authorize` | Validate `client_id`+`redirect_uri` (exact match to a registered client). Render a minimal HTML consent page with a password field. On correct password → mint single-use code (TTL ≤120s) bound to `client_id`+`redirect_uri`+`code_challenge`. Redirect to `redirect_uri?code=…&state=…`. |
| POST | `/token` | `authorization_code`: validate code (single-use, unexpired, matching client/redirect), verify PKCE (`base64url(sha256(code_verifier)) === code_challenge`), issue `access_token` (+ `refresh_token`). `refresh_token`: rotate and re-issue. Return `{access_token, token_type:"Bearer", expires_in, refresh_token}`. |

Token strategy (fully stateless — no DB, restart-safe for live connections):
- **access_token** = stateless HS256 JWT signed with `LOKYY_OAUTH_SIGNING_SECRET`
  (claims: `iss`, `aud`=resource, `exp` ~1h, `iat`, `sub`). No storage needed.
- **refresh_token** = HS256 JWT (`typ:"refresh"`, longer `exp`). Stateless; survives restart.
- **registered clients** → in-memory `Map` (only needed during the brief authorize→token
  window). Lost on restart, which is acceptable: established connections keep working via
  the stateless tokens, and claude.ai re-runs DCR if it ever needs to re-authorize.
- **authorization codes** → in-memory `Map` with TTL (single-use, ephemeral).
- **No DB migration, no `packages/core` changes** — Forge's edits stay inside `mcp/`.

`/mcp` changes:
- Bearer check now accepts **either** the legacy static `LOKYY_MCP_TOKEN` **or** a
  valid OAuth access-token JWT (`verify` against `LOKYY_OAUTH_SIGNING_SECRET`,
  check `exp`/`aud`).
- On 401, add header:
  `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource", error="invalid_token"`.

Consent password env: `LOKYY_OAUTH_PASSWORD`; if unset, fall back to `LOKYY_MCP_TOKEN`
so existing deployments still work. JWT secret env: `LOKYY_OAUTH_SIGNING_SECRET`; if
unset, derive deterministically from `LOKYY_MCP_TOKEN` (documented) so a fresh deploy
isn't broken, but recommend setting it explicitly.

## Acceptance Criteria (= ISCs)

- [ ] AC1: `GET /.well-known/oauth-protected-resource` returns 200 JSON with `resource` + `authorization_servers` derived from forwarded host.
- [ ] AC2: `GET /.well-known/oauth-protected-resource/mcp` returns the same (path-suffixed variant).
- [ ] AC3: `GET /.well-known/oauth-authorization-server` returns 200 with all required metadata fields incl. `code_challenge_methods_supported:["S256"]`.
- [ ] AC4: `POST /register` with a `redirect_uris` array returns 201/200 with a `client_id` and echoes the redirect_uris (held in-memory for the authorize/token window).
- [ ] AC5: `GET /authorize` with unknown `client_id` or mismatched `redirect_uri` is rejected (400), never redirects.
- [ ] AC6: `GET /authorize` (valid client) renders an HTML consent page with a password field.
- [ ] AC7: Correct password → 302 redirect to `redirect_uri` with `code` + original `state`.
- [ ] AC8: Wrong password → no code issued (re-render with error or 401).
- [ ] AC9: `POST /token` (authorization_code + matching PKCE verifier) returns `access_token`+`refresh_token`; `token_type:"Bearer"`.
- [ ] AC10: `POST /token` with a wrong PKCE `code_verifier` is rejected (400 `invalid_grant`).
- [ ] AC11: Auth code is single-use (second exchange fails) and expires (≤120s).
- [ ] AC12: `POST /mcp` with an OAuth-issued access token succeeds (initialize handshake).
- [ ] AC13: `POST /mcp` with the legacy `LOKYY_MCP_TOKEN` STILL succeeds (no regression).
- [ ] AC14: `POST /mcp` with no/invalid token → 401 **with** the `WWW-Authenticate: Bearer resource_metadata=…` header.
- [ ] AC15: `GET /mcp/health` still returns 200 unauthenticated.
- [ ] AC16: `redirect_uri` is exact-matched against the registered set (open-redirect safe).
- [ ] AC17: `pnpm -r build` passes (mcp + core + server + pwa typecheck clean).
- [ ] AC18: `POST /token` with `grant_type=refresh_token` (valid refresh JWT) issues a fresh access_token.
- [ ] AC19: `.env.example` + `.env.coolify.example` document `LOKYY_OAUTH_PASSWORD` + `LOKYY_OAUTH_SIGNING_SECRET`.
- [ ] AC20: `mcp/src/setup.ts` `claudeAiSnippet` rewritten to the OAuth flow (no longer says "Auth: Bearer / Token").
- [ ] AC21: `Caddyfile` (single-domain config) routes `/.well-known/oauth-*`, `/authorize`, `/token`, `/register` to the mcp service.
- [ ] AC22: Anti: no endpoint allows token issuance without the consent password gate.
- [ ] AC23: Anti: no hardcoded domain anywhere in the new code (base URL is request/env derived).
- [ ] AC24: Multi-session: a 2nd (and 3rd) new MCP `initialize` does NOT crash the server (each session gets its own Server instance). Pre-existing crash surfaced during live test.

## Decisions

- **2026-05-28 scope expansion:** Live testing surfaced a pre-existing crash in
  `httpServer.ts` — one shared MCP `Server` instance was `connect()`-ed per session,
  which the SDK forbids (`Already connected to a transport`). The 2nd MCP session
  crashed the process. Since claude.ai opens multiple sessions over a connector's life,
  the connector cannot "really work" without this fix, so it was pulled into this story:
  Server-per-session via `initServerDeps()` (one-time globals) + `createServer()` factory.
  Stdio path keeps using `buildServer()` (single transport). → AC24.

## Test Strategy

Run the built `lokyy-mcp-http` locally with a throwaway `LOKYY_MCP_TOKEN`,
`LOKYY_OAUTH_PASSWORD`, `LOKYY_OAUTH_SIGNING_SECRET` and a test DB; drive AC1–AC16 with
`curl -i` (forwarded headers simulated via `-H "X-Forwarded-Proto: https" -H "X-Forwarded-Host: mcp.test"`).
AC17 via `pnpm -r build`. AC12/AC13 by issuing a JWT through the real `/token` flow and
POSTing an MCP `initialize` to `/mcp`.

## Files

**Forge (auth core)** — owns (all inside `mcp/`):
- `mcp/src/oauth.ts` (NEW) — metadata, register, authorize (consent HTML), token, PKCE, JWT issue/verify, in-memory client/code maps.
- `mcp/src/httpServer.ts` — route OAuth paths; update `/mcp` bearer check + 401 `WWW-Authenticate`.
- `mcp/package.json` — add `jose` (or implement HS256 via `node:crypto`, no dep).

**Ops agent** — owns (disjoint files):
- `Caddyfile` — AC21 routes.
- `.env.example`, `.env.coolify.example` — AC19.
- `mcp/src/setup.ts` — AC20 (`claudeAiSnippet` only).
