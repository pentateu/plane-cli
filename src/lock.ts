/**
 * File lock for cross-process read-modify-write critical sections (TC-95
 * review C1/C2): the registry (syncs.json) and per-mount event files are
 * mutated by BOTH the CLI process and the daemon workers. tmp+rename makes
 * one write atomic but not the read→modify→write sequence — interleaving
 * loses mounts (C1) and drops pending comments (C2).
 *
 * Protocol: O_EXCL create of `<target>.lock` holding `pid timestamp`.
 * Holders keep sections SHORT (no network inside — re-checks that need the
 * network happen BEFORE the lock; the lock only guards the file RMW).
 * A claim older than STALE_MS is stolen (holder died mid-section).
 * `withLock` callers must RE-READ state inside the section — never cache
 * pre-lock reads.
 */
import { existsSync, mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** N1 (review r4): STALE_MS must be SHORTER than the default timeout —
 *  otherwise a holder that dies mid-section blocks waiters until the
 *  timeout fires BEFORE the claim ever looks stale. 5s stale / 10s
 *  timeout: a dead holder is stolen in ≤5s, a live-but-slow holder gets
 *  the remaining 5s of wait budget. Sections are ms-short (no network),
 *  so 5s is ~100x the longest legitimate section. */
const STALE_MS = 5_000;
const RETRY_MS = 25;

/** True when the existing claim is dead-old enough to steal. Also steals
 *  IMMEDIATELY when the claim's pid is provably dead (N1: kill(pid,0)
 *  ESRCH — no age wait for a corpse). Unparseable/garbage claims are
 *  treated as stale (nothing live writes garbage). */
function stealIfStale(lockPath: string): boolean {
  let raw = "";
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return !existsSync(lockPath); // vanished under us → free to try
  }
  const parts = raw.trim().split(" ");
  const pid = Number(parts[0]);
  const at = Number(parts[1] ?? 0);
  const ageFresh = Number.isFinite(at) && at > 0 && Date.now() - at < STALE_MS;
  if (ageFresh && Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0); // alive (incl. our own pid) → leave it alone
      return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") return false; // EPERM etc: alive enough
      // ESRCH: the holder is a CORPSE — steal now, whatever the age.
    }
  }
  if (ageFresh && (!Number.isFinite(pid) || pid <= 0)) return false; // malformed but fresh: brief grace
  unlinkSync(lockPath);
  return true;
}

export async function withLock<T>(lockPath: string, fn: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> {
  const dir = dirname(lockPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockPath}`);
      stealIfStale(lockPath);
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    writeSync(fd, `${process.pid} ${Date.now()}`);
  } catch { /* claim content is advisory (stale detection) */ }
  closeSync(fd);
  try {
    return await fn();
  } finally {
    // Remove only OUR claim: a stolen-then-recreated lock may belong to a
    // newer holder by the time we finish (long section + steal race).
    try {
      const raw = readFileSync(lockPath, "utf8");
      if (raw.startsWith(`${process.pid} `)) unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}
