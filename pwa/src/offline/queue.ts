/**
 * IndexedDB write queue (Story 4.2 + 4.3).
 *
 * When a save fails due to offline / network error, the call site
 * `enqueueSave()`s the payload here. `replayQueue()` drains it on the
 * `online` event or via periodic poll. Replays are sequential to preserve
 * gitService ordering.
 */

const DB_NAME = "lokyy-brain";
const DB_VERSION = 1;
const STORE = "write_queue";

interface QueueEntry {
  id?: number; // auto-increment
  endpoint: string; // e.g. "/api/notes/foo"
  method: "PUT" | "POST" | "DELETE";
  body?: unknown;
  queuedAt: number;
  attempts: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        store.createIndex("queuedAt", "queuedAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function enqueueWrite(entry: Omit<QueueEntry, "id" | "queuedAt" | "attempts">): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.add({
      ...entry,
      queuedAt: Date.now(),
      attempts: 0,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  notifyChanged();
}

export async function listQueue(): Promise<QueueEntry[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("queuedAt").getAll();
    req.onsuccess = () => resolve(req.result as QueueEntry[]);
    req.onerror = () => reject(req.error);
  });
}

export async function queueLength(): Promise<number> {
  const items = await listQueue();
  return items.length;
}

async function removeEntry(id: number): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function bumpAttempts(id: number, attempts: number): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const entry = getReq.result as QueueEntry | undefined;
      if (entry) {
        entry.attempts = attempts;
        store.put(entry);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let replaying = false;

/**
 * Drain the queue sequentially. Returns counts. Caller may call repeatedly
 * (idempotent); concurrent calls collapse via the `replaying` lock.
 */
export async function replayQueue(): Promise<{ drained: number; failed: number }> {
  if (replaying) return { drained: 0, failed: 0 };
  replaying = true;
  let drained = 0;
  let failed = 0;
  try {
    const entries = await listQueue();
    for (const e of entries) {
      try {
        const res = await fetch(e.endpoint, {
          method: e.method,
          headers: e.body ? { "Content-Type": "application/json" } : {},
          body: e.body ? JSON.stringify(e.body) : undefined,
          credentials: "include",
        });
        if (!res.ok) {
          // Conflict gets surfaced via UI hook (Story 4.4 future);
          // for now, bump attempts and keep in queue.
          if (e.id !== undefined) await bumpAttempts(e.id, e.attempts + 1);
          failed++;
          continue;
        }
        if (e.id !== undefined) await removeEntry(e.id);
        drained++;
      } catch {
        if (e.id !== undefined) await bumpAttempts(e.id, e.attempts + 1);
        failed++;
      }
    }
  } finally {
    replaying = false;
    notifyChanged();
  }
  return { drained, failed };
}

// ── Reactive subscription so components can show live queue count ────────
const listeners = new Set<() => void>();

export function subscribeQueueChanges(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyChanged() {
  for (const l of listeners) l();
}

// ── Auto-replay on online/visibility ─────────────────────────────────────
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void replayQueue());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void replayQueue();
  });
  // periodic safety net every 30s when online
  setInterval(() => {
    if (navigator.onLine) void replayQueue();
  }, 30_000);
}
