/**
 * TC-95 (§29.8) Phase 4 — sync supervisor (one instance).
 *
 * Groups active mounts by project and keeps one worker subprocess
 * (`bun src/syncWorker.ts <projectId>`) per project: independent cadence,
 * independent fate. Restarts dead workers (backoff 5 s); exits when no
 * mounts remain. Workers inherit the supervisor's env (seat, tokens,
 * PLANE_*), so attribution and targeting match an interactive CLI run.
 *
 * Mounts added/removed while running are picked up on the next roll-call
 * (new project → spawn; empty project → worker exits itself).
 */
import { readMounts } from "./sync.ts";

const WORKER_FILE = new URL("./syncWorker.ts", import.meta.url).pathname;

export function projectsOf(mounts: Array<{ projectId: string }>): string[] {
  return [...new Set(mounts.map((m) => m.projectId))];
}

export async function runSupervisor(opts: { intervalMs: number; once?: boolean }): Promise<void> {
  const kids = new Map<string, ReturnType<typeof Bun.spawn>>();
  const deadCode = new Map<string, number | null>();
  const respawning = new Set<string>();
  let dead = false;
  const killAll = () => {
    if (dead) return;
    dead = true;
    for (const k of kids.values()) k.kill("SIGTERM");
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", killAll);
  process.on("SIGINT", killAll);

  const rollCall = () => {
    if (dead) return;
    const want = projectsOf(readMounts());
    for (const [pid, kid] of [...kids]) {
      // NOTE: kid.exitCode stays null until `exited` settles — track via
      // the promise, not the property.
      const code = deadCode.get(pid) ?? kid.exitCode;
      if (code !== null && code !== undefined) {
        console.error(`supervisor: worker ${pid} exited (${code}) — respawning in 5s`);
        kids.delete(pid);
        deadCode.delete(pid);
        if (!respawning.has(pid)) {
          respawning.add(pid);
          setTimeout(() => {
            respawning.delete(pid);
            if (!dead && readMounts().some((m) => m.projectId === pid)) spawn(pid);
          }, 5000);
        }
      } else if (!want.includes(pid)) {
        kid.kill("SIGTERM");
        kids.delete(pid);
        deadCode.delete(pid);
      }
    }
    for (const pid of want) if (!kids.has(pid)) spawn(pid);
    const anyAlive = [...kids].some(([pid, k]) => (deadCode.has(pid) ? deadCode.get(pid) : k.exitCode) === null);
    if (!want.length && !anyAlive) {
      console.error("supervisor: no mounts left — exiting");
      process.exit(0);
    }
  };

  const spawn = (pid: string) => {
    const live = kids.get(pid);
    if (live && (deadCode.get(pid) ?? live.exitCode) === null) return; // already up
    const args = ["bun", WORKER_FILE, pid, `--interval-ms=${opts.intervalMs}`];
    if (opts.once) args.push("--once");
    const kid = Bun.spawn(args, {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    });
    kids.set(pid, kid);
    deadCode.delete(pid); // stale death must not haunt the replacement
    kid.exited.then((code) => deadCode.set(pid, code));
    console.error(`supervisor: worker ${pid} started (pid ${kid.pid})`);
  };

  if (opts.once) {
    // Single supervised cycle per project (harness): spawn, await, report.
    for (const pid of projectsOf(readMounts())) spawn(pid);
    const codes: Array<{ project: string; code: number | null }> = [];
    for (const [pid, kid] of kids) codes.push({ project: pid, code: await kid.exited });
    console.log(JSON.stringify(codes));
    return;
  }
  rollCall();
  setInterval(rollCall, Math.max(opts.intervalMs, 1000));
  await new Promise(() => {});
}
