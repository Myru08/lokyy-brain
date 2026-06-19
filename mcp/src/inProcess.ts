import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "./server.js";
import { handleMcpHttpRequest } from "./httpServer.js";

/**
 * In-process MCP HTTP entry. Lets another Node process (the brain's Hono app)
 * serve the MCP Streamable-HTTP transport on its OWN listener at `/mcp` —
 * instead of running a separate `binHttp.js` container/port. Keeps the MCP SDK
 * and the per-session `Server` factory inside the `@lokyy/mcp` package so the
 * caller never has to depend on `@modelcontextprotocol/sdk` directly.
 *
 * Prerequisite: `initServerDeps(...)` (exported from `./server.js`) must have
 * run once in the host process before the first request.
 */
export async function handleMcpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  await handleMcpHttpRequest(req, res, () => createServer(), token);
}
