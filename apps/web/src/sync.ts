import { MAX_SYNC_CHANGES_PER_REQUEST, type RejectedChange, type SyncChange, type SyncResponse, type SyncRow, type Tombstone } from "@task/shared";
import { applySyncData, db, getSince, setSince, type OutboxChange, type TaskDatabase } from "./db";

export type SyncStatus = "idle" | "syncing" | "offline" | "reauth" | "error";

class SyncHttpError extends Error {
  constructor(readonly status: number) {
    super(`Sync request failed (${status})`);
  }
}

export class ReauthenticationRequired extends Error {
  constructor() {
    super("再ログインが必要です");
    this.name = "ReauthenticationRequired";
  }
}

interface SyncPayload {
  rows: SyncRow[];
  tombstones: Tombstone[];
  rejected: RejectedChange[];
  fullResync: boolean;
}

const locks = new WeakMap<TaskDatabase, Promise<void>>();
const rerunRequested = new WeakSet<TaskDatabase>();
const debounceTimers = new WeakMap<TaskDatabase, ReturnType<typeof setTimeout>>();

function toSyncChange(change: OutboxChange): SyncChange {
  return {
    change_id: change.change_id,
    entity: change.entity,
    id: change.id,
    fields: change.fields,
  } as SyncChange;
}

export async function fetchApiResponse(fetcher: typeof fetch, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetcher(path, {
    ...init,
    credentials: "same-origin",
    redirect: "manual",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (response.type === "opaqueredirect" || response.status === 0 || response.status === 401 || response.status === 403) {
    throw new ReauthenticationRequired();
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new ReauthenticationRequired();
  }
  return response;
}

async function fetchJson<T>(fetcher: typeof fetch, path: string, init: RequestInit): Promise<T> {
  const response = await fetchApiResponse(fetcher, path, init);
  if (!response.ok) throw new SyncHttpError(response.status);
  return response.json() as Promise<T>;
}

function mergePayload(target: SyncPayload, response: SyncResponse): void {
  target.rows.push(...response.rows);
  target.tombstones.push(...response.tombstones);
  target.rejected.push(...response.rejected);
  target.fullResync ||= Boolean(response.full_resync);
}

async function syncRequest(
  fetcher: typeof fetch,
  since: number,
  changes: SyncChange[],
  payload: SyncPayload,
): Promise<number> {
  let body: Record<string, unknown> = { since, changes };
  let response = await fetchJson<SyncResponse>(fetcher, "/api/sync", {
    method: "POST",
    body: JSON.stringify(body),
  });
  mergePayload(payload, response);
  const upto = response.upto;
  while (response.next_page) {
    body = { since, upto, page: response.next_page, changes: [] };
    response = await fetchJson<SyncResponse>(fetcher, "/api/sync", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.upto !== upto) throw new Error("Sync page changed its fixed upper bound");
    mergePayload(payload, response);
  }
  return upto;
}

function compactPayload(payload: SyncPayload): void {
  const rows = new Map<string, SyncRow>();
  for (const row of payload.rows) {
    const id = row.entity === "settings" ? "settings" : row.id;
    const key = `${row.entity}:${id}`;
    const previous = rows.get(key);
    if (!previous || row.seq >= previous.seq) rows.set(key, row);
  }
  payload.rows = [...rows.values()];
  const tombstones = new Map<string, Tombstone>();
  for (const row of payload.tombstones) {
    const key = `${row.entity}:${row.id}`;
    const previous = tombstones.get(key);
    if (!previous || row.seq >= previous.seq) tombstones.set(key, row);
  }
  payload.tombstones = [...tombstones.values()];
}

async function runSync(
  database: TaskDatabase,
  fetcher: typeof fetch,
  onStatus?: (status: SyncStatus) => void,
): Promise<void> {
  onStatus?.("syncing");
  try {
    const startingSince = await getSince(database);
    let requestSince = startingSince;
    const payload: SyncPayload = {
      rows: [],
      tombstones: [],
      rejected: [],
      fullResync: false,
    };
    const initialOutbox = await database.outbox.orderBy("created_at").toArray();
    const changes = initialOutbox.filter((item) => !item.operation);
    const purgeChanges = initialOutbox.filter((item) => item.operation === "purge");
    const acknowledged: string[] = [];

    if (changes.length === 0) {
      requestSince = await syncRequest(fetcher, requestSince, [], payload);
    } else {
      for (let offset = 0; offset < changes.length; offset += MAX_SYNC_CHANGES_PER_REQUEST) {
        const batch = changes.slice(offset, offset + MAX_SYNC_CHANGES_PER_REQUEST);
        requestSince = await syncRequest(fetcher, requestSince, batch.map(toSyncChange), payload);
        acknowledged.push(...batch.map(({ change_id }) => change_id));
      }
    }

    compactPayload(payload);
    await applySyncData(database, payload.rows, payload.tombstones, payload.rejected, payload.fullResync, acknowledged);
    await setSince(requestSince, database);

    let purged = false;
    for (const change of purgeChanges) {
      const rejectedActive = payload.rejected.some((item) => {
        if (item.entity !== change.entity || item.id !== change.id) return false;
        return item.current.entity !== "settings" && item.current.entity !== "task_tag" && item.current.deleted_at === null;
      });
      if (rejectedActive) {
        await database.outbox.delete(change.change_id);
        continue;
      }
      try {
        await fetchJson(fetcher, "/api/trash/purge", {
          method: "POST",
          body: JSON.stringify({
            change_id: change.change_id,
            entity: change.entity,
            id: change.id,
            ...(change.entity === "project" ? { batch_id: change.batch_id ?? null } : {}),
          }),
        });
        await database.outbox.delete(change.change_id);
        purged = true;
      } catch (error) {
        if (!(error instanceof SyncHttpError) || error.status !== 409) throw error;
        await database.outbox.delete(change.change_id);
      }
    }
    if (purged) {
      const finalPayload: SyncPayload = {
        rows: [],
        tombstones: [],
        rejected: [],
        fullResync: false,
      };
      requestSince = await syncRequest(fetcher, requestSince, [], finalPayload);
      compactPayload(finalPayload);
      await applySyncData(database, finalPayload.rows, finalPayload.tombstones, finalPayload.rejected, finalPayload.fullResync);
      await setSince(requestSince, database);
    }
    onStatus?.("idle");
  } catch (error) {
    if (error instanceof ReauthenticationRequired) onStatus?.("reauth");
    else if (error instanceof TypeError || (typeof navigator !== "undefined" && !navigator.onLine)) onStatus?.("offline");
    else onStatus?.("error");
    throw error;
  }
}

export function syncNow(
  database = db,
  fetcher: typeof fetch = fetch,
  onStatus?: (status: SyncStatus) => void,
): Promise<void> {
  const active = locks.get(database);
  if (active) {
    rerunRequested.add(database);
    return active;
  }
  const operation = (async () => {
    let failed = false;
    let lastError: unknown;
    do {
      rerunRequested.delete(database);
      try {
        await runSync(database, fetcher, onStatus);
        failed = false;
      } catch (error) {
        failed = true;
        lastError = error;
      }
    } while (rerunRequested.has(database));
    if (failed) throw lastError;
  })().finally(() => {
    locks.delete(database);
    rerunRequested.delete(database);
  });
  locks.set(database, operation);
  return operation;
}

export function waitForSync(database = db): Promise<void> {
  return locks.get(database) ?? Promise.resolve();
}

export function syncSoon(database = db, onStatus?: (status: SyncStatus) => void): void {
  const previous = debounceTimers.get(database);
  if (previous) clearTimeout(previous);
  debounceTimers.set(database, setTimeout(() => {
    debounceTimers.delete(database);
    void syncNow(database, fetch, onStatus).catch(() => {});
  }, 250));
}

export function startSyncLoop(
  onStatus: (status: SyncStatus) => void,
  onSynced: () => void,
  database = db,
): () => void {
  const run = () => {
    void syncNow(database, fetch, onStatus).then(onSynced).catch(() => {});
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") run();
  };
  const onOnline = () => run();
  run();
  const interval = window.setInterval(() => {
    if (document.visibilityState === "visible") run();
  }, 30_000);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    const timer = debounceTimers.get(database);
    if (timer) clearTimeout(timer);
    debounceTimers.delete(database);
  };
}
