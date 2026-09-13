/**
 * TC-95 (§29.8) Phase 4 — per-project sync worker.
 *
 * One OS process per project (spawned by the supervisor): polls that
 * project's mounts independently — a crash takes down one project worker,
 * never the instance. Loop per mount: reconcile pending ops → pushTicket
 * (pull-if-server-moved / push-if-local-changed / conflict) → stamp
 * lastPoll + live pending count. Exits when it has no mounts left.
 *
 * Per-mount isolation (review I2): a poisoned mount (bad state, missing
 * ticket.md, live foreign claim) must NOT starve its siblings — every
 * mount gets its own try/catch, the error lands in the status file, and
 * the loop continues.
 *
 * Usage: bun src/syncWorker.ts <projectId> [--interval-ms N] [--once]
 * (--once runs a single cycle — unit/live harness, no sleep.)
 */
import { Cache } from "./cache.ts";
import { Plane } from "./api.ts";
import { resolveConfig } from "./config.ts";
import { readMounts, updateMounts, writeStatusFile } from "./sync.ts";
import { countPendingEvents } from "./sync.ts";
import { pushTicket, reconcileEvents } from "./syncPush.ts";
import { pullTicket } from "./syncPull.ts";

export async function workerCycle(projectId: string): Promise<Array<{ ticket: string; pushed: string[]; comments: number; error?: string }>> {
  const cfg = resolveConfig({});
  const cache = new Cache(process.env.PLANE_CACHE ?? `${process.env.HOME}/.config/plane/cache.json`);
  const p = new Plane(cfg, cache);
  const out: Array<{ ticket: string; pushed: string[]; comments: number; error?: string }> = [];
  for (const mount of readMounts().filter((m) => m.projectId === projectId)) {
    try {
      if (mount.lastRev === null) {
        // --no-wait mount: initial pull lands on the first worker cycle.
        const pulled = await pullTicket(p, mount);
        await updateMounts((mounts) => {
          const hit = mounts.find((m) => m.ticket === mount.ticket);
          if (hit) {
            hit.lastRev = pulled.rev;
            hit.lastBodySha = pulled.bodySha;
            hit.lastFileSha = pulled.fileSha;
            hit.kids = pulled.kids;
            hit.lastPoll = new Date().toISOString();
            hit.pending = 0;
          }
          return undefined;
        });
        writeStatusFile(mount.dir, { ticket: mount.ticket, ready: true, lastPoll: new Date().toISOString(), pending: 0, rev: pulled.rev });
        out.push({ ticket: mount.ticket, pushed: ["pulled"], comments: pulled.comments });
        continue;
      }
      await reconcileEvents(p, mount);
      const r = await pushTicket(p, mount);
      const pending = countPendingEvents(mount.dir);
      await updateMounts((mounts) => {
        const hit = mounts.find((m) => m.ticket === mount.ticket);
        if (hit) {
          hit.lastPoll = new Date().toISOString();
          hit.pending = pending;
        }
        return undefined;
      });
      writeStatusFile(mount.dir, { ticket: mount.ticket, ready: pending === 0, lastPoll: new Date().toISOString(), pending, rev: r.rev });
      out.push({ ticket: r.ticket, pushed: r.pushed, comments: r.comments });
    } catch (e) {
      // I2: record + continue — one sick mount never starves siblings.
      const message = String((e as Error)?.message ?? e).slice(0, 300);
      writeStatusFile(mount.dir, { ticket: mount.ticket, ready: false, lastPoll: new Date().toISOString(), pending: countPendingEvents(mount.dir), rev: mount.lastRev, error: message });
      out.push({ ticket: mount.ticket, pushed: [], comments: 0, error: message });
    }
  }
  return out;
}

const projectId = process.argv[2];

/** Backoff predicate (review I12/M10): extracted for unit testing. The
 *  M10 dead substring branches are gone — ApiError always sets `.kind`. */
export function shouldBackoff(e: unknown): boolean {
  const kind = String((e as { kind?: string })?.kind ?? "");
  return kind === "rate-limit" || kind === "network";
}

if (import.meta.main) {
  if (!projectId) {
    console.error("syncWorker: projectId argument required");
    process.exit(2);
  }
  const once = process.argv.includes("--once");
  const intervalMs = Number(process.argv.find((a) => a.startsWith("--interval-ms="))?.split("=")[1] ?? process.env.PLANE_SYNC_POLL_MS ?? 5000);

  if (once) {
    await workerCycle(projectId).then(
      (r) => { console.log(JSON.stringify(r)); process.exit(0); },
      (e) => { console.error(String(e?.message ?? e)); process.exit(1); },
    );
  } else {
    let backoffMs = intervalMs;
    const tick = async () => {
      try {
        await workerCycle(projectId);
        backoffMs = intervalMs; // healthy cycle resets the ramp
      } catch (e) {
        // Cycle-level failures (registry corrupt, ...) keep the ramp too.
        if (shouldBackoff(e)) {
          backoffMs = Math.min(backoffMs * 2, 60_000);
          console.error(`worker ${projectId}: ${String((e as Error)?.message ?? e)} — backing off ${Math.round(backoffMs / 1000)}s`);
        } else {
          console.error(`worker ${projectId}: ${String((e as Error)?.message ?? e)}`);
        }
      }
      let left: number;
      try {
        left = readMounts().filter((m) => m.projectId === projectId).length;
      } catch (e) {
        console.error(`worker ${projectId}: registry unreadable — ${String((e as Error).message)}`);
        process.exit(1); // M8: loud, nonzero — never "no mounts left" on corruption
      }
      if (!left) {
        console.error(`worker ${projectId}: no mounts left — exiting`);
        process.exit(0);
      }
      setTimeout(tick, backoffMs);
    };
    process.on("SIGTERM", () => process.exit(0));
    tick();
  }
}
