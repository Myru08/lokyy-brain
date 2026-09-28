import { afterEach, describe, expect, it, vi } from "vitest";

import { OllamaProvider } from "./ollama.js";

/**
 * Fork: chat() streamt (NDJSON), damit Nodes fester headersTimeout (300 s)
 * lange lokale Inferenz nicht mehr abbricht. Geprüft wird das Zusammensetzen.
 */
function ndjson(...chunks: object[]): Response {
  return new Response(chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe("OllamaProvider.chat (Stream)", () => {
  it("fordert stream: true an und setzt Text und Usage zusammen", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return ndjson(
        { model: "m", message: { role: "assistant", content: "Hal" }, done: false },
        { model: "m", message: { role: "assistant", content: "lo" }, done: false },
        { model: "m", message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 3 },
      );
    });
    const res = await new OllamaProvider({ baseUrl: "http://x:11434" }).chat([
      { role: "user", content: "hi" },
    ]);
    expect(sent.stream).toBe(true);
    expect(res.text).toBe("Hallo");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(res.finishReason).toBe("stop");
  });

  it("übernimmt Tool-Calls aus einem Teilstück", async () => {
    vi.stubGlobal("fetch", async () =>
      ndjson(
        { message: { content: "", tool_calls: [{ function: { name: "t", arguments: { a: 1 } } }] } },
        { message: { content: "" }, done: true, done_reason: "stop" },
      ),
    );
    const res = await new OllamaProvider({ baseUrl: "http://x:11434" }).chat([
      { role: "user", content: "x" },
    ]);
    expect(res.toolCalls).toEqual([{ name: "t", input: { a: 1 } }]);
    expect(res.finishReason).toBe("tool_use");
  });

  it("meldet einen Fehler-Datensatz im Stream als Fehler", async () => {
    vi.stubGlobal("fetch", async () => ndjson({ error: "model not found" }));
    await expect(
      new OllamaProvider({ baseUrl: "http://x:11434" }).chat([{ role: "user", content: "x" }]),
    ).rejects.toThrow(/model not found/);
  });
});
