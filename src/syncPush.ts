/**
 * TC-95 (§29.8) Phase 3 — one-shot push: folder → ticket.
 *
 * Applies local edits with the same call-time checks as the tc/plane verbs:
 * - drift (server updated_at vs mount.lastRev) + local change (fileSha vs
 *   mount.lastFileSha): both moved → conflict (local kept, `.conflict` copy
 *   of the server side, ONE conflict notice in comments.events.jsonl, push
 *   nothing). Server-only move → re-pull wins. Local-only → push.
 * - §30.3 checks (review C7/I1/I7/I8): the intent-claim gate runs ONLY when
 *   the computed patch actually changes state fields (never on pure comment
 *   drains or body edits), reads the workspace from the resolved config
 *   (not raw env), FAILS CLOSED on an unreadable journal (the gate must not
 *   disable itself exactly when the other writer is active), and RE-READS
 *   the claim immediately before the PATCH (check-then-act narrowed to one
 *   round-trip; documented as advisory — no server-side CAS exists).
 * - C6: the revision guard re-fetches the issue immediately before the
 *   PATCH; a rev moved mid-push aborts to the conflict path (never
 *   overwrites, never baselines-over).
 * - C5 crash-safe posting: the §2.1 msg_id is PERSISTED before the POST
 *   (row status "posting"), flipped to synced after; restart reconcile
 *   adopts by stamp substring — no double-post, no lost post.
 * - Event-file rewrites ALL go through updateEvents (lock + merge, C2);
 *   registry rewrites through updateMounts (C1).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Plane, Raw } from "./api.ts";
import { htmlToText } from "./api.ts";
import { readEventsFile, updateMounts, updateEvents, withEventsLock, writeStatusFile, metaDir, countPendingEvents, type SyncMount, type StoredEvent } from "./sync.ts";
import { adoptNewcomers, pullTicket, sha256, frontMatter, type SyncEvent } from "./syncPull.ts";

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

function conflictNotice(ticket: string, detail: string, rel: string | null = null): SyncEvent {
  return {
    event: "add",
    op: `conflict-${Date.now()}-${randomUUID().slice(0, 8)}`,
    id: null,
    parent: null,
    author: "sync-daemon",
    body: `refused: conflict — ${detail} on ${ticket} (local kept, server side in ticket.md.conflict as markdown — same format as ticket.md, diff them — resolve with \`sync ${ticket} --push-once --force\` for local-wins, or re-mount for server-wins)`,
    body_sha: sha256(`${ticket}:${detail}`),
    at: new Date().toISOString(),
    status: "conflict",
    meta: { kind: "push-conflict", ticket, rel },
  };
}

interface ConflictSnapshotCtx {
  handle: string;
  baseRev: string | null;
  serverRev: string;
  at: string;
  stateById: Map<string, string>;
  labelById: Map<string, string>;
  seatByMember: Map<string, string>;
  /** Mount handle used in the resolve hint; defaults to `handle`. Child
   *  snapshots pass the parent handle so the hint names a real mount. */
  resolveHandle?: string;
  /** M3: for child snapshots, the relative dir (e.g. sub-tickets/foo); when set,
   *  provenance prints `child: <rel>` alongside `ticket: <parent>`. */
  childRel?: string;
}

/**
 * M3: readable conflict snapshot — same schema as ticket.md so agents diff
 * two same-format files with normal tools. The HTML comment is invisible in
 * rendered markdown but greppable (provenance: base/server revs, timestamp,
 * resolve hints). The ticket.md portion byte-matches pullTicket's rendering
 * for the same server issue (same frontMatter emitter, same `# title`, same
 * htmlToText body).
 */
function renderConflictSnapshot(ticket: Raw, ctx: ConflictSnapshotCtx): string {
  const uuid = String(ticket.id ?? "");
  const stateToken = ctx.stateById.get(String(ticket.state)) ?? String(ticket.state);
  const assignees = (Array.isArray(ticket.assignees) ? ticket.assignees : []).map((a: unknown) =>
    typeof a === "string" ? a : (a as Raw)?.id,
  ).filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
  const seat = assignees.length ? (ctx.seatByMember.get(assignees[0]!) ?? assignees[0]!) : "";
  const labels = (Array.isArray(ticket.labels) ? ticket.labels : []).map((l: unknown) => {
    const id = typeof l === "string" ? l : (l as Raw)?.id;
    return typeof id === "string" ? (ctx.labelById.get(id) ?? id) : null;
  }).filter((s: unknown): s is string => typeof s === "string");
  const body = htmlToText(String(ticket.description_html ?? ""));
  const md = `${frontMatter(stateToken, seat, labels, String(ticket.priority ?? "none"))}# ${String(ticket.name ?? uuid)}\n\n${body}\n`;
  const resolveHandle = ctx.resolveHandle ?? ctx.handle;
  const provenanceLines = [
    `<!-- conflict snapshot: server side wins nothing yet — local file kept`,
    `ticket: ${ctx.handle}`,
    ...(ctx.childRel ? [`child: ${ctx.childRel}`] : []),
    `baseRev: ${ctx.baseRev ?? ""}`,
    `serverRev: ${ctx.serverRev}`,
    `at: ${ctx.at}`,
    `resolve: diff against ticket.md; \`sync ${resolveHandle} --push-once --force\` = local-wins, re-mount/pull = server-wins; never edit this file expecting it to sync -->`,
  ];
  const provenance = provenanceLines.join("\n");
  return `${provenance}\n\n${md}`;
}

/**
 * I3 (review): ONE notice per (ticket, rule, detail) — refusal paths run
 * every poll cycle while the condition holds; without dedup a blocked mount
 * spams ~12 identical rows/min. Dedup scope INCLUDES the ticket (M2): two
 * mounts sharing a dir must not suppress each other's notices.
 * I4 (review r2): meta-based dedup (exact ticket+rel) with body fallback for legacy rows.
 */
async function refuseOnce(dir: string, ticket: string, rule: string, detail: string, rel: string | null = null): Promise<void> {
  await updateEvents(dir, (events) => {
    const marker = `${rule}: ${detail}`;
    const already = (events as SyncEvent[]).some((e) => {
      if (e.status !== "conflict") return false;
      if (e.meta?.kind === "push-conflict") {
        return e.meta.ticket === ticket && (e.meta.rel ?? null) === (rel ?? null) && e.body.includes(marker);
      }
      return e.body.includes(marker) && e.body.includes(`on ${ticket}`);
    });
    if (!already) {
      events.push(conflictNotice(ticket, `${rule}: ${detail}`, rel));
    }
    return undefined;
  });
}

/**
 * §30.3 intent-claim check (daemon-side, call-time): a LIVE `pending_plane`
 * journal-intent claim from a DIFFERENT hand blocks the front-matter apply —
 * the ticket's Plane state is being mutated (or about to be) through the
 * teamctl journal outbox; racing it would double-write.
 *
 * Journal sidecar shape (teamctl src/journal.ts): `$TEAMCTL_STATE_HOME/
 * <workspace>/journals/<TC-N>.header.json` → `pending.plane = {entry, op,
 * attempts, last_error} | null`; the arming entry's seat lives in the
 * entries file (`<TC-N>.md`, `## <iso> — <kind> — <seat>` heading).
 *
 * Fail-closed (review I8): a journal that EXISTS but is unreadable returns
 * `unreadable` — the caller refuses (the gate must not disable itself
 * exactly when the other writer mutates the file, incl. torn writes).
 * A cleanly ABSENT journal is fail-open: plane-cli tickets may have no
 * journal at all (the coordination layer is teamctl's; this is the hook).
 */
export function readLiveIntentClaim(
  mountTicket: string,
  workspace: string,
): { seat: string; iso: string; op: string } | null | "unreadable" {
  const stateHome = process.env.TEAMCTL_STATE_HOME ?? join(process.env.HOME ?? "", ".local", "state", "teamctl");
  const headerPath = join(stateHome, workspace, "journals", `${mountTicket}.header.json`);
  if (!existsSync(headerPath)) return null;
  let header: { pending?: { plane?: { entry: string; op: string } | null } };
  try {
    header = JSON.parse(readFileSync(headerPath, "utf8"));
  } catch {
    return "unreadable";
  }
  const slot = header.pending?.plane;
  if (!slot) return null;
  // Arming entry seat: the entries file is markdown — `## <iso> — <kind>
  // — <seat>` headings (teamctl journal.ts render). Scan for the iso.
  const entriesPath = join(stateHome, workspace, "journals", `${mountTicket}.md`);
  let seat = "unknown";
  try {
    if (existsSync(entriesPath)) {
      for (const line of readFileSync(entriesPath, "utf8").split("\n")) {
        const m = /^## (\S+) — (\S+) — (\S+)\s*$/.exec(line);
        if (m && m[1] === slot.entry) {
          seat = m[3]!;
          break;
        }
      }
    }
  } catch { /* seat stays unknown — the claim still gates */ }
  return { seat, iso: slot.entry, op: slot.op };
}

/** Five-field §30.3 refusal block for an intent-claim conflict. */
function intentClaimBlock(ticket: string, claim: { seat: string; iso: string; op: string }, caller: string): string {
  return [
    `refused: intent-claim — ${ticket} front-matter apply blocked by LIVE pending_plane:${claim.op} (§30.3/§2.1)`,
    `  what: intent-claim — ${ticket} state apply vs journal-intent ${claim.op}`,
    `  who: ${claim.seat} holds the claim (caller: ${caller})`,
    `  since: ${claim.iso}`,
    `  why: true-conflict — another hand's Plane write is armed; racing it double-writes`,
    `  wait: let the claim apply (the journal outbox drains it), then re-edit the front-matter`,
    `  override: none — sync-channel writes never self-override a live foreign claim`,
  ].join("\n");
}

function readEvents(dir: string): SyncEvent[] {
  return readEventsFile(dir) as SyncEvent[];
}

/** Rebuild the derived comments.json snapshot from the events file. */
function writeCommentsJson(dir: string, events: SyncEvent[]): void {
  writeFileSync(
    join(metaDir(dir), "comments.json"),
    JSON.stringify(events.map(({ id, parent, author, body, at, status }) => ({ id, parent, author, body, at, status })), null, 2) + "\n",
  );
}

/**
 * M5: force-cleanup symmetry (mirrors pullTicket server-wins, but keeps audit).
 * After a force/forceAll push lands, delete the ticket's .conflict snapshot
 * (if present) and flip its conflict notice rows to terminal "resolved"
 * (kept for audit, rewritten to comments.json). Structured meta match first
 * (I4); legacy body fallback only for rows without meta. I1: snapshot delete
 * + flip + comments.json rewrite land atomically inside ONE withEventsLock.
 * "resolved" rows never re-fire: refuseOnce only dedups status "conflict"
 * rows, so a NEW conflict later files a fresh row.
 */
async function resolveForceCleanup(dir: string, conflictPath: string, ticket: string, rel: string | null): Promise<void> {
  await withEventsLock(dir, (stored) => {
    try {
      rmSync(conflictPath, { force: true });
    } catch { /* absent */ }
    const rows = stored as SyncEvent[];
    for (const e of rows) {
      if (e.status !== "conflict") continue;
      let isMatch = false;
      if (e.meta?.kind === "push-conflict") {
        isMatch = e.meta.ticket === ticket && (e.meta.rel ?? null) === (rel ?? null);
      } else {
        // Legacy fallback: match the exact strings produced today
        if (rel === null) {
          isMatch = e.body.includes(`on ${ticket}`) && e.body.includes("conflict: server rev") && !e.body.includes("conflict: child");
        } else {
          isMatch = e.body.includes(`on ${ticket}`) && e.body.includes(`conflict: child ${rel}:`);
        }
      }
      if (isMatch) e.status = "resolved";
    }
  });
  // withEventsLock already rewrote comments.json atomically; no extra write needed
}

/**
 * Restart reconcile (§29.6 durable pending-op; review C5): for every
 * pending/posting/conflict row, re-list server comments —
 * - id known on server → adopt + synced;
 * - row carries an `entry` msg_id → match by STAMP SUBSTRING
 *   (`entry <msg_id>` is unique and survives Plane's HTML normalization —
 *   full-HTML equality is too brittle) → adopt without re-posting;
 * - else → leave pending for the push to post under the SAME op (rows
 *   never re-post landed work, never lose unlanded work).
 */
export async function reconcileEvents(p: Plane, mount: SyncMount): Promise<{ adopted: number; stillPending: number }> {
  const dir = mount.dir;
  const events = readEvents(dir);
  if (!events.some((e) => e.status === "pending" || e.status === "posting" || e.status === "conflict")) return { adopted: 0, stillPending: 0 };
  const raw = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/comments/`)) as Raw;
  const server = (((raw as Raw).results ?? raw) as Raw[]).map((c) => ({
    id: String(c.id),
    parent: c.parent ? String(c.parent) : null,
    author: String(c.actor ?? ""),
    body: String(c.comment_html ?? ""),
  }));
  let adopted = 0;
  await updateEvents(dir, (stored) => {
    const rows = stored as SyncEvent[];
    for (const e of rows) {
      if (e.status !== "pending" && e.status !== "posting" && e.status !== "conflict") continue;
      if (e.id && server.some((c) => c.id === e.id)) {
        e.status = "synced";
        adopted++;
        continue;
      }
      // Stamp-substring match (C5): the msg_id is unique per post; a row
      // that reached "posting" before a kill is adopted here instead of
      // being re-posted as a duplicate.
      if (e.entry) {
        const hit = server.find((c) => (c.parent ?? null) === (e.parent ?? null) && c.body.includes(`entry ${e.entry}`));
        if (hit) {
          e.id = hit.id;
          e.status = "synced";
          adopted++;
          continue;
        }
      }
      // Legacy unstamped rows: exact posted-HTML shape match.
      const rendered = `<p>${esc(e.body)}</p>`;
      const hit = server.find((c) => (c.parent ?? null) === (e.parent ?? null) && c.body === rendered);
      if (hit) {
        e.id = hit.id;
        e.status = "synced";
        adopted++;
      }
    }
    return undefined;
  });
  const after = readEvents(dir) as SyncEvent[];
  writeCommentsJson(dir, after);
  return { adopted, stillPending: after.filter((e) => e.status === "pending" || e.status === "posting").length };
}

async function pushOne(p: Plane, mount: SyncMount, dir: string, ticket: Raw, guardedRev: string): Promise<{ pushed: string[]; comments: number; rev: string; bodySha: string }> {
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
      await refuseOnce(dir, mount.ticket, r.rule, r.detail);
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
        await refuseOnce(dir, mount.ticket, r.rule, r.detail);
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
        await refuseOnce(dir, mount.ticket, r.rule, r.detail);
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
    await refuseOnce(dir, mount.ticket, r.rule, r.detail);
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

  const stateFields = ["state", "assignees", "labels", "priority"];
  const stateChanging = stateFields.some((k) => k in patch);

  // C6: re-fetch the rev immediately before the PATCH — a server edit that
  // landed since the guard GET must not be overwritten or baselined-over.
  const fresh = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/`)) as Raw;
  const freshRev = String(fresh.updated_at ?? "");
  if (guardedRev && freshRev !== guardedRev) {
    const r: PushRefusal = { refused: true, rule: "server-moved", ticket: mount.ticket, detail: `server rev moved mid-push (${guardedRev} → ${freshRev})`, remedy: "next cycle re-evaluates (conflict or re-pull)" };
    await refuseOnce(dir, mount.ticket, r.rule, r.detail);
    throw Object.assign(new Error(`refused: ${r.rule} — ${r.detail}`), { refusal: r });
  }

  // C7/I1: gate ONLY real state-field patches, re-read the claim HERE —
  // immediately before the PATCH (the check-then-act window shrinks to one
  // round-trip; advisory by design — no server-side CAS exists). I7: the
  // workspace comes from the resolved config, never raw env. I8: an
  // unreadable journal fails CLOSED.
  if (stateChanging) {
    const claim = readLiveIntentClaim(mount.ticket, p.cfg.workspace);
    if (claim === "unreadable") {
      const r: PushRefusal = { refused: true, rule: "journal-unreadable", ticket: mount.ticket, detail: "teamctl journal sidecar exists but is unreadable (torn write?)", remedy: "retry next cycle — the gate fails closed while the writer is active" };
      await refuseOnce(dir, mount.ticket, r.rule, r.detail);
      throw Object.assign(new Error(`refused: ${r.rule} — ${r.detail}`), { refusal: r });
    }
    if (claim && claim.seat !== mount.seat) {
      const block = intentClaimBlock(mount.ticket, claim, mount.seat);
      await refuseOnce(dir, mount.ticket, "intent-claim", `LIVE pending_plane:${claim.op} by ${claim.seat}`);
      throw Object.assign(new Error(block), { refusal: { refused: true, rule: "intent-claim", ticket: mount.ticket, detail: `LIVE pending_plane:${claim.op} by ${claim.seat}`, remedy: "let the journal outbox drain, then re-edit" } as PushRefusal });
    }
  }

  if (Object.keys(patch).length) {
    await p.patchIssue(mount.uuid, patch, mount.projectId);
  }

  // Pending comment events post with the §2.1 stamp. C5 crash-safety: the
  // msg_id is PERSISTED (status "posting") BEFORE the POST — a kill between
  // POST and flip is recovered by reconcile's stamp-substring match, never
  // re-posted as a duplicate. Re-posts reuse the recorded msg_id.
  // NOTE: the v1 create serializer accepts no `parent` field (verified
  // against plane-backend v1.4.1 IssueCommentCreateSerializer) — threaded
  // replies land flat server-side. Parent is still recorded in the events
  // file (reconcile matching + future API support); the §29.6 quote rule
  // (quote the referenced passage inline as `> quote`) carries the thread
  // context in-body instead.
  let posted = 0;
  const pendingRows = readEvents(dir).filter((e) => e.status === "pending");
  for (const row of pendingRows) {
    const msgId = row.entry ?? randomUUID();
    const stamped = `${row.body} — teamctl · entry ${msgId}`;
    await updateEvents(dir, (stored) => {
      const mine = (stored as SyncEvent[]).find((e) => e.op === row.op);
      if (mine && mine.status === "pending") {
        mine.entry = msgId;
        mine.status = "posting";
      }
      return undefined;
    });
    const res = (await p.postComment(mount.uuid, `<p>${esc(stamped)}</p>`, row.parent ?? undefined, mount.projectId)) as Raw;
    const newId = String(res.id ?? res.comment_id ?? "");
    await updateEvents(dir, (stored) => {
      const mine = (stored as SyncEvent[]).find((e) => e.op === row.op);
      if (mine && mine.status === "posting") {
        mine.id = newId;
        mine.entry = msgId;
        mine.status = "synced";
      }
      return undefined;
    });
    posted++;
  }
  if (posted) writeCommentsJson(dir, readEvents(dir));

  const after = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/`)) as Raw;
  return { pushed, comments: posted, rev: String(after.updated_at ?? ""), bodySha };
}

export async function pushTicket(p: Plane, mount: SyncMount, opts?: { force?: boolean; forceAll?: boolean }): Promise<PushResult> {
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
  // separate from updated_at). Merge by id, keep pending rows. C2: the
  // merge runs through updateEvents (lock + unknown-op preservation).
  {
    const raw = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${mount.uuid}/comments/`)) as Raw;
    const server = (((raw as any).results ?? raw) as Raw[]).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const members = (await p.request("GET", `${p.base()}/members/`)) as Raw[];
    const seatByMember = new Map((Array.isArray(members) ? members : []).map((m) => [String(m.id), String(m.display_name || String(m.email ?? "").split("@")[0] || m.id)]));
    let added = 0;
    await updateEvents(dir, (stored) => {
      const prior = stored as SyncEvent[];
      const known = new Set(prior.filter((e) => e.id).map((e) => e.id as string));
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
      return undefined;
    });
    if (added) writeCommentsJson(dir, readEvents(dir));
  }
  const md = readFileSync(join(dir, "ticket.md"), "utf8");
  const localChanged = sha256(md) !== mount.lastFileSha;
  const serverChanged = mount.lastRev !== null && serverRev !== mount.lastRev;
  // M5: --force = local-wins parent only, --force-all = local-wins whole tree.
  const localForce = Boolean(opts?.force || opts?.forceAll);

  // M3: resolver maps for conflict snapshots — fetched once per pushTicket
  // call, reused for root + children (same id->token/name/seat mapping as
  // pullOne so the snapshot byte-matches pullTicket's rendering).
  // I5: bounded cost — exactly 3 fetches (states, labels, members) on the
  // FIRST conflict of a push; children reuse the same maps (O(1), not O(N)).
  // stateMap/labelMap are disk-cache-backed; only /members/ is a real HTTP GET.
  let conflictMaps: { stateById: Map<string, string>; labelById: Map<string, string>; seatByMember: Map<string, string> } | null = null;
  async function getConflictMaps(): Promise<{ stateById: Map<string, string>; labelById: Map<string, string>; seatByMember: Map<string, string> }> {
    if (!conflictMaps) {
      const [states, labels, members] = await Promise.all([
        p.stateMap(mount.projectId),
        p.labelMap(mount.projectId),
        p.request("GET", `${p.base()}/members/`) as Promise<Raw[]>,
      ]);
      conflictMaps = {
        stateById: new Map(Object.entries(states).map(([token, id]) => [id, token])),
        labelById: new Map(Object.entries(labels).map(([name, id]) => [id, name])),
        seatByMember: new Map(
          (Array.isArray(members) ? members : []).map((m) => [String(m.id), String(m.display_name || String(m.email ?? "").split("@")[0] || m.id)]),
        ),
      };
    }
    return conflictMaps;
  }

  if (serverChanged && localChanged && !localForce) {
    // Conflict: local kept, server side aside, ONE notice, push nothing.
    // --force / --force-all (manual `sync TC-N --push-once` only, never the daemon)
    // skips this branch: local wins, baselines follow the push below.
    // I1: snapshot + notice row + comments.json land atomically inside ONE withEventsLock.
    const maps = await getConflictMaps();
    const snapshot = renderConflictSnapshot(ticket, {
      handle: mount.ticket,
      baseRev: mount.lastRev,
      serverRev,
      at: new Date().toISOString(),
      ...maps,
    });
    const detail = `server rev ${serverRev} vs local edits (base ${mount.lastRev})`;
    const marker = `conflict: ${detail}`;
    await withEventsLock(dir, (events) => {
      const conflictPath = join(dir, "ticket.md.conflict");
      const tmp = `${conflictPath}.tmp.${process.pid}`;
      writeFileSync(tmp, snapshot);
      renameSync(tmp, conflictPath);
      const evs = events as SyncEvent[];
      const already = evs.some((e) => {
        if (e.status !== "conflict") return false;
        if (e.meta?.kind === "push-conflict") {
          return e.meta.ticket === mount.ticket && (e.meta.rel ?? null) === null && e.body.includes(marker);
        }
        return e.body.includes(marker) && e.body.includes(`on ${mount.ticket}`);
      });
      if (!already) evs.push(conflictNotice(mount.ticket, marker, null));
    });
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
    await updateMounts((mounts) => {
      const hit = mounts.find((m) => m.ticket === mount.ticket);
      if (hit) {
        hit.lastRev = pulled.rev;
        hit.lastBodySha = pulled.bodySha;
        hit.lastFileSha = pulled.fileSha;
        hit.kids = pulled.kids;
        hit.lastPoll = new Date().toISOString();
      }
      return undefined;
    });
    return { ticket: mount.ticket, pushed: ["pulled"], comments: 0, rev: pulled.rev };
  }
  const r = await pushOne(p, mount, dir, ticket, serverRev);

  // Adopt server-side newcomers (pulled into slug dirs + baselined), then
  // recurse into known children (registry baselines; unknown local dirs are
  // creation flow — a later phase, ignored here).
  const adopted = await adoptNewcomers(p, mount, newcomers);
  const pushed = [...r.pushed, ...adopted.map((k) => `+${k.rel}`)];
  if (localForce && serverChanged && localChanged) pushed.unshift("forced");
  // M5: force-cleanup symmetry — the force push just landed, so the root's
  // prior conflict litter (if any) resolves: delete its snapshot, flip its
  // push-conflict rows to "resolved". Child rows are NOT touched here (a
  // parent-only --force must leave newly filed child conflicts active).
  if (localForce && serverChanged && localChanged) {
    await resolveForceCleanup(dir, join(dir, "ticket.md.conflict"), mount.ticket, null);
  }
  let comments = r.comments;
  // I10: persist the parent result + adopted baselines BEFORE the child
  // loop — a child-loop throw must not orphan the parent's landed work.
  let kids = [...(mount.kids ?? []), ...adopted];
  await updateMounts((mounts) => {
    const hit = mounts.find((m) => m.ticket === mount.ticket);
    if (hit) {
      hit.lastRev = r.rev;
      hit.lastBodySha = r.bodySha;
      hit.lastFileSha = sha256(readFileSync(join(dir, "ticket.md"), "utf8"));
      hit.kids = kids;
      hit.lastPoll = new Date().toISOString();
      hit.pending = countPendingEvents(dir);
    }
    return undefined;
  });
  for (const kid of kids) {
    const childDir = join(dir, kid.rel);
    const childMd = join(childDir, "ticket.md");
    if (!existsSync(childMd)) continue;
    if (sha256(readFileSync(childMd, "utf8")) === kid.fileSha) continue;
    try {
      const childTicket = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${kid.uuid}/`)) as Raw;
      const childRev = String(childTicket.updated_at ?? "");
      // M5: parent-only --force no longer bulldozes children — only --force-all
      // force-pushes conflicted children. Skipped children file a snapshot +
      // notice and record a pushed[] entry naming the remedy.
      // M3/I1: child snapshot provenance always names the parent mount ticket + child rel,
      // atomically with the notice row inside ONE lock.
      if (childRev !== kid.rev && !opts?.forceAll) {
        const maps = await getConflictMaps();
        const snapshot = renderConflictSnapshot(childTicket, {
          handle: mount.ticket,
          baseRev: kid.rev,
          serverRev: childRev,
          at: new Date().toISOString(),
          resolveHandle: mount.ticket,
          childRel: kid.rel,
          ...maps,
        });
        const detail = `child ${kid.rel}: server rev ${childRev} vs local edits (base ${kid.rev})`;
        const marker = `conflict: ${detail}`;
        await withEventsLock(dir, (events) => {
          const conflictPath = `${childMd}.conflict`;
          const tmp = `${conflictPath}.tmp.${process.pid}`;
          mkdirSync(dirname(conflictPath), { recursive: true });
          writeFileSync(tmp, snapshot);
          renameSync(tmp, conflictPath);
          const evs = events as SyncEvent[];
          const already = evs.some((e) => {
            if (e.status !== "conflict") return false;
            if (e.meta?.kind === "push-conflict") {
              return e.meta.ticket === mount.ticket && (e.meta.rel ?? null) === kid.rel && e.body.includes(marker);
            }
            return e.body.includes(marker) && e.body.includes(`on ${mount.ticket}`);
          });
          if (!already) evs.push(conflictNotice(mount.ticket, marker, kid.rel));
        });
        pushed.push(`${kid.rel}: conflict (server rev ${childRev} vs local edits — resolve child or re-run with --force-all)`);
        continue;
      }
      // I4: the child mount carries the CHILD's handle — the intent-claim
      // gate inside pushOne consults the child's own journal (a foreign
      // claim on the parent must not block child edits, and a refusal must
      // name the child, not the parent).
      // N3 (review r4): a falsy sequence_id must NOT fall back to the
      // parent's handle — the child gate would consult the parent's journal.
      // Without a seq there is no safe child handle: skip the child this
      // cycle (the refusal names the real problem; next pull re-fetches
      // sequence_id and the child syncs then).
      const childSeq = Number(childTicket.sequence_id ?? 0);
      if (!childSeq) {
        pushed.push(`${kid.rel}: skipped (no sequence_id — gate cannot address the child safely)`);
        continue;
      }
      const childMount: SyncMount = { ...mount, uuid: kid.uuid, ticket: `${mount.ident}-${childSeq}`, lastBodySha: kid.bodySha, lastFileSha: kid.fileSha };
      const wasChildConflict = childRev !== kid.rev;
      const cr = await pushOne(p, childMount, childDir, childTicket, childRev);
      comments += cr.comments;
      if (cr.pushed.length) pushed.push(`${kid.rel}: ${cr.pushed.join(",")}`);
      // M5: a child actually pushed under --force-all resolves its prior
      // conflict litter (snapshot + notice rows flip to "resolved").
      if (opts?.forceAll && wasChildConflict) {
        await resolveForceCleanup(dir, `${childMd}.conflict`, mount.ticket, kid.rel);
      }
      const afterChild = (await p.request("GET", `${p.projectPathFor(mount.projectId)}/issues/${kid.uuid}/`)) as Raw;
      const newFileSha = sha256(readFileSync(childMd, "utf8"));
      const newSha = sha256(parseTicketMd(readFileSync(childMd, "utf8")).body);
      kids = kids.map((k) => (k.uuid === kid.uuid ? { ...k, rev: String(afterChild.updated_at ?? ""), bodySha: newSha, fileSha: newFileSha } : k));
    } catch (e) {
      // I2/I10: a poisoned child records its refusal and never kills the
      // parent cycle (the refusal row is already filed by refuseOnce).
      const message = String((e as Error)?.message ?? e).slice(0, 200);
      pushed.push(`${kid.rel}: refused (${message.split("\n")[0]})`);
    }
  }

  const livePending = countPendingEvents(dir);
  const fileShaNow = sha256(readFileSync(join(dir, "ticket.md"), "utf8"));
  await updateMounts((mounts) => {
    const hit = mounts.find((m) => m.ticket === mount.ticket);
    if (hit) {
      hit.lastRev = r.rev;
      hit.lastBodySha = r.bodySha;
      hit.lastFileSha = fileShaNow;
      hit.kids = kids;
      hit.lastPoll = new Date().toISOString();
      hit.pending = livePending;
    }
    return undefined;
  });
  writeStatusFile(dir, { ticket: mount.ticket, ready: livePending === 0, lastPoll: new Date().toISOString(), pending: livePending, rev: r.rev });
  return { ticket: mount.ticket, pushed, comments, rev: r.rev };
}
