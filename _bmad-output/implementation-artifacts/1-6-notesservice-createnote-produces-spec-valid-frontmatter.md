# Story 1.6: `notesService.createNote` Produces SPEC-Valid Frontmatter

Status: done

## Story

As a user,
I want every note created through `notesService.createNote` to have a complete, schema-valid frontmatter block,
so that the lokyy-vault pre-commit hook never rejects writes initiated by the app.

## Acceptance Criteria

1. `createNote(id, body?, opts?)` in `packages/core/src/notes/notesService.ts` produces a `.md` file whose frontmatter contains `id` (ULID, 26 chars), `type`, `title`, `created` (ISO-8601), `updated` (ISO-8601 equal to `created` on creation).
2. `opts.type` defaults to `"note"` when omitted; accepted values match the SPEC's `DOC_TYPES` closed list.
3. If a caller supplies `opts.id`, it is preserved (no overwrite — supports re-creating a note by its existing ULID).
4. The serialized frontmatter passes `validateFrontmatter(data, type)` from Story 1.5 — verified inline before write.
5. `FrontmatterValidationError` is thrown if any inconsistency is detected before commit (defensive — should never fire in normal use).
6. Existing `createNote(id, body?)` callers (server routes, future MCP tools) continue to work — the new `opts` param is purely additive and optional.
7. Vitest unit test: `createNote` → read back → frontmatter has all 5 base fields, ULID matches regex, `created === updated`, body has `# <title>` heading.
8. `pnpm -r build` exit 0, `pnpm --filter @lokyy/core test` all green.
9. Playwright PWA regression — same baseline.

## Tasks / Subtasks

- [x] Task 1-5: `createNote(id, body?, opts?)` rewritten with frontmatter generation + validation + serialization, opts shape `{ type?, id?, title?, extra? }`.
- [x] Task 6: 5 Vitest cases in `notesService.test.ts` with isolated tmpdir+bare-remote vault; `setupTestVault` helper reusable for Story 1.7.
- [x] Task 7: pnpm -r build exit 0; vitest 21/21 (16 frontmatter + 5 notesService); Playwright console baseline unchanged.

## Dev Agent Record

### File List

**New:**
- `packages/core/src/notes/notesService.test.ts` (with `setupTestVault` helper)

**Modified:**
- `packages/core/src/notes/notesService.ts` (createNote rewritten; CreateNoteOpts exported)

### Completion Notes

- The `setupTestVault` helper creates a bare remote + clones into a working dir, calls `initCore`, then `ensureRepo`. Reusable for future stories that exercise gitService/notesService end-to-end.
- `createNote` now always commits SPEC-valid frontmatter — defensive validation throws `FrontmatterValidationError` if a caller passes a malformed ULID. Confirmed by Vitest case "rejects malformed explicit id".
- Backward compatibility: existing callers `createNote(id)` and `createNote(id, body)` work unchanged — `opts` is purely additive.
- The tsx-watch in the dev server had an EADDRINUSE during the auto-restart (zombie process from a previous run still holds 8787), but the API stayed responsive via that older process. Not introduced by this story. Will revisit if it breaks future stories.

### Change Log

| Date | Change | By |
|------|--------|-----|
| 2026-05-24 | `createNote` rewritten to produce SPEC-valid frontmatter (ULID/type/title/created/updated) and defensively validate. 5 new Vitest cases, all green. Status: in-progress → done. | Dev agent (claude-opus-4-7) |

## Dev Notes

- `readNoteFile` already reads body as raw — it will pick up the new frontmatter naturally on the next call. No change needed there.
- Tests need a real or simulated vault. Simplest: use `os.tmpdir()` + `git init`, `initCore` with that dir, run `createNote`, read back, assert. Skip the `pull/push` parts by mocking gitService? Or use the real bare remote pattern from the dev smoke?
  - Decision: write a small `setupTestVault()` helper that creates a tmp dir, runs `git init`, creates an initial commit, sets up bare remote, calls `initCore`. Reusable across stories.
- `parseTitle` in graphService remains body-driven (H1) — for the tree it still uses filename per current behavior. Frontmatter `title` is consumed by the future API/PWA layer where we want the human title to flow through.
- This story does NOT change `saveNote` (Story 1.7).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

### Completion Notes List

### File List

### Change Log
