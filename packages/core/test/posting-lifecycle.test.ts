import { describe, it, expect } from "vitest";
import { PostingStatus, Posting } from "../src/schema/index.js";

describe("PostingStatus lifecycle enum", () => {
  it("has exactly active | invalidated | stale", () => {
    expect(PostingStatus.options).toEqual(["active", "invalidated", "stale"]);
  });
});

describe("Posting lifecycle fields default cleanly", () => {
  it("defaults status='active' with no invalidation metadata", () => {
    const now = new Date();
    const p = Posting.parse({
      id: "11111111-1111-1111-1111-111111111111",
      companyId: "22222222-2222-2222-2222-222222222222",
      companyName: "Acme",
      atsType: "greenhouse",
      atsJobId: "1",
      source: "greenhouse",
      tier: "tier1",
      title: "Backend Engineer",
      titleNorm: "backend-engineer",
      location: { mode: "remote" },
      salary: {},
      firstSeen: now,
      lastSeen: now,
      dedupKey: "acme|backend-engineer",
    });
    expect(p.status).toBe("active");
    expect(p.invalidReason).toBeNull();
    expect(p.invalidatedAt).toBeNull();
    // isActive stays the freshness flag, independent of lifecycle status
    expect(p.isActive).toBe(true);
  });
});
