/**
 * Story 7.12 Task 1 — build identity of the PWA bundle.
 *
 * Injected at build time by Vite (`define` in `pwa/vite.config.ts`) from the
 * monorepo root `package.json` — the same single source the server reads at
 * runtime for `GET /api/system/version`.
 *
 * `""` means "unknown" (the config could not read the root manifest). Treat
 * that as "do not compare" — an empty value must never be read as a version
 * mismatch, or a build without version info would reload itself forever.
 */
declare const __LOKYY_BUILD_VERSION__: string;
