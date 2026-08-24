#!/usr/bin/env bun
import { Cache } from "./cache.ts";
import { ApiError, Plane, VALID_STATES, htmlToText, mdToHtml } from "./api.ts";
import { UsageError, availableSeats, resolveConfig, type Config } from "./config.ts";

let activeCache: Cache | undefined;

function finish(code: number): never {
  activeCache?.save();
  process.exit(code);
}

const VERBS = ["whoami", "config", "sync", "get", "list", "claim", "state", "comments", "reply", "comment", "create", "sub", "states", "labels", "modules"] as const;

const FLAGS_WITH_VALUE = new Set(["seat", "fields", "page", "state", "label", "assignee", "parent", "search", "title", "type", "priority", "body", "body-file", "body-md", "file", "comment"]);
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
  if (!t) throw new UsageError("validation", "missing ticket ref", { valid: ["HT-<number>"], suggestion: "plane get HT-66" });
  return t;
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

const HELP = `plane — Ai Tutor ticket CLI (agent-only)

CONTRACT
  success -> one JSON line on stdout, exit 0
  failure -> one JSON error on stderr, exit 1 api|network · 2 auth · 3 not-found · 4 validation · 5 rate-limit
  errors carry code/message/valid/suggestion — fix per 'valid'/'suggestion', retry once, never loop
  handles are short names everywhere: HT-<seq>, states todo|progress|verify|done|cancelled|backlog,
  labels type:bug|type:feature|type:ops|type:plan, seats dev1.. — UUIDs never appear in data fields
  (untranslated ids render as short 'member:'/'label:' prefixes; --raw and --dry-run are the only
  surfaces that can show native payloads)
  output is minimal by default; widen with --fields a,b · deepen with --full (comments stay capped at
  their upstream 300/400 chars) · native payload with --raw
  boolean flags are bare; inline values ('--yes=false') are rejected with exit 4
  every mutating verb accepts --dry-run (prints exactly what execution would send, changes nothing)
  claim/state are idempotent: re-applying returns changed:false, exit 0 — safe retries.
  claim --comment posts ONLY when something changed (retry-safe); state --comment always posts
  (it IS the payload, e.g. close-out notes) and reports commentPosted:true
  auth: --seat > $PLANE_SEAT; token from project-scoped .plane-seats (walks up from
        cwd, gitignored, keys HOMETUTOR_TICKETS_TOKEN_<SEAT>) > legacy
        ~/.config/plane/seats.env > $PLANE_TOKEN / exported env var

VERBS
  whoami                          resolve seat -> workspace member
  config                          show resolved seat/apiBase/project/tokenSource/cache
  sync                            force-refresh cached states/labels/member/ticket index
  get HT-N [--comments] [--full] [--raw] [--fields f1,f2]
  list [--state s] [--label l] [--assignee me|name] [--parent HT-N] [--search q] [--page N]
  claim HT-N [--comment "…"]      assign self + move to progress
  state HT-N <state> [--comment "…"]
  comments HT-N                   numbered thread c1,c2,… oldest first
  reply HT-N cM "text"            threaded answer to comment cM (review-loop close-out)
  comment HT-N "text"             top-level comment ('--file -' reads stdin)
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
  plane list --assignee me --state progress`;

export async function run(argv: string[]): Promise<unknown> {
  const args = parseArgs(argv);
  if (args.verb === "help") {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }
  if (!VERBS.includes(args.verb as (typeof VERBS)[number])) {
    throw new UsageError("validation", `unknown verb '${args.verb}'`, { valid: [...VERBS], suggestion: "plane help" });
  }

  const cfg: Config = resolveConfig({ seat: typeof args.flags.seat === "string" ? args.flags.seat : undefined });
  const cache = new Cache(process.env.PLANE_CACHE ?? `${process.env.HOME}/.config/plane/cache.json`);
  activeCache = cache;
  const p = new Plane(cfg, cache);
  await p.ensureProject();
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
    case "config": {
      await p.ensureProject();
      return { seat: cfg.seat, tokenSource: cfg.tokenSource, apiBase: cfg.apiBase, workspace: cfg.workspace, project: cfg.projectName, cache: Object.keys(cache.data) };
    }
    case "sync": {
      cache.drop(`project:${cfg.projectName}`);
      cache.drop("states");
      cache.drop("labels");
      cache.drop(`member:${cfg.seat}`);
      cache.drop("members");
      cache.drop("seqmap");
      await p.ensureProject();
      const [states, labels] = await Promise.all([p.stateMap(), p.labelMap()]);
      await p.member(cfg.seat);
      const all = await fetchAll(p, "");
      return { project: cfg.projectName, states: Object.keys(states).length, labels: Object.keys(labels).length, tickets: all.raw.length };
    }
    case "get": {
      const { uuid, seq } = await p.issueRef(requireTicket(args.positionals));
      if (args.flags.raw) {
        const rawIssue = await p.request("GET", `${p.projectPath()}/issues/${uuid}/`);
        return rawIssue;
      }
      const wantComments = args.flags.comments === true;
      const [rawIssue, comments] = await Promise.all([
        p.request("GET", `${p.projectPath()}/issues/${uuid}/`) as Promise<Record<string, unknown>>,
        wantComments ? p.comments(uuid) : Promise.resolve([]),
      ]);
      const shaped = await p.shapeIssue(rawIssue as never, { full });
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
        items = items.filter((i: Record<string, unknown>) => ((i.labels as string[]) ?? []).includes(lid));
      }
      const assigneeF = args.flags.assignee;
      if (typeof assigneeF === "string") {
        const wantedId = assigneeF === "me" ? await p.me() : await p.member(assigneeF);
        items = items.filter((i: Record<string, unknown>) => ((i.assignees as string[]) ?? []).includes(wantedId));
      }
      const parentF = args.flags.parent;
      if (typeof parentF === "string") {
        const parent = await p.issueRef(parentF);
        items = items.filter((i: Record<string, unknown>) => i.parent === parent.uuid);
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
      const [issue, sm, meId] = await Promise.all([p.request("GET", `${p.projectPath()}/issues/${ref.uuid}/`) as Promise<Record<string, unknown>>, p.stateMap(), p.me()]);
      const progressId = requireStateId(sm, "progress");
      const assignees = ((issue.assignees as string[]) ?? []).slice();
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
        if (Object.keys(patch).length) reqs.push({ method: "PATCH", url: `${cfg.apiBase}${p.projectPath()}/issues/${ref.uuid}/`, body: patch });
        if (postComment) reqs.push({ method: "POST", url: `${cfg.apiBase}${p.projectPath()}/issues/${ref.uuid}/comments/`, body: { comment_html: htmlEscape(commentText!) } });
        return { dryRun: true, requests: reqs };
      }
      if (Object.keys(patch).length) await p.patchIssue(ref.uuid, patch);
      let finalAssignees = addMe ? assignees : ((issue.assignees as string[]) ?? []);
      if (Object.keys(patch).length) {
        const after = (await p.request("GET", `${p.projectPath()}/issues/${ref.uuid}/`)) as Record<string, unknown>;
        finalAssignees = (after.assignees as string[]) ?? finalAssignees;
      }
      if (postComment) await p.postComment(ref.uuid, htmlEscape(commentText!));
      return {
        id: `HT-${ref.seq}`,
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
      const [sm, issue] = await Promise.all([p.stateMap(), p.request("GET", `${p.projectPath()}/issues/${ref.uuid}/`) as Promise<Record<string, unknown>>]);
      const targetId = requireStateId(sm, target);
      const sameState = issue.state === targetId;
      const commentText = typeof args.flags.comment === "string" ? args.flags.comment : undefined;
      if (dryRun) {
        return {
          dryRun: true,
          requests: [
            ...(sameState ? [] : [{ method: "PATCH", url: `${cfg.apiBase}${p.projectPath()}/issues/${ref.uuid}/`, body: { state: targetId } }]),
            ...(commentText ? [{ method: "POST", url: `${cfg.apiBase}${p.projectPath()}/issues/${ref.uuid}/comments/`, body: { comment_html: htmlEscape(commentText) } }] : []),
          ],
        };
      }
      if (!sameState) await p.patchIssue(ref.uuid, { state: targetId });
      if (commentText) await p.postComment(ref.uuid, htmlEscape(commentText));
      return {
        id: `HT-${ref.seq}`,
        state: target,
        changed: !sameState,
        ...(commentText ? { commentPosted: true } : {}),
      };
    }
    case "comments": {
      const ref = await p.issueRef(requireTicket(args.positionals));
      const list = await p.comments(ref.uuid);
      const shaped = list.map((c) => ({ n: `c${c.n}`, author: c.author, date: c.date, text: full ? c.text : truncateText(c.text, 300) }));
      return pickFields({ id: `HT-${ref.seq}`, comments: shaped }, fields ?? "id,comments");
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
        const list = await p.comments(ref.uuid);
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
        return { dryRun: true, requests: [{ method: "POST", url: `${cfg.apiBase}${p.projectPath()}/issues/${ref.uuid}/comments/`, body }] };
      }
      await p.postComment(ref.uuid, html, parentId);
      const listAfter = await p.comments(ref.uuid);
      return { id: `HT-${ref.seq}`, ...(replyTo ? { replyTo } : {}), n: `c${listAfter.length}` };
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
      const [lm, sm] = await Promise.all([p.labelMap(), p.stateMap()]);
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
      };
      if (args.verb === "sub") {
        const parent = await p.issueRef(requireTicket(args.positionals));
        payload.parent = parent.uuid;
      }
      const requests: Array<Record<string, unknown>> = [
        { method: "POST", url: `${cfg.apiBase}${p.projectPath()}/issues/`, body: payload },
      ];
      if (dryRun) return { dryRun: true, requests };
      const created = (await p.request("POST", `${p.projectPath()}/issues/`, payload)) as Record<string, unknown>;
      cache.drop("seqmap");
      return { id: `HT-${created.sequence_id}` };
    }
  }
}

async function fetchAll(p: Plane, search: string): Promise<{ raw: Array<Record<string, unknown>> }> {
  const outArr: Array<Record<string, unknown>> = [];
  for (let pageN = 1; pageN <= 5; pageN++) {
    const q = new URLSearchParams({ per_page: "100", page: String(pageN) });
    if (search) q.set("search", search);
    const page = (await p.request("GET", `${p.projectPath()}/issues/?${q}`)) as Record<string, unknown>;
    outArr.push(...((page.results as Array<Record<string, unknown>>) ?? []));
    if (!(page.next_page_results ?? false)) break;
  }
  p.cache.set("seqmap", Object.fromEntries(outArr.map((i) => [String(i.sequence_id), i.id as string])));
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

if (import.meta.main) {
  main(process.argv.slice(2));
}
