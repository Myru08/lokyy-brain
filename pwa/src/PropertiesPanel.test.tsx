import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PropertiesPanel } from "./PropertiesPanel.js";

/**
 * Roundtrip tests for the "+ Property" feature.
 *
 * The panel is client-side only: it parses frontmatter from `body`, and on
 * every change re-serializes the whole document and reports it back via
 * `onUpdateBody`. The critical guarantee these tests lock in is that a
 * NEWLY-added key (custom or schema-suggested) flows through that same
 * serialize path and appears in the resulting frontmatter string — including
 * its value — so it survives a save→reload roundtrip.
 *
 * To assert the roundtrip without depending on @lokyy/core (node-only), we
 * re-parse the emitted body with a tiny inline frontmatter reader and check
 * the keys/values are present.
 */

const NOTE_BODY = [
  "---",
  "id: 01HZX9K2QWERTY12345ABCDEF",
  "type: note",
  "title: My Note",
  "created: 2026-05-01T10:00:00.000Z",
  "updated: 2026-05-01T10:00:00.000Z",
  "---",
  "",
  "Body content stays untouched.",
  "",
].join("\n");

/** Minimal frontmatter reader mirroring the panel's own flat parser. */
function readFrontmatter(doc: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(doc);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const km = /^([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
    if (km) out[km[1] as string] = (km[2] as string).trim();
  }
  return out;
}

/**
 * Drive the panel through a controlled-component harness so successive
 * onUpdateBody calls compound — mirroring how App.tsx re-feeds `body`. The
 * spy captures every emitted document; the last one is the roundtrip result.
 */
function renderControlled(initial: string) {
  const spy = vi.fn();
  let current = initial;
  function Harness() {
    const [doc, setDoc] = useState(initial);
    current = doc;
    return (
      <PropertiesPanel
        body={doc}
        expanded
        onToggle={() => {}}
        onUpdateBody={(next) => {
          spy(next);
          setDoc(next);
        }}
      />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, spy, getDoc: () => current };
}

describe("PropertiesPanel — add property roundtrip", () => {
  it("renders existing frontmatter keys and the + Property button", () => {
    render(
      <PropertiesPanel
        body={NOTE_BODY}
        expanded
        onToggle={() => {}}
        onUpdateBody={() => {}}
      />,
    );
    expect(screen.getByText("title")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ Property" }),
    ).toBeInTheDocument();
  });

  it("adds a schema-suggested field (tags) via one click and round-trips it", () => {
    const { spy, getDoc } = renderControlled(NOTE_BODY);

    fireEvent.click(screen.getByRole("button", { name: "+ Property" }));
    // `tags` is a suggested optional field for type=note.
    fireEvent.click(screen.getByRole("button", { name: "+ tags" }));

    expect(spy).toHaveBeenCalled();
    const fm = readFrontmatter(getDoc());
    expect(fm).toHaveProperty("tags");
    // Empty array serializes as "[]".
    expect(fm.tags).toBe("[]");
  });

  it("adds a custom field with a value and includes it in the emitted frontmatter", () => {
    const { getDoc } = renderControlled(NOTE_BODY);

    fireEvent.click(screen.getByRole("button", { name: "+ Property" }));

    const keyInput = screen.getByLabelText("Custom property key");
    fireEvent.change(keyInput, { target: { value: "priority" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    // The new field renders in the grid: label + value cell are siblings in
    // the CSS grid (flat Fragments), so the value lives in the label's next
    // sibling element. Give it a value, then assert it lands in frontmatter.
    const priorityLabel = screen.getByText("priority");
    const valueCell = priorityLabel.nextElementSibling as HTMLElement;
    const valueInput = within(valueCell).getByRole("textbox");
    fireEvent.change(valueInput, { target: { value: "high" } });

    const fm = readFrontmatter(getDoc());
    expect(fm).toHaveProperty("priority");
    expect(fm.priority).toBe("high");
  });

  it("adds a tags chip value and round-trips the array content", () => {
    const { getDoc } = renderControlled(NOTE_BODY);

    fireEvent.click(screen.getByRole("button", { name: "+ Property" }));
    fireEvent.click(screen.getByRole("button", { name: "+ tags" }));

    // Tags renders a ChipInput; type + Enter commits a chip.
    const tagsLabel = screen.getByText("tags");
    const valueCell = tagsLabel.nextElementSibling as HTMLElement;
    const chipInput = within(valueCell).getByPlaceholderText("add…");
    fireEvent.change(chipInput, { target: { value: "urgent" } });
    fireEvent.keyDown(chipInput, { key: "Enter" });

    const fm = readFrontmatter(getDoc());
    expect(fm).toHaveProperty("tags");
    expect(fm.tags).toContain("urgent");
  });

  it("keeps id read-only (immutable) and without a remove icon", () => {
    render(
      <PropertiesPanel
        body={NOTE_BODY}
        expanded
        onToggle={() => {}}
        onUpdateBody={() => {}}
      />,
    );
    const idLabel = screen.getByText("id");
    const valueCell = idLabel.nextElementSibling as HTMLElement;
    const idInput = within(valueCell).getByRole("textbox") as HTMLInputElement;
    expect(idInput.readOnly).toBe(true);
    expect(
      within(valueCell).queryByRole("button", { name: /Remove id/ }),
    ).toBeNull();
  });

  it("removes a custom field via its remove icon", () => {
    // Seed with an existing custom field so the remove icon is present.
    const seeded = NOTE_BODY.replace(
      "updated: 2026-05-01T10:00:00.000Z\n",
      "updated: 2026-05-01T10:00:00.000Z\nproject_phase: discovery\n",
    );
    const { getDoc } = renderControlled(seeded);

    expect(readFrontmatter(getDoc())).toHaveProperty("project_phase");

    const label = screen.getByText("project_phase");
    const valueCell = label.nextElementSibling as HTMLElement;
    fireEvent.click(
      within(valueCell).getByRole("button", { name: "Remove project_phase" }),
    );

    expect(readFrontmatter(getDoc())).not.toHaveProperty("project_phase");
  });
});
