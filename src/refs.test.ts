import { describe, expect, test } from "bun:test";
import { formatTicketRef, parseTicketRef } from "./api.ts";

describe("parseTicketRef", () => {
  test("HT- prefix round-trips, case-insensitive and normalized to upper", () => {
    expect(parseTicketRef("HT-66")).toEqual({ ident: "HT", seq: 66 });
    expect(parseTicketRef("ht-66")).toEqual({ ident: "HT", seq: 66 });
    expect(formatTicketRef(parseTicketRef("HT-66"))).toBe("HT-66");
    expect(formatTicketRef(parseTicketRef("ht-66"))).toBe("HT-66");
  });

  test("every real workspace identifier parses and round-trips case-insensitively", () => {
    for (const ref of ["TC-16", "XT-2", "EGG-5", "ACCT-4", "IOT-9", "INFRA-3"]) {
      const [ident, seq] = ref.split("-") as [string, number & string];
      expect(parseTicketRef(ref)).toEqual({ ident, seq: Number(seq) });
      expect(parseTicketRef(ref.toLowerCase())).toEqual({ ident, seq: Number(seq) });
      expect(formatTicketRef(parseTicketRef(ref))).toBe(ref);
      expect(formatTicketRef(parseTicketRef(ref.toLowerCase()))).toBe(ref);
    }
  });

  test("bare numbers parse with no ident (default project) and format as HT", () => {
    expect(parseTicketRef("66")).toEqual({ seq: 66 });
    expect(formatTicketRef(parseTicketRef("66"))).toBe("HT-66");
  });

  test("alphanumeric identifiers are accepted", () => {
    expect(parseTicketRef("A1-9")).toEqual({ ident: "A1", seq: 9 });
    expect(formatTicketRef(parseTicketRef("A1-9"))).toBe("A1-9");
  });

  test("invalid refs loud-error with kind validation, exit 4, and the valid grammar", () => {
    for (const bad of ["", "  ", "HT-six", "TEAMCTL", "TEAM-CTL-16", "-16", "HT-", "16-", "HT_66", "HT--66", "-66", "66-"]) {
      let caught: any;
      try {
        parseTicketRef(bad);
      } catch (e) {
        caught = e;
      }
      expect(caught?.kind).toBe("validation");
      expect(caught?.exitCode).toBe(4);
      expect(caught?.valid).toContain("HT-<number>");
      expect(caught?.valid).toContain("<IDENT>-<number>");
      expect(String(caught?.message)).toContain("invalid ticket ref");
    }
  });
});
