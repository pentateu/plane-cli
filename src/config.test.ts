import { describe, expect, test } from "bun:test";
import { resolveToken } from "./config.ts";

const FILE = { HOMETUTOR_TICKETS_TOKEN_DEV1: "tok-from-file" };

describe("token precedence (files-first, pinned)", () => {
  test("provisioned .plane-seats beats ambient $PLANE_TOKEN", () => {
    const r = resolveToken("dev1", FILE, { PLANE_TOKEN: "tok-ambient" });
    expect(r).toEqual({ token: "tok-from-file", tokenSource: "plane-seats" });
  });

  test("provisioned file beats exported seat-specific env var", () => {
    const r = resolveToken("dev1", FILE, { HOMETUTOR_TICKETS_TOKEN_DEV1: "tok-exported", PLANE_TOKEN: "tok-ambient" });
    expect(r.token).toBe("tok-from-file");
  });

  test("exported seat var beats generic $PLANE_TOKEN when no file exists", () => {
    const r = resolveToken("dev1", {}, { HOMETUTOR_TICKETS_TOKEN_DEV1: "tok-exported", PLANE_TOKEN: "tok-ambient" });
    expect(r).toEqual({ token: "tok-exported", tokenSource: "env" });
  });

  test("$PLANE_TOKEN is the last-resort fallback", () => {
    const r = resolveToken("dev1", {}, { PLANE_TOKEN: "tok-ambient" });
    expect(r).toEqual({ token: "tok-ambient", tokenSource: "env" });
  });

  test("nothing anywhere -> loud auth error naming the key to provision", () => {
    try {
      resolveToken("dev1", {}, {});
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.kind).toBe("auth");
      expect(e.exitCode).toBe(2);
      expect(String(e.suggestion)).toContain(".plane-seats");
    }
  });
});
