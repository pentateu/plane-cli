import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ProcessLoop = {
  steps: string[];
  rules: string[];
  governing: string[];
};

export type ProcessVerbRow = {
  cli: string;
  verb: string;
  loop: string | null;
  step: number | null;
  perVerb: boolean;
};

export type ProcessSpec = {
  v: number;
  loops: Record<string, ProcessLoop>;
  verbs: ProcessVerbRow[];
};

const SPEC_PATH = join(import.meta.dir, "..", "process-help.json");

let cached: ProcessSpec | undefined;

/** Read the shared canonical process spec (byte-identical across CLIs). */
export function loadSpec(): ProcessSpec {
  if (!cached) cached = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as ProcessSpec;
  return cached;
}

/** Spec rows assigned to this CLI, in spec array order. */
export function cliRows(spec: ProcessSpec = loadSpec()): ProcessVerbRow[] {
  return spec.verbs.filter((r) => r.cli === "plane");
}

export function rowForVerb(verb: string, spec: ProcessSpec = loadSpec()): ProcessVerbRow | undefined {
  return cliRows(spec).find((r) => r.verb === verb);
}

/** Primary = first loop referenced by this CLI's verbs in array order;
 *  secondary = the other referenced loops, in first-seen order. */
export function deriveLoops(spec: ProcessSpec = loadSpec()): { primary: string; secondary: string[] } {
  const rows = cliRows(spec);
  const primary = rows.find((r) => r.loop)?.loop ?? "";
  const secondary: string[] = [];
  for (const r of rows) {
    if (r.loop && r.loop !== primary && !secondary.includes(r.loop)) secondary.push(r.loop);
  }
  return { primary, secondary };
}

function ruleIds(loop: ProcessLoop): string[] {
  return loop.rules.map((rule) => rule.match(/^\S+/)?.[0] ?? rule);
}

function governingLine(loop: ProcessLoop): string {
  return loop.governing.join(" + ");
}

/**
 * CLI-level PROCESS block:
 *
 *   PROCESS — <loop-name> (<k> steps)
 *     1. <step>
 *     rules: <R-id> <clause>[; …]
 *     governing: <§-anchor(s)>
 *     help-spec: v<v>
 *   also: <loop-name> — <§-anchor>   (one line per secondary loop)
 */
export function renderProcessBlock(spec: ProcessSpec = loadSpec()): string {
  const { primary, secondary } = deriveLoops(spec);
  const loop = spec.loops[primary];
  if (!loop) return "";
  const lines: string[] = [`PROCESS — ${primary} (${loop.steps.length} steps)`];
  loop.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${step}`));
  lines.push(`  rules: ${loop.rules.join("; ")}`);
  lines.push(`  governing: ${governingLine(loop)}`);
  lines.push(`  help-spec: v${spec.v}`);
  for (const name of secondary) {
    const g = spec.loops[name]?.governing[0] ?? "";
    lines.push(`also: ${name} — ${g}`);
  }
  return lines.join("\n");
}

/**
 * Compact 3-line per-verb footer for rows tagged perVerb:true:
 *
 *   loop: <loop-name> (step <k>/<n>)
 *   rules: <R-ids>
 *   governing: <§-anchor>
 *
 * Returns undefined for rows without a per-verb assignment.
 */
export function renderVerbFooter(verb: string, spec: ProcessSpec = loadSpec()): string | undefined {
  const row = rowForVerb(verb, spec);
  if (!row || !row.perVerb || !row.loop || row.step === null) return undefined;
  const loop = spec.loops[row.loop];
  if (!loop) return undefined;
  return [
    `loop: ${row.loop} (step ${row.step}/${loop.steps.length})`,
    `rules: ${ruleIds(loop).join("; ")}`,
    `governing: ${governingLine(loop)}`,
  ].join("\n");
}

/** Every agent-facing verb must have a spec row (build-time drift guard). */
export function unassignedVerbs(verbs: readonly string[], spec: ProcessSpec = loadSpec()): string[] {
  return verbs.filter((v) => !rowForVerb(v, spec));
}
