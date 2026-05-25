# Story 1.7: `notesService.saveNote` Preserves `id`/`created`, Updates `updated`

Status: done

## Story

As a user,
I want saving an existing note to preserve its identity and creation timestamp while updating the modification timestamp,
so that the vault contract holds across the entire note lifecycle and wikilinks survive saves.

## Acceptance Criteria

1. `saveNote(id, body)` reads existing frontmatter from the file on disk, preserves `id` and `created`, sets `updated` to now, and writes the result.
2. If the supplied `body` already contains a frontmatter block, its non-protected fields are merged in (caller can update `title`, `tags`, etc.); `id` and `created` from the on-disk version always win.
3. If the supplied `body` has no frontmatter, the on-disk frontmatter is reused entirely (only the body text is updated).
4. If the file does not yet exist on disk (new note via direct saveNote), `id` is generated, `created` is set to now. (This makes `saveNote` work as upsert; `createNote` remains the canonical "new note" entry point.)
5. If validation fails, `FrontmatterValidationError` is thrown and no git commit is attempted.
6. Vitest cases: (a) round-trip preserves id/created and bumps updated; (b) body-without-frontmatter saves preserve all on-disk frontmatter; (c) body-with-new-title in frontmatter wins for title but id/created are still on-disk; (d) malformed body frontmatter rejected with FrontmatterValidationError.
7. `pnpm -r build` + tests green; Playwright PWA regression baseline unchanged.

## Tasks

- [x] `saveNote` rewritten: reads existing on-disk frontmatter, merges incoming frontmatter (id/created always from on-disk if present), bumps `updated`, validates pre-write.
- [x] 4 Vitest cases added (round-trip preserves id/created; body-without-frontmatter reuses; body-with-new-title overrides title only; malformed body rejected).
- [x] Build green, 25/25 tests pass, Playwright PWA baseline unchanged.

## Dev Notes

- The on-disk frontmatter is the authority for `id`/`created`. The supplied body's frontmatter is the authority for everything else (when present).
- `updated` always becomes `new Date().toISOString()` regardless of caller input.
- Sleep guard in test: `created !== updated` requires a non-trivial delta. Vitest test sleeps 5ms between create and save.
