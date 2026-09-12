/**
 * TC-95 (§29.8) Phase 3 — one-shot push: folder → ticket.
 *
 * Applies local edits with the same call-time checks as the tc/plane verbs:
 * - drift (server updated_at vs mount.lastRev) + local change (bodySha vs
 *   mount.lastBodySha): both moved → conflict (local kept, `.conflict` copy
 *   of the server side, ONE conflict notice in comments.events.jsonl, push
 *   nothing). Server-only move → re-pull wins. Local-only → push.
 * - §30.3 checks (intent-claim, 3-cap, budgets) are TC-63's shape; the
 *   refusal carrier here is interim: {refused, rule, ticket, detail, remedy}
 *   plus the conflict event (never silent, never a dropped edit).
 * - pending comment events post verbatim (agents stamp bodies per §2.1);
 *   rows flip to synced with the server id; comments.json rebuilds.
 * - crash-safe order lives here: rows are already pending BEFORE this runs
 *   (agents append first); restart reconcile is Phase 4 (daemon).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plane, Raw } from "./api.ts";
import { readMounts, writeMounts, type SyncMount } from "./sync.ts";
import { pullTicket, sha256, type SyncEvent } from "./syncPull.ts";

export interface PushRefusal {
  refused: true;
  rule: string;
  ticket: string;
  detail: string;
  remedy: string;
}

export interface PushResult {
  ticket: string;
  pushed: string[]; // field names applied
  comments: number; // pending events posted
  rev: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface FrontMatter {
  state: string;
  assignee: string;
  labels: string[];
  priority: string;
}

function parseList(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return t ? [t] : [];
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  try {
    const parsed: unknown = JSON.parse(`[${inner}]`);
    if (Array.isArray(parsed)) return parsed.map((x) => String(x));
  } catch { /* fall through to comma split */ }
  return inner.split(",").map((s) => {
    const v = s.trim();
    return v.startsWith('"') && v.endsWith('"') ? JSON.parse(v) : v;
  });
}

export function parseTicketMd(text: string): { fm: FrontMatter; title: string; body: string } {
  const fm: FrontMatter = { state: "", assignee: "", labels: [], priority: "" };
  let rest = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      for (const line of text.slice(4, end).split("\n")) {
        const i = line.indexOf(":");
        if (i === -1) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k === "labels") fm.labels = parseList(v);
        else if (k === "state" || k === "assignee" || k === "priority") fm[k] = v.startsWith('"') && v.endsWith('"') ? JSON.parse(v) : v;
      }
      rest = text.slice(end + 5);
    }
  }
  const lines = rest.split("\n");
  let title = "";
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (!title && line.startsWith("# ")) title = line.slice(2).trim();
    else bodyLines.push(line);
  }
  return { fm, title, body: bodyLines.join("\n").trim() };
}

function conflictNotice(ticket: string, detail: string): SyncEvent {
  return {
    event: "add",
    op: `conflict-${Date.now()}`,
    id: null,
    parent: null,
    author: "sync-daemon",
    body: `refused: conflict — ${detail} on ${ticket} (local kept, server side in .conflict — resolve, then re-push)`,
    body_sha: sha256(`${ticket}:${detail}`),
    at: new Date().toISOString(),
    status: "conflict",
  };
}

function appendEvent(dir: string, e: SyncEvent): void {
  writeFileSync(join(dir, "comments.events.jsonl"), JSON.stringify(e) + "\n", { flag: "a" });
}

function readEvents(dir: string): SyncEvent[] {
  const f = join(dir, "comments.events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SyncEvent);
}

function writeEvents(dir: string, events: SyncEvent[]): void {
  writeFileSync(join(dir, "comments.events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  writeFileSync(
    join(dir, "comments.json"),
    JSON.stringify(events.map(({ id, parent, author, body, at, status }) => ({ id, parent, author, body, at, status })), null, 2) + "\n",
  );
}

async function pushOne(p: Plane, mount: SyncMount, dir: string, ticket: Raw): Promise<{ pushed: string[]; comments: number; rev: string; bodySha: string }> {
  const pushed: string[] = [];
  const md = readFileSync(join(dir, "ticket.md"), "utf8");
  const { fm, title, body } = parseTicketMd(md);
  const patch: Raw = {};

  // State (CLI token → server id).
  if (fm.state) {
    const sm = await p.stateMap(mount.projectId);
    const id = sm[fm.state];
    if (!id) {
      const r: PushRefusal = { refused: true, rule: "unknown-state", ticket: mount.ticket, detail: `no '${fm.state}' state on the board`, remedy: "use a listed state token" };
      appendEvent(dir, conflictNotice(mount.ticket, `${r.rule}: ${r.detail}`));
      throw Object.assign(new Error(`refused: ${r.rule} — ${r.detail} (${r.remedy})`), { refusal: r });
    }
    if (String(ticket.state) !== id) {
      patch.state = id;
      pushed.push("state");
    }
  }
  // Assignee (seat → member id; empty = unassign).
  if (fm.assignee !== undefined) {
    const members = (await p.request("GET", `${p.base()}/members/`)) as Raw[];
    const list = Array.isArray(members) ? members : [];
    const seat = fm.assignee.trim();
    let want: string[] = [];
    if (seat) {
      const m = list.find((x) => x.display_name === seat || String(x.email ?? "").split("@")[0] === seat);
      if (!m) {
        const r: PushRefusal = { refused: true, rule: "unknown-assignee", ticket: mount.ticket, detail: `no member '${seat}' on the roster`, remedy: "use a roster seat name or empty to unassign" };
        appendEvent(dir, conflictNotice(mount.ticket, `${r.rule}: ${r.detail}`));
        throw Object.assign(new Error(`refused: ${r.rule} — ${r.detail} (${r.remedy})`), { refusal: r });
      }
      want = [String(m.id)];
    }
    const have = (Array.isArray(ticket.assignees) ? ticket.assignees : []).map((a: unknown) => (typeof a === "string" ? a : (a as Raw)?.id)).filter(Boolean).sort();
    if (JSON.stringify(have) !== JSON.stringify([...want].sort())) {
      patch.assignees = want;
      pushed.push("assignee");
    }
  }
  // Labels (board names → ids).
  if (fm.labels.length) {
    const lm = await p.labelMap(mount.projectId);
    const ids: string[] = [];
    for (const name of fm.labels) {
      const id = lm[name];
      if (!id) {
        const r: PushRefusal = { refused: true, rule: "unknown-label", ticket: mount.ticket, detail: `no label '${name}' on the board`, remedy: "plane sync then retry" };
        appendEvent(dir, conflictNotice(mount.ticket, `${r.rule}: ${r.detail}`));
        throw Object.assign(new Error(`refused: ${r.rule} — ${r.detail} (${r.remedy})`), { refusal: r });
      }
      ids.push(id);
    }
    const have = (Array.isArray(ticket.labels) ? ticket.labels : []).map((l: unknown) => {
      const id = typeof l === "string" ? l : (l as Raw)?.id;
      return typeof id === "string" ? (Object.entries(lm).find(([, v]) => v === id)?.[0] ?? id) : null;
    }).filter(Boolean).sort();
    if (JSON.stringify(have) !== JSON.stringify([...fm.labels].sort())) {
      patch.labels = ids;
      pushed.push("labels");
    }
  }
  // Priority.
  if (fm.priority && !["urgent", "high", "medium", "low", "none"].includes(fm.priority)) {
    const r: PushRefusal = { refused: true, rule: "unknown-priority", ticket: mount.ticket, detail: `invalid priority '${fm.priority}'`, remedy: "urgent|high|medium|low|none" };
    appendEvent(dir, conflictNotice(mount.ticket, `${r.rule}: ${r.detail}`));
    throw Object.assign(new Error(`refused: ${r.rule} — ${r.detail} (${r.remedy})`), { refusal: r });
  }
  if (fm.priority && String(ticket.priority ?? "none") !== fm.priority) {
    patch.priority = fm.priority;
    pushed.push("priority");
  }
  // Title + body.
  if (title && title !== String(ticket.name ?? "")) {
    patch.name = title;
    pushed.push("title");
  }
  const bodySha = sha256(md);
  if (bodySha !== mount.lastBodySha) {
    patch.description_html = body.split("\n").map((l) => `<p>${esc(l) || "<br>"}</p>`).join("");
    pushed.push("body");
  }

  if (Object.keys(patch).length) {
    await p.patchIssue(mount.uuid, patch, mount.projectId);
  }

  // Pending comment events post verbatim (agents stamp per §2.1).
  const events = readEvents(dir);
  let posted = 0;
  for (const e of events) {
    if (e.status !== "pending") continue;
    const res = (await p.postComment(mount.uuid, `<p>${esc(e.body)}</p>`, e.parent ?? undefined, mount.projectId)) as Raw;
    e.id = String(res.id ?? res.comment_id ?? "");
    e.status = "synced";
    posted++;
  }
  if (posted) writeEvents(dir, events);

  const after = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/`)) as Raw;
  return { pushed, comments: posted, rev: String(after.updated_at ?? ""), bodySha };
}

export async function pushTicket(p: Plane, mount: SyncMount): Promise<PushResult> {
  const dir = mount.dir;
  if (!existsSync(join(dir, "ticket.md"))) {
    throw Object.assign(new Error(`refused: missing-ticket — no ticket.md in ${dir} (mount pulled nothing?)`), {
      refusal: { refused: true, rule: "missing-ticket", ticket: mount.ticket, detail: dir, remedy: "re-mount or restore ticket.md" } as PushRefusal,
    });
  }
  const ticket = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/`)) as Raw;
  const serverRev = String(ticket.updated_at ?? "");
  const md = readFileSync(join(dir, "ticket.md"), "utf8");
  const localChanged = sha256(md) !== mount.lastBodySha;
  const serverChanged = mount.lastRev !== null && serverRev !== mount.lastRev;

  if (serverChanged && localChanged) {
    // Conflict: local kept, server side aside, ONE notice, push nothing.
    writeFileSync(join(dir, "ticket.md.conflict"), JSON.stringify(ticket, null, 2) + "\n");
    appendEvent(dir, conflictNotice(mount.ticket, `server rev ${serverRev} vs local edits (base ${mount.lastRev})`));
    return { ticket: mount.ticket, pushed: [], comments: 0, rev: mount.lastRev ?? serverRev };
  }
  if (serverChanged && !localChanged) {
    // Server-only move: re-pull wins (Phase 2 pull reused via fresh mount?
    // no — just report; the daemon re-pulls. One-shot returns pulled).
    return { ticket: mount.ticket, pushed: ["pulled"], comments: 0, rev: serverRev };
  }
  if (serverChanged && !localChanged) {
    // Server-only move: re-pull wins (local files refresh, baselines follow).
    const pulled = await pullTicket(p, mount);
    const mounts = readMounts();
    writeMounts(mounts.map((m) => (m.ticket === mount.ticket ? { ...m, lastRev: pulled.rev, lastBodySha: pulled.bodySha, kids: pulled.kids, lastPoll: new Date().toISOString() } : m)));
    return { ticket: mount.ticket, pushed: ["pulled"], comments: 0, rev: pulled.rev };
  }
  const r = await pushOne(p, mount, dir, ticket);

  // Recurse into known children (registry baselines; unknown local dirs are
  // creation flow — a later phase, ignored here).
  const pushed = [...r.pushed];
  let comments = r.comments;
  let kids = mount.kids;
  for (const kid of mount.kids) {
    const childDir = join(dir, kid.rel);
    const childMd = join(childDir, "ticket.md");
    if (!existsSync(childMd)) continue;
    if (sha256(readFileSync(childMd, "utf8")) === kid.bodySha) continue;
    const childTicket = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${kid.uuid}/`)) as Raw;
    const childRev = String(childTicket.updated_at ?? "");
    if (childRev !== kid.rev) {
      writeFileSync(`${childMd}.conflict`, JSON.stringify(childTicket, null, 2) + "\n");
      appendEvent(dir, conflictNotice(mount.ticket, `child ${kid.rel}: server rev ${childRev} vs local edits (base ${kid.rev})`));
      continue;
    }
    const childMount: SyncMount = { ...mount, uuid: kid.uuid, lastBodySha: kid.bodySha };
    const cr = await pushOne(p, childMount, childDir, childTicket);
    comments += cr.comments;
    if (cr.pushed.length) pushed.push(`${kid.rel}: ${cr.pushed.join(",")}`);
    const afterChild = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${kid.uuid}/`)) as Raw;
    const newSha = sha256(readFileSync(childMd, "utf8"));
    kids = kids.map((k) => (k.uuid === kid.uuid ? { ...k, rev: String(afterChild.updated_at ?? ""), bodySha: newSha } : k));
  }

  const mounts = readMounts();
  writeMounts(mounts.map((m) => (m.ticket === mount.ticket ? { ...m, lastRev: r.rev, lastBodySha: r.bodySha, kids, lastPoll: new Date().toISOString(), pending: 0 } : m)));
  return { ticket: mount.ticket, pushed, comments, rev: r.rev };
}
