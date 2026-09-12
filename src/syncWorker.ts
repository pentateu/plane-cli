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
import { readMounts, writeMounts } from "./sync.ts";
import { countPending, pushTicket, reconcileEvents } from "./syncPush.ts";

export async function workerCycle(projectId: string): Promise<Array<{ ticket: string; pushed: string[]; comments: number }>> {
  const cfg = resolveConfig({});
  const cache = new Cache(process.env.PLANE_CACHE ?? `${process.env.HOME}/.config/plane/cache.json`);
  const p = new Plane(cfg, cache);
  const out: Array<{ ticket: string; pushed: string[]; comments: number }> = [];
  for (const mount of readMounts().filter((m) => m.projectId === projectId)) {
    await reconcileEvents(p, mount);
    const r = await pushTicket(p, mount);
    const mounts = readMounts();
    const hit = mounts.find((m) => m.ticket === mount.ticket);
    if (hit) {
      writeMounts(mounts.map((m) =>
        m.ticket === mount.ticket
          ? { ...m, lastPoll: new Date().toISOString(), pending: countPending(m.dir) }
          : m,
      ));
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
