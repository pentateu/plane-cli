import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "./cache.ts";
import { run, peekCache } from "./cli.ts";

type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [];
let router: (m: string, p: string, b: any) => { status: number; json?: any } = () => ({ status: 404 });
let fetchSpy: any;
let spies: Array<{ mockRestore: () => void }> = [];
let envSnapshot: Record<string, string | undefined> = {};
let tmpDirs: string[] = [];

function relsOf(uuid: string): { blocking: string[]; blocked_by: string[] } {
  const m = (globalThis.__relations ??= {});
  return (m[uuid] ??= { blocking: [], blocked_by: [] });
}

function addEdge(blocker: string, blocked: string): void {
  relsOf(blocker).blocking.push(blocked);
  relsOf(blocked).blocked_by.push(blocker);
}

function removeEdgeAnyOrientation(a: string, b: string): boolean {
  const pairs: Array<[string, string]> = [
    [a, b],
    [b, a],
  ];
  for (const [x, y] of pairs) {
    const r = globalThis.__relations?.[x];
    const idx = r?.blocking.indexOf(y);
    if (r && idx !== undefined && idx >= 0) {
      r.blocking.splice(idx, 1);
      relsOf(y).blocked_by.splice(relsOf(y).blocked_by.indexOf(x), 1);
      return true;
    }
  }
  return false;
}

function relationEntry(uuid: string): Record<string, unknown> {
  // live instance shape (iswe.co.nz): {project_id, issue_id} — no id/sequence_id
  return { project_id: "pr-1", issue_id: uuid };
}

/** Minimal router serving one issue + a relations payload in any wire shape. */
function relationsShapeRouter(relations: Record<string, unknown>): (m: string, p: string) => { status: number; json?: any } {
  return (_m, path) => {
    if (path.endsWith("/projects/")) return { status: 200, json: { results: [{ id: "pr-1", name: "Ai Tutor", identifier: "AITUT" }] } };
    if (path === "/members/") return { status: 200, json: MEMBERS };
    if (/\/work-items\/([^/]+)\/relations\/$/.test(path)) return { status: 200, json: relations };
    if (path.endsWith("/states/")) return { status: 200, json: { results: STATES } };
    if (path.endsWith("/labels/")) return { status: 200, json: { results: LABELS } };
    if (/\/projects\/[^/]+\/issues\/$/.test(path)) return { status: 200, json: { results: ISSUES, next_page_results: false } };
    const m = path.match(/\/issues\/(is-\d+)\/$/);
    if (m) return { status: 200, json: ISSUES.find((i) => i.id === m[1])! };
    return { status: 404 };
  };
}

const ENV_KEYS = ["PLANE_API_BASE", "PLANE_WORKSPACE", "PLANE_PROJECT_NAME", "PLANE_SEAT", "PLANE_TOKEN", "PLANE_CACHE", "HOMETUTOR_TICKETS_PROJECT_ID"];

function capture(obj: any, method: string): any {
  const s = spyOn(obj, method).mockImplementation(() => {});
  spies.push(s);
  return s;
}

function newCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "plane-cli-test-"));
  tmpDirs.push(dir);
  return join(dir, "cache.json");
}

const STATES = [
  { id: "st-backlog", name: "Backlog" },
  { id: "st-todo", name: "Todo" },
  { id: "st-progress", name: "In Progress" },
  { id: "st-done", name: "Done" },
  { id: "st-cancelled", name: "Cancelled" },
  { id: "st-verify", name: "Awaiting verification" },
];

const LABELS = [
  { id: "lb-bug", name: "type:bug" },
  { id: "lb-feature", name: "type:feature" },
  { id: "lb-ops", name: "type:ops" },
  { id: "lb-plan", name: "type:plan" },
];

const MEMBERS = [
  { id: "mb-dev1", display_name: "dev1", email: "dev1-aitutor@x" },
  { id: "mb-dev2", display_name: "dev2", email: "dev2-aitutor@x" },
  { id: "mb-rafael", display_name: "rafael", email: "rafael@x" },
];

const ISSUES = [
  {
    id: "is-66",
    sequence_id: 66,
    name: "[impl] personal tutor coherence",
    state: "st-progress",
    priority: "high",
    assignees: ["mb-dev1"],
    labels: ["lb-plan"],
    parent: "is-67",
    description_html: `<p>${"x".repeat(600)}</p>`,
  },
  {
    id: "is-67",
    sequence_id: "67" as unknown as number,
    name: "[bug] overshoot quota",
    state: "st-todo",
    priority: "none",
    assignees: ["mb-dev2"],
    labels: ["lb-bug"],
    parent: null,
    description_html: "<p>short body</p>",
  },
];

function useDefaultRouter() {
  const ISSUE_RE = /\/projects\/[^/]+\/issues\/(is-\d+)\/$/;
  router = (_m, path, b) => {
    if (path.endsWith("/projects/")) return { status: 200, json: { results: [{ id: "pr-1", name: "Ai Tutor", identifier: "AITUT" }] } };
    if (path === "/members/") return { status: 200, json: MEMBERS };
    if (path.endsWith("/states/")) return { status: 200, json: { results: STATES } };
    if (path.endsWith("/labels/")) return { status: 200, json: { results: LABELS } };
    if (path.endsWith("/modules/")) return { status: 200, json: { results: [{ id: "mo-1", name: "CLI" }] } };
    if (/\/projects\/[^/]+\/issues\/?$/.test(path) && _m === "POST")
      return { status: 200, json: { ...(globalThis.__postBody ?? {}), id: "is-new", sequence_id: 69 } };
    if (/\/projects\/[^/]+\/issues\/$/.test(path))
      return { status: 200, json: { results: ISSUES, next_page_results: false, total_count: ISSUES.length } };
    let m = path.match(/\/work-items\/([^/]+)\/relations\/$/);
    if (m && _m === "GET") {
      const r = relsOf(m[1]!);
      return { status: 200, json: { blocking: r.blocking.map(relationEntry), blocked_by: r.blocked_by.map(relationEntry) } };
    }
    if (m && _m === "POST") {
      for (const target of (b?.issues as string[]) ?? []) addEdge(m[1]!, target);
      return { status: 201, json: [] };
    }
    m = path.match(/\/work-items\/([^/]+)\/relations\/([^/]+)\/$/);
    if (m && _m === "DELETE") {
      if (globalThis.__relationsDeleteMode === "route-404") return { status: 404, json: { error: "Page not found." } };
      if (!globalThis.__relationsDeleteEnabled) return { status: 405 };
      return removeEdgeAnyOrientation(m[1]!, m[2]!) ? { status: 204 } : { status: 404 };
    }
    const issueHit = path.match(ISSUE_RE);
    if (issueHit) {
      const issue = ISSUES.find((i) => i.id === issueHit[1])!;
      void globalThis.__method;
      return { status: 200, json: { ...issue, ...(globalThis.__patchBody ?? {}) } };
    }
    if (path.endsWith("/comments/")) return { status: 200, json: { results: globalThis.__comments } };
    return { status: 404 };
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __method: string;
  // eslint-disable-next-line no-var
  var __patchBody: Record<string, unknown> | undefined;
  // eslint-disable-next-line no-var
  var __comments: Array<Record<string, unknown>>;
  // eslint-disable-next-line no-var
  var __postBody: Record<string, unknown> | undefined;
  // eslint-disable-next-line no-var
  var __relations: Record<string, { blocking: string[]; blocked_by: string[] }> | undefined;
  // eslint-disable-next-line no-var
  var __relationsDeleteEnabled: boolean;
  // eslint-disable-next-line no-var
  var __relationsDeleteMode: "off" | "route-404";
}

globalThis.__method = "GET";
globalThis.__comments = [];
globalThis.__patchBody = undefined;
globalThis.__postBody = undefined;
globalThis.__relations = {};
globalThis.__relationsDeleteEnabled = false;
globalThis.__relationsDeleteMode = "off";

beforeEach(() => {
  calls = [];
  globalThis.__method = "GET";
  globalThis.__patchBody = undefined;
  globalThis.__comments = [];
  globalThis.__postBody = undefined;
  globalThis.__relations = {};
  globalThis.__relationsDeleteEnabled = false;
  globalThis.__relationsDeleteMode = "off";
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  process.env.PLANE_API_BASE = "http://localhost:8999/api/v1";
  process.env.PLANE_WORKSPACE = "ai-tutor";
  process.env.PLANE_PROJECT_NAME = "Ai Tutor";
  process.env.PLANE_SEAT = "dev1";
  process.env.PLANE_TOKEN = "test-token";
  process.env.PLANE_CACHE = newCachePath();
  process.env.PLANE_BACKOFF_MS = "1";
  globalThis.__comments = [
    { id: "cm-1", created_at: "2026-08-24T02:00:00Z", comment_html: "<p>second posted</p>", actor: "mb-rafael" },
    { id: "cm-0", created_at: "2026-08-24T01:00:00Z", comment_html: "<p>first note &amp; more</p>", actor: "mb-rafael" },
  ];
  useDefaultRouter();
  // @ts-ignore
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: any, init: any) => {
    const u = new URL(String(url));
    const base = `${process.env.PLANE_API_BASE!.replace("http://localhost:8999", "")}`;
    let rel = u.pathname.startsWith(base) ? u.pathname.slice(base.length) : u.pathname;
    rel = rel.replace(/^\/workspaces\/[^/]+/, "") || "/";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    globalThis.__method = init?.method ?? "POST";
    if (init?.method === "PATCH") globalThis.__patchBody = body as Record<string, unknown>;
    if (init?.method === "POST" && rel.endsWith("/comments/")) globalThis.__comments = [...(globalThis.__comments ?? []), { id: `cm-new-${globalThis.__comments.length}`, created_at: new Date(Date.now() + globalThis.__comments.length * 1000).toISOString(), comment_html: (body as any)?.comment_html ?? "", actor: "mb-dev1", parent: (body as any)?.parent ?? null }];
    if (init?.method === "POST" && rel === "/issues/") globalThis.__postBody = body as Record<string, unknown>;
    calls.push({ method: init?.method ?? "POST", path: rel, body });
    const r = router(init?.method ?? "POST", rel, body);
    const payload = r.status === 204 ? null : JSON.stringify(r.json ?? { ok: true, data: null });
    return new Response(payload, { status: r.status, headers: { "Content-Type": "application/json" } });
  }) as any);
});

afterEach(() => {
  fetchSpy.mockRestore();
  while (spies.length) spies.pop()!.mockRestore();
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

afterAll(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("auth & config", () => {
  test("no seat anywhere -> validation listing available seats", async () => {
    delete process.env.PLANE_SEAT;
    delete process.env.PLANE_TOKEN;
    let caught: any;
    try {
      await run(["whoami"]);
    } catch (e) {
      caught = e;
    }
    expect(caught.kind).toBe("validation");
    expect(String(caught.suggestion)).toContain("--seat");
  });

  test("$PLANE_TOKEN wins with tokenSource env", async () => {
    capture(console, "log");
    const d = (await run(["config"])) as Record<string, unknown>;
    expect(d.tokenSource).toBe("env");
  });

  test("config shows resolved surface without secrets", async () => {
    capture(console, "log");
    const d = (await run(["config"])) as Record<string, unknown>;
    expect(JSON.stringify(d)).not.toContain("test-token");
    expect(d.project).toBe("Ai Tutor");
  });

  test("whoami resolves exact seat member", async () => {
    capture(console, "log");
    const d = (await run(["whoami"])) as Record<string, unknown>;
    expect(d).toEqual({ seat: "dev1", name: "dev1", email: "dev1-aitutor@x" });
  });
});

describe("PC4 — disk cache persists across invocations", () => {
  test("warm cache skips project/states/labels/member lookups entirely", async () => {
    const cache = new Cache(process.env.PLANE_CACHE!);
    cache.set(`project:Ai Tutor`, "pr-1");
    cache.set("states", Object.fromEntries(STATES.map((s) => [s.name.toLowerCase().replace("in progress", "progress").replace("awaiting verification", "verify"), s.id])));
    cache.set("labels", Object.fromEntries(LABELS.map((l) => [l.name, l.id])));
    cache.set("members", Object.fromEntries(MEMBERS.map((m) => [m.id, m.display_name])));
    cache.set("member:dev1", "mb-dev1");
    cache.set("seqmap", { "66": "is-66", "67": "is-67" });
    cache.set("relmap", { "is-66": { b: [], f: [] }, "is-67": { b: [], f: [] } });
    cache.save();
    const before = calls.length;
    const d = (await run(["get", "HT-66", "--fields", "id"])) as Record<string, unknown>;
    expect(d.id).toBe("HT-66");
    const warmupCalls = calls.slice(before).filter((c) => !c.path.includes("/issues/is-66"));
    expect(warmupCalls).toEqual([]);
  });

  test("corrupt cache file recovers silently", () => {
    writeFileSync(process.env.PLANE_CACHE!, "{not json");
    const c = new Cache(process.env.PLANE_CACHE!);
    expect(c.fresh("anything")).toBeUndefined();
  });

  test("IMP-B exit-path save persists: second PROCESS makes no warmup fetches", async () => {
    const seen: string[] = [];
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        let rel = `${u.pathname}${u.search}`.replace(/^\/api\/v1/, "").replace(/^\/workspaces\/[^/]+/, "");
        const path = rel.split("?")[0]!;
        seen.push(path);
        const j = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
        if (path === "/projects/") return j({ results: [{ id: "pr-1", name: "Ai Tutor" }] });
        if (path === "/members/") return j(MEMBERS);
        if (path.endsWith("/states/")) return j({ results: STATES });
        if (path.endsWith("/labels/")) return j({ results: LABELS });
        if (/\/issues\/$/.test(path)) return j({ results: ISSUES, next_page_results: false });
        if (/\/issues\/is-\d+\/$/.test(path)) return j(ISSUES[0]);
        if (/\/work-items\/[^/]+\/relations\/$/.test(path)) return j({ blocking: [], blocked_by: [] });
        return new Response("{}", { status: 404 });
      },
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "plane-subproc-"));
      tmpDirs.push(dir);
      const cachePath = join(dir, "cache.json");
      const baseEnv = {
        ...process.env,
        PLANE_API_BASE: `http://localhost:${srv.port}/api/v1`,
        PLANE_WORKSPACE: "ai-tutor",
        PLANE_PROJECT_NAME: "Ai Tutor",
        HOMETUTOR_TICKETS_PROJECT_ID: "",
        PLANE_SEAT: "dev1",
        PLANE_TOKEN: "t",
        PLANE_CACHE: cachePath,
        PLANE_NO_PULL: "1",
        PLANE_BACKOFF_MS: "1",
      };
      const bin = join(import.meta.dir, "..", "bin", "plane");
      const spawnGet = async () => {
        const proc = Bun.spawn([bin, "get", "HT-66", "--fields", "id"], { env: baseEnv as any, cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        return { code: await proc.exited, out, err };
      };
      const r1 = await spawnGet();
      console.log("SEEN", JSON.stringify(seen));
      expect(r1.code).toBe(0);
      const afterRun1 = seen.length;
      expect(afterRun1).toBeGreaterThan(1);
      const r2 = await spawnGet();
      expect(r2.code).toBe(0);
      const run2Calls = seen.slice(afterRun1);
      expect(run2Calls.every((p) => p.includes("/issues/is-66"))).toBeTrue();
      expect(r2.out).toContain("HT-66");
    } finally {
      srv.stop(true);
    }
  });

  test("HOMETUTOR_TICKETS_PROJECT_ID skips project discovery entirely", async () => {
    process.env.HOMETUTOR_TICKETS_PROJECT_ID = "pr-explicit";
    const before = calls.length;
    await run(["get", "HT-66", "--fields", "id"]);
    expect(calls.slice(before).some((c) => c.path === "/projects/")).toBeFalse();
  });
});

describe("cache.ts", () => {
  test("fresh honors per-key TTL; stale returns regardless", () => {
    const c = new Cache(join(tmpdir(), `cache-ttl-${Date.now()}.json`));
    c.set("seqmap", { "1": "x" });
    expect(c.fresh("seqmap")).toBeDefined();
    c.data["seqmap"]!.at = Date.now() - 301_000;
    expect(c.fresh("seqmap")).toBeUndefined();
    expect(c.stale("seqmap")).toBeDefined();
    c.set("members", { a: "b" });
    c.data["members"]!.at = Date.now() - 3600_000 * 23;
    expect(c.fresh("members")).toBeDefined();
  });

  test("save is atomic-rename and reloadable; bare filename works", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-save-"));
    tmpDirs.push(dir);
    const p = join(dir, "nested", "cache.json");
    const c = new Cache(p);
    c.set("states", { todo: "t" });
    c.save();
    expect(existsSync(p)).toBeTrue();
    expect(new Cache(p).fresh("states")).toEqual({ todo: "t" });
    const bare = new Cache("plane-cache-tmp.json");
    bare.set("project:x", "y");
    bare.save();
    expect(existsSync("plane-cache-tmp.json")).toBeTrue();
    rmSync("plane-cache-tmp.json");
  });
});

describe("get", () => {
  test("flagship documented invocation get HT-N --comments works (PC1)", async () => {
    const d = (await run(["get", "HT-66", "--comments"])) as Record<string, any>;
    expect(d.id).toBe("HT-66");
    const cs = d.comments as Array<Record<string, unknown>>;
    expect(cs.map((c) => c.n)).toEqual(["c1", "c2"]);
    expect(cs[0]!.text).toContain("first note & more");
  });

  test("shapes short names, caps description, resolves parent via index", async () => {
    const d = (await run(["get", "HT-66"])) as Record<string, any>;
    expect(d.state).toBe("progress");
    expect(d.labels).toEqual(["type:plan"]);
    expect(d.priority).toBe("high");
    expect(d.parent).toBe("HT-67");
    expect(String(d.description)).toContain("(+");
  });

  test("--full uncaps description; --raw returns native payload", async () => {
    const d = (await run(["get", "HT-66", "--full", "--fields", "description"])) as Record<string, unknown>;
    expect(String(d.description)).not.toContain("(+");
    const raw = (await run(["get", "HT-66", "--raw"])) as Record<string, unknown>;
    expect(raw.id).toBe("is-66");
  });

  test("priority none renders null", async () => {
    const d = (await run(["get", "HT-67", "--fields", "priority"])) as Record<string, unknown>;
    expect(d.priority).toBeNull();
  });

  test("untranslated ids render as short prefixed forms, never raw uuids (PI-11 + r2 minor)", async () => {
    const d = (await run(["get", "HT-66", "--fields", "assignees,labels,state,parent"])) as Record<string, any>;
    expect(d.assignees).toEqual(["dev1"]);
    expect(d.labels).toEqual(["type:plan"]);
    expect(d.state).toBe("progress");
    expect(d.parent).toBe("HT-67");
    expect(JSON.stringify(d)).not.toMatch(/(is|mb|lb|st)-[0-9a-f]{6,}/);

    const cache = new Cache(process.env.PLANE_CACHE!);
    cache.set("states", { todo: "st-todo" });
    cache.set("seqmap", { "66": "is-66" });
    cache.save();
    const d2 = (await run(["get", "HT-66", "--fields", "state,parent"])) as Record<string, any>;
    expect(String(d2.state)).toMatch(/^state:/);
    expect(String(d2.parent)).toMatch(/^page:/);
    expect(JSON.stringify(d2)).not.toMatch(/(is|mb|lb|st)-[0-9a-f]{6,}/);
  });
});

describe("list", () => {
  test("cursor pagination is followed and rows are deduped (legacy page= ignored by instance)", async () => {
    const row = (n: number) => ({ id: `is-${n}`, sequence_id: n, name: `t${n}`, state: "st-todo", priority: "none", assignees: [], labels: [], parent: null });
    // harness strips query strings, so branch on call count: call 1 = page 1
    // (hostile: duplicate rows + next_cursor), call 2 = cursor page 2.
    let issueListCalls = 0;
    router = (_m, path) => {
      if (path.endsWith("/projects/")) return { status: 200, json: { results: [{ id: "pr-1", name: "Ai Tutor", identifier: "AITUT" }] } };
      if (path === "/members/") return { status: 200, json: MEMBERS };
      if (/\/work-items\/[^/]+\/relations\/$/.test(path)) return { status: 200, json: { blocking: [], blocked_by: [] } };
      if (/\/projects\/[^/]+\/issues\/$/.test(path)) {
        issueListCalls++;
        if (issueListCalls === 1)
          return { status: 200, json: { results: [row(100), row(100), row(67)], next_page_results: true, next_cursor: "1000:1:0" } };
        return { status: 200, json: { results: [row(101)], next_page_results: false } };
      }
      if (/\/projects\/[^/]+\/issues\/is-\d+\/$/.test(path)) return { status: 200, json: ISSUES[0] };
      if (path.endsWith("/states/")) return { status: 200, json: { results: STATES } };
      if (path.endsWith("/labels/")) return { status: 200, json: { results: LABELS } };
      return { status: 404 };
    };
    const d = (await run(["list"])) as Record<string, any>;
    expect(d.items.filter((i: any) => i.id === "HT-100").length).toBe(1);
    expect(d.items.map((i: any) => i.id)).toEqual(["HT-100", "HT-67", "HT-101"]);
    expect(issueListCalls).toBe(2);
  });

  test("filters by me via exact member match", async () => {
    const d = (await run(["list", "--assignee", "me"])) as Record<string, any>;
    expect(d.total).toBe(1);
    expect(d.items[0]!.id).toBe("HT-66");
  });

  test("state filter accepts backlog too", async () => {
    const d = (await run(["list", "--state", "todo"])) as Record<string, any>;
    expect(d.total).toBe(1);
    expect(d.items[0]!.id).toBe("HT-67");
  });

  test("invalid page is a loud usage error", async () => {
    await expect(run(["list", "--page", "abc"])).rejects.toMatchObject({ kind: "validation" });
    await expect(run(["list", "--page", "0"])).rejects.toMatchObject({ kind: "validation" });
  });

  test("parent filter matches uuid under the hood", async () => {
    const d = (await run(["list", "--parent", "HT-67"])) as Record<string, any>;
    expect(d.total).toBe(1);
    expect(d.items[0]!.id).toBe("HT-66");
  });
});

describe("claim", () => {
  test("appends assignee and sends state key with exact body (never state_id)", async () => {
    const d = (await run(["claim", "67"])) as Record<string, unknown>;
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toEqual({ assignees: ["mb-dev2", "mb-dev1"], state: "st-progress" });
    expect(JSON.stringify(patch.body)).not.toContain("state_id");
    expect(d).toMatchObject({ id: "HT-67", state: "progress", changed: true });
    expect("commentPosted" in d).toBeFalse();
  });

  test("idempotent re-claim makes no writes and reports changed:false", async () => {
    await run(["claim", "66"]);
    const n = calls.filter((c) => c.method !== "GET").length;
    const d = (await run(["claim", "66"])) as Record<string, unknown>;
    expect(d.changed).toBe(false);
    expect(calls.filter((c) => c.method !== "GET").length).toBe(n);
  });

  test("retry with --comment does not duplicate the comment (PI-2)", async () => {
    await run(["claim", "67", "--comment", "starting"]);
    const postsAfterFirst = calls.filter((c) => c.path.endsWith("/comments/")).length;
    const d = (await run(["claim", "67", "--comment", "starting"])) as Record<string, unknown>;
    expect(d.changed).toBe(false);
    expect(d.commentPosted).toBe(false);
    expect(calls.filter((c) => c.path.endsWith("/comments/")).length).toBe(postsAfterFirst);
  });

  test("fresh claim with comment posts exactly once", async () => {
    const d = (await run(["claim", "67", "--comment", "starting impl"])) as Record<string, unknown>;
    expect(d.commentPosted).toBe(true);
    expect(calls.find((c) => c.path.endsWith("/comments/"))!.body).toMatchObject({ comment_html: "<p>starting impl</p>" });
  });

  test("post-PATCH verification reflects server-side roster (PI-6)", async () => {
    globalThis.__patchBody = { assignees: ["mb-dev1"] };
    const d = (await run(["claim", "67"])) as Record<string, unknown>;
    expect(Array.isArray(d.assignees)).toBeTrue();
  });

  test("dry-run prints the exact would-be request and stops", async () => {
    const before = calls.length;
    const d = (await run(["claim", "67", "--dry-run"])) as Record<string, any>;
    expect(calls.filter((c) => c.method !== "GET").length).toBe(0);
    void before;
    expect(d.requests[0]).toEqual({
      method: "PATCH",
      url: expect.stringContaining("/issues/is-67/"),
      body: { assignees: ["mb-dev2", "mb-dev1"], state: "st-progress" },
    });
  });
});

describe("state", () => {
  test("invalid state enumerates the valid set", async () => {
    await expect(run(["state", "HT-66", "in-prog"])).rejects.toMatchObject({
      kind: "validation",
      valid: ["todo", "progress", "verify", "done", "cancelled"],
    });
  });

  test("transitions with exact body; board drift fails loud with sync hint (PC2)", async () => {
    const d = (await run(["state", "HT-67", "verify"])) as Record<string, unknown>;
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ state: "st-verify" });
    expect(d.changed).toBe(true);

    const cache = new Cache(process.env.PLANE_CACHE!);
    cache.set("states", { todo: "st-todo", backlog: "st-backlog" });
    cache.save();
    await expect(run(["state", "HT-67", "progress"])).rejects.toMatchObject({
      kind: "not-found",
      message: expect.stringContaining("'progress'"),
      suggestion: "plane sync then retry",
    });
  });

  test("same-state close-out still posts the comment and reports both flags", async () => {
    const d = (await run(["state", "HT-67", "todo", "--comment", "branch feature/x @ sha"])) as Record<string, unknown>;
    expect(d.changed).toBe(false);
    expect(d.commentPosted).toBe(true);
    expect(calls.some((c) => c.method === "PATCH")).toBeFalse();
  });

  test("dry-run fidelity: no-op state emits no PATCH (PI-3)", async () => {
    const d = (await run(["state", "HT-67", "todo", "--dry-run"])) as Record<string, any>;
    expect(calls.filter((c) => c.method !== "GET").length).toBe(0);
    expect(d.requests).toEqual([]);
    const d2 = (await run(["state", "HT-67", "verify", "--comment", "x", "--dry-run"])) as Record<string, any>;
    expect(d2.requests).toHaveLength(2);
    expect(d2.requests[0]!.body).toEqual({ state: "st-verify" });
  });
});

describe("comments / reply / comment", () => {
  test("thread numbers are oldest-first even with shuffled storage order", async () => {
    const d = (await run(["comments", "HT-66"])) as Record<string, any>;
    expect(d.comments.map((c: any) => c.text)).toEqual(["first note & more", "second posted"]);
  });

  test("reply targets the parent comment uuid and escapes html", async () => {
    const d = (await run(["reply", "HT-66", "c2", "<script>alert(1)</script> fixed"])) as Record<string, unknown>;
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/comments/"))!;
    expect(post.body).toMatchObject({ parent: "cm-1", comment_html: "<p>&lt;script&gt;alert(1)&lt;/script&gt; fixed</p>" });
    expect(d.replyTo).toBe("c2");
  });

  test("reply to missing handle suggests re-list", async () => {
    await expect(run(["reply", "HT-66", "c9", "x"])).rejects.toMatchObject({ kind: "not-found", valid: ["c1", "c2"] });
  });

  test("comment --file reads from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plane-cmt-"));
    tmpDirs.push(dir);
    const f = join(dir, "note.md");
    await Bun.write(f, "from file\n\nsecond para");
    await run(["comment", "HT-66", "--file", f]);
    expect(calls.find((c) => c.path.endsWith("/comments/"))!.body).toMatchObject({
      comment_html: "<p>from file</p><p>second para</p>",
    });
  });
});

describe("create / sub", () => {
  test("posts exact typed payload with state key and real label id", async () => {
    const d = (await run(["create", "--title", "[ops] x", "--type", "bug", "--priority", "high", "--body", "<p>b</p>"])) as Record<string, unknown>;
    const post = calls.find((c) => c.method === "POST" && /\/projects\/[^/]+\/issues\/?$/.test(c.path));
    expect(post!.body).toEqual({
      name: "[ops] x",
      description_html: "<p>b</p>",
      state: "st-todo",
      label_ids: ["lb-bug"],
      priority: "high",
    });
    expect(d.id).toBe("HT-69");
  });

  test("sub resolves parent uuid into the payload", async () => {
    await run(["sub", "HT-66", "--title", "child", "--type", "ops", "--body", "<p>c</p>"]);
    expect(calls.find((c) => c.method === "POST" && /\/projects\/[^/]+\/issues\/?$/.test(c.path))!.body).toMatchObject({ parent: "is-66" });
  });

  test("label not on the board fails loud listing live labels (PC3)", async () => {
    let caught: any;
    try {
      await run(["create", "--title", "t", "--type", "spike", "--body", "<p>t</p>"]);
    } catch (e) {
      caught = e;
    }
    expect(caught.kind).toBe("not-found");
    expect(caught.valid).toEqual(["type:bug", "type:feature", "type:ops", "type:plan"]);
    expect(caught.suggestion).toBe("plane sync then retry");
    expect(calls.some((c) => c.method === "POST" && /\/projects\/[^/]+\/issues\/?$/.test(c.path))).toBeFalse();
  });

  test("invalid priority enumerates the scale", async () => {
    await expect(run(["create", "--title", "t", "--type", "bug", "--priority", "P0"])).rejects.toMatchObject({
      valid: ["urgent", "high", "medium", "low"],
    });
  });

  test("--body-file and --body-md load content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plane-body-"));
    tmpDirs.push(dir);
    const html = join(dir, "b.html");
    const md = join(dir, "b.md");
    await Bun.write(html, "<p>H</p>");
    await Bun.write(md, "# Head\n\npara one");
    await run(["create", "--title", "h", "--type", "ops", "--body-file", html]);
    await run(["create", "--title", "m", "--type", "ops", "--body-md", md]);
    const posts = calls.filter((c) => c.method === "POST" && /\/projects\/[^/]+\/issues\/?$/.test(c.path));
    expect(posts[0]!.body).toMatchObject({ description_html: "<p>H</p>" });
    expect(posts[1]!.body).toMatchObject({ description_html: "<p># Head</p><p>para one</p>" });
  });

  test("dry-run create shows the POST without sending", async () => {
    const before = calls.length;
    const d = (await run(["create", "--title", "dr", "--type", "bug", "--body", "<p>x</p>", "--dry-run"])) as Record<string, any>;
    expect(calls.filter((c) => c.method !== "GET").length).toBe(0);
    void before;
    expect(d.dryRun).toBe(true);
    expect(d.requests[0]!.method).toBe("POST");
  });
});

describe("states / labels / modules lookups (PC5)", () => {
  test("states lists tokens with ids", async () => {
    const d = (await run(["states"])) as Record<string, any>;
    expect(d.states[0]).toEqual({ token: "backlog", id: "st-backlog" });
    expect(d.states.find((s: any) => s.token === "progress")).toBeDefined();
  });

  test("labels lists names with ids", async () => {
    const d = (await run(["labels"])) as Record<string, any>;
    expect(d.labels[0]).toEqual({ name: "type:bug", id: "lb-bug" });
  });

  test("modules lists module names", async () => {
    const d = (await run(["modules"])) as Record<string, any>;
    expect(d.modules).toEqual([{ name: "CLI", id: "mo-1" }]);
  });
});

describe("sync", () => {
  test("rebuilds every cached namespace and reports counts", async () => {
    const d = (await run(["sync"])) as Record<string, unknown>;
    expect(d).toEqual({ project: "Ai Tutor", states: 6, labels: 4, tickets: 2, edges: 0, edgeErrors: 0 });
  });

  test("refreshes relations into the cache so short handles render offline", async () => {
    addEdge("is-67", "is-66");
    const d = (await run(["sync"])) as Record<string, unknown>;
    expect(d.edges).toBe(1);
    expect(d.edgeErrors).toBe(0);
    const c = peekCache()!;
    const relmap = c.fresh("relmap") as Record<string, { b: string[]; f: string[] }>;
    expect(relmap["is-67"]).toEqual({ b: [], f: ["is-66"] });
    expect(relmap["is-66"]).toEqual({ b: ["is-67"], f: [] });
  });

  test("rate-limited relation lookups are skipped (no zero-poison) and reported", async () => {
    addEdge("is-67", "is-66");
    // seed a previous good entry the walk must NOT lose
    const seed = new Cache(process.env.PLANE_CACHE!);
    seed.set("relmap", { "is-66": { b: ["is-67"], f: [] } });
    seed.save();
    let n = 0;
    router = (_m, path) => {
      if (/\/work-items\/([^/]+)\/relations\/$/.test(path)) {
        n++;
        if (n === 1 && path.includes("is-67")) return { status: 200, json: { blocking: ["is-66"], blocked_by: [] } };
        if (path.includes("is-67")) return { status: 200, json: { blocking: ["is-66"], blocked_by: [] } };
        return { status: 429 };
      }
      if (path.endsWith("/projects/")) return { status: 200, json: { results: [{ id: "pr-1", name: "Ai Tutor", identifier: "AITUT" }] } };
      if (path === "/members/") return { status: 200, json: MEMBERS };
      if (/\/projects\/[^/]+\/issues\/$/.test(path)) return { status: 200, json: { results: ISSUES, next_page_results: false } };
      if (path.endsWith("/states/")) return { status: 200, json: { results: STATES } };
      if (path.endsWith("/labels/")) return { status: 200, json: { results: LABELS } };
      return { status: 404 };
    };
    const d = (await run(["sync"])) as Record<string, any>;
    expect(d.edgeErrors).toBe(1);
    const c = peekCache()!;
    const relmap = c.fresh("relmap") as Record<string, { b: string[]; f: string[] }>;
    expect(relmap["is-67"]).toEqual({ b: [], f: ["is-66"] }); // fresh from this walk
    expect(relmap["is-66"]).toEqual({ b: ["is-67"], f: [] }); // preserved from before
  });
});

describe("blocks / depends / unblocks", () => {
  async function kindOf(args: string[]): Promise<{ kind?: string; exitCode?: number; message?: string; valid?: string[]; suggestion?: string }> {
    try {
      await run(args);
      return {};
    } catch (e: any) {
      return { kind: e.kind, exitCode: e.exitCode, message: e.message, valid: e.valid, suggestion: e.suggestion };
    }
  }

  test("blocks posts the exact native payload on the blocker's relations endpoint", async () => {
    const d = (await run(["blocks", "HT-66", "HT-67"])) as Record<string, unknown>;
    expect(d).toEqual({ ok: true, edge: "HT-66->HT-67", changed: true });
    const post = calls.find((c) => c.method === "POST" && c.path.includes("/relations/"))!;
    expect(post.path).toContain("/work-items/is-66/relations/");
    expect(post.body).toEqual({ relation_type: "blocking", issues: ["is-67"] });
  });

  test("depends HT-B HT-A is the same directed edge as blocks HT-A HT-B", async () => {
    const d = (await run(["depends", "HT-67", "HT-66"])) as Record<string, unknown>;
    expect(d).toMatchObject({ edge: "HT-66->HT-67", changed: true });
    const post = calls.find((c) => c.method === "POST" && c.path.includes("/relations/"))!;
    expect(post.path).toContain("/work-items/is-66/relations/");
    expect(post.body).toEqual({ relation_type: "blocking", issues: ["is-67"] });
  });

  test("re-creating an existing edge is idempotent: changed:false, zero writes", async () => {
    await run(["blocks", "HT-66", "HT-67"]);
    const writes = calls.filter((c) => c.method !== "GET").length;
    const d = (await run(["blocks", "HT-66", "HT-67"])) as Record<string, unknown>;
    expect(d).toEqual({ ok: true, edge: "HT-66->HT-67", changed: false });
    expect(calls.filter((c) => c.method !== "GET").length).toBe(writes);
  });

  test("unblocks removes the edge via DELETE and reports changed:true", async () => {
    globalThis.__relationsDeleteEnabled = true;
    addEdge("is-66", "is-67");
    const d = (await run(["unblocks", "HT-66", "HT-67"])) as Record<string, unknown>;
    expect(d).toEqual({ ok: true, edge: "HT-66->HT-67", changed: true });
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.path).toBe("/projects/pr-1/work-items/is-66/relations/is-67/");
    expect(relsOf("is-66").blocking).toEqual([]);
    expect(relsOf("is-67").blocked_by).toEqual([]);
  });

  test("unblocks a missing edge is idempotent: changed:false, no DELETE sent", async () => {
    globalThis.__relationsDeleteEnabled = true;
    const d = (await run(["unblocks", "HT-66", "HT-67"])) as Record<string, unknown>;
    expect(d).toEqual({ ok: true, edge: "HT-66->HT-67", changed: false });
    expect(calls.some((c) => c.method === "DELETE")).toBeFalse();
  });

  test("pre-patch instance fails loud with fork/UI guidance (405 and route-404 modes)", async () => {
    addEdge("is-66", "is-67");
    const e = await kindOf(["unblocks", "HT-66", "HT-67"]);
    expect(e.kind).toBe("api");
    expect(e.message).toContain("relation DELETE");
    expect(String(e.suggestion)).toContain("plane-fork");

    // trial-style: DELETE route itself 404s instead of method-405
    globalThis.__relationsDeleteMode = "route-404";
    const e2 = await kindOf(["unblocks", "HT-66", "HT-67"]);
    expect(e2.kind).toBe("api");
    expect(e2.message).toContain("relation DELETE");
    globalThis.__relationsDeleteMode = "off";
  });

  test("self-edge rejected with validation exit 4 before any network call", async () => {
    const e = await kindOf(["blocks", "HT-66", "66"]);
    expect(e).toMatchObject({ kind: "validation", exitCode: 4, message: expect.stringContaining("self-edge") });
    expect(calls.filter((c) => c.method !== "GET").length).toBe(0);
    const e2 = await kindOf(["depends", "HT-66", "HT-66"]);
    expect(e2.kind).toBe("validation");
  });

  test("malformed refs are validation errors", async () => {
    const e = await kindOf(["blocks", "HT-six", "HT-66"]);
    expect(e).toMatchObject({ kind: "validation", exitCode: 4 });
    expect(calls.filter((c) => c.method !== "GET").length).toBe(0);
  });

  test("arity is exactly two: missing and extra refs both fail loud", async () => {
    expect(await kindOf(["blocks", "HT-66"])).toMatchObject({ kind: "validation" });
    expect(await kindOf(["blocks", "HT-66", "HT-67", "HT-68"])).toMatchObject({ kind: "validation", message: expect.stringContaining("ambiguous") });
    expect(calls.filter((c) => c.method !== "GET").length).toBe(0);
  });

  test("unknown handle -> not-found exit 3 with nearest matches from the ticket index", async () => {
    await run(["list"]); // warm seqmap cache like production
    const before = calls.length;
    const e = await kindOf(["blocks", "HT-70", "HT-66"]);
    expect(e).toMatchObject({ kind: "not-found", exitCode: 3, message: expect.stringContaining("HT-70") });
    expect(e.valid).toEqual(["HT-67", "HT-66"]);
    expect(calls.length).toBeGreaterThan(before);
  });

  test("--dry-run prints exact would-be requests and mutates nothing", async () => {
    const d = (await run(["blocks", "HT-66", "HT-67", "--dry-run"])) as Record<string, any>;
    expect(d.dryRun).toBe(true);
    expect(d.requests[0]).toEqual({
      method: "POST",
      url: expect.stringContaining("/work-items/is-66/relations/"),
      body: { relation_type: "blocking", issues: ["is-67"] },
    });
    addEdge("is-66", "is-67");
    const d2 = (await run(["unblocks", "HT-66", "HT-67", "--dry-run"])) as Record<string, any>;
    expect(d2.requests[0]!.method).toBe("DELETE");
    expect(d2.requests[0]!.url).toContain("/work-items/is-66/relations/is-67/");
    expect(calls.filter((c) => c.method !== "GET").length).toBe(0);
    expect(relsOf("is-66").blocking).toEqual(["is-67"]);
  });

  test("acceptance shape: blocks HT-151 HT-184 then get HT-184 --fields blockedBy => [HT-151]", async () => {
    // same mechanics as the live acceptance pair, exercised on fixture tickets
    await run(["blocks", "HT-66", "HT-67"]);
    const c = new Cache(process.env.PLANE_CACHE!);
    c.set("relmap", { "is-67": { b: ["is-66"], f: [] }, "is-66": { b: [], f: ["is-67"] } });
    c.set("seqmap", { "66": "is-66", "67": "is-67" });
    c.save();
    const g = (await run(["get", "HT-67", "--fields", "blockedBy"])) as Record<string, unknown>;
    expect(g.blockedBy).toEqual(["HT-66"]);
  });
});

describe("edge read side", () => {
  test("get renders blockedBy/blocks as short handles; empty arrays fine", async () => {
    addEdge("is-67", "is-66"); // HT-67 blocks HT-66
    const g66 = (await run(["get", "HT-66", "--fields", "id,blockedBy,blocks"])) as Record<string, any>;
    expect(g66.blockedBy).toEqual(["HT-67"]);
    expect(g66.blocks).toEqual([]);
    const g67 = (await run(["get", "HT-67", "--fields", "blockedBy,blocks"])) as Record<string, any>;
    expect(g67.blockedBy).toEqual([]);
    expect(g67.blocks).toEqual(["HT-66"]);
  });

  test("get default output carries empty relation arrays without noise", async () => {
    const d = (await run(["get", "HT-66"])) as Record<string, any>;
    expect(d.blockedBy).toEqual([]);
    expect(d.blocks).toEqual([]);
  });

  test("untranslated edge uuids render with short edge: prefix, never raw uuids", async () => {
    const c = new Cache(process.env.PLANE_CACHE!);
    c.set("states", Object.fromEntries(STATES.map((s) => [s.id, s.name.toLowerCase() === "in progress" ? "progress" : s.name.toLowerCase().split(" ")[0]!])));
    c.set("labels", Object.fromEntries(LABELS.map((l) => [l.name, l.id])));
    c.set("seqmap", { "66": "is-66" });
    c.set("relmap", { "is-66": { b: ["zzzzzzzz-0000-0000-0000-000000000000"], f: [] } });
    c.save();
    const d = (await run(["get", "HT-66", "--fields", "blockedBy"])) as Record<string, any>;
    expect(d.blockedBy).toEqual(["edge:zzzzzzzz"]);
    expect(JSON.stringify(d)).not.toMatch(/zzzzzzzz-0000/);
  });

  test("relations entries in upstream shape ({id}) parse too, not just live {issue_id}", async () => {
    router = relationsShapeRouter({ blocking: [{ id: "is-67" }], blocked_by: [] });
    const d = (await run(["get", "HT-66", "--fields", "blocks"])) as Record<string, any>;
    expect(d.blocks).toEqual(["HT-67"]);
  });

  test("relations entries as bare uuid strings (commercial trial shape) parse too", async () => {
    router = relationsShapeRouter({ blocking: ["is-67"], blocked_by: [] });
    const d = (await run(["get", "HT-66", "--fields", "blocks"])) as Record<string, any>;
    expect(d.blocks).toEqual(["HT-67"]);
  });

  test("list --blocked-by HT-N lists tickets N blocks (what can start now)", async () => {
    addEdge("is-66", "is-67"); // HT-66 blocks HT-67
    const d = (await run(["list", "--blocked-by", "HT-66"])) as Record<string, any>;
    expect(d.total).toBe(1);
    expect(d.items[0]!.id).toBe("HT-67");
  });

  test("list --blocked-by composes with other filters and rejects unknown handles", async () => {
    addEdge("is-66", "is-67");
    const none = (await run(["list", "--blocked-by", "HT-67"])) as Record<string, any>;
    expect(none.total).toBe(0);
    await expect(run(["list", "--blocked-by", "HT-999"])).rejects.toMatchObject({ kind: "not-found", exitCode: 3 });
  });
});

describe("error taxonomy", () => {
  async function kindOf(args: string[]): Promise<{ kind?: string; exitCode?: number; message?: string }> {
    try {
      await run(args);
      return {};
    } catch (e: any) {
      return { kind: e.kind, exitCode: e.exitCode, message: e.message };
    }
  }

  test("403 -> auth exit 2", async () => {
    router = () => ({ status: 403 });
    const e = await kindOf(["list"]);
    expect(e).toMatchObject({ kind: "auth", exitCode: 2 });
  });

  test("400 with ok:false -> validation carrying message", async () => {
    router = () => ({ status: 400, json: { ok: false, error: "bad payload" } });
    const e = await kindOf(["get", "HT-66"]);
    expect(e.kind).toBe("validation");
    expect(e.message).toContain("bad payload");
  });

  test("422 -> validation", async () => {
    router = () => ({ status: 422, json: {} });
    const e = await kindOf(["get", "HT-66"]);
    expect(e.kind).toBe("validation");
  });

  test("persistent 500 -> retried x3 then network", async () => {
    let n = 0;
    router = () => {
      n++;
      return { status: 502 };
    };
    const e = await kindOf(["get", "HT-66"]);
    expect(e.kind).toBe("network");
    expect(n).toBe(4);
  });

  test("persistent 429 -> rate-limit after initial+3", async () => {
    let n = 0;
    router = () => {
      n++;
      return { status: 429 };
    };
    const e = await kindOf(["list"]);
    expect(e.kind).toBe("rate-limit");
    expect(n).toBe(4);
  });

  test("network throw -> network kind", async () => {
    // @ts-ignore
    fetchSpy.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const e = await kindOf(["list"]);
    expect(e.kind).toBe("network");
  });

  test("timeout -> network kind naming the endpoint", async () => {
    // @ts-ignore
    fetchSpy.mockImplementation(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const e = await kindOf(["list"]);
    expect(e.kind).toBe("network");
  });
});

describe("parser contract", () => {
  test("boolean flags reject inline values (minor/C1-class)", async () => {
    await expect(run(["get", "HT-66", "--full=false"])).rejects.toMatchObject({
      kind: "validation",
      message: expect.stringContaining("boolean flag"),
    });
  });

  test("unknown flag enumerates the flag set", async () => {
    await expect(run(["get", "HT-66", "--commentss"])).rejects.toMatchObject({ valid: expect.any(Array) });
  });

  test("unknown verb is validation-kind with the verb list", async () => {
    await expect(run(["frobnicate"])).rejects.toMatchObject({ kind: "validation", valid: expect.arrayContaining(["claim"]) });
  });
});

describe("identifier-aware refs (TC-17)", () => {
  const TC_STATES = [
    { id: "st2-backlog", name: "Backlog" },
    { id: "st2-todo", name: "Todo" },
    { id: "st2-progress", name: "In Progress" },
    { id: "st2-done", name: "Done" },
    { id: "st2-cancelled", name: "Cancelled" },
    { id: "st2-verify", name: "Awaiting verification" },
  ];
  const TC_LABELS = [
    { id: "lb2-bug", name: "type:bug" },
    { id: "lb2-feature", name: "type:feature" },
    { id: "lb2-ops", name: "type:ops" },
    { id: "lb2-plan", name: "type:plan" },
  ];
  const TC_ISSUES = [
    { id: "tc-16", sequence_id: 16, name: "fleet ticket", state: "st2-todo", priority: "low", assignees: [], labels: ["lb2-plan"], parent: null, description_html: "<p>tc16</p>" },
    { id: "tc-17", sequence_id: 17, name: "the TC-17 subject", state: "st2-todo", priority: "urgent", assignees: [], labels: ["lb2-bug"], parent: null, description_html: "<p>tc17</p>" },
  ];
  const INFRA_ISSUES = [
    { id: "in-3", sequence_id: 3, name: "infra ticket", state: "st-todo", priority: "none", assignees: [], labels: [], parent: null, description_html: "<p>in3</p>" },
  ];
  const XT_ISSUES = [
    { id: "xt-2", sequence_id: 2, name: "x tools ticket", state: "st-todo", priority: "none", assignees: [], labels: [], parent: null, description_html: "<p>xt2</p>" },
  ];
  const EGG_ISSUES = [
    { id: "eg-5", sequence_id: 5, name: "egg farm ticket", state: "st-todo", priority: "none", assignees: [], labels: [], parent: null, description_html: "<p>eg5</p>" },
  ];

  function useProjectsRouter() {
    router = (_m, path, b) => {
      if (path.endsWith("/projects/")) return { status: 200, json: { results: [{ id: "pr-1", name: "Ai Tutor", identifier: "HT" }, { id: "pr-2", name: "Teamctl", identifier: "TC" }, { id: "pr-3", name: "Infra", identifier: "INFRA" }, { id: "pr-4", name: "X Tools", identifier: "XT" }, { id: "pr-5", name: "FreshFarmEggs", identifier: "EGG" }], next_page_results: false } };
      if (path === "/members/") return { status: 200, json: MEMBERS };
      if (path.endsWith("/states/")) return { status: 200, json: { results: path.includes("pr-2") ? TC_STATES : STATES } };
      if (path.endsWith("/labels/")) return { status: 200, json: { results: path.includes("pr-2") ? TC_LABELS : LABELS } };
      if (path.endsWith("/modules/")) return { status: 200, json: { results: [] } };
      if (/\/projects\/pr-1\/issues\/$/.test(path)) return { status: 200, json: { results: ISSUES, next_page_results: false } };
      if (/\/projects\/pr-2\/issues\/$/.test(path) && _m === "POST") return { status: 200, json: { ...(b as any), id: "tc-18", sequence_id: 18 } };
      if (/\/projects\/pr-2\/issues\/$/.test(path)) return { status: 200, json: { results: TC_ISSUES, next_page_results: false } };
      if (/\/projects\/pr-3\/issues\/$/.test(path)) return { status: 200, json: { results: INFRA_ISSUES, next_page_results: false } };
      if (/\/projects\/pr-4\/issues\/$/.test(path)) return { status: 200, json: { results: XT_ISSUES, next_page_results: false } };
      if (/\/projects\/pr-5\/issues\/$/.test(path)) return { status: 200, json: { results: EGG_ISSUES, next_page_results: false } };
      const issueHit = path.match(/\/projects\/([^/]+)\/issues\/([^/]+)\/$/);
      if (issueHit) {
        const pool = issueHit[1] === "pr-2" ? TC_ISSUES : issueHit[1] === "pr-3" ? INFRA_ISSUES : issueHit[1] === "pr-4" ? XT_ISSUES : issueHit[1] === "pr-5" ? EGG_ISSUES : ISSUES;
        const issue = pool.find((i: any) => i.id === issueHit[2]);
        if (!issue) return { status: 404 };
        return { status: 200, json: { ...issue, ...(globalThis.__patchBody ?? {}) } };
      }
      if (/\/projects\/pr-2\/work-items\/([^/]+)\/relations\/$/.test(path)) return { status: 200, json: { blocking: [], blocked_by: [] } };
      if (/\/work-items\/([^/]+)\/relations\/$/.test(path)) return { status: 200, json: { blocking: [], blocked_by: [] } };
      if (path.endsWith("/comments/")) return { status: 200, json: { results: globalThis.__comments } };
      return { status: 404 };
    };
  }

  test("projects verb lists workspace projects", async () => {
    useProjectsRouter();
    const d = (await run(["projects"])) as any;
    expect(d.projects).toEqual([
      { name: "Ai Tutor", identifier: "HT", id: "pr-1" },
      { name: "Teamctl", identifier: "TC", id: "pr-2" },
      { name: "Infra", identifier: "INFRA", id: "pr-3" },
      { name: "X Tools", identifier: "XT", id: "pr-4" },
      { name: "FreshFarmEggs", identifier: "EGG", id: "pr-5" },
    ]);
  });

  test("projects verb works without a resolvable default project", async () => {
    useProjectsRouter();
    process.env.PLANE_PROJECT_NAME = "Bogus";
    const d = (await run(["projects"])) as any;
    expect(d.projects).toHaveLength(5);
  });

  test("get TC-16 resolves the identifier to its project and shapes the id", async () => {
    useProjectsRouter();
    const d = (await run(["get", "TC-16"])) as any;
    expect(d.id).toBe("TC-16");
    expect(d.title).toBe("fleet ticket");
    expect(calls.some((c) => c.path === "/projects/pr-2/issues/tc-16/")).toBeTrue();
    expect(calls.some((c) => c.path === "/projects/pr-1/issues/tc-16/")).toBeFalse();
  });

  test("get tc-16 (lowercase) resolves identically", async () => {
    useProjectsRouter();
    const d = (await run(["get", "tc-16", "--fields", "id"])) as any;
    expect(d.id).toBe("TC-16");
  });

  test("get INFRA-3 resolves a third project", async () => {
    useProjectsRouter();
    const d = (await run(["get", "INFRA-3", "--fields", "id,title"])) as any;
    expect(d.id).toBe("INFRA-3");
    expect(d.title).toBe("infra ticket");
  });

  test("unknown identifier fails loud listing valid identifiers", async () => {
    useProjectsRouter();
    let caught: any;
    try {
      await run(["get", "TEAMXX-1"]);
    } catch (e) {
      caught = e;
    }
    expect(caught.kind).toBe("not-found");
    expect(caught.valid).toEqual(["EGG", "HT", "INFRA", "TC", "XT"]);
    expect(String(caught.suggestion)).toContain("plane projects");
  });

  test("get XT-2 resolves the X Tools project", async () => {
    useProjectsRouter();
    const d = (await run(["get", "XT-2", "--fields", "id,title"])) as any;
    expect(d.id).toBe("XT-2");
    expect(d.title).toBe("x tools ticket");
    expect(calls.some((c) => c.path === "/projects/pr-4/issues/xt-2/")).toBeTrue();
  });

  test("get EGG-5 resolves the FreshFarmEggs project", async () => {
    useProjectsRouter();
    const d = (await run(["get", "EGG-5", "--fields", "id,title"])) as any;
    expect(d.id).toBe("EGG-5");
    expect(d.title).toBe("egg farm ticket");
    expect(calls.some((c) => c.path === "/projects/pr-5/issues/eg-5/")).toBeTrue();
  });

  test("blocks EGG-5 XT-2 posts to the blocker's project with real idents", async () => {
    useProjectsRouter();
    const d = (await run(["blocks", "EGG-5", "XT-2"])) as any;
    expect(d).toMatchObject({ ok: true, edge: "EGG-5->XT-2", changed: true });
    const post = calls.find((c) => c.method === "POST" && c.path.includes("/relations/"))!;
    expect(post.path).toContain("/projects/pr-5/work-items/eg-5/relations/");
    expect(post.body).toEqual({ relation_type: "blocking", issues: ["xt-2"] });
  });

  test("missing ticket in another project suggests nearest matches with the right ident", async () => {
    useProjectsRouter();
    let caught: any;
    try {
      await run(["get", "TC-99"]);
    } catch (e) {
      caught = e;
    }
    expect(caught.kind).toBe("not-found");
    expect(caught.valid).toEqual(["TC-17", "TC-16"]);
    expect(String(caught.message)).toContain("TC-99 not found");
  });

  test("state TC-17 verify patches the owning project with its own state ids", async () => {
    useProjectsRouter();
    const d = (await run(["state", "TC-17", "verify"])) as any;
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/projects/pr-2/issues/tc-17/");
    expect(patch.body).toEqual({ state: "st2-verify" });
    expect(d).toMatchObject({ id: "TC-17", state: "verify", changed: true });
  });

  test("claim TC-17 routes to the owning project and renders the ident", async () => {
    useProjectsRouter();
    const d = (await run(["claim", "TC-17", "--comment", "on it"])) as any;
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/projects/pr-2/issues/tc-17/");
    expect(patch.body).toMatchObject({ state: "st2-progress", assignees: ["mb-dev1"] });
    expect(d).toMatchObject({ id: "TC-17", changed: true });
    const comment = calls.find((c) => c.method === "POST" && c.path.endsWith("/comments/"))!;
    expect(comment.path).toContain("pr-2");
  });

  test("comment TC-16 posts to the owning project comments endpoint", async () => {
    useProjectsRouter();
    await run(["comment", "TC-16", "note"]);
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/comments/"))!;
    expect(post.path).toBe("/projects/pr-2/issues/tc-16/comments/");
  });

  test("reply TC-16 c1 reads and writes the owning project's thread", async () => {
    useProjectsRouter();
    globalThis.__comments = [{ id: "cm-tc", created_at: "2026-08-27T01:00:00Z", comment_html: "<p>parent note</p>", actor: "mb-dev2" }];
    await run(["reply", "TC-16", "c1", "ack"]);
    expect(calls.some((c) => c.path === "/projects/pr-2/issues/tc-16/comments/")).toBeTrue();
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/comments/"))!;
    expect(post.path).toBe("/projects/pr-2/issues/tc-16/comments/");
    expect(post.body).toMatchObject({ parent: "cm-tc" });
  });

  test("sub TC-16 creates the child in the parent's project with its states/labels", async () => {
    useProjectsRouter();
    const d = (await run(["sub", "TC-16", "--title", "child", "--type", "ops", "--body", "<p>c</p>"])) as any;
    const post = calls.find((c) => c.method === "POST" && /\/projects\/[^/]+\/issues\/?$/.test(c.path))!;
    expect(post.path).toBe("/projects/pr-2/issues/");
    expect(post.body).toMatchObject({ parent: "tc-16", state: "st2-todo", label_ids: ["lb2-ops"] });
    expect(d.id).toBe("TC-18");
  });

  test("blocks TC-16 HT-66 names the edge with real idents and posts to the blocker project", async () => {
    useProjectsRouter();
    const d = (await run(["blocks", "TC-16", "HT-66"])) as any;
    expect(d).toMatchObject({ ok: true, edge: "TC-16->HT-66", changed: true });
    const post = calls.find((c) => c.method === "POST" && c.path.includes("/relations/"))!;
    expect(post.path).toContain("/projects/pr-2/work-items/tc-16/relations/");
    expect(post.body).toEqual({ relation_type: "blocking", issues: ["is-66"] });
  });

  test("blocks HT-66 TC-16 posts to the blocker's (default) project", async () => {
    useProjectsRouter();
    const d = (await run(["blocks", "HT-66", "TC-16"])) as any;
    expect(d).toMatchObject({ edge: "HT-66->TC-16" });
    const post = calls.find((c) => c.method === "POST" && c.path.includes("/relations/"))!;
    expect(post.path).toContain("/projects/pr-1/work-items/is-66/relations/");
    expect(post.body).toEqual({ relation_type: "blocking", issues: ["tc-16"] });
  });

  test("list --blocked-by TC-16 reads relations from the owning project", async () => {
    useProjectsRouter();
    const d = (await run(["list", "--blocked-by", "TC-16"])) as any;
    expect(calls.some((c) => c.path === "/projects/pr-2/work-items/tc-16/relations/")).toBeTrue();
    expect(d.total).toBe(0);
  });

  test("self-edge pre-check compares ident+seq, not seq alone", async () => {
    useProjectsRouter();
    let caught: any;
    try {
      await run(["blocks", "TC-16", "TC-16"]);
    } catch (e) {
      caught = e;
    }
    expect(caught.kind).toBe("validation");
    expect(String(caught.message)).toContain("self-edge");
    expect(calls.filter((c) => c.method !== "GET").length).toBe(0);
  });

  test("same seq in another project is a distinct ticket: TC-16 resolves while bare 16 does not", async () => {
    useProjectsRouter();
    let caught: any;
    try {
      await run(["get", "16"]);
    } catch (e) {
      caught = e;
    }
    expect(caught.kind).toBe("not-found");
    expect(String(caught.message)).toContain("HT-16 not found");
  });
});
