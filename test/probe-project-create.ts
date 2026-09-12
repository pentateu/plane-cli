/**
 * TC-86: attempt to create a TEST project via the Plane API using the dev2
 * seat token resolved exactly the way the CLI resolves it (project-scoped
 * .plane-seats, walked up from cwd). The token is never printed.
 *
 * Usage: bun test/probe-project-create.ts [name] [identifier]
 */
import { parseEnvFile, resolveToken } from "../src/config.ts";

// Same resolution the CLI performs when run from the teamctl checkout:
// project-scoped .plane-seats walked up from that repo root. Values are read
// into memory only — never printed.
const seats = parseEnvFile("/home/rafael/Development/teamctl/.plane-seats");
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
const { token } = resolveToken("dev2", seats, env);
const cfg = {
  token,
  apiBase: process.env.PLANE_API_BASE ?? "https://tools-small.tail8a19c.ts.net/api/v1",
  workspace: "ai-tutor",
};
const api = cfg.apiBase;
const ws = cfg.workspace;

const name = process.argv[2] ?? "TESTCLI";
const identifier = process.argv[3] ?? "TESTCLI";

const res = await fetch(`${api}/workspaces/${ws}/projects/`, {
  method: "POST",
  headers: {
    "X-Api-Key": cfg.token,
    ...(cfg.token.split(".").length === 3 ? { Authorization: `Bearer ${cfg.token}` } : {}),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name, identifier }),
  signal: AbortSignal.timeout(15_000),
});

const text = await res.text();
console.log(JSON.stringify({ status: res.status, body: text.slice(0, 500) }));
