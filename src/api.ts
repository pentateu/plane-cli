import { Cache } from "./cache.ts";
import { UsageError, type Config } from "./config.ts";

export class ApiError extends UsageError {
  constructor(
    kind: "auth" | "not-found" | "validation" | "rate-limit" | "api" | "network",
    message: string,
    opts: { valid?: string[]; suggestion?: string; status?: number } = {},
  ) {
    super(kind, message, { ...opts, exitCode: kind === "auth" ? 2 : kind === "not-found" ? 3 : kind === "rate-limit" ? 5 : kind === "validation" ? 4 : 1 });
  }
}

export type IssueRow = {
  id: string;
  title: string;
  state: string;
  priority: string | null;
  assignees: string[];
  labels: string[];
  parent: string | null;
};

type Raw = Record<string, any>;

export type IssueRelations = { blockers: string[]; blocks: string[] };
export type RelMap = Record<string, { b: string[]; f: string[] }>;

const STATE_TOKENS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  "in progress": "progress",
  "awaiting verification": "verify",
  done: "done",
  cancelled: "cancelled",
};

export const VALID_STATES = ["todo", "progress", "verify", "done", "cancelled"];
export const VALID_LABELS = ["type:bug", "type:feature", "type:ops", "type:plan"];

export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, cap: number): { text: string; full: boolean; rest: number } {
  if (text.length <= cap) return { text, full: true, rest: 0 };
  return { text: text.slice(0, cap), full: false, rest: text.length - cap };
}

export function mdToHtml(md: string): string {
  const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.trim().replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export class Plane {
  cfg: Config;
  cache: Cache;
  backoffMs: number;

  constructor(cfg: Config, cache: Cache) {
    this.cfg = cfg;
    this.cache = cache;
    this.backoffMs = Number(process.env.PLANE_BACKOFF_MS ?? 1000);
  }

  async request(method: string, path: string, body?: unknown): Promise<Raw | Raw[]> {
    const doFetch = async (): Promise<Response> => {
      try {
        return await fetch(`${this.cfg.apiBase}${path}`, {
          method,
          headers: { "X-Api-Key": this.cfg.token, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        if ((e as any)?.name === "TimeoutError" || (e as any)?.code === "ABORT_ERR")
          throw new ApiError("network", `timeout calling ${method} ${path}`);
        throw new ApiError("network", `request failed: ${(e as Error).message}`, {
          suggestion: `retry once; if it persists check ${this.cfg.apiBase}`,
        });
      }
    };
    let res = await doFetch();
    let retries = 0;
    const retryAfterMs = (): number => {
      const h = res.headers.get("retry-after");
      const s = h ? Number(h) : NaN;
      return Number.isFinite(s) && s > 0 ? s * 1000 : 0;
    };
    while ((res.status === 429 || res.status >= 500) && retries < 3) {
      retries++;
      try {
        res.body?.cancel();
      } catch {
        /* best effort */
      }
      await new Promise((r) => setTimeout(r, Math.max(retryAfterMs(), this.backoffMs * 2 ** (retries - 1))));
      res = await doFetch();
    }
    if (res.status === 401 || res.status === 403)
      throw new ApiError("auth", `seat '${this.cfg.seat}' was rejected (${res.status})`, {
        suggestion: `plane whoami --seat ${this.cfg.seat} to verify the token`,
      });
    if (res.status === 404) throw new ApiError("not-found", `no resource at ${path}`, { suggestion: "plane list to browse open tickets" });
    if (res.status === 429) throw new ApiError("rate-limit", "rate limited by the API after retries", { suggestion: "wait for the retry-after window, then retry" });
    if (res.status >= 500) throw new ApiError("network", `server error ${res.status} on ${method} after ${retries} retries`);
    if (!res.ok && res.status >= 400)
      throw new ApiError(res.status === 400 || res.status === 422 ? "validation" : "api", `${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;
    return (payload && typeof payload === "object" && payload.data !== undefined ? payload.data : payload) ?? {};
  }

  base(): string {
    return `/workspaces/${this.cfg.workspace}`;
  }

  projectPath(): string {
    return `${this.base()}/projects/${this.projectId()}`;
  }

  projectId(): string {
    if (this.cfg.projectId) return this.cfg.projectId;
    const key = `project:${this.cfg.projectName}`;
    const hit = this.cache.fresh(key);
    if (typeof hit === "string") return hit;
    const stale = this.cache.stale(key);
    if (typeof stale === "string") return stale;
    throw new ApiError("api", "project id not cached yet", { suggestion: "plane sync" });
  }

  async ensureProject(): Promise<void> {
    if (this.cfg.projectId) return;
    const key = `project:${this.cfg.projectName}`;
    if (this.cache.fresh(key)) return;
    const page = (await this.request("GET", `${this.base()}/projects/`)) as Raw;
    const results = (page.results ?? page) as Raw[];
    const proj = results.find((p) => p.name === this.cfg.projectName || p.identifier === this.cfg.projectName);
    if (!proj)
      throw new ApiError("not-found", `project '${this.cfg.projectName}' not found in workspace '${this.cfg.workspace}'`, {
        valid: results.map((p) => p.name),
      });
    this.cache.set(key, proj.id);
  }

  async stateMap(): Promise<Record<string, string>> {
    const cached = this.cache.fresh("states");
    if (cached) return cached as Record<string, string>;
    await this.ensureProject();
    const page = (await this.request("GET", `${this.base()}/projects/${this.projectId()}/states/`)) as Raw;
    const map: Record<string, string> = {};
    for (const s of page.results as Raw[]) map[STATE_TOKENS[s.name.toLowerCase()] ?? s.name.toLowerCase()] = s.id;
    this.cache.set("states", map);
    return map;
  }

  async labelMap(): Promise<Record<string, string>> {
    const cached = this.cache.fresh("labels");
    if (cached) return cached as Record<string, string>;
    await this.ensureProject();
    const page = (await this.request("GET", `${this.base()}/projects/${this.projectId()}/labels/`)) as Raw;
    const map: Record<string, string> = {};
    for (const l of page.results as Raw[]) map[l.name] = l.id;
    this.cache.set("labels", map);
    return map;
  }

  me(): Promise<string> {
    return this.member(this.cfg.seat);
  }

  async member(seat: string): Promise<string> {
    const key = `member:${seat}`;
    const hit = this.cache.fresh(key);
    if (typeof hit === "string") return hit;
    const members = (await this.request("GET", `${this.base()}/members/`)) as Raw[];
    const local = (x: Raw) => String(x.email ?? "").split("@")[0] ?? "";
    let matches = members.filter((x) => x.display_name === seat || local(x) === seat || local(x).startsWith(`${seat}-`));
    if (matches.length > 1) {
      const exact = matches.find((x) => x.display_name === seat) ?? matches.find((x) => local(x) === seat);
      if (exact) matches = [exact];
    }
    if (matches.length !== 1)
      throw new ApiError("not-found", `seat '${seat}' is ambiguous or unknown on the workspace roster`, {
        valid: members.map((x) => x.display_name),
        suggestion: "plane whoami to verify your seat",
      });
    this.cache.set(key, matches[0]!.id);
    return matches[0]!.id;
  }

  async memberNamesPublic(ids: string[]): Promise<string[]> {
    const names = await this.memberNames();
    return ids.map((i) => (names[i] ? names[i] : `member:${i.slice(0, 8)}`));
  }

  /** Walk the project's issue list. Current instances are CURSOR-paginated
   *  (next_cursor/next_page_results) and ignore the legacy offset `page` param —
   *  following `page=N` would re-fetch page 1 forever. Dedupes defensively. */
  async listIssues(params: Record<string, string> = {}, maxPages = 10): Promise<Raw[]> {
    const out: Raw[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const q = new URLSearchParams({ per_page: "100", ...params });
      if (cursor) q.set("cursor", cursor);
      const page = (await this.request("GET", `${this.projectPath()}/issues/?${q}`)) as Raw;
      for (const r of (page.results as Raw[]) ?? []) {
        const key = String(r.id);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(r);
        }
      }
      if (!(page.next_page_results ?? false)) break;
      cursor = String(page.next_cursor ?? "");
      if (!cursor) break;
    }
    return out;
  }

  async issueRef(input: string): Promise<{ uuid: string; seq: number }> {
    const m = input.match(/^(?:HT-)?(\d+)$/i);
    if (!m)
      throw new ApiError("validation", `invalid ticket ref '${input}'`, {
        valid: ["HT-<number>", "<number>"],
        suggestion: "plane get HT-66",
      });
    const seq = Number(m[1]);
    const mapKey = "seqmap";
    const load = async (): Promise<Record<string, string>> => {
      const map: Record<string, string> = {};
      for (const i of await this.listIssues()) map[String(i.sequence_id)] = i.id as string;
      this.cache.set(mapKey, map);
      return map;
    };
    let map = (this.cache.fresh(mapKey) ?? (await load())) as Record<string, string>;
    let uuid = map[String(seq)];
    if (!uuid) {
      map = await load();
      uuid = map[String(seq)];
    }
    if (!uuid)
      throw new ApiError("not-found", `HT-${seq} not found`, {
        suggestion: "plane list --search HT-" + seq,
      });
    return { uuid, seq };
  }

  private async memberNames(): Promise<Record<string, string>> {
    const cached = this.cache.fresh("members");
    if (cached) return cached as Record<string, string>;
    const members = (await this.request("GET", `${this.base()}/members/`)) as Raw[];
    const out: Record<string, string> = {};
    for (const x of members) out[x.id] = x.display_name || x.first_name || x.id;
    this.cache.set("members", out);
    return out;
  }

  async shapeIssue(i: Raw, opts: { full?: boolean; memberNames?: Record<string, string>; labelNames?: Record<string, string>; stateTokens?: Record<string, string>; relations?: IssueRelations }): Promise<IssueRow & { description?: string; blockedBy?: string[]; blocks?: string[] }> {
    const names = opts.memberNames ?? (await this.memberNames());
    const lm = opts.labelNames ?? (await this.labelMap());
    const sm = opts.stateTokens ?? inverse(await this.stateMap());
    const seqByUuid: Record<string, string> = {};
    for (const [seq, uuid] of Object.entries(this.cache.stale("seqmap") as Record<string, string> ?? {})) seqByUuid[uuid] = `HT-${seq}`;
    let description: string | undefined;
    if ("description_html" in i) {
      const t = htmlToText(String(i.description_html ?? ""));
      const tr = truncate(t, opts.full ? Number.MAX_SAFE_INTEGER : 500);
      description = tr.full ? tr.text : `${tr.text}…(+${tr.rest} chars — plane get HT-${i.sequence_id} --full)`;
    }
    const row: IssueRow & { description?: string; blockedBy?: string[]; blocks?: string[] } = {
      id: `HT-${i.sequence_id}`,
      title: String(i.name),
      state: sm[i.state] ?? `state:${String(i.state).slice(0, 8)}`,
      priority: i.priority === "none" ? null : i.priority ?? null,
      assignees: ((i.assignees ?? []) as string[]).map((a) => names[a] ?? `member:${String(a).slice(0, 8)}`).sort(),
      labels: ((i.labels ?? []) as string[]).map((l) => Object.entries(lm).find(([, v]) => v === l)?.[0] ?? `label:${String(l).slice(0, 8)}`),
      parent: i.parent ? (seqByUuid[i.parent as string] ?? `page:${String(i.parent).slice(0, 8)}`) : null,
    };
    if (description !== undefined) row.description = description;
    if (opts.relations) {
      const shortHandle = (u: string): string => seqByUuid[u] ?? `edge:${String(u).slice(0, 8)}`;
      row.blockedBy = opts.relations.blockers.map(shortHandle);
      row.blocks = opts.relations.blocks.map(shortHandle);
    }
    return row;
  }

  async comments(uuid: string): Promise<Array<{ n: number; author: string; date: string; id: string; text: string }>> {
    const [raw, names] = await Promise.all([
      this.request("GET", `${this.projectPath()}/issues/${uuid}/comments/`) as Promise<Raw>,
      this.memberNames(),
    ]);
    const list = ((raw.results ?? raw) as Raw[]).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    return list.map((c, idx) => ({
      n: idx + 1,
      author: names[c.actor] ?? c.actor,
      date: String(c.created_at).slice(0, 10),
      id: c.id,
      text: htmlToText(String(c.comment_html ?? "")).replace(/\s+/g, " ").slice(0, 400),
    }));
  }

  postComment(uuid: string, html: string, parent?: string): Promise<Raw> {
    const body: Raw = { comment_html: html };
    if (parent) body.parent = parent;
    return this.request("POST", `${this.projectPath()}/issues/${uuid}/comments/`, body) as Promise<Raw>;
  }

  patchIssue(uuid: string, body: Raw): Promise<Raw> {
    return this.request("PATCH", `${this.projectPath()}/issues/${uuid}/`, body) as Promise<Raw>;
  }

  /** Native blocking edges (Plane stores one row: issue=blocked, related=blocker,
   *  relation_type="blocked_by"; "blocking"/"blocked_by" are two spellings).
   *  Only the work-items prefix exposes /relations/ on current instances.
   *  Entry shape varies by install: bare uuid strings (commercial trial),
   *  {issue_id} (community), {id} (upstream master) — accept all three. */
  async relations(uuid: string): Promise<IssueRelations> {
    const raw = (await this.request("GET", `${this.projectPath()}/work-items/${uuid}/relations/`)) as Raw;
    const ids = (v: unknown): string[] =>
      Array.isArray(v)
        ? v
            .map((r: any) => (typeof r === "string" ? r : String(r?.issue_id ?? r?.id ?? "")))
            .filter((s) => s && s !== "undefined")
        : [];
    return { blockers: ids(raw.blocked_by), blocks: ids(raw.blocking) };
  }

  async relationsCached(uuid: string): Promise<IssueRelations> {
    const map = this.cache.fresh("relmap") as RelMap | undefined;
    const hit = map?.[uuid];
    if (hit) return { blockers: hit.b, blocks: hit.f };
    const rels = await this.relations(uuid);
    this.cacheRel(uuid, rels);
    return rels;
  }

  cacheRel(uuid: string, rels: IssueRelations): void {
    const map = (this.cache.stale("relmap") as RelMap | undefined) ?? {};
    map[uuid] = { b: rels.blockers, f: rels.blocks };
    this.cache.set("relmap", map);
  }

  setBlockEdge(blockerUuid: string, blockedUuid: string): Promise<Raw> {
    return this.request("POST", `${this.projectPath()}/work-items/${blockerUuid}/relations/`, {
      relation_type: "blocking",
      issues: [blockedUuid],
    }) as Promise<Raw>;
  }

  removeBlockEdge(blockerUuid: string, blockedUuid: string): Promise<Raw> {
    return this.request("DELETE", `${this.projectPath()}/work-items/${blockerUuid}/relations/${blockedUuid}/`) as Promise<Raw>;
  }
}

export function inverse(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[v] = k;
  return out;
}
