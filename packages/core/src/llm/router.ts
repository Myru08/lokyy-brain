import type { LlmProvider, LlmRole, LlmRoutingConfig } from "./types.js";
import { llmRegistry } from "./registry.js";
import { LlmUnavailable } from "./errors.js";

/**
 * Routes a role to its configured provider. Privacy-tier-aware:
 * if the note context is local-only OR privacyTier=always_local OR
 * (privacyTier=local_for_personal_folders AND note in protected folder),
 * the router forces a local-isLocal provider regardless of the role mapping.
 */
export interface RouteContext {
  /** true if the requesting note has frontmatter `privacy: local-only` */
  noteIsPrivate?: boolean;
  /** the note's folder, used together with privacyTier=local_for_personal_folders */
  noteFolder?: string;
}

export class LlmRouter {
  constructor(private config: LlmRoutingConfig) {}

  /**
   * Returns the provider chain to try for a role (primary first, then fallbacks).
   * Resolves privacy-tier to filter cloud providers when appropriate.
   */
  getProviderChain(role: LlmRole, ctx: RouteContext = {}): LlmProvider[] {
    const enforceLocal = this.shouldEnforceLocal(ctx);
    const tried = new Set<string>();
    const chain: LlmProvider[] = [];

    const mapping = this.config.roles[role];
    const candidates = [
      ...(mapping ? [mapping.provider] : []),
      ...(this.config.fallbacks?.[role] ?? []),
    ];

    for (const name of candidates) {
      if (tried.has(name)) continue;
      tried.add(name);
      const provider = llmRegistry().get(name);
      if (!provider) continue;
      if (enforceLocal && !provider.info.isLocal) continue;
      chain.push(provider);
    }

    if (chain.length === 0) {
      throw new LlmUnavailable(
        role,
        `no provider available for role=${role} (privacy=${enforceLocal ? "local-only" : "any"})`,
      );
    }
    return chain;
  }

  /** Convenience: get primary provider only (or throws). */
  getProvider(role: LlmRole, ctx: RouteContext = {}): LlmProvider {
    return this.getProviderChain(role, ctx)[0]!;
  }

  private shouldEnforceLocal(ctx: RouteContext): boolean {
    if (ctx.noteIsPrivate) return true;
    if (this.config.privacyTier === "always_local") return true;
    if (
      this.config.privacyTier === "local_for_personal_folders" &&
      ctx.noteFolder &&
      this.config.privacyTierFolders?.some((f) => ctx.noteFolder!.startsWith(f))
    )
      return true;
    return false;
  }
}
