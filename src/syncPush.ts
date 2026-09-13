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
import { htmlToText } from "./api.ts";
import { countPendingEvents, readEventsFile, readMounts, writeMounts, writeStatusFile, type SyncMount } from "./sync.ts";
import { adoptNewcomers, pullTicket, sha256, type SyncEvent } from "./syncPull.ts";

export function countPending(dir: string): number {
  return countPendingEvents(dir);
}

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
    body: `refused: conflict — ${detail} on ${ticket} (local kept, server side in .conflict — resolve with \`sync ${ticket} --push-once --force\` for local-wins, or re-mount for server-wins)`,
    body_sha: sha256(`${ticket}:${detail}`),
    at: new Date().toISOString(),
    status: "conflict",
  };
}

function appendEvent(dir: string, e: SyncEvent): void {
  writeFileSync(join(dir, "comments.events.jsonl"), JSON.stringify(e) + "\n", { flag: "a" });
}

/** ONE notice per (server rev, base rev) pair: while a conflict sits
 *  unresolved, every poll cycle re-detects it — re-notifying each time
 *  would spam ~12 identical rows/min at the 5s cadence. */
function conflictAlreadyNoticed(dir: string, serverRev: string, baseRev: string | null): boolean {
  return readEvents(dir).some(
    (e) => e.status === "conflict" && e.body.includes(`server rev ${serverRev} vs local edits (base ${baseRev})`),
  );
}

function readEvents(dir: string): SyncEvent[] {
  return readEventsFile(dir) as SyncEvent[];
}

function writeEvents(dir: string, events: SyncEvent[]): void {
  writeFileSync(join(dir, "comments.events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  writeFileSync(
    join(dir, "comments.json"),
    JSON.stringify(events.map(({ id, parent, author, body, at, status }) => ({ id, parent, author, body, at, status })), null, 2) + "\n",
  );
}

export function countPending(dir: string): number {
  return countPendingEvents(dir);
}

/**
 * Restart reconcile (§29.6 durable pending-op): for every pending/conflict
 * row, re-list server comments — id known and landed → adopt + synced;
 * id unknown → match (author, parent, body_sha) → adopt; else leave pending
 * for the push to post under the SAME op (never re-post landed, never lose
 * unlanded).
 */
export async function reconcileEvents(p: Plane, mount: SyncMount): Promise<{ adopted: number; stillPending: number }> {
  const dir = mount.dir;
  const events = readEvents(dir);
  if (!events.some((e) => e.status === "pending" || e.status === "conflict")) return { adopted: 0, stillPending: 0 };
  const raw = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/comments/`)) as Raw;
  const server = (((raw as Raw).results ?? raw) as Raw[]).map((c) => ({
    id: String(c.id),
    parent: c.parent ? String(c.parent) : null,
    author: String(c.actor ?? ""),
    body: String(c.comment_html ?? ""),
  }));
  let adopted = 0;
  for (const e of events) {
    if (e.status !== "pending" && e.status !== "conflict") continue;
    if (e.id && server.some((c) => c.id === e.id)) {
      e.status = "synced";
      adopted++;
      continue;
    }
    // Match by author display/seat? Server actor is a member id; event author
    // is a seat. Match on parent + body text containment both ways is too
    // loose — match parent + identical posted-HTML shape instead: the daemon
    // posts `<p>${esc(body)}</p>`, so compare against that rendering.
    const rendered = `<p>${e.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`;
    const hit = server.find((c) => (c.parent ?? null) === (e.parent ?? null) && c.body === rendered);
    if (hit) {
      e.id = hit.id;
      e.status = "synced";
      adopted++;
    }
  }
  writeEvents(dir, events);
  return { adopted, stillPending: events.filter((e) => e.status === "pending").length };
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
  const bodySha = sha256(body);
  if (bodySha !== mount.lastBodySha) {
    patch.description_html = body.split("\n").map((l) => `<p>${esc(l) || "<br>"}</p>`).join("");
    pushed.push("body");
  }

  if (Object.keys(patch).length) {
    await p.patchIssue(mount.uuid, patch, mount.projectId);
  }

  // Pending comment events post verbatim (agents stamp per §2.1).
  // NOTE: the v1 create serializer accepts no `parent` field (verified
  // against plane-backend v1.4.1 IssueCommentCreateSerializer) — threaded
  // replies land flat server-side. Parent is still recorded in the events
  // file (reconcile matching + future API support); the §29.6 quote rule
  // (quote the referenced passage inline as `> quote`) carries the thread
  // context in-body instead.
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

export async function pushTicket(p: Plane, mount: SyncMount, opts?: { force?: boolean }): Promise<PushResult> {
  const dir = mount.dir;
  if (!existsSync(join(dir, "ticket.md"))) {
    throw Object.assign(new Error(`refused: missing-ticket — no ticket.md in ${dir} (mount pulled nothing?)`), {
      refusal: { refused: true, rule: "missing-ticket", ticket: mount.ticket, detail: dir, remedy: "re-mount or restore ticket.md" } as PushRefusal,
    });
  }
  const ticket = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/`)) as Raw;
  const serverRev = String(ticket.updated_at ?? "");
  // Reconcile BEFORE any post: a previous run may have landed a comment
  // without recording its id (kill-mid-push) — adopt instead of duplicating.
  await reconcileEvents(p, mount);
  // Pull new server comments that don't bump the issue rev (comments are
  // separate from updated_at). Merge by id, keep pending rows.
  {
    const raw = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/comments/`)) as Raw;
    const server = (((raw as any).results ?? raw) as Raw[]).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const prior = readEventsFile(dir) as SyncEvent[];
    const known = new Set(prior.filter((e) => e.id).map((e) => e.id as string));
    const members = (await p.request("GET", `${p.base()}/members/`)) as Raw[];
    const seatByMember = new Map((Array.isArray(members) ? members : []).map((m) => [String(m.id), String(m.display_name || String(m.email ?? "").split("@")[0] || m.id)]));
    let added = 0;
    for (const c of server) {
      const id = String(c.id);
      if (known.has(id)) continue;
      const body = htmlToText(String(c.comment_html ?? ""));
      prior.push({
        event: c.parent ? "reply" : "add",
        op: `server-${id.slice(0,8)}`,
        id,
        parent: c.parent ? String(c.parent) : null,
        author: seatByMember.get(String(c.actor ?? "")) ?? String(c.actor ?? ""),
        body,
        body_sha: sha256(body),
        at: String(c.created_at ?? ""),
        status: "synced",
      } as SyncEvent);
      added++;
    }
    if (added) {
      writeFileSync(join(dir, "comments.events.jsonl"), prior.map((e) => JSON.stringify(e)).join("\n") + (prior.length ? "\n" : ""));
      writeFileSync(join(dir, "comments.json"), JSON.stringify(prior.map(({ id, parent, author, body, at, status }) => ({ id, parent, author, body, at, status })), null, 2) + "\n");
    }
  }
  const md = readFileSync(join(dir, "ticket.md"), "utf8");
  const localChanged = sha256(md) !== mount.lastFileSha;
  const serverChanged = mount.lastRev !== null && serverRev !== mount.lastRev;

  if (serverChanged && localChanged && !opts?.force) {
    // Conflict: local kept, server side aside, ONE notice, push nothing.
    // --force (manual `sync TC-N --push-once --force` only, never the daemon)
    // skips this branch: local wins, baselines follow the push below.
    writeFileSync(join(dir, "ticket.md.conflict"), JSON.stringify(ticket, null, 2) + "\n");
    if (!conflictAlreadyNoticed(dir, serverRev, mount.lastRev))
      appendEvent(dir, conflictNotice(mount.ticket, `server rev ${serverRev} vs local edits (base ${mount.lastRev})`));
    return { ticket: mount.ticket, pushed: [], comments: 0, rev: mount.lastRev ?? serverRev };
  }
  // Child arrivals don't bump the parent rev (Plane-side fact, proven live):
  // adopt any server child missing a baseline — but never clobber a locally
  // edited child (its sha differs from baseline → handled in the recurse
  // below with the same conflict shape as root).
  const knownUuids = new Set((mount.kids ?? []).map((k) => k.uuid));
  const serverKids = (await p.listIssues({}, 10, mount.projectId)).filter((i) => String(i.parent ?? "") === mount.uuid);
  const newcomers = serverKids.filter((k) => !knownUuids.has(String(k.id)));
  // Locally edited children (whole-file sha vs baseline): the re-pull below
  // must not clobber them — the recurse handles each child individually.
  const editedKids = (mount.kids ?? []).filter((k) => {
    const f = join(dir, k.rel, "ticket.md");
    return existsSync(f) && sha256(readFileSync(f, "utf8")) !== k.fileSha;
  });
  if (serverChanged && !localChanged && !editedKids.length) {
    // Server-only move: re-pull wins (local files refresh, baselines follow).
    const pulled = await pullTicket(p, mount);
    const mounts = readMounts();
    writeMounts(mounts.map((m) => (m.ticket === mount.ticket ? { ...m, lastRev: pulled.rev, lastBodySha: pulled.bodySha, lastFileSha: pulled.fileSha, kids: pulled.kids, lastPoll: new Date().toISOString() } : m)));
    return { ticket: mount.ticket, pushed: ["pulled"], comments: 0, rev: pulled.rev };
  }
  const r = await pushOne(p, mount, dir, ticket);

  // Adopt server-side newcomers (pulled into slug dirs + baselined), then
  // recurse into known children (registry baselines; unknown local dirs are
  // creation flow — a later phase, ignored here).
  const adopted = await adoptNewcomers(p, mount, newcomers);
  const pushed = [...r.pushed, ...adopted.map((k) => `+${k.rel}`)];
  if (opts?.force && serverChanged && localChanged) pushed.unshift("forced");
  let comments = r.comments;
  let kids = [...(mount.kids ?? []), ...adopted];
  for (const kid of kids) {
    const childDir = join(dir, kid.rel);
    const childMd = join(childDir, "ticket.md");
    if (!existsSync(childMd)) continue;
    if (sha256(readFileSync(childMd, "utf8")) === kid.fileSha) continue;
    const childTicket = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${kid.uuid}/`)) as Raw;
    const childRev = String(childTicket.updated_at ?? "");
    if (childRev !== kid.rev && !opts?.force) {
      writeFileSync(`${childMd}.conflict`, JSON.stringify(childTicket, null, 2) + "\n");
      if (!conflictAlreadyNoticed(dir, childRev, kid.rev))
        appendEvent(dir, conflictNotice(mount.ticket, `child ${kid.rel}: server rev ${childRev} vs local edits (base ${kid.rev})`));
      continue;
    }
    const childMount: SyncMount = { ...mount, uuid: kid.uuid, lastBodySha: kid.bodySha };
    const cr = await pushOne(p, childMount, childDir, childTicket);
    comments += cr.comments;
    if (cr.pushed.length) pushed.push(`${kid.rel}: ${cr.pushed.join(",")}`);
    const afterChild = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${kid.uuid}/`)) as Raw;
    const newFileSha = sha256(readFileSync(childMd, "utf8"));
    const newSha = sha256(parseTicketMd(readFileSync(childMd, "utf8")).body);
    kids = kids.map((k) => (k.uuid === kid.uuid ? { ...k, rev: String(afterChild.updated_at ?? ""), bodySha: newSha, fileSha: newFileSha } : k));
  }

  const mounts = readMounts();
  const livePending = countPendingEvents(dir);
  const fileShaNow = sha256(readFileSync(join(dir, "ticket.md"), "utf8"));
  const next = { ...mounts.find((m) => m.ticket === mount.ticket)!, lastRev: r.rev, lastBodySha: r.bodySha, lastFileSha: fileShaNow, kids, lastPoll: new Date().toISOString(), pending: livePending };
  writeMounts(mounts.map((m) => (m.ticket === mount.ticket ? next : m)));
  writeStatusFile(dir, { ticket: mount.ticket, ready: livePending === 0, lastPoll: next.lastPoll, pending: livePending, rev: next.lastRev });
  return { ticket: mount.ticket, pushed, comments, rev: r.rev };
}
