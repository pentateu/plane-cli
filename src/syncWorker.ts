/**
 * TC-95 (§29.8) Phase 4 — per-project sync worker.
 *
 * One OS process per project (spawned by the supervisor): polls that
 * project's mounts independently — a crash takes down one project worker,
 * never the instance. Loop per mount: reconcile pending ops → pushTicket
 * (pull-if-server-moved / push-if-local-changed / conflict) → stamp
 * lastPoll + live pending count. Exits when it has no mounts left.
 *
 * Usage: bun src/syncWorker.ts <projectId> [--interval-ms N] [--once]
 * (--once runs a single cycle — unit/live harness, no sleep.)
 */
import { Cache } from "./cache.ts";
import { Plane } from "./api.ts";
import { resolveConfig } from "./config.ts";
import { readMounts, writeMounts, writeStatusFile } from "./sync.ts";
import { countPending, pushTicket, reconcileEvents } from "./syncPush.ts";
import { pullTicket } from "./syncPull.ts";

export async function workerCycle(projectId: string): Promise<Array<{ ticket: string; pushed: string[]; comments: number }>> {
  const cfg = resolveConfig({});
  const cache = new Cache(process.env.PLANE_CACHE ?? `${process.env.HOME}/.config/plane/cache.json`);
  const p = new Plane(cfg, cache);
  const out: Array<{ ticket: string; pushed: string[]; comments: number }> = [];
  for (const mount of readMounts().filter((m) => m.projectId === projectId)) {
    if (mount.lastRev === null) {
      // --no-wait mount: initial pull lands on the first worker cycle.
      const pulled = await pullTicket(p, mount);
      const mounts = readMounts();
      const next = { ...mount, lastRev: pulled.rev, lastBodySha: pulled.bodySha, lastFileSha: pulled.fileSha, kids: pulled.kids, lastPoll: new Date().toISOString(), pending: 0 };
      writeMounts(mounts.map((m) => (m.ticket === mount.ticket ? next : m)));
      writeStatusFile(mount.dir, { ticket: mount.ticket, ready: true, lastPoll: next.lastPoll, pending: 0, rev: next.lastRev });
      out.push({ ticket: mount.ticket, pushed: ["pulled"], comments: pulled.comments });
      continue;
    }
    await reconcileEvents(p, mount);
    const r = await pushTicket(p, mount);
    const mounts = readMounts();
    const hit = mounts.find((m) => m.ticket === mount.ticket);
    if (hit) {
      const next = { ...hit, lastPoll: new Date().toISOString(), pending: countPending(hit.dir) };
      writeMounts(mounts.map((m) => (m.ticket === mount.ticket ? next : m)));
      writeStatusFile(hit.dir, { ticket: hit.ticket, ready: hit.lastRev !== null && next.pending === 0, lastPoll: next.lastPoll, pending: next.pending, rev: hit.lastRev });
    }
    out.push({ ticket: r.ticket, pushed: r.pushed, comments: r.comments });
  }
  return out;
}

const projectId = process.argv[2];

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
    const tick = async () => {
      try {
        await workerCycle(projectId);
      } catch (e) {
        console.error(`worker ${projectId}: ${String((e as Error)?.message ?? e)}`);
      }
      const left = readMounts().filter((m) => m.projectId === projectId);
      if (!left.length) {
        console.error(`worker ${projectId}: no mounts left — exiting`);
        process.exit(0);
      }
      setTimeout(tick, intervalMs);
    };
    process.on("SIGTERM", () => process.exit(0));
    tick();
  }
}
