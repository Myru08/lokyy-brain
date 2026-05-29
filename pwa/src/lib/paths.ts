/**
 * Pure vault-path helpers.
 *
 * These mirror the inline logic in `App.tsx` (`safeName` at the top of the
 * file and the create-in-folder join inside `handleCreate`) so the rules
 * that historically broke — path-unsafe characters slipping through and the
 * parent-prefix join — can be unit-tested without rendering React.
 *
 * Keep these 1:1 with `App.tsx`. If the component's logic changes, change it
 * here too (and the test will tell you when they drift).
 */

/**
 * Strip path-unsafe characters, keep spaces (Obsidian-faithful), and trim
 * surrounding whitespace. Mirrors `safeName` in `App.tsx`.
 *
 * Removed characters: `/ \ : * ? " < > |` — the cross-platform-illegal set
 * plus the path separators (so a name can never inject a sub-folder).
 */
export function safeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

/**
 * Build the full vault path for a newly created note/folder. Mirrors the
 * `parentPath ? `${parentPath}/${clean}` : clean` join in `handleCreate`.
 *
 * `parentPath` is the (already-valid) folder the entry is created in, or an
 * empty string for the vault root. `rawName` is the user's untrusted input;
 * it is sanitised via {@link safeName} before joining.
 *
 * Returns `null` when the sanitised name is empty — the caller (handleCreate)
 * treats that as "do nothing" (`if (!clean) return;`), so a structured
 * `null` lets tests assert that branch instead of producing a path that
 * dangles a trailing slash.
 */
export function buildCreatePath(
  parentPath: string,
  rawName: string,
): string | null {
  const clean = safeName(rawName);
  if (!clean) return null;
  return parentPath ? `${parentPath}/${clean}` : clean;
}
