import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { coreConfig, initCore, type CoreConfig } from "../util/coreConfig.js";
import {
  classifyGitError,
  GitBackendError,
  MergeConflictError,
} from "../errors/GitError.js";

const exec = promisify(execFile);

/**
 * Git-Service. Kapselt die einzige echte Working-Copy des Vaults.
 *
 * Grundsatz: Forgejo ist die Wahrheit. Vor dem Lesen wird gepullt, beim
 * Speichern wird committet und sofort wieder mit dem Remote abgeglichen.
 * Operationen sind serialisiert (siehe `lock`), damit nie zwei git-Befehle
 * gleichzeitig auf dasselbe Repo losgehen.
 *
 * Configuration is shared with other core services via `coreConfig()`.
 * Callers initialize once via `initCore(config)` (or the back-compat
 * `initGitService` alias) at process startup.
 */

/** Back-compat alias for callers that still reference `GitConfig`. */
export type GitConfig = CoreConfig;

/** Back-compat alias for callers that still call `initGitService(config)`. */
export const initGitService = initCore;

const config = coreConfig;

/**
 * FIFO operation lock (Story 10.6 base, hardened in Story 10.12 AC#1).
 *
 * `lockTail` is the tail of the chain: every `serialize` call attaches its work
 * AFTER the previous op settles and *synchronously* advances the tail to its own
 * completion before returning. Because the advance is synchronous (no `await`
 * before the reassignment), two `serialize` calls in the same tick cannot both
 * read the same tail and "latch" onto an already-settled promise — the second
 * always chains behind the first. This is what guarantees a running op reliably
 * blocks the next (true FIFO, not best-effort).
 *
 * Why a settled-state tail is safe: we advance the tail with `run.catch(() => {})`
 * so a *rejected* op never poisons the queue — the next op still runs. But the
 * caller's own `run` keeps the original rejection, so failures still surface.
 */
const lockTails = new Map<string, Promise<unknown>>();

/**
 * Stellt git-Operationen hintereinander, gibt das Ergebnis von `fn` zurück.
 *
 * Multi-tenant (LBMT-1.2): the FIFO chain is keyed by `vaultDir`, so an op on
 * one customer's working copy never blocks an op on another's. For the single
 * vault this is exactly the old behaviour (a single key). The tail is advanced
 * synchronously (before any await yields) so the very next `serialize()` in
 * this tick queues behind us, never onto a stale tail.
 *
 * Story 1.13: `targetDir` makes that key explicit for callers that operate on a
 * directory OTHER than the singleton (`provisionVaultDir` provisioning a tenant
 * working copy). Omitting it resolves to `config().vaultDir` — synchronously,
 * exactly as before — so every pre-existing call site is unchanged.
 */
function serialize<T>(fn: () => Promise<T>, targetDir?: string): Promise<T> {
  const key = targetDir ?? config().vaultDir;
  const prev = lockTails.get(key) ?? Promise.resolve();
  // Both branches run `fn` regardless of whether the previous op fulfilled or
  // rejected — a failed predecessor must not cancel its successor (FIFO).
  const run = prev.then(fn, fn);
  lockTails.set(key, run.catch(() => {}));
  return run;
}

/**
 * Coalescing registry for rapid text saves to the SAME note (Story 10.12 AC#2).
 *
 * Keyed by vault-relative path. A `Pending` exists only while a save for that
 * path is *waiting in the lock queue but has not started executing*. While it
 * waits, a newer save() for the same path overwrites `content`/`message`
 * (last-write-wins) and registers its resolve/reject — so N keystroke saves
 * collapse into ONE git push, and every caller resolves with that one result.
 *
 * Invariant that makes this loss-free: once the op begins executing it removes
 * itself from the registry, so an in-flight commit can never have its bytes
 * swapped out from under it, and any save arriving after that point starts a
 * fresh op carrying the newest content.
 */
interface Pending {
  content: string;
  message: string;
  waiters: Array<{
    resolve: (result: SaveResult) => void;
    reject: (err: unknown) => void;
  }>;
}
const pendingSaves = new Map<string, Pending>();

/**
 * Outcome of a write. Forgejo stays the truth — but its *availability* must
 * never make a locally-committed note look lost.
 *
 * `synced` answers "did this write reach the remote"; `pending` answers the
 * only question the UI actually needs: "is a safe local commit stuck waiting
 * for an unreachable remote". They are NOT inverses:
 *
 *   | situation                        | synced | pending |
 *   | no remote configured (local-only)| false  | false   |
 *   | pushed / already upstream        | true   | false   |
 *   | remote unreachable after commit  | false  | true    |
 *
 * A local-only vault has nothing to sync, so it is `pending: false` and must
 * never raise the "Sync ausstehend" hint.
 */
export interface SaveResult {
  /** HEAD after the write — the new commit, or the unchanged HEAD on a no-op. */
  sha: string;
  /** True when the commit is confirmed on the remote. */
  synced: boolean;
  /**
   * True when a remote EXISTS but was unreachable: the commit is safe locally
   * and the next `sync()` (or the next successful save) carries it upstream.
   */
  pending: boolean;
}

/**
 * Working copies that hold at least one commit the remote has not confirmed
 * (Story: offline-toleranter Save). Keyed by working-copy dir so a tenant vault
 * cannot mask the primary vault's state.
 *
 * Set when a transient backend failure hits AFTER a successful commit; cleared
 * by any push that lands (`writeAndSync`, `saveBinary`, `move`, `sync`). It is
 * a UI hint, not a queue — the pending commits live in git, which is what
 * actually makes them safe. Deliberately in-memory: a restart re-derives the
 * truth from the first successful sync.
 */
const unsyncedDirs = new Set<string>();

function markSyncPending(targetDir: string): void {
  unsyncedDirs.add(targetDir);
}

function markSynced(targetDir: string): void {
  unsyncedDirs.delete(targetDir);
}

/**
 * True when a commit is waiting for an unreachable remote in `targetDir`
 * (defaults to the singleton vault). Consumed by the save routes so a pending
 * push surfaces as HTTP 200 + `synced:false` rather than a 503 "not saved".
 */
export function isSyncPending(targetDir?: string): boolean {
  return unsyncedDirs.has(targetDir ?? config().vaultDir);
}

/**
 * Coalescing key — vault-scoped (LBMT-1.2) so the same `relPath` in two
 * different customer vaults never collides into one push. NUL separates the
 * two components (it is illegal in a path, so it can't appear in either side).
 */
function saveKey(relPath: string): string {
  return `${config().vaultDir}\u0000${relPath}`;
}

/**
 * Roher git-Aufruf in EINEM beliebigen Working-Copy-Verzeichnis (Story 1.14).
 *
 * The generalized form of `git()` below: identical env-building, just with an
 * explicit `cwd`. It exists so the write path can target a tenant working copy
 * (`<vaultsRoot>/<vaultId>`) instead of only the `config().vaultDir` singleton
 * — and so the parameterized path inherits the C-locale pinning for free
 * rather than re-deriving it (see the comment on `LC_ALL` below).
 */
async function gitIn(targetDir: string, args: string[]): Promise<string> {
  const c = config();
  const { stdout } = await exec("git", args, {
    cwd: targetDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: c.gitAuthorName,
      GIT_AUTHOR_EMAIL: c.gitAuthorEmail,
      GIT_COMMITTER_NAME: c.gitAuthorName,
      GIT_COMMITTER_EMAIL: c.gitAuthorEmail,
      // Force C locale so stderr is stable English — the error classifier
      // (Story 10.6) pattern-matches git messages and must not depend on the
      // host's LANG (a German "KONFLIKT" would otherwise dodge the parser).
      LC_ALL: "C",
      LANG: "C",
    },
  });
  return stdout.trim();
}

/** Roher git-Aufruf im Vault-Verzeichnis. */
function git(args: string[]): Promise<string> {
  return gitIn(config().vaultDir, args);
}

/**
 * Klont das Remote beim ersten Start, falls der Vault-Ordner leer/nicht
 * vorhanden ist. Idempotent — danach ein No-op.
 *
 * Skips silently when `coreConfig().gitRemote` is the empty string — that
 * indicates the user hasn't run the setup wizard yet (or has detached the
 * vault). The wizard wires up the remote via `setupVaultFromForgejo` and
 * persists it on the `vaults` row; subsequent restarts will call this with
 * a non-empty remote and clone normally.
 */
export async function ensureRepo(): Promise<void> {
  return serialize(async () => {
    const c = config();
    if (!c.gitRemote) {
      console.log(
        "[gitService] ensureRepo: GIT_REMOTE not set — skipping clone " +
          "(setup wizard not run yet or vault detached).",
      );
      return;
    }
    const hasGit = existsSync(join(c.vaultDir, ".git"));
    if (hasGit) return;

    await mkdir(c.vaultDir, { recursive: true });
    const entries = existsSync(c.vaultDir) ? await readdir(c.vaultDir) : [];
    if (entries.length > 0) {
      throw new Error(
        `VAULT_DIR (${c.vaultDir}) ist nicht leer und kein git-Repo.`,
      );
    }
    // in den (leeren) Zielordner klonen
    await exec("git", [
      "clone",
      "--branch",
      c.gitBranch,
      c.gitRemote,
      c.vaultDir,
    ]);
  });
}

/**
 * Bootstrap the vault working-copy from a Forgejo OAuth flow result.
 *
 * Called by the setup-wizard after the user has authorized lokyy-brain
 * against their Forgejo instance and picked (or created) a repo. We embed
 * the OAuth access token into the remote URL using the `oauth2:` username
 * convention — Forgejo treats this exactly like a personal access token
 * for HTTPS auth, but lets us swap the token without rewriting the URL.
 *
 * Behavior:
 *   1. Build URL: https://oauth2:<token>@<host>/<owner>/<repo>.git
 *   2. Wipe `vaultDir` (fresh setup — safe; the wizard runs before any
 *      writes), recreate empty.
 *   3. `git clone --branch <branch> <url> <vaultDir>`.
 *   4. If clone fails because the branch doesn't exist (brand-new empty
 *      repo, no commits yet): `git init` locally, add the remote, create
 *      the branch, drop a `.gitkeep`, commit, push `-u`.
 *
 * Returns the configured remote URL + branch so the caller can persist
 * them on the `vaults` row.
 *
 * Note on URL secrets: the access token lives in plain-text inside
 * `.git/config` (origin URL). This is the same trade-off the manual
 * "paste your PAT" path already had; encrypting Git's own config is out
 * of scope. Rotation = call this function again with a fresh token.
 */
export async function setupVaultFromForgejo(opts: {
  vaultId: string;
  forgejoBaseUrl: string;
  accessToken: string;
  repoFullName: string;
  branch: string;
}): Promise<{ gitRemote: string; gitBranch: string }> {
  const { forgejoBaseUrl, accessToken, repoFullName, branch } = opts;
  const hostNoScheme = stripScheme(forgejoBaseUrl);
  const remoteUrl = `https://oauth2:${accessToken}@${hostNoScheme}/${repoFullName}.git`;

  return provisionVaultDir({
    targetDir: config().vaultDir,
    remote: { url: remoteUrl, branch },
  });
}

/** An already-credentialed remote to provision against. */
export interface ProvisionRemote {
  /** Full clone URL INCLUDING any auth (`https://oauth2:<token>@host/org/repo.git`). */
  url: string;
  /** Branch to check out / bootstrap. */
  branch: string;
}

export interface ProvisionVaultOpts {
  /** Directory to provision. May be any path — not necessarily `config().vaultDir`. */
  targetDir: string;
  /** Omit for a purely local repo (no `remote add`, no push). */
  remote?: ProvisionRemote;
}

/**
 * Provision a git working copy in ANY directory (Story 1.13).
 *
 * This is the single git-mechanics primitive behind every vault provisioning:
 * the setup wizard's primary vault (`setupVaultFromForgejo` / `initLocalVault`,
 * both now thin wrappers around this) AND the multi-tenant `POST /api/tenants`
 * route, which provisions `<vaultsRoot>/<vaultId>`. It exists because the two
 * used to be duplicated — the wizard path hardwired to the `config().vaultDir`
 * singleton, the tenant path hand-rolled as raw `exec("git", …)` in the route.
 *
 * Sequence:
 *   1. Clear `targetDir`'s CONTENTS in place (see the mount-point note below).
 *   2. `git init` (+ `remote add origin <url>` when a remote is given).
 *   3. With a remote: fetch + `checkout -B <branch> FETCH_HEAD` + set upstream.
 *   4. Empty remote (ref doesn't exist yet) or no remote at all: bootstrap —
 *      `checkout -b <branch>`, `.gitkeep`, initial commit, and `push -u` when
 *      a remote exists.
 *
 * Mount-point constraint (do not "simplify" this): we delete the directory's
 * entries but NEVER rmdir `targetDir` itself, because in the Docker deployment
 * it is a volume mount point and removing the mount fails with `EBUSY`. That is
 * also why we clone IN PLACE via init+fetch+checkout — plain
 * `git clone <url> <dir>` refuses a pre-existing directory.
 *
 * Branch without a remote falls back to `config().gitBranch`. Git identity is
 * process-wide (`config().gitAuthorName`/`…Email`) and deliberately NOT
 * parameterized — only the directory and the remote are per-vault.
 *
 * Runs inside the shared `serialize()` FIFO lock keyed by `targetDir`, so a
 * provisioning never interleaves with a save/pull on the SAME directory, while
 * two different directories provision concurrently without blocking each other.
 *
 * Errors follow the provisioning convention of this file: plain `Error`, not
 * the `classifyGitError` typed errors used by the ongoing-write functions.
 */
export async function provisionVaultDir(
  opts: ProvisionVaultOpts,
): Promise<{ gitRemote: string; gitBranch: string }> {
  const { targetDir, remote } = opts;

  return serialize(async () => {
    const c = config();
    const branch = remote?.branch ?? c.gitBranch;

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: c.gitAuthorName,
      GIT_AUTHOR_EMAIL: c.gitAuthorEmail,
      GIT_COMMITTER_NAME: c.gitAuthorName,
      GIT_COMMITTER_EMAIL: c.gitAuthorEmail,
      // Force C locale so stderr is stable English — the empty-repo probe below
      // pattern-matches git's "couldn't find remote ref" message and must not
      // depend on the host's LANG (a German "Konnte Remote-Referenz … nicht
      // finden" would otherwise dodge the parser and turn a brand-new empty
      // Forgejo repo into a hard failure). Same reason as in `git()` above.
      LC_ALL: "C",
      LANG: "C",
    };

    // Fresh-setup: clear the directory CONTENTS in place (incl. a stale .git),
    // keeping the directory itself — see the mount-point note above.
    await mkdir(targetDir, { recursive: true });
    for (const entry of await readdir(targetDir)) {
      await rm(join(targetDir, entry), { recursive: true, force: true });
    }
    await exec("git", ["-C", targetDir, "init"], { env });

    if (remote) {
      await exec("git", ["-C", targetDir, "remote", "add", "origin", remote.url], {
        env,
      });

      // Attempt 1: fetch + check out the existing branch.
      try {
        await exec("git", ["-C", targetDir, "fetch", "origin", branch], { env });
        await exec("git", ["-C", targetDir, "checkout", "-B", branch, "FETCH_HEAD"], {
          env,
        });
        await exec(
          "git",
          ["-C", targetDir, "branch", `--set-upstream-to=origin/${branch}`, branch],
          { env },
        ).catch(() => {});
        return { gitRemote: remote.url, gitBranch: branch };
      } catch (err) {
        // Empty repo (branch/ref doesn't exist yet) → bootstrap below. Any other
        // failure (network, auth) re-throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !/couldn't find remote ref|remote branch .* not found|not found in upstream|empty repository|no such ref|did not match any/i.test(
            msg,
          )
        ) {
          throw new Error(`git clone failed: ${msg}`);
        }
      }
    }

    // Attempt 2 (and the only attempt without a remote): empty-repo bootstrap.
    // Unborn HEAD → `checkout -b` just points the symref at `branch`, so the
    // first commit lands there regardless of the host's `init.defaultBranch`.
    await exec("git", ["-C", targetDir, "checkout", "-b", branch], { env });

    // A repo with zero commits has no HEAD, which several read paths
    // (`rev-parse HEAD`, `git log`) treat as an error — anchor it with a
    // placeholder commit.
    await writeFile(join(targetDir, ".gitkeep"), "", "utf8");

    await exec("git", ["-C", targetDir, "add", "--", ".gitkeep"], { env });
    await exec(
      "git",
      [
        "-C",
        targetDir,
        "commit",
        "-m",
        remote
          ? "chore: initialize lokyy vault"
          : "chore: initialize lokyy vault (local-only)",
      ],
      { env },
    );
    if (remote) {
      await exec("git", ["-C", targetDir, "push", "-u", "origin", branch], { env });
    }

    return { gitRemote: remote?.url ?? "", gitBranch: branch };
  }, targetDir);
}

/**
 * Bootstrap a purely LOCAL vault working-copy — no remote, no push.
 *
 * The counterpart to `setupVaultFromForgejo` for users who complete the setup
 * wizard WITHOUT connecting a Forgejo instance. It performs exactly the
 * empty-repo bootstrap half of that function (clear → init → branch → .gitkeep
 * → commit) and deliberately stops there: no `git remote add`, no `push`.
 *
 * "No remote" is not a degraded state — it is a documented, first-class one:
 * `hasRemote()` probes the actual `.git/config`, and every write path
 * (`runSave`, `saveBinary`) already returns right after `git commit` when no
 * `origin` exists ("local commit only"), while `pull`/`sync`/`ensureRepo`
 * no-op. The only thing that was missing was a way to CREATE that repo; this
 * is it. A remote can be attached later (Settings / `POST /api/admin/...`)
 * without touching the commits made in the meantime.
 *
 * Directory handling mirrors `setupVaultFromForgejo`: we clear the CONTENTS of
 * `vaultDir` in place and never rmdir the directory itself, because it is a
 * Docker volume mount point (removing the mount fails with `EBUSY`).
 *
 * Runs inside the shared `serialize()` FIFO lock like every other git op, so
 * provisioning can never interleave with an in-flight save/pull.
 */
export async function initLocalVault(): Promise<void> {
  await provisionVaultDir({ targetDir: config().vaultDir });
}

/** `https://forgejo.example.com` → `forgejo.example.com`. */
function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Returns true if the working copy has an `origin` remote configured.
 *
 * We probe the actual git state (`git remote get-url origin`) instead of
 * trusting `coreConfig().gitRemote`, because `setupVaultFromForgejo` writes
 * the remote straight into `.git/config` — it does not necessarily round-trip
 * through the in-memory config slice. `git remote get-url` exits non-zero
 * (throws) when no `origin` exists; an empty stdout is treated the same way.
 *
 * No remote = the documented pre-setup state (server up, setup wizard hasn't
 * wired a Forgejo repo yet). In that state pull/push have no target.
 *
 * Story 1.14: `targetDir` probes a directory OTHER than the singleton (a tenant
 * working copy). Omitting it resolves to `config().vaultDir` — synchronously,
 * exactly as before — so every pre-existing call site is unchanged.
 */
async function hasRemote(targetDir?: string): Promise<boolean> {
  try {
    const url = await gitIn(targetDir ?? config().vaultDir, [
      "remote",
      "get-url",
      "origin",
    ]);
    return url !== "";
  } catch {
    return false;
  }
}

/**
 * Idempotency probe for the pull-failure path (Story 10.6 AC#2).
 *
 * The race that produced bogus 409s: writer B committed the *same* content to
 * the remote a beat before us. Our `pull --rebase` then fails (our patch can't
 * replay cleanly / is a no-op skip), and the old code blindly reported
 * "Merge-Konflikt" + 409 — even though the bytes the user wanted are already
 * upstream. The fix is to ask the only question that actually disambiguates a
 * benign race from a real conflict: **does the remote tracking branch already
 * carry the content we intended to persist?**
 *
 * We compare our intended bytes against `origin/<branch>:relPath`:
 *   - text save → compare against `expected` (the content we were asked to write)
 *   - binary save / move → compare against our committed blob for `relPath`
 *     (HEAD:relPath), since we don't carry the raw bytes here.
 *
 * Equal ⇒ the user's content is safely upstream; this was a redundant race, not
 * a conflict. The caller treats it as success (push is then a no-op / deferred).
 * Different (or the path is absent upstream) ⇒ a genuine divergence → real
 * conflict, surfaced to the user.
 *
 * @param relPath vault-relative path that was being written.
 * @param expected the content we intended to persist; `null` falls back to
 *   comparing our committed blob (HEAD:relPath) — used for binary saves / moves.
 * @param branch the (validated) remote branch name.
 * @param targetDir working copy to probe; defaults to `config().vaultDir`.
 */
async function isAlreadyPersisted(
  relPath: string,
  expected: string | null,
  branch: string,
  targetDir?: string,
): Promise<boolean> {
  const dir = targetDir ?? config().vaultDir;
  // What the remote currently has at this path. Throws (→ false) when the
  // path doesn't exist upstream, which is itself a "not the same" signal.
  let remoteContent: string;
  try {
    remoteContent = await gitIn(dir, ["show", `origin/${branch}:${relPath}`]);
  } catch {
    return false;
  }

  // The bytes we intended to persist. For text saves that's `expected`; for
  // binary/move we use the blob we just committed locally (HEAD:relPath). Both
  // sides are compared `.trim()`-normalized: `git()` already trims `git show`
  // output, so we trim `expected` the same way to avoid a spurious
  // trailing-newline mismatch (git stores "x\n", git show returns "x").
  let intended: string;
  if (expected !== null) {
    intended = expected.trim();
  } else {
    try {
      intended = await gitIn(dir, ["show", `HEAD:${relPath}`]);
    } catch {
      return false;
    }
  }

  return remoteContent === intended;
}

/**
 * Best-effort push after an idempotent recovery. The local commit is already
 * safe; if the push still fails (e.g. transient network), we swallow it — a
 * later `save`/`pull` will carry the commit upstream. We never turn a
 * successfully-persisted write into a user-facing error here.
 */
async function tryDeferredPush(branch: string, targetDir?: string): Promise<void> {
  try {
    await gitIn(targetDir ?? config().vaultDir, ["push", "origin", branch]);
  } catch {
    /* deferred — the commit is local-safe; next sync pushes it. */
  }
}

/**
 * How a post-commit sync failure was absorbed.
 *
 * `synced`  — the remote confirmed the write, or the intended content is
 *   provably upstream already (benign race).
 * `pending` — the remote was unreachable (transient). The commit is safe
 *   locally and waits for the next sync; NOT an error.
 */
type SyncRecovery = "synced" | "pending";

/**
 * Shared pull-failure handler for save/saveBinary/move (Story 10.6 AC#2/#3,
 * extended for offline tolerance).
 *
 * 1. Abort the half-applied rebase to leave a clean tree (unchanged behavior).
 * 2. Idempotency: if the intended content is already persisted, treat as
 *    success — best-effort push, then `"synced"` (no error).
 * 3. Transient backend failure (Forgejo down, DNS blip, 502/503): the commit
 *    from step 0 is already safe, so report `"pending"` instead of throwing.
 *    Availability of the remote must not make a persisted note look lost.
 * 4. Otherwise classify the git stderr into a typed error and throw it. We
 *    bias an *unclassifiable* failure on the rebase step toward
 *    `MergeConflictError` (that step's most likely real cause), but a clearly
 *    non-transient backend stderr (misconfigured remote, auth) still surfaces
 *    as `GitBackendError` — that is a real problem, not a blip.
 *
 * @param targetDir working copy to recover; defaults to `config().vaultDir`.
 */
async function handlePullFailure(
  err: unknown,
  relPath: string,
  expected: string | null,
  branch: string,
  targetDir?: string,
): Promise<SyncRecovery> {
  const dir = targetDir ?? config().vaultDir;
  await gitIn(dir, ["rebase", "--abort"]).catch(() => {});

  if (await isAlreadyPersisted(relPath, expected, branch, dir)) {
    await tryDeferredPush(branch, dir);
    return "synced";
  }

  const classified = classifyGitError(err, relPath);
  if (classified instanceof GitBackendError && classified.transient) {
    return "pending";
  }
  // A bare rebase rejection with no recognizable backend/hook marker is, in
  // this code path, overwhelmingly a real content conflict — surface it as
  // such rather than an opaque backend error.
  if (
    classified instanceof GitBackendError &&
    !classified.transient &&
    classified.stderr.trim() === ""
  ) {
    throw new MergeConflictError({ relPath, stderr: classified.stderr, cause: err });
  }
  throw classified;
}

/**
 * Push counterpart of `handlePullFailure`: the pull succeeded but the push
 * itself hit the network. Same rule — the commit is already safe, so a
 * transient failure is `"pending"`, anything else throws typed.
 */
function handlePushFailure(err: unknown, relPath: string | undefined): SyncRecovery {
  const classified = classifyGitError(err, relPath);
  if (classified instanceof GitBackendError && classified.transient) {
    return "pending";
  }
  throw classified;
}

/**
 * `git pull --rebase --autostash`. Aufrufen bevor Notizen gelesen werden
 * (Notiz öffnen, Tab wieder aktiv).
 */
export async function pull(): Promise<void> {
  return serialize(async () => {
    if (!(await hasRemote())) return; // no remote = nothing to pull from
    await git(["pull", "--rebase", "--autostash", "origin", config().gitBranch]);
  });
}

/**
 * Result of a `sync()` reconcile. `changed` is true when the operation moved
 * the working copy forward (pull brought new commits) OR pushed previously
 * unpushed local commits to the remote — i.e. the local↔remote state was NOT
 * already in agreement. `false` means nothing happened (no-op): HEAD didn't
 * move and there was nothing to push.
 */
export interface SyncResult {
  changed: boolean;
}

/**
 * Reconcile the working copy with Forgejo WITHOUT writing any note content
 * (Story: separate Save & Sync buttons, AC#1).
 *
 *   git pull --rebase --autostash   →   git push (only when commits are unpushed)
 *
 * Runs inside the same `serialize()` FIFO lock as every write op (10.6 base /
 * 10.12 hardening), so a manual sync never races an in-flight save/move/pull.
 * Reuses the existing `git()` runner and `hasRemote()` probe — no new unguarded
 * git access is introduced.
 *
 * `changed` semantics (drives the PWA's disabled-state + badge):
 *   - HEAD advanced during the pull  → changed
 *   - we had local commits ahead of the remote and pushed them → changed
 *   - neither → no-op (changed = false)
 *
 * No-remote (setup wizard not run / vault detached) is a benign no-op: there is
 * nothing to reconcile against, so we return `{ changed: false }` rather than
 * throwing. A failed pull/push surfaces the same typed errors as `save` via
 * `classifyGitError` so the route can map them to consistent HTTP status codes.
 */
export async function sync(): Promise<SyncResult> {
  return serialize(async () => {
    if (!(await hasRemote())) return { changed: false }; // nothing to reconcile

    const c = config();
    const branch = c.gitBranch;

    // HEAD before the pull — comparing against HEAD after tells us whether the
    // pull brought in new upstream commits (HEAD moved) vs was a no-op.
    const headBefore = await git(["rev-parse", "HEAD"]).catch(() => "");

    try {
      await git(["pull", "--rebase", "--autostash", "origin", branch]);
    } catch (err) {
      // Leave a clean tree, then surface a typed error (merge-conflict vs
      // backend) exactly like the save path's classifier.
      await git(["rebase", "--abort"]).catch(() => {});
      throw classifyGitError(err, undefined);
    }

    const headAfter = await git(["rev-parse", "HEAD"]).catch(() => "");
    const pulledNew = headBefore !== "" && headAfter !== "" && headBefore !== headAfter;

    // Are there local commits the remote doesn't have yet? `rev-list` counts
    // commits on HEAD not reachable from the remote tracking ref. A non-empty
    // count means we have something to push. The remote ref is refreshed by the
    // pull above, so this reflects post-pull divergence.
    let pushed = false;
    const ahead = await git([
      "rev-list",
      "--count",
      `origin/${branch}..HEAD`,
    ]).catch(() => "0");
    if (ahead !== "" && ahead !== "0") {
      await git(["push", "origin", branch]);
      pushed = true;
    }

    // We got all the way through pull + (any needed) push: nothing is waiting
    // on the remote any more, so the PWA's "Sync ausstehend" hint can clear.
    markSynced(c.vaultDir);

    return { changed: pulledNew || pushed };
  });
}

export interface SaveVaultFileOpts {
  /** Working copy to write into. May be any path — not necessarily `config().vaultDir`. */
  targetDir: string;
  /** Path of the file relative to `targetDir`. */
  relPath: string;
  /** UTF-8 content to persist. */
  content: string;
  /** Commit message. */
  message: string;
  /** Branch to pull/push against. Defaults to `config().gitBranch`. */
  branch?: string;
}

/**
 * The write-and-sync mechanics, WITHOUT the `serialize()` lock — every caller
 * must already hold the lock for `targetDir` (`serialize()` is a FIFO chain,
 * not reentrant: taking it again from inside would deadlock).
 *
 *   write → add → status (no-op if unchanged) → commit → pull --rebase → push
 */
async function writeAndSync(opts: Required<Omit<SaveVaultFileOpts, "branch">> & {
  branch: string;
}): Promise<SaveResult> {
  const { targetDir, relPath, content, message, branch } = opts;

  /** Reads HEAD and stamps the outcome, keeping the pending registry in step. */
  const settle = async (outcome: SyncRecovery | "no-remote"): Promise<SaveResult> => {
    const sha = await gitIn(targetDir, ["rev-parse", "HEAD"]);
    if (outcome === "pending") {
      markSyncPending(targetDir);
      return { sha, synced: false, pending: true };
    }
    if (outcome === "no-remote") {
      // Nothing to push to — not synced, but nothing is stuck either.
      return { sha, synced: false, pending: false };
    }
    markSynced(targetDir);
    return { sha, synced: true, pending: false };
  };

  const abs = join(targetDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");

  await gitIn(targetDir, ["add", "--", relPath]);

  // nichts zu committen? (Inhalt identisch) -> still zurueck. Nothing was
  // written, so we report the vault's CURRENT sync state rather than claiming
  // a push that never happened.
  const status = await gitIn(targetDir, ["status", "--porcelain", "--", relPath]);
  if (status === "") {
    const sha = await gitIn(targetDir, ["rev-parse", "HEAD"]);
    const pending = isSyncPending(targetDir);
    return { sha, synced: !pending, pending };
  }

  await gitIn(targetDir, ["commit", "-m", message]);
  // From here on the user's bytes are SAFE in git. Every failure below is
  // about reaching Forgejo — it may degrade the result, never lose it.

  // Kein Remote (Setup-Wizard noch nicht gelaufen) -> nur lokaler Commit.
  if (!(await hasRemote(targetDir))) {
    return settle("no-remote");
  }

  try {
    await gitIn(targetDir, ["pull", "--rebase", "--autostash", "origin", branch]);
  } catch (err) {
    // Pull fehlgeschlagen: erst Idempotenz prüfen (Commit liegt evtl. schon
    // sauber auf Disk/HEAD -> kein Konflikt), dann auf transienten Backend-
    // Fehler prüfen (Forgejo down -> pending), sonst typisierten Fehler werfen.
    return settle(await handlePullFailure(err, relPath, content, branch, targetDir));
  }

  try {
    await gitIn(targetDir, ["push", "origin", branch]);
  } catch (err) {
    return settle(handlePushFailure(err, relPath));
  }
  return settle("synced");
}

/**
 * Write one text file into ANY vault working copy and sync it (Story 1.14).
 *
 * The write-path counterpart to Story 1.13's `provisionVaultDir`: the same
 * mechanics `save()` has always used for the primary vault, now pointed at an
 * explicit directory, so `PUT /api/tenants/:vaultId/scope` can commit its
 * `mcp-scopes.yaml` change through gitService instead of raw `exec("git", …)`
 * (architecture.md: any vault-filesystem write bypassing gitService is a hard
 * constraint violation). `save()` itself is now a thin wrapper over the same
 * core.
 *
 * Runs inside the shared `serialize()` FIFO lock keyed by `targetDir`, so a
 * tenant write never interleaves with a save/pull on the SAME directory, while
 * two different directories write concurrently without blocking each other.
 *
 * Deliberately NOT coalesced (AC#3): `pendingSaves` exists to collapse a
 * keystroke-driven autosave storm on one note path into a single push. Callers
 * of this function make infrequent, deliberate writes — there is no storm to
 * collapse, so it takes the plain locked path.
 *
 * Errors follow the write-path convention: typed `MergeConflictError` /
 * `GitBackendError` / `PreCommitHookError` via `classifyGitError`, which the
 * route maps to an HTTP status.
 *
 * @returns the resulting commit SHA (unchanged HEAD when nothing was modified)
 *   plus whether it reached the remote (`synced`/`pending`, see `SaveResult`).
 */
export async function saveVaultFile(opts: SaveVaultFileOpts): Promise<SaveResult> {
  const { targetDir } = opts;
  const branch = opts.branch ?? config().gitBranch;
  return serialize(() => writeAndSync({ ...opts, branch }), targetDir);
}

/**
 * The actual serialized write of one text note: the bytes captured here are the
 * bytes committed — no other path can swap them mid-flight (see `pendingSaves`).
 *   write → add → commit → pull --rebase → push
 */
function runSave(
  relPath: string,
  content: string,
  message: string,
): Promise<SaveResult> {
  return serialize(async () => {
    // Coalescing handoff: this op now owns the latest pending bytes for
    // `relPath`. Read them, then drop the registry entry so any save() arriving
    // from here on starts a brand-new op (it can't mutate our in-flight bytes).
    const key = saveKey(relPath);
    const pend = pendingSaves.get(key);
    const finalContent = pend ? pend.content : content;
    const finalMessage = pend ? pend.message : message;
    pendingSaves.delete(key);

    // We already hold the lock for the primary vault, so call the unlocked core
    // directly (see `writeAndSync` on why re-entering `serialize()` deadlocks).
    const c = config();
    return writeAndSync({
      targetDir: c.vaultDir,
      relPath,
      content: finalContent,
      message: finalMessage,
      branch: c.gitBranch,
    });
  });
}

/**
 * Schreibt eine Datei und bringt sie nach Forgejo:
 *   write → add → commit → pull --rebase → push
 *
 * `relPath` ist relativ zum Vault-Root. Gibt den neuen Commit-Hash zurück,
 * zusammen mit `synced`/`pending` (siehe `SaveResult`): ist Forgejo nicht
 * erreichbar, ist der Commit trotzdem sicher und der Push wird nachgeholt.
 * Wirft bei echten Merge-Konflikten (gleiche Zeilen geändert) — der Caller
 * kann das an die PWA melden.
 *
 * Story 10.12 AC#2 — coalescing front door: if a save for the SAME `relPath` is
 * already queued (waiting in the lock, not yet executing) and coalescing is on,
 * we overwrite its pending content (last-write-wins) and attach to it instead of
 * enqueuing a second push. All coalesced callers resolve with the one executed
 * commit SHA / reject with its error. This collapses a keystroke storm into a
 * single push without delaying or dropping the newest write.
 */
export async function save(
  relPath: string,
  content: string,
  message: string,
): Promise<SaveResult> {
  // Coalescing is opt-out and applies to text saves only.
  if (config().coalesceSameNoteSaves === false) {
    return runSave(relPath, content, message);
  }

  const key = saveKey(relPath);
  const existing = pendingSaves.get(key);
  if (existing) {
    // A queued-but-not-started save for this note already exists. Update the
    // bytes it will commit (last write wins) and ride along on its result.
    existing.content = content;
    existing.message = message;
    return new Promise<SaveResult>((resolve, reject) => {
      existing.waiters.push({ resolve, reject });
    });
  }

  // First save for this note in the current window: register it as the pending
  // entry, then enqueue ONE serialized op. `runSave` reads the latest pending
  // bytes when it starts and clears the entry, so saves arriving while it waits
  // coalesce, while saves arriving after it starts open a fresh window.
  const pend: Pending = { content, message, waiters: [] };
  pendingSaves.set(key, pend);

  const result = runSave(relPath, content, message);

  // Fan the single op's outcome out to every coalesced waiter. The leader gets
  // it via the returned promise below; followers via their stored callbacks.
  // `runSave` already deletes our registry entry when it STARTS executing, so a
  // save arriving after that point has installed a NEW `Pending` — we must not
  // clobber it. The `=== pend` guard makes this cleanup our-entry-only (matters
  // only on the rare path where the op settles without ever having started).
  result.then(
    (saved) => {
      if (pendingSaves.get(key) === pend) pendingSaves.delete(key);
      for (const w of pend.waiters) w.resolve(saved);
    },
    (err) => {
      if (pendingSaves.get(key) === pend) pendingSaves.delete(key);
      for (const w of pend.waiters) w.reject(err);
    },
  );

  return result;
}

/**
 * Wie `save`, aber für binäre Inhalte (Bilder, PDFs, …). Schreibt die
 * `Buffer`-/`Uint8Array`-Bytes direkt (kein utf8-encode) und benutzt
 * denselben git-Flow: write → add → commit → pull --rebase → push.
 *
 * Teilt das Promise-Lock mit allen anderen git-Operationen — kein Risiko
 * paralleler Schreibvorgänge auf das Working-Copy.
 *
 * Wichtig: assets bekommen keine Frontmatter (binär), der lokyy-vault
 * pre-commit Hook prüft Frontmatter nur für `.md`.
 */
export async function saveBinary(
  relPath: string,
  content: Uint8Array,
  message: string,
): Promise<SaveResult> {
  return serialize(async () => {
    const c = config();

    /** Mirrors `writeAndSync`'s settle — same offline-tolerance contract. */
    const settle = async (
      outcome: SyncRecovery | "no-remote",
    ): Promise<SaveResult> => {
      const sha = await git(["rev-parse", "HEAD"]);
      if (outcome === "pending") {
        markSyncPending(c.vaultDir);
        return { sha, synced: false, pending: true };
      }
      if (outcome === "no-remote") {
        return { sha, synced: false, pending: false };
      }
      markSynced(c.vaultDir);
      return { sha, synced: true, pending: false };
    };

    const abs = join(c.vaultDir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);

    await git(["add", "--", relPath]);

    const status = await git(["status", "--porcelain", "--", relPath]);
    if (status === "") {
      const sha = await git(["rev-parse", "HEAD"]);
      const pending = isSyncPending(c.vaultDir);
      return { sha, synced: !pending, pending };
    }

    await git(["commit", "-m", message]);

    // Kein Remote (Setup-Wizard noch nicht gelaufen) -> nur lokaler Commit.
    if (!(await hasRemote())) {
      return settle("no-remote");
    }

    try {
      await git([
        "pull",
        "--rebase",
        "--autostash",
        "origin",
        c.gitBranch,
      ]);
    } catch (err) {
      // Binär: kein Byte-Vergleich (expected=null) — sauberer Working-Tree
      // (HEAD==Disk) ist hier das einzige Idempotenz-Signal.
      return settle(await handlePullFailure(err, relPath, null, c.gitBranch));
    }

    try {
      await git(["push", "origin", c.gitBranch]);
    } catch (err) {
      return settle(handlePushFailure(err, relPath));
    }
    return settle("synced");
  });
}

/** Löscht eine Datei und pusht das ebenfalls nach Forgejo. */
export async function remove(relPath: string, message: string): Promise<void> {
  return serialize(async () => {
    const c = config();
    await git(["rm", "-r", "--", relPath]);
    await git(["commit", "-m", message]);
    await git(["pull", "--rebase", "--autostash", "origin", c.gitBranch]);
    await git(["push", "origin", c.gitBranch]);
  });
}

/**
 * Verschiebt/benennt um — `git mv` funktioniert für Dateien *und* Ordner,
 * Rename ist nur ein Move im selben Verzeichnis. Legt das Zielverzeichnis
 * an, falls nötig, und gleicht danach mit Forgejo ab.
 */
export async function move(
  fromRel: string,
  toRel: string,
  message: string,
): Promise<void> {
  return serialize(async () => {
    const c = config();
    await mkdir(dirname(join(c.vaultDir, toRel)), { recursive: true });
    await git(["mv", "--", fromRel, toRel]);
    await git(["commit", "-m", message]);
    try {
      await git([
        "pull",
        "--rebase",
        "--autostash",
        "origin",
        c.gitBranch,
      ]);
    } catch (err) {
      // Move: the destination path is the idempotency anchor — if the rename
      // already landed (toRel clean in HEAD), this is a benign race, not a
      // conflict. expected=null (we don't compare bytes for a move).
      // Unreachable remote → the rename is committed locally and waits.
      if ((await handlePullFailure(err, toRel, null, c.gitBranch)) === "pending") {
        markSyncPending(c.vaultDir);
      }
      return;
    }
    try {
      await git(["push", "origin", c.gitBranch]);
    } catch (err) {
      if (handlePushFailure(err, toRel) === "pending") markSyncPending(c.vaultDir);
      return;
    }
    markSynced(c.vaultDir);
  });
}

/** ISO-Timestamp des letzten Commits, der `relPath` berührt hat. */
export async function lastModified(relPath: string): Promise<string> {
  try {
    const ts = await git(["log", "-1", "--format=%cI", "--", relPath]);
    return ts || new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ─── Story 10.17: READ-ONLY history / diff helpers ─────────────────────────
//
// Both functions are purely additive and READ-ONLY: no add/commit/push, no
// working-tree mutation. They go through the same `serialize()` FIFO lock as
// every write op (10.6 base / 10.12 hardening) so a history/diff read never
// runs concurrently with an in-flight `save`/`move`/`pull` against the working
// copy. They do NOT touch the write path, lock semantics, coalescing, or the
// typed-error machinery — they only consume the existing `git()` runner and
// (for the bad-sha case) `classifyGitError` for message consistency.

/** One commit that touched a note, newest first. */
export interface NoteHistoryEntry {
  /** Full 40-char commit SHA. */
  sha: string;
  /** Committer date, ISO-8601 (`%cI`). */
  date: string;
  /** Commit subject line (`%s`). */
  message: string;
}

/** Default number of history entries returned by `noteHistory`. */
const DEFAULT_HISTORY_LIMIT = 50;

/**
 * READ-ONLY version history of a single note (`git log` scoped to the file).
 *
 * Returns up to `limit` commits, newest first. An empty array means the path
 * has no recorded history (untracked / never committed) — not an error.
 *
 * `limit` is clamped: a non-finite, non-positive, or non-integer value falls
 * back to `DEFAULT_HISTORY_LIMIT`; otherwise it is floored to an integer.
 *
 * Records are emitted with a custom format using ASCII unit/record separators
 * (`\x1f` between fields, `\x1e` between records) so commit subjects containing
 * spaces, tabs, or newlines parse unambiguously.
 */
export async function noteHistory(
  relPath: string,
  limit = DEFAULT_HISTORY_LIMIT,
): Promise<NoteHistoryEntry[]> {
  const max =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_HISTORY_LIMIT;

  const out = await serialize(() =>
    git(["log", `-${max}`, "--format=%H%x1f%cI%x1f%s%x1e", "--", relPath]),
  );

  if (out === "") return [];

  return out
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter((rec) => rec !== "")
    .map((rec) => {
      const [sha, date, message] = rec.split("\x1f");
      return { sha, date, message };
    });
}

/** A diff for a note: a committed change (`sha` set) or the working-tree diff (`sha` null). */
export interface NoteDiff {
  /** The inspected commit SHA, or `null` for the uncommitted working-tree diff. */
  sha: string | null;
  /** Unified diff text (may be empty when there is nothing to show). */
  diff: string;
}

/**
 * READ-ONLY diff for a single note.
 *
 * With `sha`: shows that commit's patch scoped to the file (`git show <sha> --
 * <path>`). A bad/unknown sha is surfaced as a descriptive error, classified
 * through the existing `classifyGitError` (Story 10.6) for message consistency.
 *
 * Without `sha`: shows the uncommitted working-tree diff for the file
 * (`git diff -- <path>`), with `sha: null`.
 *
 * Never mutates the working tree.
 */
export async function noteDiff(relPath: string, sha?: string): Promise<NoteDiff> {
  return serialize(async () => {
    if (sha) {
      try {
        const diff = await git(["show", sha, "--", relPath]);
        return { sha, diff };
      } catch (err) {
        // Read-only: do not recover, just surface a descriptive typed error.
        throw classifyGitError(err, relPath);
      }
    }
    const diff = await git(["diff", "--", relPath]);
    return { sha: null, diff };
  });
}

// ─── Story 11.11: READ-ONLY vault-wide activity (Streak / Heatmap) ─────────
//
// K-3: `noteHistory` is per-NOTE (`git log -- <path>`); the dashboard needs a
// VAULT-WIDE commit timeline to draw a GitHub-style activity heatmap and derive
// the current/longest commit streaks. This helper runs EXACTLY ONE `git log`
// over HEAD (no path filter) inside the same `serialize()` FIFO lock as every
// write op, aggregates committer dates into per-day buckets in memory, and
// computes both streaks. It is purely additive + READ-ONLY: no add/commit/push,
// no working-tree mutation. A 60s in-process memo cache keeps a frequently
// re-opened dashboard cheap. (R-4: only Story 11.11 touches gitService.)

/** One calendar day with its commit count, oldest→newest. */
export interface VaultActivityDay {
  /** Local-less ISO date `YYYY-MM-DD` (committer date, UTC day-bucket). */
  date: string;
  /** Number of commits whose committer date falls on this day. */
  commits: number;
}

/** Vault-wide activity over a window + the derived streaks. */
export interface VaultActivity {
  /** Every day in `[today-sinceDays+1 … today]`, gap-filled with 0-commit days. */
  days: VaultActivityDay[];
  /** Consecutive days ending today (or yesterday) with ≥1 commit. */
  currentStreak: number;
  /** Longest run of consecutive ≥1-commit days within the window. */
  longestStreak: number;
}

/** Default activity window (one year — drives the heatmap). */
const DEFAULT_ACTIVITY_DAYS = 365;
/** Memo-cache TTL for `vaultActivity` (Story 11.11 — frequent dashboard opens). */
const ACTIVITY_CACHE_TTL_MS = 60_000;

interface ActivityCacheEntry {
  expires: number;
  value: VaultActivity;
}
/** Memo keyed by `vaultDir::windowDays` — vault-path keying avoids a stale
 * cross-vault read after a hot-swap (and keeps tests isolated). */
const activityCache = new Map<string, ActivityCacheEntry>();

/** `YYYY-MM-DD` of an ISO timestamp's UTC day. */
function utcDayKey(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Add `n` whole days to a `YYYY-MM-DD` key, returning a new key. */
function addDays(dayKey: string, n: number): string {
  const ms = Date.parse(`${dayKey}T00:00:00.000Z`) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * READ-ONLY vault-wide commit activity (Story 11.11 / K-3).
 *
 * Aggregates the committer dates of every commit reachable from HEAD into
 * per-day buckets over the last `sinceDays` days, gap-fills missing days with
 * `0`, and derives the current + longest streaks. `currentStreak` counts back
 * from today; a vault committed-to yesterday but not yet today still keeps its
 * streak (today's 0 does not break it until tomorrow).
 *
 * One `git log --format=%cI` call, no path filter, inside the serialize lock.
 * An empty / history-less repo yields all-zero days and zero streaks (never an
 * error). Results are memoized for 60s keyed by the window size.
 */
export async function vaultActivity(
  sinceDays = DEFAULT_ACTIVITY_DAYS,
): Promise<VaultActivity> {
  const windowDays =
    Number.isFinite(sinceDays) && sinceDays > 0
      ? Math.floor(sinceDays)
      : DEFAULT_ACTIVITY_DAYS;

  const now = Date.now();
  const cacheKey = `${config().vaultDir}::${windowDays}`;
  const cached = activityCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cached.value;
  }

  // Single vault-wide log over HEAD. `--since` prunes server-side so the buffer
  // stays small even on a 10k-commit repo. An empty repo (no HEAD) throws →
  // treat as no activity.
  let out = "";
  try {
    out = await serialize(() =>
      git(["log", "--format=%cI", `--since=${windowDays} days ago`]),
    );
  } catch {
    out = "";
  }

  // Bucket committer dates by UTC day.
  const counts = new Map<string, number>();
  if (out !== "") {
    for (const line of out.split("\n")) {
      const key = utcDayKey(line.trim());
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // Gap-fill the full window oldest→newest so the heatmap has a cell per day.
  const today = new Date(now).toISOString().slice(0, 10);
  const start = addDays(today, -(windowDays - 1));
  const days: VaultActivityDay[] = [];
  for (let i = 0; i < windowDays; i++) {
    const date = addDays(start, i);
    days.push({ date, commits: counts.get(date) ?? 0 });
  }

  // Longest streak: longest run of consecutive ≥1 days anywhere in the window.
  let longestStreak = 0;
  let run = 0;
  for (const d of days) {
    if (d.commits > 0) {
      run += 1;
      if (run > longestStreak) longestStreak = run;
    } else {
      run = 0;
    }
  }

  // Current streak: count back from today. A 0-commit TODAY does not break the
  // streak (the day isn't over) — we start counting at the most recent active
  // day if that day is today or yesterday.
  let currentStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i] as VaultActivityDay;
    if (d.commits > 0) {
      currentStreak += 1;
    } else if (d.date === today) {
      // Today not yet committed — skip without breaking the back-count.
      continue;
    } else {
      break;
    }
  }

  const value: VaultActivity = { days, currentStreak, longestStreak };
  activityCache.set(cacheKey, { expires: now + ACTIVITY_CACHE_TTL_MS, value });
  return value;
}
