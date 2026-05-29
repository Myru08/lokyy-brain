import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for the PWA workspace.
 *
 * - jsdom environment so React Testing Library can render components and
 *   `api.ts` can read `navigator.onLine` without a real browser.
 * - `globals: true` exposes `describe/it/expect/vi` without per-file imports
 *   AND lets `@testing-library/jest-dom` register its matchers globally.
 * - `setupFiles` wires jest-dom matchers and resets mocks between tests.
 * - `include` is scoped to `*.test.ts(x)` under `src` so production sources
 *   are never picked up as test files.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    clearMocks: true,
    restoreMocks: true,
  },
});
