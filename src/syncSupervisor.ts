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
 *
 * Pidfile protocol (review C3/C4): the pidfile is claimed ATOMICALLY
 * (`openSync "wx"`) by the supervisor at startup — a loser exits instead
 * of running a second daemon. Identity = pid + /proc/<pid>/cmdline check:
 * a recycled pid (different binary) reads as STALE, not alive. Removal is
 * own-pid-only: a crashed supervisor's stale file is stolen by the next
 * starter; a live daemon's claim is never deleted by anyone else.
 */
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { readMounts } from "./sync.ts";

const WORKER_FILE = new URL("./syncWorker.ts", import.meta.url).pathname;
export const SUPERVISOR_FILE = new URL("./syncSupervisor.ts", import.meta.url).pathname;

export function supervisorPidFile(): string {
  const state = process.env.PLANE_SYNC_STATE ?? `${process.env.HOME ?? "~"}/.config/plane/syncs.json`;
  return `${state.replace(/\.json$/, "")}-daemon.pid`;
}

/** /proc identity: the pid must belong to a syncSupervisor process. A
 *  recycled pid (any other binary) reads as dead. Non-Linux (no /proc)
 *  falls back to signal-0 liveness (weaker, still better than nothing). */
function procIdentityHolds(pid: number): boolean {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("syncSupervisor");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // dead or no /proc
    // EPERM etc: fall back to signal-0 (alive check only).
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export function daemonAlive(): number | null {
  const f = supervisorPidFile();
  if (!existsSync(f)) return null;
  let pid = 0;
  try {
    pid = Number(readFileSync(f, "utf8").trim().split(" ")[0]);
  } catch {
    return null;
  }
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (pid === process.pid) return pid;
  if (!procIdentityHolds(pid)) {
    // Stale (crashed daemon or recycled pid): steal so the next starter
    // isn't blocked forever (review C4). Only when we can actually remove.
    try {
      rmSync(f, { force: true });
    } catch { /* concurrent starter may have removed it already */ }
    return null;
  }
  return pid;
}

/** Atomic claim: O_EXCL create; on EEXIST verify the holder — a dead or
 *  foreign-pid holder is stale and gets stolen once, then one retry. */
function claimPidFile(): boolean {
  const f = supervisorPidFile();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(f, "wx");
      writeSync(fd, `${process.pid} ${Date.now()}`);
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const live = daemonAlive(); // steals when stale/dead
      if (live !== null) return false; // a REAL daemon owns it — we lost
    }
  }
  return false;
}

/** Remove the pidfile ONLY when it still names us (review C4): our stale
 *  file must never delete a successor's claim. */
function releasePidFile(): void {
  const f = supervisorPidFile();
  try {
    const raw = readFileSync(f, "utf8").trim().split(" ")[0];
    if (Number(raw) === process.pid) rmSync(f, { force: true });
  } catch { /* already gone */ }
}

export type SpawnResult =
  | { state: "started"; pid: number; log: string }
  | { state: "already"; pid: number; log: string }
  | { state: "failed"; pid: number; log: string; error: string };

/** Spawn a DETACHED supervisor (survives the mounting CLI process) unless
 *  one is already alive. Discriminated result (review I11): a spawn failure
 *  is REPORTED, never dressed up as `running (pid 0)`.
 *  PLANE_SYNC_NO_DAEMON=1 (unit suite) skips spawning entirely. */
export function ensureSupervisor(): SpawnResult {
  if (process.env.PLANE_SYNC_NO_DAEMON === "1") return { state: "failed", pid: 0, log: "", error: "daemon spawn disabled (PLANE_SYNC_NO_DAEMON)" };
  const live = daemonAlive();
  if (live !== null) return { state: "already", pid: live, log: "" };
  const pidFile = supervisorPidFile();
  const log = pidFile.replace("daemon.pid", "daemon.log");
  try {
    const outFd = openSync(log, "a");
    const pollMs = Number.isFinite(Number(process.env.PLANE_SYNC_POLL_MS)) ? Number(process.env.PLANE_SYNC_POLL_MS) : 5000;
    const kid = Bun.spawn(["bun", SUPERVISOR_FILE, `--interval-ms=${Math.round(pollMs)}`], {
      env: { ...process.env },
      stdout: outFd,
      stderr: outFd,
      stdin: "ignore",
      detached: true,
      cwd: process.cwd(),
    });
    kid.unref?.();
    return { state: "started", pid: kid.pid, log };
  } catch (e) {
    return { state: "failed", pid: 0, log, error: String((e as Error).message) };
  }
}

export function projectsOf(mounts: Array<{ projectId: string }>): string[] {
  return [...new Set(mounts.map((m) => m.projectId))];
}

export async function runSupervisor(opts: { intervalMs: number; once?: boolean }): Promise<void> {
  // C3: atomic claim BEFORE any work. A concurrent supervisor already owns
  // the pidfile → we exit 0 (it is running; our spawner will observe it).
  if (!claimPidFile()) {
    console.error("supervisor: another daemon holds the pidfile — exiting");
    return;
  }
  const kids = new Map<string, ReturnType<typeof Bun.spawn>>();
  const deadCode = new Map<string, number | null>();
  const respawning = new Set<string>();
  let dead = false;
  const killAll = () => {
    if (dead) return;
    dead = true;
    for (const k of kids.values()) k.kill("SIGTERM");
    setTimeout(() => {
      releasePidFile();
      process.exit(0);
    }, 500);
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
      releasePidFile();
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
    releasePidFile();
    return;
  }
  rollCall();
  setInterval(rollCall, Math.max(opts.intervalMs, 1000));
  await new Promise(() => {});
}

if (import.meta.main) {
  // Standalone entry for the auto-started daemon (`sync TC-N` mounts spawn
  // this detached). `sync --daemon` imports runSupervisor directly instead.
  const raw = Number(process.argv.find((a) => a.startsWith("--interval-ms="))?.split("=")[1] ?? process.env.PLANE_SYNC_POLL_MS ?? 5000);
  await runSupervisor({ intervalMs: Math.round(Number.isFinite(raw) && raw > 0 ? raw : 5000) });
}
