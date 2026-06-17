/**
 * `createManaged` — THE single sanctioned write path for new notes (OS-contract,
 * ADR-004 / ISC-59).
 *
 * A caller (the MCP `notes.create_managed` tool OR the HTTP
 * `POST /api/notes/create-managed` route) supplies an INTENT only:
 *
 *   { title, body?, type, tags?, folder_hint? }
 *
 * Brain owns everything else:
 *   - the target PATH is DERIVED from `type` (canonical `type → folder` map +
 *     dated `{folder}/{YYYY-MM-DD}-{slug}` for captures/tasks, slug from title);
 *     the client NEVER dictates the path or frontmatter;
 *   - the ULID, `created`/`updated`, and SPEC-valid frontmatter are assembled by
 *     `createNote` (same code path as every other note write), so there is no
 *     second frontmatter-assembly surface to drift.
 *
 * This file is the ONE source of truth shared by both transports:
 *   - the pure resolver (`resolveManagedCreate` + `slugifyTitle`) is exported so
 *     the MCP layer can scope-gate the derived path BEFORE writing;
 *   - the orchestrator (`createManaged`) resolves THEN writes via `createNote`,
 *     used directly by the HTTP route (which has no per-note scope model).
 */

import {
  checkPathMatchesType,
  derivePathForType,
  folderForType,
  isDatedType,
} from "./folderMap.js";
import { createNote } from "./notesService.js";
import { TypeFolderMismatchError } from "../errors/TypeFolderMismatchError.js";
import { type AnyDocType } from "../frontmatter/types.js";
import {
  DEFAULT_VAULT_PROFILE,
  getProfileSpec,
  type VaultProfile,
} from "../frontmatter/profiles.js";
import type { Note } from "@lokyy/shared";

/**
 * Runtime type-guard for a profile's closed doc-type list. A present-but-unknown
 * type is REJECTED (never silently coerced to "note"). Story S3 — the allowed
 * set is the ACTIVE profile's `docTypes` (PARA's 15, or karpathy's three), so a
 * karpathy vault accepts `raw-source`/`wiki-article`/`frage-report` and a PARA
 * vault keeps rejecting them, exactly as before.
 */
function isProfileDocType(
  value: unknown,
  profile: VaultProfile,
): value is AnyDocType {
  const allowed = getProfileSpec(profile).docTypes as readonly string[];
  return typeof value === "string" && allowed.includes(value);
}

/**
 * Slugify a free-form title into a kebab-case slug for the derived note path.
 * Diacritics folded, non-alphanumerics collapsed to single hyphens, trimmed.
 * An empty result (e.g. an all-symbol title) falls back to "note" so a path is
 * always derivable. Pure → unit-testable.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "note";
}

/** The intent a caller passes to `createManaged` (ADR-004 NoteCreateIntent + superset). */
export interface NoteCreateIntent {
  title: string;
  body?: string;
  type: AnyDocType;
  tags?: string[];
  /** Optional location hint; honored only when under the type's canonical folder. */
  folder_hint?: string;
}

/** Structured error payloads `createManaged` returns before any write. */
export type ManagedCreateInputError =
  | { error: "invalid-type"; got: unknown; allowed: string[] }
  | { error: "missing-title"; message: string };

/** Resolved intent for a valid `createManaged` request. */
export type ManagedCreateInput =
  | { ok: true; type: AnyDocType; path: string; title: string; tags: string[] }
  | { ok: false; error: ManagedCreateInputError };

/**
 * Resolve a `createManaged` INTENT into { type, derived path, title, tags }
 * (ADR-004). The client supplies NO path and NO frontmatter:
 *
 *   - `type` is strict (a present-but-unknown value is rejected, never coerced;
 *     absent → "note"). Brain accepts its FULL DOC_TYPES superset — every
 *     ADR-004 NoteType is a subset, so this is backward-compatible.
 *   - The path is ALWAYS derived from `type` (canonical folder + dated pattern
 *     for captures/tasks), with the slug taken from `title`. A client-supplied
 *     path is structurally impossible (no `path` field on the intent).
 *   - `folder_hint` is honored ONLY when it is the type's canonical folder or a
 *     sub-folder of it; otherwise it is ignored and the canonical path wins
 *     (the hint can never escape the type's folder).
 *
 * Pure + side-effect-free so it is unit-testable without a live DB/git server.
 * `now` is injectable for deterministic tests of the dated pattern.
 */
export function resolveManagedCreate(
  args: Record<string, unknown>,
  now: Date = new Date(),
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): ManagedCreateInput {
  const allowedTypes = getProfileSpec(profile).docTypes;
  const rawType = args.type;
  let type: AnyDocType;
  if (rawType === undefined || rawType === null) {
    // Default home type per profile: PARA → "note"; karpathy has no "note", so
    // its first type (raw-source) is the safe ingest default.
    type = (allowedTypes as readonly AnyDocType[])[0] ?? "note";
    if (profile === "para") type = "note";
  } else if (isProfileDocType(rawType, profile)) {
    type = rawType;
  } else {
    return {
      ok: false,
      error: { error: "invalid-type", got: rawType, allowed: [...allowedTypes] },
    };
  }

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (title.length === 0) {
    return {
      ok: false,
      error: { error: "missing-title", message: "`title` is required and must be non-empty." },
    };
  }

  const slug = slugifyTitle(title);
  // Canonical, type-derived path (dated for captures/tasks under PARA, for
  // raw-source under karpathy). This is the default and the security boundary
  // — the client never dictates placement.
  let path = derivePathForType(type, slug, now, profile);

  // Optional folder_hint: honored ONLY when it sits under the type's canonical
  // folder (so it can refine the sub-folder, never escape the type's home).
  const hint =
    typeof args.folder_hint === "string" && args.folder_hint.trim().length > 0
      ? args.folder_hint.trim().replace(/^\/+|\/+$/g, "")
      : undefined;
  if (hint) {
    const canonical = folderForType(type, profile);
    // Path-traversal guard: a hint like `20_notes/../50_decisions` would PASS a
    // naive `startsWith("20_notes/")` check yet collapse (via path.join) to a
    // folder OUTSIDE the type's home — or, with enough `..`, escape the vault
    // root entirely. Reject any `..`/`.`/empty segment up front; such a hint is
    // ignored and the canonical path stands (same outcome as any other hint
    // that does not sit under the type's canonical folder).
    const segments = hint.split("/");
    const hasTraversal = segments.some(
      (seg) => seg === ".." || seg === "." || seg === "",
    );
    // A hint is honored when it sits under the type's canonical folder AND the
    // resulting path passes the (profile-aware) placement guard. The guard
    // encodes karpathy's flat-Wiki rule, so a `Wiki/sub` hint is rejected here
    // (the canonical flat path stands) instead of being built and then bounced
    // by createNote's guard.
    const underCanonical =
      !hasTraversal &&
      (hint === canonical || hint.startsWith(`${canonical}/`));
    // Re-derive the leaf via derivePathForType against the hint folder so the
    // dated prefix + profile-specific date separator (PARA `-`, karpathy `_`)
    // match exactly what createNote would synthesize.
    const datedLeaf = derivePathForType(type, slug, now, profile).split("/").pop();
    const leaf = isDatedType(type, profile) ? (datedLeaf ?? slug) : slug;
    const candidate = `${hint}/${leaf}`;
    if (underCanonical && checkPathMatchesType(type, candidate, profile).ok) {
      path = candidate;
    }
    // else: hint ignored — canonical path stands.
  }

  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t): t is string => typeof t === "string")
    : [];

  return { ok: true, type, path, title, tags };
}

/** Structured failure forms `createManaged` returns instead of throwing. */
export type ManagedCreateError =
  | ManagedCreateInputError
  | {
      error: "type-folder-mismatch";
      type: AnyDocType;
      expectedFolder: string;
      gotPath: string;
    };

/** Result of `createManaged`: the created note, or a structured error. */
export type ManagedCreateResult =
  | { ok: true; note: Note }
  | { ok: false; error: ManagedCreateError };

/**
 * THE sanctioned write path. Resolves the intent to a type-derived path, then
 * writes via the SHARED `createNote` (ULID / created / updated / frontmatter
 * assembly + SPEC validation identical to every other note write). `validate
 * Placement` is on — a contradictory derived path is structurally impossible
 * (we derive it), but the guard stays for the `folder_hint` sub-folder case.
 *
 * Returns a discriminated result rather than throwing for the EXPECTED error
 * shapes (invalid-type, missing-title, type-folder-mismatch) so both the MCP
 * tool and the HTTP route can map them to their own envelope without a
 * try/catch dance. Genuinely-unexpected errors (git/frontmatter) still throw
 * so the caller's error mapping (mapSaveError / classifyToolError) handles them.
 *
 * `now` is injectable for deterministic tests of the dated path.
 */
export async function createManaged(
  intent: NoteCreateIntent,
  now: Date = new Date(),
  profile: VaultProfile = DEFAULT_VAULT_PROFILE,
): Promise<ManagedCreateResult> {
  const resolved = resolveManagedCreate(
    intent as unknown as Record<string, unknown>,
    now,
    profile,
  );
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  const { type, path, title, tags } = resolved;

  try {
    const note = await createNote(path, intent.body, {
      title,
      type,
      profile,
      ...(tags.length > 0 ? { extra: { tags } } : {}),
      validatePlacement: true,
    });
    return { ok: true, note };
  } catch (err) {
    if (err instanceof TypeFolderMismatchError) {
      return {
        ok: false,
        error: {
          error: "type-folder-mismatch",
          type: err.type,
          expectedFolder: err.expectedFolder,
          gotPath: err.gotPath,
        },
      };
    }
    throw err;
  }
}
