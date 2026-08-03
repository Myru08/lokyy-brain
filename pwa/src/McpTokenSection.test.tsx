import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpTokenSection } from "./McpTokenSection.js";
import { api } from "./api.js";
import type { OwnMcpTokenList } from "./api.js";

/**
 * Story 7.10 — the MCP token section in Einstellungen.
 *
 * The guarantees worth locking in are the ones a careless refactor would break:
 *   - the plaintext is shown ONCE and never re-offered (only its hash exists),
 *   - the shared public default token is visibly flagged as insecure (AC#7),
 *   - revoking asks first and takes effect without a restart (AC#4).
 */

const EMPTY: OwnMcpTokenList = {
  vaultId: "01VAULT",
  vaultName: "Mein Vault",
  tokens: [],
  envToken: { configured: false, shared: false },
};

function listWith(over: Partial<OwnMcpTokenList>): OwnMcpTokenList {
  return { ...EMPTY, ...over };
}

const TOKEN_META = {
  id: "01TOKEN",
  agentId: "claude-code",
  role: "write",
  label: "Claude Desktop",
  createdAt: "2026-08-01T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(() => Promise.resolve()) },
  });
});

afterEach(() => vi.restoreAllMocks());

describe("McpTokenSection", () => {
  it("shows metadata of existing tokens but never a plaintext bearer (AC#2)", async () => {
    vi.spyOn(api, "listOwnMcpTokens").mockResolvedValue(
      listWith({ tokens: [{ ...TOKEN_META, lastUsedAt: "2026-08-02T09:00:00.000Z" }] }),
    );

    render(<McpTokenSection />);

    expect(await screen.findByText("Claude Desktop")).toBeInTheDocument();
    expect(screen.getByText(/claude-code/)).toBeInTheDocument();
    // There is no "show token again" affordance — it cannot exist.
    expect(screen.queryByText(/erneut anzeigen/i)).not.toBeInTheDocument();
  });

  it("flags the shared public default token as insecure (AC#7)", async () => {
    vi.spyOn(api, "listOwnMcpTokens").mockResolvedValue(
      listWith({ envToken: { configured: true, shared: true } }),
    );

    render(<McpTokenSection />);

    expect(
      await screen.findByText(/öffentlich bekannten Standard-Token/i),
    ).toBeInTheDocument();
  });

  it("shows a fresh token exactly once, with the connection block (AC#3)", async () => {
    vi.spyOn(api, "listOwnMcpTokens").mockResolvedValue(EMPTY);
    const create = vi.spyOn(api, "createOwnMcpToken").mockResolvedValue({
      ...TOKEN_META,
      vaultId: "01VAULT",
      token: "lokyy_mcp_PLAINTEXT123",
      connector: "/mcp",
    });
    const onFreshToken = vi.fn();

    render(
      <McpTokenSection endpoint="https://brain.example/mcp" onFreshToken={onFreshToken} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Token erzeugen/i }));

    expect(await screen.findByText("lokyy_mcp_PLAINTEXT123")).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    // The ready-to-paste Authorization header, and the "only once" warning.
    expect(
      screen.getByText(/Authorization: Bearer lokyy_mcp_PLAINTEXT123/),
    ).toBeInTheDocument();
    expect(screen.getByText(/nur dieses eine Mal/i)).toBeInTheDocument();
    expect(screen.getByText(/neu hinterlegen/i)).toBeInTheDocument();
    // Lifted so the config snippets can substitute their placeholder.
    expect(onFreshToken).toHaveBeenCalledWith("lokyy_mcp_PLAINTEXT123");

    // Dismissing removes it from the DOM for good.
    fireEvent.click(screen.getByRole("button", { name: /Verstanden/i }));
    await waitFor(() =>
      expect(screen.queryByText("lokyy_mcp_PLAINTEXT123")).not.toBeInTheDocument(),
    );
  });

  it("asks before revoking and states that it is effective immediately (AC#4)", async () => {
    vi.spyOn(api, "listOwnMcpTokens").mockResolvedValue(
      listWith({ tokens: [TOKEN_META] }),
    );
    const revoke = vi.spyOn(api, "revokeOwnMcpToken").mockResolvedValue({ ok: true });

    render(<McpTokenSection />);

    fireEvent.click(await screen.findByRole("button", { name: /widerrufen/i }));
    expect(revoke).not.toHaveBeenCalled(); // confirmation first

    fireEvent.click(screen.getByRole("button", { name: /Endgültig widerrufen/i }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("01TOKEN"));
    expect(screen.getByText(/ohne Neustart/i)).toBeInTheDocument();
  });

  it("surfaces a load failure instead of rendering an empty shell", async () => {
    vi.spyOn(api, "listOwnMcpTokens").mockRejectedValue(new Error("boom"));

    render(<McpTokenSection />);

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});
