/**
 * TC-95 (§29.8) Phase 2 — one-shot pull: ticket → folder.
 *
 * Writes `<dir>/ticket.md` (front-matter + title + body), `sub-tickets/`
 * (one `ticket.md` per child, recursive), `comments.events.jsonl` (existing
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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { htmlToText, type Plane, type Raw } from "./api.ts";
import type { SyncMount } from "./sync.ts";

export interface SyncEvent {
  event: "add" | "reply" | "resolve";
  op: string;
  id: string | null;
  parent: string | null;
  author: string;
  body: string;
  body_sha: string;
  at: string;
  status: "pending" | "synced" | "conflict";
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

function frontMatter(state: string, assignee: string, labels: string[], priority: string): string {
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
}

async function pullOne(ctx: PullCtx, issue: Raw, dir: string): Promise<{ rev: string; bodySha: string }> {
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
  const bodySha = sha256(md);

  // Children (recursive) — grandchildren nest per §29.7 tree rules.
  const all = await ctx.p.listIssues({}, 10, ctx.projectId);
  for (const child of all.filter((i) => String(i.parent ?? "") === uuid && !ctx.visited.has(String(i.id)))) {
    const slug = ticketSlug(String(child.name ?? child.id), String(child.id).slice(0, 8));
    await pullOne(ctx, child, join(dir, "sub-tickets", slug));
  }
  return { rev: String(issue.updated_at ?? ""), bodySha };
}

export async function pullTicket(p: Plane, mount: SyncMount): Promise<{ rev: string; bodySha: string; comments: number; children: number }> {
  const [issue, rawComments, members, states, labels] = await Promise.all([
    p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/`) as Promise<Raw>,
    p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/comments/`) as Promise<Raw>,
    p.request("GET", `${p.base()}/members/`) as Promise<Raw[]>,
    p.stateMap(mount.projectId),
    p.labelMap(mount.projectId),
  ]);
  const ctx: PullCtx = {
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
  };
  const { rev, bodySha } = await pullOne(ctx, issue, mount.dir);
  const children = ctx.visited.size - 1;

  // Existing comments → synced events (server ids known) + derived snapshot.
  const list = (((rawComments as Raw).results ?? rawComments) as Raw[]).slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const seatByMember = ctx.seatByMember;
  const events: SyncEvent[] = list.map((c) => {
    const body = htmlToText(String(c.comment_html ?? ""));
    const actor = String(c.actor ?? "");
    return {
      event: c.parent ? "reply" : "add",
      op: randomUUID(),
      id: String(c.id),
      parent: c.parent ? String(c.parent) : null,
      author: seatByMember.get(actor) ?? actor,
      body,
      body_sha: sha256(body),
      at: String(c.created_at ?? ""),
      status: "synced",
    } as SyncEvent;
  });
  writeFileSync(join(mount.dir, "comments.events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  writeFileSync(
    join(mount.dir, "comments.json"),
    JSON.stringify(events.map(({ id, parent, author, body, at, status }) => ({ id, parent, author, body, at, status })), null, 2) + "\n",
  );
  return { rev, bodySha, comments: events.length, children };
}
