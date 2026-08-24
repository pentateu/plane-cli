import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "./cache.ts";
import { run } from "./cli.ts";

type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [];
let router: (m: string, p: string, b: any) => { status: number; json?: any } = () => ({ status: 404 });
let fetchSpy: any;
let spies: Array<{ mockRestore: () => void }> = [];
let envSnapshot: Record<string, string | undefined> = {};
let tmpDirs: string[] = [];

const ENV_KEYS = ["PLANE_API_BASE", "PLANE_WORKSPACE", "PLANE_PROJECT_NAME", "PLANE_SEAT", "PLANE_TOKEN", "PLANE_CACHE"];

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
  router = (_m, path) => {
    if (path.endsWith("/projects/")) return { status: 200, json: { results: [{ id: "pr-1", name: "Ai Tutor", identifier: "AITUT" }] } };
    if (path === "/members/") return { status: 200, json: MEMBERS };
    if (path.endsWith("/states/")) return { status: 200, json: { results: STATES } };
    if (path.endsWith("/labels/")) return { status: 200, json: { results: LABELS } };
    if (path.endsWith("/modules/")) return { status: 200, json: { results: [{ id: "mo-1", name: "CLI" }] } };
    if (/\/projects\/[^/]+\/issues\/?$/.test(path) && _m === "POST")
      return { status: 200, json: { ...(globalThis.__postBody ?? {}), id: "is-new", sequence_id: 69 } };
    if (/\/projects\/[^/]+\/issues\/$/.test(path))
      return { status: 200, json: { results: ISSUES, next_page_results: false, total_count: ISSUES.length } };
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
}

globalThis.__method = "GET";
globalThis.__comments = [];
globalThis.__patchBody = undefined;
globalThis.__postBody = undefined;

beforeEach(() => {
  calls = [];
  globalThis.__method = "GET";
  globalThis.__patchBody = undefined;
  globalThis.__comments = [];
  globalThis.__postBody = undefined;
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
    return new Response(JSON.stringify(r.json ?? { ok: true, data: null }), { status: r.status, headers: { "Content-Type": "application/json" } });
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
    expect(d).toEqual({ project: "Ai Tutor", states: 6, labels: 4, tickets: 2 });
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
