import { defineConfig } from "vitest/config";

/**
 * Vitest-Konfiguration für `@lokyy/core`.
 *
 * ── Warum die Timeouts hier hochgesetzt sind ────────────────────────────
 *
 * Ein großer Teil dieser Suite sind INTEGRATIONSTESTS gegen einen echten
 * Git-Vault: `beforeAll` legt ein bare-Remote an, seedet ein Repo, committet,
 * pusht und klont über `ensureRepo`; jeder einzelne Test fährt danach echte
 * `git add → commit → pull --rebase → push`-Zyklen als Kindprozesse. Vitests
 * Defaults (`testTimeout` 5 s, `hookTimeout` 10 s) sind für UNIT-Tests
 * bemessen — für diese Klasse sind sie schlicht die falsche Größenordnung.
 *
 * Das ist keine Aussage über langsame Tests, sondern über Contention.
 * Gemessen auf dieser Suite:
 *   - langsamster Einzeltest ISOLIERT:            ~1,0 s
 *   - derselbe Test unter voller Datei-Parallelität: 14,9 s  (≈15×)
 *   - langsamste Datei (gitService, 43 Tests):      ~61–72 s
 * Sobald mehrere git-schwere Dateien gleichzeitig laufen, stauen sich die
 * Prozess-Spawns, und es reißen zuerst die `beforeAll`/`beforeEach`-Hooks
 * anderer Dateien — also Tests, die mit der Ursache nichts zu tun haben.
 * Mit den Defaults ist der Lauf hier reproduzierbar rot (5 Fehlschläge in
 * 3 Dateien), und `.github/workflows/ci.yml` fährt `pnpm -r --if-present
 * test` genau so: ohne Flags. Das wäre CI-Flake an fremden Dateien.
 *
 * Die Werte sind bewusst großzügig: ein Timeout soll einen HÄNGER fangen,
 * nicht langsame Integration bestrafen.
 *   - `testTimeout`  60 s = 4× der schlechtesten gemessenen Testlaufzeit.
 *     Ein Test, der das reißt, ist kaputt und nicht bloß langsam.
 *   - `hookTimeout` 120 s = doppelt so viel, weil die `beforeAll`-Hooks die
 *     schwerste Arbeit machen (mehrere git-Prozesse VOR dem ersten Test) und
 *     alle Dateien sie gleichzeitig zu Beginn des Laufs abarbeiten — genau
 *     dann ist die Contention am höchsten.
 *
 * Wer einen echten Hänger sucht, setzt die Werte per CLI-Flag runter
 * (`--testTimeout=5000`), statt sie hier zu senken.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
