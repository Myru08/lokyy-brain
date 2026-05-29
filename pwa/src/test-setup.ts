/**
 * Vitest setup — runs once per test file before any test.
 *
 * Registers `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
 * `toHaveAttribute`, …) and tears down the RTL DOM after each test so
 * render smoke tests don't leak nodes between cases.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
