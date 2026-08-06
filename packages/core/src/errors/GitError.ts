/**
 * Typed git-sync errors (Story 10.6).
 *
 * Before this, `gitService` collapsed *every* `git pull --rebase` rejection
 * into a hardcoded "Merge-Konflikt" — pre-commit-hook rejections, network /
 * auth failures and real rebase conflicts all surfaced as a bogus 409. These
 * three classes let the git layer report what actually went wrong, and let the
 * route map each cause to the right HTTP status.
 *
 * The existing `FrontmatterValidationError` stays the canonical type for
 * frontmatter problems detected BEFORE git (pre-validated in `notesService`);
 * `PreCommitHookError` is the post-commit sibling for the *same* class of
 * failure when it is the vault pre-commit hook (not our own validator) that
 * rejects the write.
 */

/** Base class so callers can `instanceof GitSyncError` for a catch-all. */
export class GitSyncError extends Error {
  /** Raw git stderr (trimmed) that produced this classification, when known. */
  readonly stderr: string;

  constructor(message: string, opts?: { stderr?: string; cause?: unknown }) {
    super(message, opts?.cause ? { cause: opts.cause } : undefined);
    this.name = "GitSyncError";
    this.stderr = opts?.stderr ?? "";
  }
}

/**
 * The vault's pre-commit hook (frontmatter validator) rejected the write.
 * Distinct from a merge conflict — the content is malformed, not contended.
 * Maps to HTTP 422 (unprocessable) with the hook output as the detail.
 */
export class PreCommitHookError extends GitSyncError {
  constructor(opts: { message?: string; stderr: string; cause?: unknown }) {
    super(
      opts.message ??
        "Pre-Commit-Hook hat den Schreibvorgang abgelehnt (ungültige Frontmatter).",
      { stderr: opts.stderr, cause: opts.cause },
    );
    this.name = "PreCommitHookError";
  }
}

/**
 * Der Hook konnte gar nicht erst AUSGEFÜHRT werden — er ist kaputt, nicht der
 * Inhalt der Notiz.
 *
 * Der Fall aus der Praxis: ein CRLF-Checkout unter Windows legt das endungslose
 * POSIX-Skript `.githooks/pre-commit` mit `\r\n` ab, der Linux-Kernel sucht
 * daraufhin den Interpreter `/bin/sh\r` und git bricht ab mit
 *
 *     fatal: cannot exec '.githooks/pre-commit': No such file or directory
 *
 * Das ist ein Infrastruktur-Defekt: JEDER Commit scheitert, unabhängig davon,
 * was der User schreibt. Bis hierher fing {@link PreCommitHookError} diese
 * Meldung ab (sie enthält „pre-commit") und meldete „ungültige Frontmatter" —
 * die exakt falsche Fährte, die den User seine völlig korrekte Notiz debuggen
 * ließ. Deshalb prüft `classifyGitError` diese Signatur ZUERST.
 *
 * `healVaultHook` (`vault/hookHealth.ts`) repariert die Ursache beim nächsten
 * Serverstart — genau das sagt die Meldung dem User auch.
 */
export class HookExecutionError extends GitSyncError {
  constructor(opts: { message?: string; stderr: string; cause?: unknown }) {
    super(
      opts.message ??
        "Der Prüf-Hook des Vaults ist beschädigt — Lokyy repariert ihn beim " +
          "nächsten Start; bis dahin: Lokyy neu starten.",
      { stderr: opts.stderr, cause: opts.cause },
    );
    this.name = "HookExecutionError";
  }
}

/**
 * A genuine merge/rebase conflict — the same lines changed locally and on the
 * remote. The user has to resolve it. Maps to HTTP 409.
 */
export class MergeConflictError extends GitSyncError {
  /** Vault-relative path of the file that could not be synced, when known. */
  readonly relPath: string | null;

  constructor(opts: { message?: string; relPath?: string; stderr?: string; cause?: unknown }) {
    super(
      opts.message ??
        (opts.relPath
          ? `Merge-Konflikt beim Speichern von ${opts.relPath}. ` +
            `Datei wurde remote an denselben Zeilen geändert.`
          : "Merge-Konflikt: Datei wurde remote geändert."),
      { stderr: opts.stderr, cause: opts.cause },
    );
    this.name = "MergeConflictError";
    this.relPath = opts.relPath ?? null;
  }
}

/**
 * Network / auth / remote-backend failure (could not reach Forgejo, refused
 * auth, refspec error, …). `transient` is set when the cause looks retryable
 * (connection reset, timeout, temporary DNS) so the route can hint a retry.
 * Maps to HTTP 503.
 */
export class GitBackendError extends GitSyncError {
  /** True when the failure looks retryable (network blip, timeout). */
  readonly transient: boolean;

  constructor(opts: { message?: string; stderr: string; transient?: boolean; cause?: unknown }) {
    super(opts.message ?? "Git-Backend nicht erreichbar.", {
      stderr: opts.stderr,
      cause: opts.cause,
    });
    this.name = "GitBackendError";
    this.transient = opts.transient ?? false;
  }
}

/** Extracts a usable stderr/message string from an unknown thrown value. */
function stderrOf(err: unknown): string {
  if (err && typeof err === "object") {
    // `execFile` rejections carry `stderr` (and `stdout`) plus `message`.
    const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const parts = [e.stderr, e.stdout, e.message]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join("\n");
    if (parts) return parts;
  }
  return typeof err === "string" ? err : String(err);
}

// Hook nicht ausführbar (kaputte Shebang durch CRLF, fehlender Interpreter).
// git formuliert das je nach Version als „cannot exec"/„cannot run"/„cannot
// spawn"; geprüft wird deshalb das Verb-Set plus der Hook-Pfad im selben Satz.
// MUSS vor PRE_COMMIT_RE laufen — diese Meldungen enthalten „pre-commit" und
// würden sonst als Frontmatter-Ablehnung durchgehen.
const HOOK_EXEC_RE =
  /cannot (?:exec|run|spawn) ['"]?[^'"\n]{0,200}?(?:pre-commit|hooks?\/[a-z-]+)/i;

// Pre-commit hook rejection: git prints the failing hook + the hook's own
// stderr. The lokyy-vault hook mentions "frontmatter" / "pre-commit"; git's
// generic wrapper says "hook ... exited with code" / "cannot ... pre-commit".
const PRE_COMMIT_RE =
  /pre-commit|frontmatter|hook (?:declined|failed|.*exited)|\.git\/hooks\//i;

// Real rebase/merge conflict markers.
const CONFLICT_RE =
  /merge conflict|rebase.*conflict|conflict.*rebase|could not apply|fix conflicts|patch failed|needs merge|automatic merge failed/i;

// Transient backend failures worth a retry hint.
const TRANSIENT_RE =
  /could not resolve host|connection (?:reset|refused|timed out)|timed out|temporary failure|failed to connect|operation timed out|early eof|rpc failed|the remote end hung up|503 |502 |504 /i;

// Any other backend failure (auth, refspec, permission, generic remote error).
const BACKEND_RE =
  /authentication failed|could not read|permission denied|access denied|repository not found|fatal: unable to|fatal: cannot rebase|fatal: couldn't find remote ref|remote: |403 |401 |404 |non-fast-forward/i;

/**
 * Classifies a raw git failure (thrown `execFile` error or stderr string) into
 * one of the typed errors. Order matters: a hook that could not be EXECUTED at
 * all is checked first (its message mentions „pre-commit" and would otherwise
 * be mistaken for a frontmatter rejection), then hook rejection (a hook failure
 * during commit can otherwise read as a generic backend error), then real
 * conflicts, then transient/backend.
 *
 * Falls back to `GitBackendError` (non-transient) for anything unrecognized —
 * never to a blanket "Merge-Konflikt".
 *
 * @param relPath optional file path, threaded into a `MergeConflictError`.
 */
export function classifyGitError(err: unknown, relPath?: string): GitSyncError {
  const stderr = stderrOf(err);

  if (HOOK_EXEC_RE.test(stderr)) {
    return new HookExecutionError({ stderr, cause: err });
  }
  if (PRE_COMMIT_RE.test(stderr)) {
    return new PreCommitHookError({ stderr, cause: err });
  }
  if (CONFLICT_RE.test(stderr)) {
    return new MergeConflictError({
      ...(relPath ? { relPath } : {}),
      stderr,
      cause: err,
    });
  }
  const transient = TRANSIENT_RE.test(stderr);
  if (transient || BACKEND_RE.test(stderr)) {
    return new GitBackendError({ stderr, transient, cause: err });
  }
  // Unknown failure: treat as a (non-transient) backend error rather than
  // mislabeling it a merge conflict.
  return new GitBackendError({ stderr, transient: false, cause: err });
}
