import { describe, expect, it } from "vitest";
import { getPreset, listPresets } from "../src/presets/index.js";

/** The Remote OK / Jobicy wiring (2026-11 follow-up to docs/internal/PRESET_COVERAGE.md). */
describe("Remote OK and Jobicy preset feeds", () => {
  const feed = (preset: string, id: string) => getPreset(preset)?.feeds.find((f) => f.id === id);

  it("Remote OK has no region filter, so only global-remote polls it", () => {
    expect(feed("global-remote", "global-remote.remoteok")?.source).toBe("remoteok");
    expect(listPresets().filter((p) => p.feeds.some((f) => f.source === "remoteok")).map((p) => p.id)).toEqual(["global-remote"]);
  });

  it("Jobicy is polled per region with its own geo slugs, and marked slow (one pass an hour)", () => {
    expect(feed("global-remote", "global-remote.jobicy")?.targets.map((t) => t.params?.geo)).toEqual(["anywhere"]);
    expect(feed("us", "us.jobicy")?.targets.map((t) => t.params?.geo)).toEqual(["usa"]);
    expect(feed("eu-uk", "eu-uk.jobicy")?.targets.map((t) => t.params?.geo)).toEqual(["uk", "germany", "netherlands"]);
    expect(feed("canada", "canada.jobicy")?.targets.map((t) => t.params?.geo)).toEqual(["canada"]);
    for (const p of listPresets()) for (const f of p.feeds.filter((x) => x.source === "jobicy")) expect(f.slow, f.id).toBe(true);
  });

  it("the india preset (golden) is unchanged: no Remote OK / Jobicy feed", () => {
    expect(getPreset("india")?.feeds.some((f) => f.source === "remoteok" || f.source === "jobicy")).toBe(false);
  });
});
