# @lokyy/core

Shared service layer for lokyy-brain. Imported by `server` and the future
`mcp` package — never by the browser-side `pwa`.

This workspace was bootstrapped in Story 1.2. Subsequent stories migrate the
existing services in (1.3 `gitService`, 1.4 `notesService` / `graphService` /
`pipeQueue`) and add the vault-compliance utility (1.5 `frontmatter` with
`ulid`, `gray-matter`, `ajv`).

Built with `pnpm --filter @lokyy/core build`.
