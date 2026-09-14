import { describe, expect, test } from "bun:test";
import { helpText, VERBS } from "./cli.ts";
import { loadSpec, renderProcessBlock, renderVerbFooter, unassignedVerbs } from "./process-help.ts";

const PER_VERB = ["list", "get", "blocks", "depends", "unblocks", "claim", "state", "comment", "create", "sub", "comments", "reply"];

describe("process-help shared spec (19.7)", () => {
  test("spec loads at v1 and carries exactly the 23 plane rows", () => {
    const spec = loadSpec();
    expect(spec.v).toBe(1);
    const rows = spec.verbs.filter((r) => r.cli === "plane");
    expect(rows).toHaveLength(25);
    expect(rows.filter((r) => r.perVerb).map((r) => r.verb).sort()).toEqual([...PER_VERB].sort());
  });

  test("every VERBS entry has a spec row — unassigned-verb build check", () => {
    expect(unassignedVerbs(VERBS)).toEqual([]);
  });

  test("plane primary loop is ticket-work, no secondary", () => {
    const spec = loadSpec();
    const block = renderProcessBlock(spec);
    expect(block).toMatch(/^PROCESS — ticket-work \(5 steps\)$/m);
    expect(block.split("\n").filter((l) => l.startsWith("also: "))).toHaveLength(0);
  });
});

describe("plane help PROCESS block (19.7)", () => {
  test("block sits after VERBS, before ENV, with exactly one help-spec stamp", () => {
    const text = helpText();
    expect(text.match(/^PROCESS — .+ \(\d+ steps\)$/m)).not.toBeNull();
    expect(text.match(/^  help-spec: v1$/gm)).toHaveLength(1);
    const iVerbs = text.indexOf("VERBS");
    const iBlock = text.indexOf("PROCESS —");
    const iEnv = text.indexOf("ENV");
    expect(iVerbs).toBeGreaterThan(-1);
    expect(iBlock).toBeGreaterThan(iVerbs);
    expect(iEnv).toBeGreaterThan(iBlock);
  });

  test("CLI-level block stays within the 15-line token budget", () => {
    const block = renderProcessBlock();
    expect(block.split("\n").length).toBeLessThanOrEqual(15);
  });
});

describe("plane help <verb> per-verb footers (perVerb rows)", () => {
  for (const verb of PER_VERB) {
    test(`${verb}: exactly one governing line, 3-line footer`, () => {
      const text = helpText(verb);
      const governing = text.split("\n").filter((l) => l.startsWith("governing: "));
      expect(governing).toHaveLength(1);
      expect(governing[0]).toContain("§");
      const footer = renderVerbFooter(verb)!;
      const lines = footer.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^loop: ticket-work \(step \d+\/5\)$/);
      expect(lines[1]).toMatch(/^rules: R-13; R-7; R-1\/R-4$/);
      expect(lines[2]).toMatch(/^governing: §2 tool action map/);
      expect(text).toContain(footer);
    });
  }

  test("non-perVerb rows emit usage without a footer", () => {
    const text = helpText("whoami");
    expect(text).toContain("whoami");
    expect(text).not.toContain("governing:");
  });

  test("verb with no spec row exits 2 with a clear message", () => {
    try {
      helpText("frobnicate");
      expect.unreachable();
    } catch (e: any) {
      expect(e.kind).toBe("validation");
      expect(e.exitCode).toBe(2);
      expect(String(e.suggestion)).toBe("plane help");
    }
  });
});