import { describe, expect, it } from "vitest";
import { diversifyByCompany, diversifyKey, DIVERSIFY_PER_COMPANY, DIVERSIFY_WINDOW } from "../src/match/view.js";

interface Card {
  id: string;
  company: string;
  score: number;
}

/** a ranked list shaped like the audit's India top 50: one employer holds 19 of them */
function rankedList(): Card[] {
  const cards: Card[] = [];
  let score = 95;
  for (let i = 0; i < 50; i++) {
    const big = i < 12 || i % 3 === 0; // the first 12 and every third card after
    cards.push({ id: `c${i}`, company: big && cards.filter((c) => c.company === "Example Corp").length < 19 ? "Example Corp" : `Other ${i}`, score: score-- });
  }
  return cards;
}

const key = (c: Card) => diversifyKey(c.company);

function maxPerWindow(list: Card[], window: number): number {
  let worst = 0;
  for (let i = 0; i + window <= list.length; i++) {
    const counts = new Map<string, number>();
    for (const c of list.slice(i, i + window)) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
    worst = Math.max(worst, ...counts.values());
  }
  return worst;
}

describe("company spread (a presentation order — invariant #4)", () => {
  it("keeps at most 3 cards per company in any 20 while other companies remain", () => {
    const list = rankedList();
    expect(list.filter((c) => c.company === "Example Corp")).toHaveLength(19);
    const out = diversifyByCompany(list, key);
    // the spread holds up to the last other company's card; after it only Example Corp is left
    const lastOther = out.map((c) => c.company).lastIndexOf(out.filter((c) => c.company !== "Example Corp").at(-1)!.company);
    expect(lastOther).toBeGreaterThan(30);
    expect(maxPerWindow(out.slice(0, lastOther + 1), DIVERSIFY_WINDOW)).toBeLessThanOrEqual(DIVERSIFY_PER_COMPANY);
    expect(out.slice(0, 20).filter((c) => c.company === "Example Corp")).toHaveLength(3);
    // the top card is still the top card
    expect(out[0]!.id).toBe(list[0]!.id);
  });

  it("drops nothing, changes no score, and keeps each company's own order", () => {
    const list = rankedList();
    const out = diversifyByCompany(list, key);
    expect(out).toHaveLength(list.length);
    expect(new Set(out.map((c) => c.id))).toEqual(new Set(list.map((c) => c.id)));
    for (const c of out) expect(c.score).toBe(list.find((x) => x.id === c.id)!.score);
    const order = (l: Card[], co: string) => l.filter((c) => key(c) === co).map((c) => c.id);
    for (const co of new Set(list.map(key))) expect(order(out, co)).toEqual(order(list, co));
    // among the other companies, score order is untouched
    const others = (l: Card[]) => l.filter((c) => c.company !== "Example Corp").map((c) => c.id);
    expect(others(out)).toEqual(others(list));
  });

  it("is a no-op on an already diverse list and when the window allows it", () => {
    const diverse = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, company: `Co ${i % 10}`, score: 90 - i }));
    expect(diversifyByCompany(diverse, key)).toEqual(diverse);
    const list = rankedList();
    expect(diversifyByCompany(list, key, { perCompany: 100 })).toEqual(list);
  });

  it("groups a company across sources by its normalized name", () => {
    const list: Card[] = [
      { id: "a1", company: "Example Corp", score: 90 },
      { id: "a2", company: "Example Corp.", score: 89 },
      { id: "a3", company: "example corp", score: 88 },
      { id: "o1", company: "Other", score: 70 },
    ];
    const out = diversifyByCompany(list, key, { window: 3, perCompany: 2 });
    expect(out.map((c) => c.id)).toEqual(["a1", "a2", "o1", "a3"]);
  });

  it("an all-one-company tail stays in score order instead of vanishing", () => {
    const list = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, company: "Example Corp", score: 80 - i }));
    expect(diversifyByCompany(list, key).map((c) => c.id)).toEqual(list.map((c) => c.id));
  });
});
