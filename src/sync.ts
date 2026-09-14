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
import { withLock } from "./lock.ts";

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
  lastBodySha: string | null; // sha of ticket BODY text at last pull/push (body-push decision) — M4: normalized sha
  lastFileSha: string | null; // sha of the whole ticket.md file (ANY local edit → conflict detection)
  kids: Array<{ rel: string; uuid: string; rev: string; bodySha: string; fileSha: string; state?: string; assignee?: string; labels?: string[]; priority?: string; title?: string; bodyNormalizedSha?: string }>; // sub-ticket baselines, rel = dir path relative to mount root (no registry rows for children)
  // M4 field-level baselines (optional for backward compat; populated after next pull/push)
  lastState?: string;
  lastAssignee?: string;
  lastLabels?: string[];
  lastPriority?: string;
  lastTitle?: string;
  lastBodyNormalizedSha?: string;
}

export function syncStatePath(): string {
  const override = process.env.PLANE_SYNC_STATE;
  if (override) return override;
  return `${homedir()}/.config/plane/syncs.json`;
}

/** Corrupt registry = loud (review M8): silent [] made a worker exit 0 "no
 *  mounts left" while real mounts existed — data-loss signal must not be
 *  swallowed. */
export function readMounts(): SyncMount[] {
  const path = syncStatePath();
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`sync registry corrupt (${path}): ${String((e as Error).message)}`);
  }
  if (!Array.isArray(raw)) throw new Error(`sync registry corrupt (${path}): not an array`);
  return raw as SyncMount[];
}

export function writeMounts(mounts: SyncMount[]): void {
  const path = syncStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(mounts, null, 2));
  renameSync(tmp, path);
}

/**
 * C1 (review): the ONLY sanctioned registry mutation. Locks the registry,
 * re-reads FRESH inside the section, applies the mutator, writes. Every
 * former read→map→write call site must go through this — a bare writeMounts
 * of a pre-lock read resurrects stopped mounts and drops concurrent edits.
 * Mutator mutates the array IN PLACE (or replaces its contents); its return
 * value is ignored. Return data via closure capture.
 */
export async function updateMounts(mutate: (mounts: SyncMount[]) => void): Promise<void> {
  await withLock(`${syncStatePath()}.lock`, () => {
    const mounts = readMounts();
    mutate(mounts);
    writeMounts(mounts);
  });
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
  /** I2 (review): last cycle error for this mount (absent = healthy). */
  error?: string;
}

/**
 * Watch surface: `.plane/.sync-status.json` inside each mount dir states
 * whether the folder is complete and drained. Watchers (inotify/kqueue, or
 * a simple poll on mtime) see readiness without touching the registry — the
 * file appears at mount time (ready:false) and flips when the pull lands
 * and whenever the drain state changes.
 */
export function statusFile(dir: string): string {
  return join(dir, ".plane", ".sync-status.json");
}

/** ALL sync metadata lives in this hidden dir; the mount root holds only
 *  the files humans edit (ticket.md, sub-tickets/) — no JSON noise. */
export function metaDir(dir: string): string {
  return join(dir, ".plane");
}

export function countPendingEvents(dir: string): number {
  const f = join(metaDir(dir), "comments.events.jsonl");
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
    mkdirSync(metaDir(dir), { recursive: true });
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
  const f = join(metaDir(dir), "comments.events.jsonl");
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

export function writeEventsFile(dir: string, events: StoredEvent[]): void {
  mkdirSync(metaDir(dir), { recursive: true });
  writeFileSync(join(metaDir(dir), "comments.events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
}

/**
 * C2 (review): the ONLY sanctioned event-file rewrite. Locks the per-mount
 * event file, reads FRESH inside the section, applies the mutator, writes.
 * Merge rule for concurrent shell appends (the documented agent path): rows
 * whose `op` is unknown to the mutator's read are PRESERVED — an append
 * landing mid-section survives the rewrite.
 *
 * N2 (review r4, accepted micro-window): an agent O_APPEND landing in the
 * microseconds between the post-mutate re-read and writeEventsFile is NOT
 * in `fresh` and is lost. Agents append via `>>` (no lock); closing that
 * window fully needs lock-holding appends (a watched FIFO or inotify), a
 * later phase. Contract: appends are single-line JSON + \n, one write() —
 * torn appends heal on the next read.
 *
 * I1 (review r2): extracted locked RMW core as withEventsLock so conflict
 * snapshot + notice row + comments.json land atomically inside ONE lock.
 * updateEvents delegates to this helper (single writing path).
 */
export async function withEventsLock(dir: string, mutate: (events: StoredEvent[]) => void | Promise<void>): Promise<void> {
  await withLock(join(metaDir(dir), "events.lock"), async () => {
    const events = readEventsFile(dir);
    const known = new Set(events.map((e) => String((e as { op?: string }).op ?? "")));
    await mutate(events);
    // Rows appended while the mutator ran (unknown ops) are merged back —
    // an append landing mid-section survives the rewrite.
    const fresh = readEventsFile(dir).filter((e) => !known.has(String((e as { op?: string }).op ?? "")));
    const resultOps = new Set(events.map((e) => String((e as { op?: string }).op ?? "")));
    const merged = [...events, ...fresh.filter((e) => !resultOps.has(String((e as { op?: string }).op ?? "")))];
    writeEventsFile(dir, merged);
    // I1: derived comments.json is rewritten atomically alongside events inside the same lock
    try {
      mkdirSync(metaDir(dir), { recursive: true });
      writeFileSync(
        join(metaDir(dir), "comments.json"),
        JSON.stringify(merged.map(({ id, parent, author, body, at, status }) => ({ id, parent, author, body, at, status })), null, 2) + "\n",
      );
    } catch { /* advisory — events landed */ }
  });
}

export async function updateEvents(dir: string, mutate: (events: StoredEvent[]) => void): Promise<void> {
  await withEventsLock(dir, mutate);
}
