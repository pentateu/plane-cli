import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const TTL: Record<string, number> = {
  states: 24 * 3600_000,
  labels: 24 * 3600_000,
  project: 24 * 3600_000,
  member: 24 * 3600_000,
  members: 24 * 3600_000,
  seqmap: 300_000,
};

export type CacheData = Record<string, { at: number; value: unknown }>;

export class Cache {
  path: string;
  data: CacheData = {};
  dirty = false;

  constructor(path: string) {
    this.path = path;
    try {
      if (existsSync(path)) this.data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      this.data = {};
    }
  }

  fresh(key: string): unknown | undefined {
    const e = this.data[key];
    if (!e) return undefined;
    const ttl = TTL[key.split(":")[0]!] ?? 0;
    if (Date.now() - e.at > ttl) return undefined;
    return e.value;
  }

  stale(key: string): unknown | undefined {
    return this.data[key]?.value;
  }

  set(key: string, value: unknown): void {
    this.data[key] = { at: Date.now(), value };
    this.dirty = true;
  }

  drop(key: string): void {
    delete this.data[key];
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    const dir = this.path.includes("/") ? this.path.replace(/\/[^/]+$/, "") : ".";
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}
