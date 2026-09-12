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
import { dirname } from "node:path";
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
  lastBodySha: string | null; // sha of ticket.md at last pull/push (change detect)
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
