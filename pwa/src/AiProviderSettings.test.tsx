import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderSettings } from "./AiProviderSettings.js";
import { api } from "./api.js";
import type { LlmConfigResponse, OllamaModelStatus } from "./api.js";

/**
 * issue #46 — the AI-Provider panel must expose the Ollama local-model gap.
 *
 * Guarantees a careless refactor would break:
 *   - a configured-but-missing local model is shown as fehlt with a 1-click
 *     install button (Privacy-Max's chat model is the load-bearing case),
 *   - clicking install kicks off the pull stream for that exact model.
 */

const CONFIG: LlmConfigResponse = {
  providers: [{ name: "ollama", enabled: true, baseUrl: "http://ollama-x:11434" }],
  routing: {
    privacyTier: "always_local",
    roles: {
      embedding: { provider: "ollama", model: "nomic-embed-text" },
      hyde: { provider: "ollama", model: "llama3.1:8b" },
    },
  },
  usage: [],
};

// Ollama up, embed model present, chat model (llama3.1:8b) missing.
const STATUS: OllamaModelStatus = {
  ollamaReachable: true,
  host: "http://ollama-x:11434",
  installed: ["nomic-embed-text:latest"],
  models: [],
};

function mockLoads(status: OllamaModelStatus = STATUS) {
  vi.spyOn(api, "getLlmConfig").mockResolvedValue(CONFIG);
  vi.spyOn(api, "getOpenAICompatPresets").mockResolvedValue([]);
  vi.spyOn(api, "getOllamaModelStatus").mockResolvedValue(status);
}

afterEach(() => vi.restoreAllMocks());

describe("AiProviderSettings — Ollama local models", () => {
  it("shows a missing chat model with a 1-click install button + Privacy-Max warning", async () => {
    mockLoads();
    render(<AiProviderSettings />);

    // The chat model is flagged missing with an install button carrying its size.
    const installBtn = await screen.findByRole("button", { name: /Modell installieren/ });
    expect(installBtn).toHaveTextContent(/GB|MB/);
    // …and the Privacy-Max/local warning names the missing model.
    expect(screen.getByText(/Lokales Chat-Modell fehlt/)).toBeInTheDocument();
    // The local-models section labels the model with its role/kind.
    expect(screen.getByText(/chat · hyde/)).toBeInTheDocument();
  });

  it("kicks off the pull stream for the clicked model", async () => {
    mockLoads();
    const streamSpy = vi
      .spyOn(api, "streamOllamaPull")
      .mockReturnValue(() => {});
    render(<AiProviderSettings />);

    const installBtn = await screen.findByRole("button", { name: /Modell installieren/ });
    fireEvent.click(installBtn);

    await waitFor(() => expect(streamSpy).toHaveBeenCalledTimes(1));
    expect(streamSpy.mock.calls[0][0]).toBe("llama3.1:8b");
  });

  it("warns when Ollama itself is unreachable", async () => {
    mockLoads({ ...STATUS, ollamaReachable: false, installed: [], error: "ECONNREFUSED" });
    render(<AiProviderSettings />);

    expect(await screen.findByText(/Ollama nicht erreichbar/)).toBeInTheDocument();
  });
});
