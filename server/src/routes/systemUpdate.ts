import { Hono, type MiddlewareHandler } from "hono";
import { requireAdmin } from "../middleware/auth.js";

/**
 * Story 7.12 Task 4 — `/api/system/update/*`: the brain's side of the one-click
 * update.
 *
 * This module is deliberately thin. It owns exactly two things:
 *
 *   1. **The admin gate.** Reading a version number is public (`GET
 *      /api/system/version`, see `system.ts`); *executing* an update is not.
 *      AC#10 — the server is the authority, the UI only the convenience.
 *   2. **Capability detection.** Whether this deployment can update itself at
 *      all. Fähigkeitsbasiert, not env-sniffing: we ask the updater. A Coolify
 *      deployment has no sidecar, so the answer is "managed" and the UI shows a
 *      sentence instead of a button (AC#11).
 *
 * What it deliberately does NOT own: **job state**. The brain restarts in the
 * middle of an update — that is the normal case, not the edge case. Anything
 * cached here would be lost exactly when the UI needs it most, and worse, would
 * be *wrong* rather than missing. Every poll goes to the updater, which is the
 * one process that survives the restart (it excludes itself from `up -d`).
 *
 * Every call to the updater is bounded by a short timeout, and an updater that
 * does not answer is a normal answer (`canUpdate: false`), never a 500. On a
 * remote deployment "no updater" is the common case, not a failure.
 */

export type UpdateMode = "local" | "managed" | "off";

/** Why an update cannot be started. Mirrored verbatim into the UI's vocabulary. */
export type UnavailableReason = "managed" | "off" | "blocked" | "unreachable";

export interface UpdateCapability {
  canUpdate: boolean;
  /** The EFFECTIVE mode — "local" also covers a local setup that is currently broken. */
  mode: UpdateMode;
  reason: UnavailableReason | null;
  /** One sentence, ready to render. `null` iff `canUpdate`. */
  message: string | null;
  /** Only ever non-empty for `reason: "blocked"` — actionable misconfiguration. */
  blockers: string[];
  /** A job the updater is running right now; the UI jumps straight into it. */
  currentJobId: string | null;
  project: string | null;
}

/** The subset of `fetch` this module uses — narrow enough to fake in a test. */
export type UpdaterFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface UpdaterDeps {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetchImpl?: UpdaterFetch;
  /** Test seam: overrides all three budgets below. */
  timeoutMs?: number;
}

/** Short on purpose — this sits in a request path an admin is waiting on. */
export const CAPABILITY_TIMEOUT_MS = 2_000;
/** The updater answers `POST /update` immediately with a queued job; it does not build inline. */
export const START_TIMEOUT_MS = 8_000;
export const POLL_TIMEOUT_MS = 5_000;

/**
 * Sprache: `message` und `blockers[]` werden von der PWA als Fließtext
 * gerendert und sind daher deutsch — das Publikum dieser Story sind genau die
 * Leute, die kein Terminal öffnen. Maschinenlesbar bleibt englisch (`error`,
 * `reason`, `phase`), ebenso der Log-Tail: der steht hinter „Protokoll
 * anzeigen" in einem `<pre>` und besteht aus `docker compose`-Ausgabe.
 * Grenze also: als Satz gerendert → deutsch, als Werkzeugausgabe → unberührt.
 */
const MANAGED_MESSAGE =
  "Diese Installation aktualisiert sich nicht selbst — das übernimmt die Plattform, auf der sie " +
  "bereitgestellt wurde (zum Beispiel Coolify). Die Prüfung oben sagt dir nur, dass es eine " +
  "neuere Version gibt.";

const OFF_MESSAGE =
  "Das Aktualisieren über die Oberfläche ist auf diesem System abgeschaltet (LOKYY_UPDATE_MODE=off).";

const BLOCKED_MESSAGE =
  "Ein Updater ist installiert, kann aber noch kein Update ausführen. Bis das behoben ist, " +
  "aktualisierst du auf dem manuellen Weg (`git pull && ./install.sh`).";

/** Job ids come from the updater; anything else must not reach its URL. */
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `LOKYY_UPDATE_MODE` — the explicit override from AC#11. Anything we do not
 * recognise means "no override": a typo must not silently disable updates, it
 * must fall through to the capability probe.
 */
export function resolveUpdateMode(env: Env = process.env): UpdateMode | null {
  const raw = (env.LOKYY_UPDATE_MODE ?? "").trim().toLowerCase();
  if (raw === "local" || raw === "managed" || raw === "off") return raw;
  return null;
}

export function resolveUpdaterEndpoint(env: Env = process.env): { url: string; token: string } {
  return {
    url: (env.LOKYY_UPDATER_URL ?? "").trim().replace(/\/+$/, ""),
    token: (env.LOKYY_UPDATER_TOKEN ?? "").trim(),
  };
}

type UpdaterCall =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: string };

const defaultFetch: UpdaterFetch = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, signal: init.signal });

/**
 * One bounded request to the updater. Never throws, never hangs: a dead
 * sidecar, a wrong URL and a timeout all come back as `{ ok: false }`, which
 * every caller turns into an answer rather than an error.
 */
async function callUpdater(
  url: string,
  path: string,
  method: string,
  token: string | null,
  timeoutMs: number,
  fetchImpl: UpdaterFetch,
): Promise<UpdaterCall> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(`${url}${path}`, { method, headers, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* a non-JSON answer is still an answer — the status carries the meaning */
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: controller.signal.aborted ? `keine Antwort innerhalb von ${timeoutMs} ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(
  mode: UpdateMode,
  reason: UnavailableReason,
  message: string,
  blockers: string[] = [],
  extra: Partial<UpdateCapability> = {},
): UpdateCapability {
  return {
    canUpdate: false,
    mode,
    reason,
    message,
    blockers,
    currentJobId: null,
    project: null,
    ...extra,
  };
}

/**
 * Can this deployment update itself?
 *
 * The one distinction worth the extra code: an updater that is *there but
 * broken* ("blocked") is not the same as *not there* ("managed"). Reporting a
 * missing `LOKYY_UPDATER_TOKEN` as "your platform handles updates" would send
 * an operator looking in the wrong place indefinitely, so a reachable-but-
 * unusable updater says so, with its own words in `blockers`.
 */
export async function detectCapability(deps: UpdaterDeps = {}): Promise<UpdateCapability> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const timeout = deps.timeoutMs ?? CAPABILITY_TIMEOUT_MS;
  const override = resolveUpdateMode(env);

  if (override === "off") return unavailable("off", "off", OFF_MESSAGE);
  if (override === "managed") return unavailable("managed", "managed", MANAGED_MESSAGE);

  const { url, token } = resolveUpdaterEndpoint(env);
  const forcedLocal = override === "local";

  if (!url) {
    return forcedLocal
      ? unavailable("local", "blocked", BLOCKED_MESSAGE, [
          "LOKYY_UPDATE_MODE=local ist gesetzt, aber LOKYY_UPDATER_URL ist leer — der Brain weiß nicht, wo der Updater liegt.",
        ])
      : unavailable("managed", "managed", MANAGED_MESSAGE);
  }

  // No token: we cannot authenticate, so `/status` would 401 either way. The
  // unauthenticated liveness endpoint tells us whether a sidecar exists at all,
  // which is what decides between "misconfigured" and "not this kind of deployment".
  if (!token) {
    const health = await callUpdater(url, "/health", "GET", null, timeout, fetchImpl);
    if (!health.ok || health.status >= 400) {
      return forcedLocal
        ? unavailable("local", "unreachable", unreachableMessage(url, health.ok ? `HTTP ${health.status}` : health.error))
        : unavailable("managed", "managed", MANAGED_MESSAGE);
    }
    return unavailable("local", "blocked", BLOCKED_MESSAGE, [
      "LOKYY_UPDATER_TOKEN ist im Brain nicht gesetzt — trage bei lokyy-brain und lokyy-updater denselben Wert ein und starte beide neu.",
    ]);
  }

  const status = await callUpdater(url, "/status", "GET", token, timeout, fetchImpl);
  if (!status.ok) {
    return forcedLocal
      ? unavailable("local", "unreachable", unreachableMessage(url, status.error))
      : unavailable("managed", "managed", MANAGED_MESSAGE);
  }
  if (status.status === 401 || status.status === 403) {
    return unavailable("local", "blocked", BLOCKED_MESSAGE, [
      "Der Updater hat den LOKYY_UPDATER_TOKEN des Brains abgelehnt — die beiden Werte sind verschieden. Trage bei beiden Diensten denselben Wert ein und starte sie neu.",
    ]);
  }
  if (status.status >= 400 || !isRecord(status.body)) {
    return unavailable("local", "blocked", BLOCKED_MESSAGE, [
      `Der Updater hat unerwartet geantwortet (HTTP ${status.status}).`,
    ]);
  }

  const body = status.body;
  const blockers = Array.isArray(body.blockers)
    ? body.blockers.filter((b): b is string => typeof b === "string")
    : [];
  const project = typeof body.project === "string" ? body.project : null;
  const currentJobId = typeof body.currentJobId === "string" ? body.currentJobId : null;

  if (body.canUpdate === true) {
    return {
      canUpdate: true,
      mode: "local",
      reason: null,
      message: null,
      blockers: [],
      currentJobId,
      project,
    };
  }

  return unavailable(
    "local",
    "blocked",
    BLOCKED_MESSAGE,
    blockers.length > 0 ? blockers : ["Der Updater hat nicht gesagt, warum er kein Update ausführen kann."],
    { currentJobId, project },
  );
}

function unreachableMessage(url: string, detail: string): string {
  return (
    `LOKYY_UPDATE_MODE=local ist gesetzt, aber der Updater unter ${url} war nicht erreichbar (${detail}). ` +
    "Prüfe, ob der Container lokyy-updater läuft."
  );
}

/** What a handler emits. The status set is closed — no updater status leaks through raw. */
export interface ProxyResult {
  status: 200 | 202 | 400 | 404 | 409 | 503;
  body: Record<string, unknown>;
}

function unavailableBody(capability: UpdateCapability, retryable: boolean): Record<string, unknown> {
  return {
    error: "update-unavailable",
    reason: capability.reason,
    message: capability.message,
    blockers: capability.blockers,
    retryable,
  };
}

/**
 * `POST /api/system/update` — hand the job to the updater and return its
 * snapshot unchanged. The brain does not track it; the id in the response is
 * the only thing the UI needs, and it stays valid across the restart that this
 * very job will cause.
 */
export async function startUpdate(deps: UpdaterDeps = {}): Promise<ProxyResult> {
  const capability = await detectCapability(deps);
  if (!capability.canUpdate) {
    return { status: 503, body: unavailableBody(capability, false) };
  }

  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const { url, token } = resolveUpdaterEndpoint(env);
  const res = await callUpdater(
    url,
    "/update",
    "POST",
    token,
    deps.timeoutMs ?? START_TIMEOUT_MS,
    fetchImpl,
  );

  if (!res.ok) {
    return {
      status: 503,
      body: {
        error: "updater-unreachable",
        retryable: true,
        message: `Der Updater war nicht erreichbar (${res.error}). Es wurde nichts gestartet.`,
      },
    };
  }

  // The updater answers 409 for TWO different things (updater/src/index.ts:97
  // and :99): "a job is already running" and "I am blocked". Only the first is
  // a wait-and-poll situation. Telling someone whose compose project cannot be
  // determined that "an update is already running" would send them off waiting
  // for a job that will never exist, so the two are kept apart by the reason
  // the updater gives.
  if (res.status === 409) {
    const reason = messageOf(res.body);
    if (reason === null || /already running/i.test(reason)) {
      return {
        status: 409,
        body: {
          error: "job-running",
          message: reason ?? "Es läuft bereits ein Update.",
          currentJobId: capability.currentJobId,
        },
      };
    }
    return {
      status: 503,
      body: {
        error: "update-unavailable",
        reason: "blocked" satisfies UnavailableReason,
        message: BLOCKED_MESSAGE,
        blockers: [reason],
        retryable: false,
      },
    };
  }

  if ((res.status === 200 || res.status === 202) && isRecord(res.body)) {
    return { status: 202, body: res.body };
  }

  // Anything else stays inside the vocabulary the UI already knows.
  return {
    status: 503,
    body: {
      error: "update-unavailable",
      reason: "blocked" satisfies UnavailableReason,
      message: BLOCKED_MESSAGE,
      blockers: [`Der Updater hat mit HTTP ${res.status} geantwortet.`],
      retryable: false,
    },
  };
}

/**
 * `GET /api/system/update/:id` — the poll.
 *
 * `retryable` is the field the UI polls on: `true` means "keep going, this is
 * the restart window", `false` means "stop, this will not fix itself". A 404 is
 * never retryable — job state survives the restart inside the updater, so an
 * unknown id is a real bug, not a timing artifact.
 */
export async function fetchJob(id: string, deps: UpdaterDeps = {}): Promise<ProxyResult> {
  if (!JOB_ID.test(id)) {
    return {
      status: 400,
      body: { error: "invalid-job-id", message: "Das ist keine Job-ID, die dieser Server vergeben hat." },
    };
  }

  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const { url, token } = resolveUpdaterEndpoint(env);
  if (!url || !token) {
    const capability = await detectCapability(deps);
    return { status: 503, body: unavailableBody(capability, false) };
  }

  const res = await callUpdater(
    url,
    `/update/${encodeURIComponent(id)}`,
    "GET",
    token,
    deps.timeoutMs ?? POLL_TIMEOUT_MS,
    fetchImpl,
  );

  if (!res.ok) {
    return {
      status: 503,
      body: {
        error: "updater-unreachable",
        retryable: true,
        message: `Der Updater hat nicht geantwortet (${res.error}). Wenn gerade ein Update läuft, ist das normal, während die Dienste neu starten.`,
      },
    };
  }
  if (res.status === 404) {
    return { status: 404, body: { error: "unknown-job", message: "Der Updater kennt diesen Job nicht." } };
  }
  if (res.status === 200 && isRecord(res.body)) {
    return { status: 200, body: res.body };
  }
  return {
    status: 503,
    body: {
      error: "updater-unreachable",
      retryable: true,
      message: `Der Updater hat mit HTTP ${res.status} geantwortet.`,
    },
  };
}

function messageOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const value = body.error ?? body.message;
  return typeof value === "string" ? value : null;
}

/**
 * The `guard` parameter exists so the routes can be exercised end-to-end in a
 * test without a database-backed session — production always uses the default.
 * `deps` is the same seam for the updater client.
 */
export function createSystemUpdateRoutes(
  options: { guard?: MiddlewareHandler; deps?: UpdaterDeps } = {},
): Hono {
  const guard = options.guard ?? requireAdmin;
  const deps = options.deps ?? {};
  const routes = new Hono();

  // Same gating pattern as `adminRoutes` (server/src/routes/admin.ts:45).
  routes.use("*", guard);

  routes.get("/", async (c) => c.json(await detectCapability(deps)));

  routes.post("/", async (c) => {
    const result = await startUpdate(deps);
    return c.json(result.body, result.status);
  });

  routes.get("/:id", async (c) => {
    const result = await fetchJob(c.req.param("id"), deps);
    return c.json(result.body, result.status);
  });

  return routes;
}

export const systemUpdateRoutes = createSystemUpdateRoutes();
