// Guard: every Compose service that runs the brain/mcp process (built from the
// repo-root Dockerfile) MUST set OLLAMA_HOST. Rationale — the Tier2 embedding
// path builds `new Tier2Provider({ vaultId })` without an explicit host, so it
// reads process.env.OLLAMA_HOST and otherwise falls back to
// http://localhost:11434 (Tier2Provider.ts). In a container that is not Ollama,
// that fallback is ECONNREFUSED and semantic search dies on the write path.
// This bit us once: lokyy-mcp shipped without OLLAMA_HOST (Issue #41). Keep this
// gap from coming back.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/** Walk up to the monorepo root (the manifest named `lokyy-brain`). */
function repoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth <= 8; depth += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (parsed.name === "lokyy-brain") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// All Compose files that describe a real deployment of this stack.
const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.local.yml",
  "docker-compose.coolify.yml",
];

interface ComposeService {
  build?: string | { context?: string; dockerfile?: string; target?: string };
  environment?: string[] | Record<string, string | number | null>;
}

/**
 * A service runs the brain/mcp process when it is built from the repo-root
 * Dockerfile (dockerfile omitted or literally "Dockerfile"). The PWA
 * (pwa/Dockerfile) and updater (updater/Dockerfile) use their own Dockerfiles
 * and do not embed, so they are exempt. Image-based services (postgres, ollama,
 * forgejo) have no `build` and are exempt too.
 */
function runsBrainOrMcp(service: ComposeService): boolean {
  const build = service.build;
  if (build === undefined) return false;
  if (typeof build === "string") return true; // `build: .` → root Dockerfile
  const df = build.dockerfile;
  return df === undefined || df === "Dockerfile";
}

/** Does the service's environment declare OLLAMA_HOST (list or map form)? */
function hasOllamaHost(service: ComposeService): boolean {
  const env = service.environment;
  if (env === undefined) return false;
  if (Array.isArray(env)) {
    return env.some((entry) => /^OLLAMA_HOST(=|$)/.test(entry));
  }
  return Object.prototype.hasOwnProperty.call(env, "OLLAMA_HOST");
}

describe("Compose OLLAMA_HOST guard", () => {
  const root = repoRoot();

  it("locates the repo root", () => {
    expect(root).not.toBeNull();
  });

  for (const file of COMPOSE_FILES) {
    it(`${file}: every brain/mcp service sets OLLAMA_HOST`, () => {
      if (root === null) return; // covered by the assertion above
      const path = join(root, file);
      if (!existsSync(path)) return; // optional file; nothing to assert
      const doc = parse(readFileSync(path, "utf8")) as {
        services?: Record<string, ComposeService>;
      };
      const services = doc.services ?? {};
      const offenders = Object.entries(services)
        .filter(([, svc]) => runsBrainOrMcp(svc) && !hasOllamaHost(svc))
        .map(([name]) => name);
      expect(offenders, `${file}: missing OLLAMA_HOST on ${offenders.join(", ")}`).toEqual(
        [],
      );
    });
  }
});
