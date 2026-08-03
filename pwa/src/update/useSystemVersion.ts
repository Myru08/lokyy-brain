import { useEffect, useState } from "react";
import { api, type SystemVersion } from "../api.js";
import { reconcileBundleVersion } from "./cacheRenewal.js";

/**
 * Story 7.12 Task 5 — one place that asks `GET /api/system/version`.
 *
 * Besides handing the payload to the banner and the settings tab, this hook
 * performs cache-renewal path (a): compare the bundle's own build version
 * against the server's `running` and, on a mismatch, drop the service worker
 * and reload exactly once (AC#7). That check is deliberately NOT gated on a
 * role — a stale shell is a stale shell for everyone, and this is the path
 * that repairs the manual `git pull && ./install.sh` route.
 *
 * `api.getSystemVersion()` never throws, so a failed check stays invisible
 * (AC#3): the hook simply keeps `status: "unknown"`, which means "no banner".
 */
/**
 * The build version of THIS bundle.
 *
 * `__LOKYY_BUILD_VERSION__` is a Vite `define`, i.e. a literal substitution at
 * build time — it is NOT a real global. Under vitest (its own config, no
 * `define`) the identifier simply does not exist, so it is read through
 * `typeof`, which is the one operator that tolerates an undeclared name. The
 * `""` fallback means "unknown", and `reconcileBundleVersion` refuses to
 * compare an unknown version. That is what keeps a build without version info
 * from reloading itself forever.
 */
export function bundleVersion(): string {
  return typeof __LOKYY_BUILD_VERSION__ === "string" ? __LOKYY_BUILD_VERSION__ : "";
}

export function useSystemVersion(): { version: SystemVersion | null } {
  const [version, setVersion] = useState<SystemVersion | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const payload = await api.getSystemVersion();
      if (cancelled) return;
      setVersion(payload);
      await reconcileBundleVersion(bundleVersion(), payload.running);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { version };
}
