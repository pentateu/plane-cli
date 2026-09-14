/**
 * TC-95 (§29.8) Phase 2 — one-shot pull: ticket → folder.
 *
 * Writes `<dir>/ticket.md` (front-matter + title + body), `sub-tickets/`
 * (one `ticket.md` per child, recursive, each with its OWN `.plane/`
 * comment home — review I5), `.plane/comments.events.jsonl` (existing
 * comments as `synced` events) + DERIVED `comments.json`. Returns the server
 * revision so the mount record can revision-guard later pushes.
 *
 * Value choices (documented, round-trippable through the CLI surface):
 * - `state:` = CLI state token (todo|progress|verify|done|cancelled|backlog)
 * - `assignee:` = seat name (member display_name, else email local-part), else raw member id
 * - `labels:` = full board label names (e.g. type:ops)
 * - body = plain text via htmlToText (spec's "html fallback wherever easier",
 *   inverted: lossless HTML round-trip is a later phase if agents need it)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { htmlToText, type Plane, type Raw } from "./api.ts";
import { readEventsFile, updateEvents, writeStatusFile, metaDir, type SyncMount, type StoredEvent } from "./sync.ts";

export interface SyncEvent {
  event: "add" | "reply" | "resolve";
  op: string;
  id: string | null;
  parent: string | null;
  author: string;
  body: string;
  body_sha: string;
  at: string;
  status: "pending" | "posting" | "synced" | "conflict" | "resolved";
  /** §2.1 msg_id the daemon stamped the post with (persisted BEFORE the
   *  POST — review C5); the NATS outbox (§4.5) reuses it as Nats-Msg-Id. */
  entry?: string;
  /** I4 (review r2): structured dedup key for push-conflict notices.
   *  Optional for backward compat (legacy rows have no meta; predicates fall
   *  back to body substring checks). */
  meta?: { kind: "push-conflict"; ticket: string; rel: string | null };
}

export function sha256(s: string): string {
  return `sha256-${createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12)}`;
}

export function ticketSlug(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

/** @internal — single sanctioned emitter (pull + conflict snapshot); quote-aware */ 
export function frontMatter(state: string, assignee: string, labels: string[], priority: string): string {
  // Minimal emitter: quote only when the value would confuse the Phase 3
  // line parser (commas, newlines, leading #/space). `type:bug` stays bare;
  // the parser JSON.parse-fallbacks anything quoted.
  const q = (s: string) => (/,|\n|^#|^\s/.test(s) ? JSON.stringify(s) : s);
  return `---\nstate: ${q(state)}\nassignee: ${q(assignee)}\nlabels: [${labels.map((l) => q(l)).join(", ")}]\npriority: ${q(priority)}\n---\n`;
}

interface PullCtx {
  p: Plane;
  projectId: string;
  stateById: Map<string, string>; // state uuid -> CLI token
  labelById: Map<string, string>; // label uuid -> board name
  seatByMember: Map<string, string>; // member uuid -> seat (email local-part)
  visited: Set<string>;
  kids: Array<{ rel: string; uuid: string; rev: string; bodySha: string; fileSha: string }>;
  root: string; // mount dir (kids rel paths resolve against it)
}

/**
 * I9 (review): sibling dir for a child. Same-titled siblings must not map
 * to one dir (initial pull overwrote, adopt silently skipped). Deterministic
 * rule: `slug` unless ANOTHER sibling of the same parent slugifies to the
 * same name, or an existing baseline (different uuid) already claims the
 * plain-slug dir → `slug-<uuid8>`. Stable across pulls: the collision set
 * comes from server siblings + recorded baselines, not pull order.
 */
function childRelFor(ctx: PullCtx, child: Raw, siblingTitles: string[], existingRels: string[] = []): string {
  const slug = ticketSlug(String(child.name ?? child.id), String(child.id).slice(0, 8));
  const siblingDupe = siblingTitles.filter((t) => ticketSlug(t, "x") === slug).length > 1;
  const kidDupe =
    ctx.kids.some((k) => k.uuid !== String(child.id) && k.rel === `sub-tickets/${slug}`) ||
    existingRels.some((r) => r === `sub-tickets/${slug}`);
  // Suffix = the full id slugified (mock ids like "is-twin-a" share an
  // 8-char prefix; a short slice would re-collide — I9's exact trap).
  const name = siblingDupe || kidDupe ? `${slug}-${ticketSlug(String(child.id), "id")}` : slug;
  return `sub-tickets/${name}`;
}

async function pullOne(ctx: PullCtx, issue: Raw, dir: string): Promise<{ rev: string; bodySha: string; fileSha: string }> {
  const uuid = String(issue.id);
  ctx.visited.add(uuid);
  mkdirSync(dir, { recursive: true });

  const stateToken = ctx.stateById.get(String(issue.state)) ?? String(issue.state);
  const assignees = (Array.isArray(issue.assignees) ? issue.assignees : []).map((a: unknown) =>
    typeof a === "string" ? a : (a as Raw)?.id,
  ).filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
  const seat = assignees.length ? (ctx.seatByMember.get(assignees[0]!) ?? assignees[0]!) : "";
  const labels = (Array.isArray(issue.labels) ? issue.labels : []).map((l: unknown) => {
    const id = typeof l === "string" ? l : (l as Raw)?.id;
    return typeof id === "string" ? (ctx.labelById.get(id) ?? id) : null;
  }).filter((s: unknown): s is string => typeof s === "string");
  const body = htmlToText(String(issue.description_html ?? ""));
  const md = `${frontMatter(stateToken, seat, labels, String(issue.priority ?? "none"))}# ${String(issue.name ?? uuid)}\n\n${body}\n`;
  writeFileSync(join(dir, "ticket.md"), md);
  // Baseline tracks the BODY text only: front-matter edits must not read as
  // body changes (the whole-file sha would flag every state/label edit).
  const bodySha = sha256(body);
  const fileSha = sha256(md);

  // Children (recursive) — grandchildren nest per §29.7 tree rules.
  // Baselines recorded on the ctx so push can revision-guard children
  // without registry rows.
  const all = await ctx.p.listIssues({}, 10, ctx.projectId);
  const kids = all.filter((i) => String(i.parent ?? "") === uuid && !ctx.visited.has(String(i.id)));
  const siblingTitles = kids.map((k) => String(k.name ?? ""));
  for (const child of kids) {
    const rel = childRelFor(ctx, child, siblingTitles, ctx.kids.map((k) => k.rel));
    const childDir = join(dir, rel);
    const r = await pullOne(ctx, child, childDir);
    ctx.kids.push({ rel: relative(ctx.root, childDir), uuid: String(child.id), rev: r.rev, bodySha: r.bodySha, fileSha: r.fileSha });
  }

  // I5 (review): EVERY ticket in the tree gets its own comment home — the
  // child's `.plane/comments.events.jsonl` is where child-dir pending rows
  // post from (pushOne reads the dir it is given). Server comments merge by
  // id; local pending/posting rows survive (never drop unposted work).
  try {
    const rawComments = (await ctx.p.request("GET", `${ctx.p.projectPathFor(ctx.projectId)}/issues/${uuid}/comments/`)) as Raw;
    await mergeServerComments(dir, rawComments, ctx.seatByMember);
  } catch { /* comments are best-effort on pull — the ticket.md landed */ }

  const rev = String(issue.updated_at ?? "");
  return { rev, bodySha, fileSha };
}

/** Merge server comments into a dir's events file (root OR child). */
async function mergeServerComments(dir: string, rawComments: Raw, seatByMember: Map<string, string>): Promise<number> {
  const list = (((rawComments as Raw).results ?? rawComments) as Raw[]).slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  let added = 0;
  await updateEvents(dir, (stored) => {
    const prior = stored as SyncEvent[];
    const knownIds = new Set(prior.filter((e) => e.status === "synced" && e.id).map((e) => e.id as string));
    for (const c of list) {
      if (knownIds.has(String(c.id))) continue;
      const body = htmlToText(String(c.comment_html ?? ""));
      const actor = String(c.actor ?? "");
      prior.push({
        event: c.parent ? "reply" : "add",
        op: randomUUID(),
        id: String(c.id),
        parent: c.parent ? String(c.parent) : null,
        author: seatByMember.get(actor) ?? actor,
        body,
        body_sha: sha256(body),
        at: String(c.created_at ?? ""),
        status: "synced",
      } as SyncEvent);
      added++;
    }
    return undefined;
  });
  return added;
}

function buildCtx(p: Plane, mount: SyncMount, members: Raw[], states: Record<string, string>, labels: Record<string, string>): PullCtx {
  return {
    p,
    projectId: mount.projectId,
    stateById: new Map(Object.entries(states).map(([token, id]) => [id, token])),
    labelById: new Map(Object.entries(labels).map(([name, id]) => [id, name])),
    seatByMember: new Map(
      // Seat = display_name first (the CLI's own member-matching surface),
      // email local-part as fallback.
      (Array.isArray(members) ? members : []).map((m) => [String(m.id), String(m.display_name || String(m.email ?? "").split("@")[0] || m.id)]),
    ),
    visited: new Set<string>(),
    kids: [],
    root: mount.dir,
  };
}

export async function pullTicket(p: Plane, mount: SyncMount): Promise<{ rev: string; bodySha: string; fileSha: string; comments: number; children: number; kids: Array<{ rel: string; uuid: string; rev: string; bodySha: string; fileSha: string }> }> {
  const [issue, rawComments, members, states, labels] = await Promise.all([
    p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/`) as Promise<Raw>,
    p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/comments/`) as Promise<Raw>,
    p.request("GET", `${p.base()}/members/`) as Promise<Raw[]>,
    p.stateMap(mount.projectId),
    p.labelMap(mount.projectId),
  ]);
  const ctx = buildCtx(p, mount, members, states, labels);
  const { rev, bodySha, fileSha } = await pullOne(ctx, issue, mount.dir);
  const children = ctx.visited.size - 1;

  // Existing comments → synced events + derived snapshot (root; children
  // got theirs inside pullOne). Local pending/posting rows SURVIVE the
  // rewrite (re-pull must never drop unposted work); server rows already
  // present (by id) are not duplicated. Conflict rows are CONVERTED to
  // "resolved": a completed pull means the server state is now the local
  // state — the conflict is resolved (server-wins), so its notice row
  // becomes terminal audit (I2 race: pull-then-force and force-then-pull
  // both preserve the audit marker). Stale .conflict snapshots are litter
  // and deleted after the lock.
  let kept = 0;
  await updateEvents(mount.dir, (stored) => {
    const prior = stored as SyncEvent[];
    const surviving = prior.filter((e) => e.status === "pending" || e.status === "posting");
    kept = surviving.length;
    // "resolved" rows are terminal audit — they survive pulls like synced rows.
    const priorSynced = prior.filter((e) => e.status === "synced" || e.status === "resolved");
    // I2: convert conflict → resolved instead of dropping (makes both
    // pull-then-force and force-then-pull safe; audit survives either order).
    const priorConflictsAsResolved: SyncEvent[] = prior.filter((e) => e.status === "conflict").map((e) => ({ ...e, status: "resolved" as const }));
    const knownIds = new Set(priorSynced.filter((e) => e.id).map((e) => e.id as string));
    const list = (((rawComments as Raw).results ?? rawComments) as Raw[]).slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const fresh: SyncEvent[] = [];
    for (const c of list) {
      if (knownIds.has(String(c.id))) continue;
      const body = htmlToText(String(c.comment_html ?? ""));
      const actor = String(c.actor ?? "");
      fresh.push({
        event: c.parent ? "reply" : "add",
        op: randomUUID(),
        id: String(c.id),
        parent: c.parent ? String(c.parent) : null,
        author: ctx.seatByMember.get(actor) ?? actor,
        body,
        body_sha: sha256(body),
        at: String(c.created_at ?? ""),
        status: "synced",
      } as SyncEvent);
    }
    // Prior synced/resolved rows keep their ops (stable dedup keys); converted
    // conflict→resolved rows join them; fresh server rows append in time order;
    // local pending/posting rows stay verbatim.
    prior.length = 0;
    prior.push(...priorSynced, ...priorConflictsAsResolved, ...fresh, ...surviving);
  });
  const events = readEventsFile(mount.dir) as SyncEvent[];
  writeFileSync(
    join(metaDir(mount.dir), "comments.json"),
    JSON.stringify(events.map(({ id, parent, author, body, at, status }) => ({ id, parent, author, body, at, status })), null, 2) + "\n",
  );
  // Stale conflict snapshots: the pull just made server state local — any
  // .conflict file (root or child) describes a fight that is now over.
  try { rmSync(join(mount.dir, "ticket.md.conflict"), { force: true }); } catch { /* absent */ }
  for (const kid of ctx.kids) {
    try { rmSync(join(mount.dir, kid.rel, "ticket.md.conflict"), { force: true }); } catch { /* absent */ }
  }
  writeStatusFile(mount.dir, { ticket: mount.ticket, ready: kept === 0, lastPoll: new Date().toISOString(), pending: kept, rev });
  return { rev, bodySha, fileSha, comments: events.length, children, kids: ctx.kids };
}

/**
 * Adopt server-side children missing baselines (child creation doesn't bump
 * the parent rev — Plane-side fact). Pulls each newcomer into its slug dir
 * and returns the new baselines for the registry. Never touches existing
 * folders (locally edited children keep their files; push guards them).
 * I9: the dir respects sibling-slug collisions (same rule as pullOne).
 */
export async function adoptNewcomers(p: Plane, mount: SyncMount, newcomers: Raw[]): Promise<Array<{ rel: string; uuid: string; rev: string; bodySha: string; fileSha: string }>> {
  if (!newcomers.length) return [];
  const [members, states, labels] = await Promise.all([
    p.request("GET", `${p.base()}/members/`) as Promise<Raw[]>,
    p.stateMap(mount.projectId),
    p.labelMap(mount.projectId),
  ]);
  const ctx = buildCtx(p, mount, members, states, labels);
  // Sibling context for collision-aware dirs: newcomers + already-known kids.
  const siblingTitles = newcomers.map((c) => String(c.name ?? ""));
  const existingRels = (mount.kids ?? []).map((k) => k.rel);
  for (const child of newcomers) {
    const rel = childRelFor(ctx, child, siblingTitles, existingRels);
    const childDir = join(mount.dir, rel);
    if (existsSync(join(childDir, "ticket.md"))) continue;
    const full = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${String(child.id)}/`)) as Raw;
    const r = await pullOne(ctx, full, childDir);
    ctx.kids.push({ rel, uuid: String(child.id), rev: r.rev, bodySha: r.bodySha, fileSha: r.fileSha });
  }
  return ctx.kids;
}
