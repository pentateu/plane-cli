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
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { readMounts } from "./sync.ts";

const WORKER_FILE = new URL("./syncWorker.ts", import.meta.url).pathname;
export const SUPERVISOR_FILE = new URL("./syncSupervisor.ts", import.meta.url).pathname;

/** Pidfile lives beside the mount registry; the daemon writes its pid there
 *  on start and removes it on exit. `ensureSupervisor` uses it to avoid
 *  double-daemons (auto-start on mount + manual `sync --daemon`). */
export function supervisorPidFile(): string {
  const state = process.env.PLANE_SYNC_STATE ?? `${process.env.HOME ?? "~"}/.config/plane/syncs.json`;
  return `${state.replace(/\.json$/, "")}-daemon.pid`;
}

export function daemonAlive(): number | null {
  const f = supervisorPidFile();
  if (!existsSync(f)) return null;
  try {
    const pid = Number(readFileSync(f, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return null;
    process.kill(pid, 0); // throws ESRCH when the pid is gone
    return pid;
  } catch {
    return null;
  }
}

/** Spawn a DETACHED supervisor (survives the mounting CLI process) unless
 *  one is already alive. Returns { started | already } with the pid.
 *  PLANE_SYNC_NO_DAEMON=1 (unit suite) skips spawning entirely. */
export function ensureSupervisor(): { started: boolean; pid: number; log: string; skipped?: boolean } {
  if (process.env.PLANE_SYNC_NO_DAEMON === "1") return { started: false, pid: 0, log: "", skipped: true };
  const live = daemonAlive();
  if (live !== null) return { started: false, pid: live, log: "" };
  const pidFile = supervisorPidFile();
  const log = pidFile.replace("daemon.pid", "daemon.log");
  try {
    rmSync(pidFile, { force: true });
    const outFd = openSync(log, "a");
    const pollMs = Number.isFinite(Number(process.env.PLANE_SYNC_POLL_MS)) ? Number(process.env.PLANE_SYNC_POLL_MS) : 5000;
    const kid = Bun.spawn(["bun", SUPERVISOR_FILE, `--interval-ms=${Math.round(pollMs)}`], {
      env: { ...process.env, PLANE_SUPERVISOR_BOOTSTRAP_PID: pidFile },
      stdout: outFd,
      stderr: outFd,
      detached: true,
      cwd: process.cwd(),
    });
    kid.unref?.();
    return { started: true, pid: kid.pid, log };
  } catch (e) {
    return { started: false, pid: 0, log: String((e as Error).message) };
  }
}

export function projectsOf(mounts: Array<{ projectId: string }>): string[] {
  return [...new Set(mounts.map((m) => m.projectId))];
}

export async function runSupervisor(opts: { intervalMs: number; once?: boolean }): Promise<void> {
  const pidFile = process.env.PLANE_SUPERVISOR_BOOTSTRAP_PID ?? supervisorPidFile();
  const claimPid = () => {
    try {
      const dir = pidFile.includes("/") ? pidFile.replace(/\/[^/]+$/, "") : ".";
      mkdirSync(dir, { recursive: true });
      const fd = openSync(pidFile, "w");
      writeSync(fd, String(process.pid));
    } catch { /* best-effort: still run without a pidfile */ }
  };
  claimPid();
  const kids = new Map<string, ReturnType<typeof Bun.spawn>>();
  const deadCode = new Map<string, number | null>();
  const respawning = new Set<string>();
  let dead = false;
  const killAll = () => {
    if (dead) return;
    dead = true;
    for (const k of kids.values()) k.kill("SIGTERM");
    setTimeout(() => { try { rmSync(pidFile, { force: true }); } catch { /* best effort */ } process.exit(0); }, 500);
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
      try { rmSync(pidFile, { force: true }); } catch { /* best effort */ }
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

if (import.meta.main) {
  // Standalone entry for the auto-started daemon (`sync TC-N` mounts spawn
  // this detached). `sync --daemon` imports runSupervisor directly instead.
  const raw = Number(process.argv.find((a) => a.startsWith("--interval-ms="))?.split("=")[1] ?? process.env.PLANE_SYNC_POLL_MS ?? 5000);
  await runSupervisor({ intervalMs: Math.round(Number.isFinite(raw) && raw > 0 ? raw : 5000) });
}
