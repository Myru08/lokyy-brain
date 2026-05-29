import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "./Spinner.js";

/**
 * Render smoke test — proves the jsdom + React Testing Library pipeline
 * works end to end (component mounts, DOM is queryable, jest-dom matchers
 * are registered). Spinner is a pure presentational SVG with no network or
 * context deps, so it's the cleanest probe for the test harness itself.
 */
describe("Spinner", () => {
  it("renders a status role with the default 'loading' label", () => {
    render(<Spinner />);

    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute("aria-label", "loading");
  });

  it("honours a custom aria-label and size", () => {
    render(<Spinner label="saving" size={32} />);

    const status = screen.getByRole("status", { name: "saving" });
    expect(status).toBeInTheDocument();
    expect(status).toHaveStyle({ width: "32px", height: "32px" });
  });

  it("draws the SVG geometry (orbit arc + brain glyph)", () => {
    const { container } = render(<Spinner />);

    expect(container.querySelector("svg")).not.toBeNull();
    // Two <g> groups: the orbiting arc and the centre brain silhouette.
    expect(container.querySelectorAll("svg g")).toHaveLength(2);
  });
});
