# Story 1.5: Vault Compliance Utility (Frontmatter + ULID + AJV)

Status: done

## Story

As a developer,
I want a shared frontmatter utility in `@lokyy/core` using `ulid`, `gray-matter`, and `ajv`,
so that every note write is provably SPEC-valid and rejection from the vault hook surfaces as a typed error.

## Acceptance Criteria

1. `@lokyy/core` declares `ulid@^3.0.2`, `gray-matter@^4.0.3`, `ajv@^8.20.0` as dependencies (plus `ajv-formats` for date-time validation if needed).
2. `packages/core/src/frontmatter/index.ts` exposes: `parseFrontmatter(raw: string): { data: FrontmatterMap; body: string }`, `serializeFrontmatter(data: FrontmatterMap, body: string): string`, `validateFrontmatter(data: FrontmatterMap, type: DocType): ValidationResult`, `generateUlid(): string`.
3. `packages/core/src/frontmatter/schemas/` contains one JSON schema per doc type (`note`, `capture`, `project`, `task`, `decision`, `meeting`, `customer`, `workflow`, `intervention`, `content`). Schemas validate the required SPEC fields: `id` (ULID, 26 chars), `type` (matches the schema's doc type), `title` (string), `created` (ISO-8601 date-time), `updated` (ISO-8601 date-time).
4. `packages/core/src/errors/FrontmatterValidationError.ts` exports a distinct error class with `cause`, `noteId`, and `errors` (Ajv error list) fields. Extends `Error`.
5. The frontmatter utility is re-exported from `packages/core/src/index.ts` so `server` / `mcp` can import directly.
6. Unit tests (Vitest) cover at minimum: (a) valid `note` round-trip — parse → validate → serialize → parse → identical data; (b) missing required `id` field rejected; (c) wrong `type` value rejected; (d) invalid ULID format (wrong length, wrong charset) rejected; (e) invalid `created` ISO-8601 rejected; (f) `serialize → parse` preserves data fidelity including arrays/nested values.
7. `pnpm --filter @lokyy/core build` exits 0.
8. `pnpm --filter @lokyy/core test` exits 0 (Vitest runner installed; ≥10 test cases pass).
9. `pnpm -r build` exits 0 across all workspaces.
10. Server boot still reaches `lokyy-brain Server laeuft auf :8787`; PWA still loads (Playwright check, no new console errors).
11. **Anti:** `notesService` is NOT modified in this story. Story 1.6 wires `createNote` to the new utility; Story 1.7 wires `saveNote`. This story only adds the utility surface + tests.

## Tasks / Subtasks

- [x] **Task 1:** Added deps: `ulid@^3.0.2`, `gray-matter@^4.0.3`, `ajv@^8.20.0`, `ajv-formats@^3.0.1`; devDep `vitest@^1.6.0`. `pnpm install` exit 0 (+64 packages, 9.2s).
- [x] **Task 2:** `generateUlid()` wraps `ulid()` — provides indirection for future swap.
- [x] **Task 3:** `parseFrontmatter` + `serializeFrontmatter` use `gray-matter` defaults (YAML, `---` delimiters).
- [x] **Task 4:** 11 JSON schemas in `packages/core/src/frontmatter/schemas/` (1 base + 10 doc types). Each type schema locks `type` to its single value via `const`.
- [x] **Task 5:** `validateFrontmatter(data, type)` compiles + caches per-type Ajv validators at module load; uses `ajv-formats` for `date-time`. Returns typed `ValidationResult`.
- [x] **Task 6:** `FrontmatterValidationError` exports `noteId`, `errors`, `cause` fields.
- [x] **Task 7:** `packages/core/vitest.config.ts` with `test.include: ['src/**/*.test.ts']`. Script `test: vitest run` added.
- [x] **Task 8:** 16 test cases written (exceeds the 6-case AC floor) covering: ULID format + uniqueness, parse/serialize round-trip, parse-on-no-frontmatter, valid note, missing id, wrong type value, invalid ULID (short), invalid ULID (forbidden chars I/L/O/U), invalid date-time, empty title, valid capture with source, invalid source enum, unknown type fallback, full end-to-end createNote-like flow.
- [x] **Task 9:** Re-exported from `packages/core/src/index.ts` with `FrontmatterValidationError` also exported from `./errors/`.
- [x] **Task 10:** Build exit 0 across all workspaces; tests 16/16 pass; Playwright reload shows same baseline console (1 pre-existing favicon 404, 3 pre-existing a11y warnings).

## Dev Agent Record

### Debug Log References

- Initial Ajv import wrote `new Ajv.default(...)` and `addFormats.default(ajv)` — wrong for `esModuleInterop: true`. With interop the default import is the constructor itself. Fixed to `new Ajv(...)` + `addFormats(ajv)`. Build exit 0 after fix.
- Added `resolveJsonModule: true` to `packages/core/tsconfig.json` so the schemas can be `import`ed via `with { type: "json" }`. Also added `"exclude": ["src/**/*.test.ts"]` so tsc build doesn't compile Vitest specs (Vitest runs them via its own bundler).
- `pnpm --filter @lokyy/core test`: 16/16 tests pass in 936ms. Validators compile once, are cached in a Map keyed by DocType — no recompilation on validation calls.
- The `FrontmatterValidationError` is exported but not yet thrown anywhere. Story 1.6 (`createNote`) and Story 1.7 (`saveNote`) wire it into the notesService write path.
- Playwright PWA reload: same baseline (msgid 29-34), no new console errors. No regression from adding deps.

### Completion Notes List

- 16 test cases exceeds the AC #6 floor of 6 — additional cases were cheap once the test harness was set up. Coverage spans the happy path + 8 distinct rejection modes + an end-to-end flow.
- The base schema in `schemas/base.json` is currently unused by validators — kept as a reference / fallback path for the "unknown type" case. Removing it has no behavioral impact but keeping it documents the shared shape.
- Doc types beyond `note` and `capture` have minimal extensions in their schemas (just optional fields like `status`, `due`, `attendees`). Stories that introduce those types (e.g. Epic 8's `intervention`, future task/project workflows) can tighten the schemas without touching the framework.
- gray-matter's stringify orders keys by insertion order — callers should construct frontmatter objects in the order they want serialized. Tests verify round-trip preserves order.
- Vault hook integration: this story does NOT install a pre-commit hook in any vault. The hook is a vault-side concern (separate repo). This utility is the *client-side* equivalent that should prevent invalid writes from ever reaching the hook. Once the lokyy-vault repo is set up (Epic 1.9 / deferred Forgejo setup), the hook will use the same JSON schemas (or a port of them).

### File List

**New:**
- `packages/core/src/frontmatter/index.ts` — public surface
- `packages/core/src/frontmatter/types.ts` — DocType, FrontmatterMap, ValidationResult
- `packages/core/src/frontmatter/frontmatter.test.ts` — 16 Vitest cases
- `packages/core/src/frontmatter/schemas/base.json`
- `packages/core/src/frontmatter/schemas/note.json`
- `packages/core/src/frontmatter/schemas/capture.json`
- `packages/core/src/frontmatter/schemas/project.json`
- `packages/core/src/frontmatter/schemas/task.json`
- `packages/core/src/frontmatter/schemas/decision.json`
- `packages/core/src/frontmatter/schemas/meeting.json`
- `packages/core/src/frontmatter/schemas/customer.json`
- `packages/core/src/frontmatter/schemas/workflow.json`
- `packages/core/src/frontmatter/schemas/intervention.json`
- `packages/core/src/frontmatter/schemas/content.json`
- `packages/core/src/errors/FrontmatterValidationError.ts`
- `packages/core/vitest.config.ts`

**Modified:**
- `packages/core/package.json` (added 4 deps + vitest devDep + test script)
- `packages/core/tsconfig.json` (added `resolveJsonModule: true` and excluded test files)
- `packages/core/src/index.ts` (re-export frontmatter surface + FrontmatterValidationError)
- `pnpm-lock.yaml` (regenerated)

### Change Log

| Date | Change | By |
|------|--------|-----|
| 2026-05-24 | Vault-compliance frontmatter utility added to `@lokyy/core`: parse/serialize/validate via gray-matter + Ajv, ULID generator, 10 doc-type schemas, FrontmatterValidationError. 16/16 unit tests pass. Build green, PWA Playwright-regression-free. Status: in-progress → done. | Dev agent (claude-opus-4-7) |

## Dev Notes

### ULID format

26 chars, Crockford's base32 (no I, L, O, U): `[0-9A-HJ-KMNP-TV-Z]{26}`. The `ulid` package's output is already correctly formatted. Schema regex: `^[0-9A-HJKMNP-TV-Z]{26}$`.

### Doc-type design

For v1, all schemas share the same required base. Type-specific extensions land as Stories require them. The 10 types listed in CLAUDE.md SPEC:
`note`, `capture`, `project`, `task`, `decision`, `meeting`, `customer`, `workflow`, `intervention`, `content`.

Each schema's `type` enum locks it to exactly one value (e.g. `note` schema requires `type: "note"`). This means `validateFrontmatter(data, 'note')` rejects a note with `type: 'capture'` as a defensive cross-check.

### gray-matter setup

Default config writes YAML with `---` delimiters — matches the SPEC. `gray-matter` parses lenient (works on docs without frontmatter, returns empty data). For SPEC-compliance we layer validation on top: empty data → validation fails on missing required fields.

### Ajv + ajv-formats

Use `Ajv` strict mode + `addFormats(ajv)` to enable `date-time` format. Compile each schema once at module load. Cache compiled validators per type.

### File structure

```
packages/core/src/
├── frontmatter/
│   ├── index.ts                          (parse / serialize / validate / generateUlid)
│   ├── schemas/
│   │   ├── base.json                     (shared required fields)
│   │   ├── note.json
│   │   ├── capture.json
│   │   ├── project.json
│   │   ├── task.json
│   │   ├── decision.json
│   │   ├── meeting.json
│   │   ├── customer.json
│   │   ├── workflow.json
│   │   ├── intervention.json
│   │   └── content.json
│   ├── frontmatter.test.ts               (Vitest)
│   └── types.ts                          (FrontmatterMap, DocType, ValidationResult)
└── errors/
    └── FrontmatterValidationError.ts
```

### Vitest config

Add `vitest@^1.6.0` as devDep. Create `packages/core/vitest.config.ts` with `test.include: ['src/**/*.test.ts']`. Add `"test": "vitest run"` script.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.5]
- [Source: _bmad-output/planning-artifacts/architecture.md — Tech Stack lines 122-124: ulid 3.0.2, gray-matter 4.0.3, ajv 8.20.0]
- [Source: CLAUDE.md "Vault Contract (SPEC)" section — closed list of 10 doc types]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

### Completion Notes List

### File List

### Change Log
