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
let lockTail: Promise<unknown> = Promise.resolve();

/** Stellt git-Operationen hintereinander, gibt das Ergebnis von `fn` zurück. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  // Both branches run `fn` regardless of whether the previous op fulfilled or
  // rejected — a failed predecessor must not cancel its successor (FIFO).
  const run = lockTail.then(fn, fn);
  // Advance the tail synchronously (before any await yields) so the very next
  // serialize() in this tick queues behind us, never onto a stale tail.
  lockTail = run.catch(() => {});
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
  waiters: Array<{ resolve: (sha: string) => void; reject: (err: unknown) => void }>;
}
const pendingSaves = new Map<string, Pending>();

/** Roher git-Aufruf im Vault-Verzeichnis. */
async function git(args: string[]): Promise<string> {
  const c = config();
  const { stdout } = await exec("git", args, {
    cwd: c.vaultDir,
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

  return serialize(async () => {
    const c = config();

    // Fresh-setup: wipe + recreate the vault directory. The wizard runs
    // before any writes; there is nothing valuable to preserve.
    await rm(c.vaultDir, { recursive: true, force: true });
    await mkdir(c.vaultDir, { recursive: true });

    // Attempt 1: clone the existing branch.
    try {
      await exec("git", ["clone", "--branch", branch, remoteUrl, c.vaultDir]);
      return { gitRemote: remoteUrl, gitBranch: branch };
    } catch (err) {
      // Forgejo returns "Remote branch <x> not found in upstream origin" for
      // an empty repo. Fall through to the init-and-push path. Any other
      // failure (network, auth) re-throws.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/remote branch .* not found|empty repository/i.test(msg)) {
        throw new Error(`git clone failed: ${msg}`);
      }
    }

    // Attempt 2: empty-repo bootstrap.
    await exec("git", ["init", c.vaultDir]);
    await exec("git", ["-C", c.vaultDir, "remote", "add", "origin", remoteUrl]);
    await exec("git", ["-C", c.vaultDir, "checkout", "-b", branch]);

    await writeFile(join(c.vaultDir, ".gitkeep"), "", "utf8");

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: c.gitAuthorName,
      GIT_AUTHOR_EMAIL: c.gitAuthorEmail,
      GIT_COMMITTER_NAME: c.gitAuthorName,
      GIT_COMMITTER_EMAIL: c.gitAuthorEmail,
    };
    await exec("git", ["-C", c.vaultDir, "add", "--", ".gitkeep"], { env });
    await exec(
      "git",
      ["-C", c.vaultDir, "commit", "-m", "chore: initialize lokyy vault"],
      { env },
    );
    await exec("git", ["-C", c.vaultDir, "push", "-u", "origin", branch], {
      env,
    });

    return { gitRemote: remoteUrl, gitBranch: branch };
  });
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
 */
async function hasRemote(): Promise<boolean> {
  try {
    const url = await git(["remote", "get-url", "origin"]);
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
 */
async function isAlreadyPersisted(
  relPath: string,
  expected: string | null,
  branch: string,
): Promise<boolean> {
  // What the remote currently has at this path. Throws (→ false) when the
  // path doesn't exist upstream, which is itself a "not the same" signal.
  let remoteContent: string;
  try {
    remoteContent = await git(["show", `origin/${branch}:${relPath}`]);
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
      intended = await git(["show", `HEAD:${relPath}`]);
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
async function tryDeferredPush(branch: string): Promise<void> {
  try {
    await git(["push", "origin", branch]);
  } catch {
    /* deferred — the commit is local-safe; next sync pushes it. */
  }
}

/**
 * Shared pull-failure handler for save/saveBinary/move (Story 10.6 AC#2/#3).
 *
 * 1. Abort the half-applied rebase to leave a clean tree (unchanged behavior).
 * 2. Idempotency: if the intended content is already persisted, treat as
 *    success — best-effort push, then return (no error).
 * 3. Otherwise classify the git stderr into a typed error and throw it. We
 *    bias an *unclassifiable* failure on the rebase step toward
 *    `MergeConflictError` (that step's most likely real cause), but a clearly
 *    transient/backend stderr still surfaces as `GitBackendError`.
 *
 * @returns `true` when the write was idempotently recovered (caller returns
 *   success); never returns `false` — it throws instead.
 */
async function handlePullFailure(
  err: unknown,
  relPath: string,
  expected: string | null,
  branch: string,
): Promise<true> {
  await git(["rebase", "--abort"]).catch(() => {});

  if (await isAlreadyPersisted(relPath, expected, branch)) {
    await tryDeferredPush(branch);
    return true;
  }

  const classified = classifyGitError(err, relPath);
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
 * The actual serialized write of one text note: the bytes captured here are the
 * bytes committed — no other path can swap them mid-flight (see `pendingSaves`).
 *   write → add → commit → pull --rebase → push
 */
function runSave(relPath: string, content: string, message: string): Promise<string> {
  return serialize(async () => {
    // Coalescing handoff: this op now owns the latest pending bytes for
    // `relPath`. Read them, then drop the registry entry so any save() arriving
    // from here on starts a brand-new op (it can't mutate our in-flight bytes).
    const pend = pendingSaves.get(relPath);
    const finalContent = pend ? pend.content : content;
    const finalMessage = pend ? pend.message : message;
    pendingSaves.delete(relPath);

    const c = config();
    const abs = join(c.vaultDir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, finalContent, "utf8");

    await git(["add", "--", relPath]);

    // nichts zu committen? (Inhalt identisch) -> still zurueck
    const status = await git(["status", "--porcelain", "--", relPath]);
    if (status === "") {
      return git(["rev-parse", "HEAD"]);
    }

    await git(["commit", "-m", finalMessage]);

    // Kein Remote (Setup-Wizard noch nicht gelaufen) -> nur lokaler Commit.
    if (!(await hasRemote())) {
      return git(["rev-parse", "HEAD"]);
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
      // Pull fehlgeschlagen: erst Idempotenz prüfen (Commit liegt evtl. schon
      // sauber auf Disk/HEAD -> kein Konflikt), sonst typisierten Fehler werfen.
      await handlePullFailure(err, relPath, finalContent, c.gitBranch);
      return git(["rev-parse", "HEAD"]); // idempotent recovered
    }

    await git(["push", "origin", c.gitBranch]);
    return git(["rev-parse", "HEAD"]);
  });
}

/**
 * Schreibt eine Datei und bringt sie nach Forgejo:
 *   write → add → commit → pull --rebase → push
 *
 * `relPath` ist relativ zum Vault-Root. Gibt den neuen Commit-Hash zurück.
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
): Promise<string> {
  // Coalescing is opt-out and applies to text saves only.
  if (config().coalesceSameNoteSaves === false) {
    return runSave(relPath, content, message);
  }

  const existing = pendingSaves.get(relPath);
  if (existing) {
    // A queued-but-not-started save for this note already exists. Update the
    // bytes it will commit (last write wins) and ride along on its result.
    existing.content = content;
    existing.message = message;
    return new Promise<string>((resolve, reject) => {
      existing.waiters.push({ resolve, reject });
    });
  }

  // First save for this note in the current window: register it as the pending
  // entry, then enqueue ONE serialized op. `runSave` reads the latest pending
  // bytes when it starts and clears the entry, so saves arriving while it waits
  // coalesce, while saves arriving after it starts open a fresh window.
  const pend: Pending = { content, message, waiters: [] };
  pendingSaves.set(relPath, pend);

  const result = runSave(relPath, content, message);

  // Fan the single op's outcome out to every coalesced waiter. The leader gets
  // it via the returned promise below; followers via their stored callbacks.
  // `runSave` already deletes our registry entry when it STARTS executing, so a
  // save arriving after that point has installed a NEW `Pending` — we must not
  // clobber it. The `=== pend` guard makes this cleanup our-entry-only (matters
  // only on the rare path where the op settles without ever having started).
  result.then(
    (sha) => {
      if (pendingSaves.get(relPath) === pend) pendingSaves.delete(relPath);
      for (const w of pend.waiters) w.resolve(sha);
    },
    (err) => {
      if (pendingSaves.get(relPath) === pend) pendingSaves.delete(relPath);
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
): Promise<string> {
  return serialize(async () => {
    const c = config();
    const abs = join(c.vaultDir, relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);

    await git(["add", "--", relPath]);

    const status = await git(["status", "--porcelain", "--", relPath]);
    if (status === "") {
      return git(["rev-parse", "HEAD"]);
    }

    await git(["commit", "-m", message]);

    // Kein Remote (Setup-Wizard noch nicht gelaufen) -> nur lokaler Commit.
    if (!(await hasRemote())) {
      return git(["rev-parse", "HEAD"]);
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
      await handlePullFailure(err, relPath, null, c.gitBranch);
      return git(["rev-parse", "HEAD"]); // idempotent recovered
    }

    await git(["push", "origin", c.gitBranch]);
    return git(["rev-parse", "HEAD"]);
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
      await handlePullFailure(err, toRel, null, c.gitBranch);
      return; // idempotent recovered
    }
    await git(["push", "origin", c.gitBranch]);
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
