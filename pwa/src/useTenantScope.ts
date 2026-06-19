import { useEffect, useState } from "react";
import { api, getActiveVaultCookie } from "./api.js";
import type { TenantScope } from "./FileTree.js";

/**
 * Folder-share controller for the active vault (Freigaben). Returns a
 * `TenantScope` (per-folder state + cycle) ONLY when the active vault is a
 * tenant (shared/company) — otherwise null, so the FileTree shows no locks for
 * the owner's own vault. Cycling a folder rewrites the customer's scope via the
 * API (live for the MCP immediately) and re-renders with the new state.
 */
const glob = (p: string) => `${p}/**`;

export function useTenantScope(): TenantScope | null {
  const [scope, setScope] = useState<TenantScope | null>(null);

  useEffect(() => {
    let cancelled = false;
    const vid = getActiveVaultCookie();
    if (!vid) {
      setScope(null);
      return;
    }
    void (async () => {
      try {
        const vs = await api.getVaults();
        const v = vs.vaults.find((x) => x.id === vid);
        if (!v || v.isDefault || v.kind === "personal") {
          if (!cancelled) setScope(null);
          return;
        }
        const s = await api.getTenantScope(vid);
        let read = [...s.readGlobs];
        let write = [...s.writeGlobs];
        const build = (): TenantScope => ({
          stateFor: (p) =>
            write.includes(glob(p)) ? "write" : read.includes(glob(p)) ? "read" : "hidden",
          cycle: (p) => {
            const g = glob(p);
            const cur = write.includes(g) ? "write" : read.includes(g) ? "read" : "hidden";
            const next = cur === "hidden" ? "read" : cur === "read" ? "write" : "hidden";
            read = read.filter((x) => x !== g);
            write = write.filter((x) => x !== g);
            if (next === "read" || next === "write") read = [...read, g];
            if (next === "write") write = [...write, g];
            void api.putTenantScope(vid, { readGlobs: read, writeGlobs: write });
            setScope(build());
          },
        });
        if (!cancelled) setScope(build());
      } catch {
        if (!cancelled) setScope(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return scope;
}
