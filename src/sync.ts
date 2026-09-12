/**
 * TC-95 (§29.8) — ticket↔folder mount registry.
 *
 * Phase 1: the registry only (mount / list / unmount records). The daemon
 * (poll, push, reconcile) arrives in later phases; the record shape already
 * carries the fields it will need (lastPoll, pending).
 *
 * State file: `$PLANE_SYNC_STATE`, else `~/.config/plane/syncs.json`
 * (JSON array; written tmp + rename so a killed CLI never leaves halves).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface SyncMount {
  ticket: string; // canonical handle, e.g. "TEST-1" (uppercased ident)
  projectId: string;
  uuid: string;
  seq: number;
  ident: string;
  dir: string; // absolute mount dir
  seat: string;
  createdAt: string;
  lastPoll: string | null; // daemon fills; null until first poll
  pending: number; // daemon fills; events awaiting push
  lastRev: string | null; // server updated_at at last pull/push (revision guard)
  lastBodySha: string | null; // sha of ticket BODY text at last pull/push (body-push decision)
  lastFileSha: string | null; // sha of the whole ticket.md file (ANY local edit → conflict detection)
  kids: Array<{ slug: string; uuid: string; rev: string; bodySha: string; fileSha: string }>; // sub-ticket baselines (no registry rows for children)
}

export function syncStatePath(): string {
  const override = process.env.PLANE_SYNC_STATE;
  if (override) return override;
  return `${homedir()}/.config/plane/syncs.json`;
}

export function readMounts(): SyncMount[] {
  const path = syncStatePath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(raw) ? (raw as SyncMount[]) : [];
  } catch {
    return [];
  }
}

export function writeMounts(mounts: SyncMount[]): void {
  const path = syncStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(mounts, null, 2));
  renameSync(tmp, path);
}

export function findMount(ticketHandle: string): SyncMount | undefined {
  const want = ticketHandle.toUpperCase();
  return readMounts().find((m) => m.ticket.toUpperCase() === want);
}

export interface SyncStatus {
  ticket: string;
  ready: boolean;
  lastPoll: string | null;
  pending: number;
  rev: string | null;
}

/**
 * Watch surface: `.sync-status.json` inside each mount dir states whether
 * the folder is complete and drained. Watchers (inotify/kqueue, or a simple
 * poll on mtime) see readiness without touching the registry — the file
 * appears at mount time (ready:false) and flips when the pull lands and
 * whenever the drain state changes.
 */
export function statusFile(dir: string): string {
  return join(dir, ".sync-status.json");
}

export function countPendingEvents(dir: string): number {
  const f = join(dir, "comments.events.jsonl");
  if (!existsSync(f)) return 0;
  let n = 0;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      if ((JSON.parse(line) as { status?: string }).status === "pending") n++;
    } catch { /* torn last line under concurrent append — recount next poll */ }
  }
  return n;
}

export function writeStatusFile(dir: string, s: SyncStatus): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(statusFile(dir), JSON.stringify(s) + "\n");
  } catch { /* status is advisory — never fail a sync over it */ }
}

export function readyStatus(mount: SyncMount): SyncStatus {
  const pending = countPendingEvents(mount.dir);
  return {
    ticket: mount.ticket,
    ready: mount.lastRev !== null && pending === 0,
    lastPoll: mount.lastPoll,
    pending,
    rev: mount.lastRev,
  };
}

export interface StoredEvent {
  status?: string;
  id?: string | null;
  [k: string]: unknown;
}

export function readEventsFile(dir: string): StoredEvent[] {
  const f = join(dir, "comments.events.jsonl");
  if (!existsSync(f)) return [];
  const out: StoredEvent[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as StoredEvent);
    } catch { /* torn last line under concurrent append — next read heals */ }
  }
  return out;
}
