import { describe, expect, it } from "vitest";
import { SOURCE_RICHNESS } from "../src/dedup/index.js";
import { SOURCE_TRUST } from "../src/match/trust.js";
import type { SourceKind } from "../src/schema/index.js";

describe("SOURCE_RICHNESS (canonical winner in a dup cluster)", () => {
  it("ranks every source that has a trust prior, each once", () => {
    const ranked = new Set(SOURCE_RICHNESS);
    expect(ranked.size).toBe(SOURCE_RICHNESS.length);
    for (const s of Object.keys(SOURCE_TRUST) as SourceKind[]) expect(ranked.has(s), s).toBe(true);
  });

  it("the re-dating remote boards rank below the employer's own boards and with their peers", () => {
    const rank = (s: SourceKind) => SOURCE_RICHNESS.indexOf(s);
    for (const s of ["remoteok", "jobicy"] as const) {
      expect(rank(s)).toBeGreaterThan(rank("greenhouse"));
      expect(rank(s)).toBeGreaterThan(rank("himalayas"));
      expect(rank(s)).toBeLessThan(rank("adzuna"));
    }
  });
});
