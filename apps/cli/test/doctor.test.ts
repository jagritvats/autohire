import { describe, expect, it } from "vitest";
import { networkCheck } from "../src/commands/doctor.js";

const GH = "https://boards-api.greenhouse.io/v1/boards/";
const LEVER = "https://api.lever.co/v0/postings/";

describe("doctor's network row", () => {
  it("any HTTP response reads as reachable — the bare API roots answer 404", () => {
    const c = networkCheck([
      { url: GH, ok: true, status: 404 },
      { url: LEVER, ok: true, status: 404 },
    ]);
    expect(c.status).toBe("ok");
    expect(c.detail).toBe("boards-api.greenhouse.io reachable · api.lever.co reachable");
    expect(c.detail).not.toContain("404");
    expect(c.fix).toBeUndefined();
  });

  it("a connection error is the only failure, and names its cause", () => {
    const c = networkCheck([
      { url: GH, ok: true, status: 500 },
      { url: LEVER, ok: false, error: "ENOTFOUND" },
    ]);
    expect(c.status).toBe("warn");
    expect(c.detail).toBe("boards-api.greenhouse.io reachable · api.lever.co ✗ ENOTFOUND");
    expect(c.fix).toBeTruthy();
  });

  it("no host reachable fails the check", () => {
    const c = networkCheck([
      { url: GH, ok: false, error: "timeout" },
      { url: LEVER, ok: false },
    ]);
    expect(c.status).toBe("fail");
    expect(c.detail).toBe("boards-api.greenhouse.io ✗ timeout · api.lever.co ✗ unreachable");
  });
});
