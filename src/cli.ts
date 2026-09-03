#!/usr/bin/env bun
import { Cache } from "./cache.ts";
import { ApiError, Plane, VALID_STATES, htmlToText, mdToHtml, parseTicketRef, type IssueRelations, type RelMap } from "./api.ts";
import { UsageError, availableSeats, resolveConfig, type Config } from "./config.ts";

let activeCache: Cache | undefined;

function finish(code: number): never {
  activeCache?.save();
  process.exit(code);
}

const VERBS = ["whoami", "config", "sync", "projects", "get", "list", "claim", "state", "comments", "reply", "comment", "create", "sub", "blocks", "depends", "unblocks", "states", "labels", "modules"] as const;

const FLAGS_WITH_VALUE = new Set(["seat", "as", "fields", "page", "state", "label", "assignee", "parent", "search", "blocked-by", "title", "type", "priority", "body", "body-file", "body-md", "file", "comment"]);
const BOOLEAN_FLAGS = new Set(["full", "raw", "dry-run", "comments"]);

type Args = {
  verb: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): Args {
  const verb = argv[0];
  if (!verb) throw new UsageError("validation", "no verb given", { valid: [...VERBS], suggestion: "plane help" });
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
    if (!FLAGS_WITH_VALUE.has(name) && !BOOLEAN_FLAGS.has(name)) {
      throw new UsageError("validation", `unknown flag '--${name}'`, {
        valid: [...FLAGS_WITH_VALUE, ...BOOLEAN_FLAGS].map((f) => `--${f}`),
      });
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1)
        throw new UsageError("validation", `--${name} is a boolean flag — pass it bare (an inline value like '--${name}=${a.slice(eq + 1)}' would silently coerce to true)`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = a.slice(eq + 1);
    else {
      value = argv[++i];
      if (value === undefined) throw new UsageError("validation", `flag '--${name}' needs a value`, { suggestion: `--${name} <value>` });
    }
    flags[name] = value;
  }
  return { verb: verb.toLowerCase(), positionals, flags };
}

function out(data: unknown): never {
  process.stdout.write(JSON.stringify(data) + "\n");
  finish(0);
}

function fail(e: unknown): never {
  if (e instanceof UsageError) {
    const body: Record<string, unknown> = { code: e.kind, message: e.message };
    if (e.valid) body.valid = e.valid;
    if (e.suggestion) body.suggestion = e.suggestion;
    process.stderr.write(JSON.stringify({ ok: false, ...body }) + "\n");
    finish(e.exitCode);
  }
  process.stderr.write(JSON.stringify({ ok: false, code: "api", message: String((e as Error)?.message ?? e) }) + "\n");
  finish(1);
}

function requireTicket(positionals: string[]): string {
  const t = positionals[0];
  if (!t) throw new UsageError("validation", "missing ticket ref", { valid: ["HT-<number>", "<IDENT>-<number>", "<number>"], suggestion: "plane get HT-66" });
  return t;
}

type EdgeVerbs = "blocks" | "depends" | "unblocks";

async function runEdgeVerb(args: Args, p: Plane, cfg: Config, dryRun: boolean): Promise<{ ok: true; edge: string; changed: boolean } | { dryRun: true; requests: Array<Record<string, unknown>> }> {
  const remove = args.verb === ("unblocks" as EdgeVerbs);
  if (args.positionals.length < 2)
    throw new UsageError("validation", `${args.verb} needs exactly two ticket refs`, {
      valid: ["HT-<number>", "<IDENT>-<number>"],
      suggestion: `plane ${args.verb} HT-151 HT-184`,
    });
  if (args.positionals.length > 2)
    throw new UsageError("validation", `ambiguous — ${args.verb} takes exactly two refs (got ${args.positionals.length})`, {
      valid: ["HT-<number>", "<IDENT>-<number>"],
      suggestion: `plane ${args.verb} HT-151 HT-184`,
    });
  const [rawA, rawB] = args.positionals as [string, string];
  const refA = parseTicketRef(rawA);
  const refB = parseTicketRef(rawB);
  if ((refA.ident ?? "HT") === (refB.ident ?? "HT") && refA.seq === refB.seq)
    throw new UsageError("validation", `self-edge rejected — '${rawA}' cannot block itself`, { valid: ["two distinct tickets"] });
  // "depends HT-B HT-A" is the same directed edge as "blocks HT-A HT-B"
  const [blockerRef, blockedRef] = args.verb === "depends" ? ([rawB, rawA] as const) : ([rawA, rawB] as const);

  const [blocker, blocked] = await Promise.all([p.issueRef(blockerRef), p.issueRef(blockedRef)]);
  if (blocker.uuid === blocked.uuid)
    throw new UsageError("validation", `self-edge rejected — both refs resolve to ${blocker.ident}-${blocker.seq}`, { valid: ["two distinct tickets"] });

  const edge = `${blocker.ident}-${blocker.seq}->${blocked.ident}-${blocked.seq}`;
  const rels = await p.relationsCached(blocker.uuid, blocker.projectId);
  const exists = rels.blocks.includes(blocked.uuid);
  // Adjust the in-process relation cache without extra fetches: the blocker
  // side is already resolved above; the inverse side only when it was warm.
  const warmInverse = (): IssueRelations | undefined => {
    const hit = (p.cache.fresh("relmap") as RelMap | undefined)?.[blocked.uuid];
    return hit ? { blockers: hit.b, blocks: hit.f } : undefined;
  };

  if (remove) {
    if (!exists) return { ok: true, edge, changed: false };
    const url = `${cfg.apiBase}${p.projectPathFor(blocker.projectId)}/work-items/${blocker.uuid}/relations/${blocked.uuid}/`;
    if (dryRun) return { dryRun: true, requests: [{ method: "DELETE", url }] };
    try {
      await p.removeBlockEdge(blocker.uuid, blocked.uuid, blocker.projectId);
    } catch (e) {
      // Existence was just confirmed, so any 404/405 here means the instance
      // lacks the relation-DELETE route (community: 405 method-not-allowed;
      // some installs: route-level 404) — not a genuine race.
      const msg = e instanceof Error ? e.message : String(e);
      if ((e instanceof ApiError && (e.kind === "not-found" || /\b405\b/.test(msg))) || /\b405\b/.test(msg))
        throw new ApiError("api", "this Plane instance does not expose relation DELETE yet (public API v1 is GET+POST only)", {
          suggestion: "apply the plane-fork relation-delete patch, or remove the edge in the web UI",
        });
      throw e;
    }
    p.cacheRel(blocker.uuid, { blockers: rels.blockers.filter((u) => u !== blocked.uuid), blocks: rels.blocks });
    const inv = warmInverse();
    if (inv) p.cacheRel(blocked.uuid, { blockers: inv.blockers, blocks: inv.blocks.filter((u) => u !== blocker.uuid) });
    return { ok: true, edge, changed: true };
  }

  if (exists) return { ok: true, edge, changed: false };
  const url = `${cfg.apiBase}${p.projectPathFor(blocker.projectId)}/work-items/${blocker.uuid}/relations/`;
  const body = { relation_type: "blocking", issues: [blocked.uuid] };
  if (dryRun) return { dryRun: true, requests: [{ method: "POST", url, body }] };
  await p.setBlockEdge(blocker.uuid, blocked.uuid, blocker.projectId);
  p.cacheRel(blocker.uuid, { blockers: rels.blockers, blocks: [...rels.blocks, blocked.uuid] });
  const inv = warmInverse();
  if (inv) p.cacheRel(blocked.uuid, { blockers: [...inv.blockers, blocker.uuid], blocks: inv.blocks });
  return { ok: true, edge, changed: true };
}

function pickFields<T extends Record<string, unknown>>(data: T, fields?: string): T | Record<string, unknown> {
  if (!fields) return data;
  const keys = fields.split(",").map((s) => s.trim()).filter(Boolean);
  const outObj: Record<string, unknown> = {};
  for (const k of keys) if (k in data) outObj[k] = data[k];
  return outObj;
}

async function bodyText(flags: Record<string, string | boolean>): Promise<string> {
  if (typeof flags.body === "string") return flags.body;
  if (typeof flags["body-file"] === "string") return Bun.file(flags["body-file"]).text();
  if (typeof flags["body-md"] === "string") return mdToHtml(await Bun.file(flags["body-md"]).text());
  throw new UsageError("validation", "one of --body <html> | --body-file <path> | --body-md <path> is required");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function htmlEscape(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function normalizeIdArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).map((a) => (typeof a === "string" ? a : (a as any)?.id)).filter((s): s is string => typeof s === "string" && s.length > 0);
}

async function resolveAsToken(asSubject: string, aud: string): Promise<string> {
  const platformTokenPath = process.env.PLATFORM_TOKEN_PATH ?? "/run/agenix/platform-token";
  let platformToken = process.env.PLATFORM_TOKEN ?? "";
  if (!platformToken) {
    try {
      platformToken = (await Bun.file(platformTokenPath).text()).trim();
    } catch {
      throw new UsageError("auth", `PLATFORM_TOKEN not found: set PLATFORM_TOKEN env or have ${platformTokenPath} 0400`);
    }
  }
  if (!platformToken) throw new UsageError("auth", "PLATFORM_TOKEN empty");
  const email = asSubject.includes("@") ? asSubject : `${asSubject}@iswe.co.nz`;
  const issuerBase = "https://auth.iswe.co.nz";
  const ccRes = await fetch(`${issuerBase}/application/o/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "platform",
      client_secret: platformToken,
      scope: "openid profile email",
    }),
  });
  if (!ccRes.ok) throw new UsageError("auth", `platform client_credentials failed ${ccRes.status}`);
  const ccJson: any = await ccRes.json();
  const platformJwt = ccJson.access_token as string;
  if (!platformJwt) throw new UsageError("auth", "platform JWT missing");
  const exRes = await fetch(`${issuerBase}/application/o/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      client_id: "platform",
      client_secret: platformToken,
      subject_token: platformJwt,
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      requested_subject: email,
      scope: "openid profile email",
      aud,
      audience: aud,
    }),
  });
  if (!exRes.ok) {
    const txt = await exRes.text().catch(() => "");
    throw new UsageError("auth", `token-exchange for ${email} aud=${aud} failed ${exRes.status} ${txt.slice(0, 200)}`);
  }
  const exJson: any = await exRes.json();
  const devJwt = exJson.access_token as string;
  if (!devJwt) throw new UsageError("auth", "dev JWT missing");
  try {
    const payload = JSON.parse(Buffer.from(devJwt.split(".")[1], "base64url").toString());
    console.error(JSON.stringify({ jwt: { sub: payload.sub, aud: payload.aud, exp: payload.exp, iss: payload.iss } }));
  } catch { /* ignore */ }
  return devJwt;
}

const HELP = `plane — Ai Tutor ticket CLI (agent-only)

CONTRACT
  success -> one JSON line on stdout, exit 0
  failure -> one JSON error on stderr, exit 1 api|network · 2 auth · 3 not-found · 4 validation · 5 rate-limit
  errors carry code/message/valid/suggestion — fix per 'valid'/'suggestion', retry once, never loop
  handles are short names everywhere: <IDENT>-<seq> (HT-<seq> and bare <seq> are the default
  project), states todo|progress|verify|done|cancelled|backlog,
  labels type:bug|type:feature|type:ops|type:plan, seats dev1.. — UUIDs never appear in data fields
  (untranslated ids render as short 'member:'/'label:' prefixes; --raw and --dry-run are the only
  surfaces that can show native payloads)
  output is minimal by default; widen with --fields a,b · deepen with --full (comments stay capped at
  their upstream 300/400 chars) · native payload with --raw
  boolean flags are bare; inline values ('--yes=false') are rejected with exit 4
  every mutating verb accepts --dry-run (prints exactly what execution would send, changes nothing)
  claim/state are idempotent: re-applying returns changed:false, exit 0 — safe retries.
  blocks/depends/unblocks are idempotent the same way (re-creating or re-removing an
  edge => changed:false, zero writes)
  claim --comment posts ONLY when something changed (retry-safe); state --comment always posts
  (it IS the payload, e.g. close-out notes) and reports commentPosted:true
   auth: --seat > $PLANE_SEAT; --as dev1 uses PLATFORM_TOKEN 0400 -> dev1 JWT aud=plane via token-exchange (INFRA-SSO-2, no password); token from project-scoped .plane-seats (walks up from
         cwd, gitignored, keys HOMETUTOR_TICKETS_TOKEN_<SEAT>) > legacy
         ~/.config/plane/seats.env > $PLANE_TOKEN / exported env var

VERBS
  whoami                          resolve seat -> workspace member
  config                          show resolved seat/apiBase/project/tokenSource/cache
  projects                        list workspace projects (name, identifier, id)
  sync                            force-refresh cached states/labels/member/ticket index
  get HT-N [--comments] [--full] [--raw] [--fields f1,f2]
                                  renders blockedBy[]/blocks[] (short handles):
                                  who holds HT-N up, what HT-N holds up
  list [--state s] [--label l] [--assignee me|name] [--parent HT-N] [--blocked-by HT-N]
       [--search q] [--page N]    --blocked-by = the "what can start now" query:
                                  tickets held up by HT-N
  claim HT-N [--comment "…"]      assign self + move to progress
  state HT-N <state> [--comment "…"]
  comments HT-N                   numbered thread c1,c2,… oldest first
  reply HT-N cM "text"            threaded answer to comment cM (review-loop close-out)
  comment HT-N "text"             top-level comment ('--file -' reads stdin)
  blocks HT-A HT-B                edge: A blocks B — persisted natively on Plane
  depends HT-B HT-A               same edge spelled from the dependent side
  unblocks HT-A HT-B              remove that edge
  create --title t --type bug|feature|ops|plan [--priority urgent|high|medium|low]
         [--body html | --body-file f.html | --body-md f.md]
  sub HT-N …                      same as create, filed as child of HT-N
  states | labels | modules       raw id lookups (debug)

ENV
  credentials: project-scoped .plane-seats (walks up from cwd, gitignored;
  keys HOMETUTOR_TICKETS_TOKEN_<SEAT>) > legacy ~/.config/plane/seats.env >
  $PLANE_TOKEN / $HOMETUTOR_TICKETS_TOKEN_<SEAT> exported in the environment
  board: PLANE_SEAT · PLANE_API_BASE or PLANE_URL (api/v1 derived) · PLANE_WORKSPACE ·
  PLANE_PROJECT_NAME · HOMETUTOR_TICKETS_PROJECT_ID (skips discovery) · PLANE_CACHE ·
  PLANE_NO_PULL · PLANE_BACKOFF_MS

EXAMPLES
  plane claim HT-66 --comment "starting impl"
  plane get HT-66 --comments --fields id,state,description
  plane reply HT-66 c3 "fixed in a925b68 — guard added, tests green"
  plane state HT-66 verify --comment "branch feature/x @ sha"
  plane list --assignee me --state progress
  plane blocks HT-151 HT-184 && plane list --blocked-by HT-151`;

export async function run(argv: string[]): Promise<unknown> {
  // INFRA-SSO-2: handle --as as global flag before verb (ot style) — plane verb is argv[0] but --as may precede it
  let asFlag: string | undefined;
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--as" && i + 1 < argv.length) { asFlag = argv[++i]; continue; }
    if (a.startsWith("--as=")) { asFlag = a.slice(5); continue; }
    filtered.push(a);
  }
  const args = parseArgs(filtered);
  if (asFlag) args.flags.as = asFlag;
  if (args.verb === "help") {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }
  if (!VERBS.includes(args.verb as (typeof VERBS)[number])) {
    throw new UsageError("validation", `unknown verb '${args.verb}'`, { valid: [...VERBS], suggestion: "plane help" });
  }

  let cfg: Config = resolveConfig({ seat: typeof args.flags.seat === "string" ? args.flags.seat : typeof args.flags.as === "string" ? args.flags.as : undefined });
  if (typeof args.flags.as === "string") {
    const asSub = String(args.flags.as);
    const aud = "plane";
    const devJwt = await resolveAsToken(asSub, aud);
    cfg = { ...cfg, token: devJwt, seat: asSub.includes("@") ? asSub.split("@")[0] : asSub } as Config;
  }
  const cache = new Cache(process.env.PLANE_CACHE ?? `${process.env.HOME}/.config/plane/cache.json`);
  activeCache = cache;
  const p = new Plane(cfg, cache);
  if (args.verb !== "projects") await p.ensureProject();
  const dryRun = args.flags["dry-run"] === true;
  const full = args.flags.full === true;
  const fields = typeof args.flags.fields === "string" ? args.flags.fields : undefined;
  const positional = args.positionals[0];

  const requireStateId = (sm: Record<string, string>, token: string): string => {
    const id = sm[token];
    if (!id)
      throw new UsageError("not-found", `board has no '${token}' state — the workflow states were renamed or drifted`, {
        valid: Object.keys(sm),
        suggestion: "plane sync then retry",
      });
    return id;
  };

  switch (args.verb) {
    case "whoami": {
      const memberId = await p.me();
      const members = (await p.request("GET", `${p.base()}/members/`)) as Array<Record<string, string>>;
      const m = members.find((x) => x.id === memberId);
      if (!m) throw new UsageError("not-found", `seat '${cfg.seat}' resolved to a member missing from the workspace roster`, { suggestion: "plane sync then retry" });
      return { seat: cfg.seat, name: m.display_name || m.first_name, email: m.email };
    }
    case "blocks":
    case "depends":
    case "unblocks":
      return runEdgeVerb(args, p, cfg, dryRun);
    case "states": {
      const sm = await p.stateMap();
      return { states: Object.entries(sm).map(([token, id]) => ({ token, id })).sort((a, b) => a.token.localeCompare(b.token)) };
    }
    case "labels": {
      const lm = await p.labelMap();
      return { labels: Object.entries(lm).map(([name, id]) => ({ name, id })).sort((a, b) => a.name.localeCompare(b.name)) };
    }
    case "modules": {
      const page = (await p.request("GET", `${p.projectPath()}/modules/`)) as Record<string, unknown>;
      const rows = (page.results as Array<Record<string, any>>) ?? [];
      return { modules: rows.map((m) => ({ name: m.name, id: m.id })) };
    }
    case "projects": {
      const projects = await p.projects();
      return { projects: projects.map((x) => ({ name: x.name as string, identifier: x.identifier as string, id: x.id as string })) };
    }
    case "config": {
      await p.ensureProject();
      return { seat: cfg.seat, tokenSource: cfg.tokenSource, apiBase: cfg.apiBase, workspace: cfg.workspace, project: cfg.projectName, cache: Object.keys(cache.data) };
    }
    case "sync": {
      // Capture the default project id BEFORE dropping `project:<name>` —
      // projectId() resolves from that key when no explicit id is configured.
      const pid = p.projectId();
      cache.drop(`project:${cfg.projectName}`);
      // Project-scoped map keys (multi-project host cache): drop only the
      // current project's maps, never another checkout's.
      cache.drop(`states:${pid}`);
      cache.drop(`labels:${pid}`);
      cache.drop(`member:${cfg.seat}`);
      cache.drop("members");
      cache.drop(`seqmap:${pid}`);
      await p.ensureProject();
      const [states, labels] = await Promise.all([p.stateMap(), p.labelMap()]);
      await p.member(cfg.seat);
      const all = await fetchAll(p, "");
      // Relations walk: rate-limited instances make per-ticket lookups flaky,
      // so merge into the previous map (never clobber good data with zeros),
      // skip failed lookups entirely, and pace the batches.
      const prevRelmap = ((cache.stale("relmap") as RelMap | undefined) ?? {}) as RelMap;
      const relmap: RelMap = { ...prevRelmap };
      let edgeErrors = 0;
      for (let i = 0; i < all.raw.length; i += 10) {
        await Promise.all(
          all.raw.slice(i, i + 10).map(async (issue) => {
            const u = String(issue.id);
            try {
              const r = await p.relations(u);
              relmap[u] = { b: r.blockers, f: r.blocks };
            } catch {
              edgeErrors++;
            }
          }),
        );
        if (i + 10 < all.raw.length) await new Promise((r) => setTimeout(r, 200));
      }
      cache.set("relmap", relmap);
      return {
        project: cfg.projectName,
        states: Object.keys(states).length,
        labels: Object.keys(labels).length,
        tickets: all.raw.length,
        edges: Object.values(relmap).reduce((n, r) => n + r.b.length, 0),
        edgeErrors,
      };
    }
    case "get": {
      const { uuid, ident, projectId } = await p.issueRef(requireTicket(args.positionals));
      if (args.flags.raw) {
        const rawIssue = await p.request("GET", `${p.projectPathFor(projectId)}/issues/${uuid}/`);
        return rawIssue;
      }
      const wantComments = args.flags.comments === true;
      const [rawIssue, comments, rels] = await Promise.all([
        p.request("GET", `${p.projectPathFor(projectId)}/issues/${uuid}/`) as Promise<Record<string, unknown>>,
        wantComments ? p.comments(uuid, projectId) : Promise.resolve([]),
        p.relationsCached(uuid, projectId),
      ]);
      const shaped = await p.shapeIssue(rawIssue as never, { full, relations: rels, ident, projectId });
      const obj = { ...shaped, ...(wantComments ? { comments: comments.map(({ n, author, date, text }) => ({ n: `c${n}`, author, date, text })) } : {}) };
      return pickFields(obj as Record<string, unknown>, fields);
    }
    case "list": {
      const all = await fetchAll(p, typeof args.flags.search === "string" ? args.flags.search : "");
      const forwardStates = await p.stateMap();
      const lm = await p.labelMap();
      let items = all.raw;
      const stateF = args.flags.state;
      if (typeof stateF === "string") {
        if (!VALID_STATES.concat("backlog").includes(stateF))
          throw new UsageError("validation", `invalid state '${stateF}'`, { valid: [...VALID_STATES, "backlog"] });
        const sid = forwardStates[stateF];
        items = items.filter((i: Record<string, unknown>) => i.state === sid);
      }
      const labelF = args.flags.label;
      if (typeof labelF === "string") {
        const lid = lm[labelF];
        if (!lid)
          throw new UsageError("not-found", `unknown label '${labelF}'`, { valid: Object.keys(lm), suggestion: "plane sync then retry" });
        items = items.filter((i: Record<string, unknown>) => normalizeIdArray(i.labels).includes(lid));
      }
      const assigneeF = args.flags.assignee;
      if (typeof assigneeF === "string") {
        const wantedId = assigneeF === "me" ? await p.me() : await p.member(assigneeF);
        items = items.filter((i: Record<string, unknown>) => normalizeIdArray(i.assignees).includes(wantedId));
      }
      const parentF = args.flags.parent;
      if (typeof parentF === "string") {
        const parent = await p.issueRef(parentF);
        items = items.filter((i: Record<string, unknown>) => i.parent === parent.uuid);
      }
      const blockedByF = args.flags["blocked-by"];
      if (typeof blockedByF === "string") {
        // tickets held up by TEAMCTL-16 = the ones TEAMCTL-16 blocks
        const ref = await p.issueRef(blockedByF);
        const rels = await p.relations(ref.uuid, ref.projectId);
        p.cacheRel(ref.uuid, rels);
        const heldUp = new Set(rels.blocks);
        items = items.filter((i: Record<string, unknown>) => heldUp.has(String(i.id)));
      }
      const page = Number(args.flags.page ?? 1);
      if (!Number.isInteger(page) || page < 1)
        throw new UsageError("validation", `--page must be a positive integer (got '${args.flags.page}')`);
      const pageSize = 25;
      const slice = items.slice((page - 1) * pageSize, page * pageSize);
      const rows = [];
      for (const i of slice) {
        const s = await p.shapeIssue(i as never, {});
        rows.push({
          id: s.id,
          title: s.title.length > 100 ? `${s.title.slice(0, 99)}…` : s.title,
          state: s.state,
          priority: s.priority,
          assignee: s.assignees[0] ?? null,
          ...(fields?.includes("labels") ? { labels: s.labels } : {}),
          ...(fields?.includes("parent") ? { parent: s.parent } : {}),
        });
      }
      return { items: rows, total: items.length, page, nextPage: page * pageSize < items.length ? page + 1 : null };
    }
    case "claim": {
      const ref = await p.issueRef(requireTicket(args.positionals));
      const [issue, sm, meId] = await Promise.all([
        p.request("GET", `${p.projectPathFor(ref.projectId)}/issues/${ref.uuid}/`) as Promise<Record<string, unknown>>,
        p.stateMap(ref.projectId),
        p.me(),
      ]);
      const progressId = requireStateId(sm, "progress");
      const assignees = normalizeIdArray(issue.assignees).slice();
      const addMe = !assignees.includes(meId);
      if (addMe) assignees.push(meId);
      const stateChange = issue.state !== progressId;
      const patch: Record<string, unknown> = {};
      if (addMe) patch.assignees = assignees;
      if (stateChange) patch.state = progressId;
      const changed = addMe || stateChange;
      const commentText = typeof args.flags.comment === "string" ? args.flags.comment : undefined;
      const postComment = Boolean(commentText) && changed;
      if (dryRun) {
        const reqs: Array<Record<string, unknown>> = [];
        if (Object.keys(patch).length) reqs.push({ method: "PATCH", url: `${cfg.apiBase}${p.projectPathFor(ref.projectId)}/issues/${ref.uuid}/`, body: patch });
        if (postComment) reqs.push({ method: "POST", url: `${cfg.apiBase}${p.projectPathFor(ref.projectId)}/issues/${ref.uuid}/comments/`, body: { comment_html: htmlEscape(commentText!) } });
        return { dryRun: true, requests: reqs };
      }
      if (Object.keys(patch).length) await p.patchIssue(ref.uuid, patch, ref.projectId);
      let finalAssignees = addMe ? assignees : normalizeIdArray(issue.assignees);
      if (Object.keys(patch).length) {
        const after = (await p.request("GET", `${p.projectPathFor(ref.projectId)}/issues/${ref.uuid}/`)) as Record<string, unknown>;
        finalAssignees = normalizeIdArray(after.assignees);
        if (finalAssignees.length === 0) finalAssignees = normalizeIdArray(issue.assignees);
      }
      if (postComment) await p.postComment(ref.uuid, htmlEscape(commentText!), undefined, ref.projectId);
      return {
        id: `${ref.ident}-${ref.seq}`,
        state: "progress",
        changed,
        ...(commentText ? { commentPosted: postComment } : {}),
        assignees: (await p.memberNamesPublic(finalAssignees)).sort(),
      };
    }
    case "state": {
      const target = String(args.positionals[1] ?? "");
      if (!VALID_STATES.includes(target)) {
        throw new UsageError("validation", `invalid state '${target}'`, { valid: VALID_STATES });
      }
      const ref = await p.issueRef(requireTicket(args.positionals));
      const [sm, issue] = await Promise.all([p.stateMap(ref.projectId), p.request("GET", `${p.projectPathFor(ref.projectId)}/issues/${ref.uuid}/`) as Promise<Record<string, unknown>>]);
      const targetId = requireStateId(sm, target);
      const sameState = issue.state === targetId;
      const commentText = typeof args.flags.comment === "string" ? args.flags.comment : undefined;
      if (dryRun) {
        return {
          dryRun: true,
          requests: [
            ...(sameState ? [] : [{ method: "PATCH", url: `${cfg.apiBase}${p.projectPathFor(ref.projectId)}/issues/${ref.uuid}/`, body: { state: targetId } }]),
            ...(commentText ? [{ method: "POST", url: `${cfg.apiBase}${p.projectPathFor(ref.projectId)}/issues/${ref.uuid}/comments/`, body: { comment_html: htmlEscape(commentText) } }] : []),
          ],
        };
      }
      if (!sameState) await p.patchIssue(ref.uuid, { state: targetId }, ref.projectId);
      if (commentText) await p.postComment(ref.uuid, htmlEscape(commentText), undefined, ref.projectId);
      return {
        id: `${ref.ident}-${ref.seq}`,
        state: target,
        changed: !sameState,
        ...(commentText ? { commentPosted: true } : {}),
      };
    }
    case "comments": {
      const ref = await p.issueRef(requireTicket(args.positionals));
      const list = await p.comments(ref.uuid, ref.projectId);
      const shaped = list.map((c) => ({ n: `c${c.n}`, author: c.author, date: c.date, text: full ? c.text : truncateText(c.text, 300) }));
      return pickFields({ id: `${ref.ident}-${ref.seq}`, comments: shaped }, fields ?? "id,comments");
    }
    case "reply":
    case "comment": {
      const isReply = args.verb === "reply";
      const ref = await p.issueRef(requireTicket(args.positionals));
      const textArg = args.positionals.slice(isReply ? 2 : 1).join(" ");
      let html: string;
      if (typeof args.flags.file === "string" && args.flags.file === "-") html = htmlEscape(await readStdin());
      else if (typeof args.flags.file === "string") html = htmlEscape(await Bun.file(args.flags.file).text());
      else {
        if (!textArg.trim())
          throw new UsageError("validation", isReply ? "missing reply text" : "missing comment text", {
            suggestion: isReply ? `plane reply ${positional} c1 "text"` : `plane comment ${positional} "text"`,
          });
        html = htmlEscape(textArg);
      }
      let parentId: string | undefined;
      let replyTo: string | undefined;
      if (isReply) {
        const handle = String(args.positionals[1] ?? "");
        const m = handle.match(/^c(\d+)$/);
        if (!m) throw new UsageError("validation", `invalid comment handle '${handle}'`, { valid: ["c<N>"], suggestion: `plane comments ${positional}` });
        const list = await p.comments(ref.uuid, ref.projectId);
        const target = list.find((c) => c.n === Number(m[1]));
        if (!target)
          throw new UsageError("not-found", `comment ${handle} not found on ${positional}`, {
            valid: list.map((c) => `c${c.n}`),
            suggestion: `plane comments ${positional} to re-list`,
          });
        parentId = target.id;
        replyTo = handle;
      }
      if (dryRun) {
        const body: Record<string, unknown> = { comment_html: html, ...(parentId ? { parent: parentId } : {}) };
        return { dryRun: true, requests: [{ method: "POST", url: `${cfg.apiBase}${p.projectPathFor(ref.projectId)}/issues/${ref.uuid}/comments/`, body }] };
      }
      await p.postComment(ref.uuid, html, parentId, ref.projectId);
      const listAfter = await p.comments(ref.uuid, ref.projectId);
      return { id: `${ref.ident}-${ref.seq}`, ...(replyTo ? { replyTo } : {}), n: `c${listAfter.length}` };
    }
    case "create":
    case "sub": {
      const title = typeof args.flags.title === "string" ? args.flags.title : "";
      if (!title.trim()) throw new UsageError("validation", "--title is required", { suggestion: `plane ${args.verb} --title "[bug] …" --type bug` });
      const typeRaw = typeof args.flags.type === "string" ? args.flags.type : "";
      const typeName = typeRaw.startsWith("type:") ? typeRaw : `type:${typeRaw}`;
      const prio = typeof args.flags.priority === "string" ? args.flags.priority : "";
      if (prio && !["urgent", "high", "medium", "low"].includes(prio))
        throw new UsageError("validation", `invalid --priority '${prio}'`, { valid: ["urgent", "high", "medium", "low"] });
      const html = await bodyText(args.flags);
      let parentRef: { uuid: string; seq: number; ident: string; projectId: string } | undefined;
      if (args.verb === "sub") parentRef = await p.issueRef(requireTicket(args.positionals));
      const projectId = parentRef?.projectId;
      const ident = parentRef?.ident;
      const [lm, sm] = await Promise.all([p.labelMap(projectId), p.stateMap(projectId)]);
      const labelId = lm[typeName];
      if (!labelId)
        throw new UsageError("not-found", `label '${typeName}' not found on the board`, {
          valid: Object.keys(lm),
          suggestion: "plane sync then retry",
        });
      const payload: Record<string, unknown> = {
        name: title,
        description_html: html,
        state: requireStateId(sm, "todo"),
        label_ids: [labelId],
        ...(prio ? { priority: prio } : {}),
        ...(parentRef ? { parent: parentRef.uuid } : {}),
      };
      const targetId = projectId ?? p.projectId();
      const requests: Array<Record<string, unknown>> = [
        { method: "POST", url: `${cfg.apiBase}${p.projectPathFor(targetId)}/issues/`, body: payload },
      ];
      if (dryRun) return { dryRun: true, requests };
      const created = (await p.request("POST", `${p.projectPathFor(targetId)}/issues/`, payload)) as Record<string, unknown>;
      cache.drop(`seqmap:${targetId}`);
      return { id: `${ident ?? cfg.ident}-${created.sequence_id}` };
    }
  }
}

async function fetchAll(p: Plane, search: string): Promise<{ raw: Array<Record<string, unknown>> }> {
  const outArr = await p.listIssues(search ? { search } : {});
  p.cache.set(`seqmap:${p.projectId()}`, Object.fromEntries(outArr.map((i) => [String(i.sequence_id), i.id as string])));
  return { raw: outArr };
}

function truncateText(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

export function main(argv: string[]): void {
  run(argv).then(
    (data) => {
      if (data !== undefined) out(data);
      finish(0);
    },
    (e) => fail(e),
  );
}

/** Test/debug seam: the cache instance bound to the most recent run(). */
export function peekCache(): Cache | undefined {
  return activeCache;
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
