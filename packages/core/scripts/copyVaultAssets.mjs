/**
 * Copy the non-TypeScript vault assets into `dist/` after `tsc` (Story 1.19).
 *
 * `src/vault/` ships three kinds of file `tsc` does not emit: the POSIX-sh
 * pre-commit hook, `SPEC.md` and the note templates. `buildVaultScaffold()`
 * reads them relative to its own `import.meta.url`, so the same relative layout
 * has to exist under `dist/vault/` for the built server — otherwise the scaffold
 * works in tests and fails in production.
 *
 * Deliberately no `cp -r`: this runs on the Docker build too, where a shell
 * builtin's flags are not something to bet a release on.
 */

import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/vault/", import.meta.url));
const dest = fileURLToPath(new URL("../dist/vault/", import.meta.url));

await cp(src, dest, {
  recursive: true,
  // Everything tsc already handles (or must not ship) stays out.
  filter: (path) => !/\.tsx?$/.test(path),
});

console.log("[core] vault assets copied to dist/vault/");
