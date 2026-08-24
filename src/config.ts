import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type Seat = string;

export type Config = {
  seat: Seat;
  token: string;
  tokenSource: "env" | "plane-seats";
  apiBase: string;
  workspace: string;
  projectName: string;
  projectId?: string;
};

export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

function walkUp(name: string): string | undefined {
  let dir = process.cwd();
  for (;;) {
    const hit = resolve(dir, name);
    if (existsSync(hit)) return hit;
    const parent = resolve(dir, "..");
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function firstEnvFile(...names: string[]): Record<string, string> {
  for (const n of names) {
    const p = walkUp(n);
    if (p) return parseEnvFile(p);
  }
  return {};
}

export class UsageError extends Error {
  kind: string;
  valid?: string[];
  suggestion?: string;
  exitCode: number;
  constructor(kind: string, message: string, opts: { valid?: string[]; suggestion?: string; exitCode?: number } = {}) {
    super(message);
    this.kind = kind;
    this.valid = opts.valid;
    this.suggestion = opts.suggestion;
    this.exitCode = opts.exitCode ?? 4;
  }
}

const LEGACY_DIR = `${homedir()}/.config/plane`;

export function availableSeats(): string[] {
  const seats = firstEnvFile(".plane-seats", `${LEGACY_DIR}/seats.env`);
  return Object.keys(seats)
    .map((k) => (k.match(/^HOMETUTOR_TICKETS_TOKEN_(.+)$/)?.[1] ?? "").toLowerCase())
    .filter(Boolean)
    .sort();
}

/** Token precedence (pinned by tests): provisioned seat files win over
 *  ambient environment — a generic $PLANE_TOKEN must never silently override
 *  an attributed per-seat credential. Order: project .plane-seats >
 *  legacy seats.env > exported HOMETUTOR_TICKETS_TOKEN_<SEAT> > $PLANE_TOKEN. */
export function resolveToken(seat: string, seats: Record<string, string>, env: Record<string, string>): { token: string; tokenSource: Config["tokenSource"] } {
  const key = `HOMETUTOR_TICKETS_TOKEN_${seat.toUpperCase()}`;
  if (seats[key]) return { token: seats[key], tokenSource: "plane-seats" };
  if (env[key]) return { token: env[key], tokenSource: "env" };
  if (env.PLANE_TOKEN) return { token: env.PLANE_TOKEN, tokenSource: "env" };
  throw new UsageError("auth", `no token for seat '${seat}'`, {
    valid: Object.keys(seats)
      .map((k) => (k.match(/^HOMETUTOR_TICKETS_TOKEN_(.+)$/)?.[1] ?? "").toLowerCase())
      .filter(Boolean)
      .sort(),
    suggestion: `add HOMETUTOR_TICKETS_TOKEN_${seat.toUpperCase()} to the project-scoped .plane-seats (gitignored) at the repo root`,
    exitCode: 2,
  });
}

export function resolveConfig(opts: { seat?: string }): Config {
  const agent = { ...parseEnvFile(`${LEGACY_DIR}/agent.env`), ...firstEnvFile(".plane-env") };
  const seats = { ...parseEnvFile(`${LEGACY_DIR}/seats.env`), ...firstEnvFile(".plane-seats") };
  const env = (k: string): string | undefined => process.env[k] ?? agent[k];

  const resolvedSeat = opts.seat ?? process.env.PLANE_SEAT;
  if (!resolvedSeat) {
    throw new UsageError("validation", "no seat resolved — pass --seat <name> or set PLANE_SEAT", {
      valid: availableSeats(),
      suggestion: `plane --seat ${availableSeats()[0] ?? "dev1"} whoami`,
    });
  }

  const processEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") processEnv[k] = v;
  const { token, tokenSource } = resolveToken(resolvedSeat, seats, processEnv);

  const url = env("PLANE_URL");
  const apiBase = (process.env.PLANE_API_BASE ?? env("PLANE_API_BASE") ?? env("HOMETUTOR_TICKETS_API_BASE") ?? (url ? `${url.replace(/\/$/, "")}/api/v1` : "https://plane.iswe.co.nz/api/v1")).replace(/\/$/, "");
  const projectId = process.env.PLANE_PROJECT_ID ?? env("HOMETUTOR_TICKETS_PROJECT_ID");

  return {
    seat: resolvedSeat,
    token,
    tokenSource,
    apiBase,
    workspace: process.env.PLANE_WORKSPACE ?? env("HOMETUTOR_TICKETS_WORKSPACE") ?? "ai-tutor",
    projectName: process.env.PLANE_PROJECT_NAME ?? env("HOMETUTOR_TICKETS_PROJECT") ?? "Ai Tutor",
    ...(projectId ? { projectId } : {}),
  };
}
