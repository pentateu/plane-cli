/**
 * TC-86: manual probe — create a project via the Plane API using a seat
 * token resolved the way the CLI resolves it (explicit --seats file, else
 * `.plane-seats` walked up from cwd, else exported env). The token is never
 * printed. MANUAL ONLY: writes to whatever instance PLANE_API_BASE points
 * at, so PLANE_API_BASE is required with no default — there is deliberately
 * no live fallback that could misfire.
 *
 * Usage:
 *   PLANE_API_BASE=http://127.0.0.1:3211/api/v1 \
 *     bun test/manual/probe-project-create.ts [name] [identifier] \
 *       [--seat test] [--seats ./test/plane-test/.plane-test-env] [--workspace plane-cli-test]
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnvFile, resolveToken } from "../../src/config.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// Same precedence the CLI uses: explicit file, else walk up from cwd.
function walkUp(name: string): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

const apiBase = process.env.PLANE_API_BASE;
if (!apiBase) {
  console.error("PLANE_API_BASE is required (no default — refusing to guess an instance)");
  process.exit(2);
}
const seat = arg("seat") ?? process.env.PLANE_SEAT ?? "test";
const seatsPath = arg("seat-file") ?? arg("seats") ?? walkUp(".plane-seats");
const seats = seatsPath ? parseEnvFile(seatsPath) : {};
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
const { token } = resolveToken(seat, seats, env);
const ws = arg("workspace") ?? "plane-cli-test";

const name = positionals[0] ?? "TESTCLI";
const identifier = positionals[1] ?? "TESTCLI";

const res = await fetch(`${apiBase.replace(/\/$/, "")}/workspaces/${ws}/projects/`, {
  method: "POST",
  headers: {
    "X-Api-Key": token,
    ...(token.split(".").length === 3 ? { Authorization: `Bearer ${token}` } : {}),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name, identifier }),
  signal: AbortSignal.timeout(15_000),
});

const text = await res.text();
console.log(JSON.stringify({ status: res.status, body: text.slice(0, 500) }));
