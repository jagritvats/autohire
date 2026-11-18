import type { Posting } from "../schema/entities.js";
import { describeLocation } from "../match/display.js";
import { canonicalKey, countryCodeFromText } from "../normalize/index.js";
import { dedupTitleKey, normCompany } from "../normalize/titles.js";

/**
 * Sibling postings (§ Deduper): the SAME role a company posts once per country or region —
 * Airbyte, Sentry, Honeycomb, Grafana post one req for the US, one for the UK, one for
 * Germany, with the same title and the same JD (2026-11 feed review: four Grafana cards in a
 * row). They are NOT duplicates — each is a real, separate req with its own apply link and
 * its own location fit, so `dedup` never merges them. The feed shows them as ONE card (the
 * sibling that scores best for this user) with "also posted for UK, Germany", the others a
 * click away. Grouping is presentation only: scores are untouched and the folded count is
 * reported, never silently hidden (invariant #4).
 *
 * Siblings share: the company, the dedup title key (team, specialty and LEVEL kept — "Senior
 * SRE" and "SRE" are two roles), and a near-identical JD (word-set overlap ≥ 0.7 over the
 * first 4,000 characters; the per-country req usually differs in one location paragraph) —
 * and differ in location (same title + same place is the deduper's business, not this).
 */

export const SIBLING_JD_SIMILARITY = 0.7;

type SiblingLike = Pick<Posting, "id" | "companyName" | "title" | "location"> & Partial<Pick<Posting, "jdText">>;

/** title segments that only say where / how: "Spain", "Remote", "EST Canada", "East Coast", "USA" */
const PLACE_TAG = /^(remote|hybrid|on-?site|onsite|in-office|wfh|anywhere|worldwide|global|emea|apac|amer|americas|latam|meta|dach|nordics|benelux|norben|central|east coast|west coast|(est|cst|pst|cet|ist)( .+)?)$/i;
function isPlaceSegment(seg: string): boolean {
  const t = seg.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.split(" ").length > 4) return false;
  const parts = t.split(/\s*[,/]\s*/).filter(Boolean);
  return parts.every((x) => PLACE_TAG.test(x) || countryCodeFromText(x) != null);
}

/**
 * The title with its place / work-mode segments dropped — per-country reqs often name their
 * country in the title ("Principal Technical Marketing Engineer | Spain | Remote", "Engineering
 * Manager (Remote, Canada)").
 */
export function titleWithoutPlaces(title: string): string {
  const kept = title
    .replace(/\(([^)]*)\)/g, (m, inner: string) => (isPlaceSegment(inner) ? " " : m))
    .split(/\s*(?:\||\s[-–—]\s)\s*/)
    .filter((seg) => !isPlaceSegment(seg));
  // a trailing ", US" / ", Germany" comma segment too
  const out = kept.join(" - ").split(/\s*,\s*/);
  while (out.length > 1 && isPlaceSegment(out[out.length - 1]!)) out.pop();
  return out.join(", ").trim() || title;
}

/** the company + title part of a sibling key (no location): "acme|senior~engineer-site-reliability" */
export function siblingTitleKey(p: Pick<Posting, "companyName" | "title">): string {
  return `${normCompany(p.companyName)}|${dedupTitleKey(titleWithoutPlaces(p.title))}`;
}

function locKey(p: SiblingLike): string {
  // canonicalKey's location part ("remote:us_only", "onsite:berlin"), plus the countries named
  const k = canonicalKey("", "", p.location).split("|")[2] ?? "";
  return `${k}|${(p.location.countries ?? []).join(",")}`;
}

function words(text: string): Set<string> {
  return new Set((text.slice(0, 4000).toLowerCase().match(/[\p{L}\p{N}+#]{3,}/gu) ?? []));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Group postings into sibling groups. Returns a stable key per posting id: the company +
 * title key, suffixed with the smallest member id when one title key holds more than one
 * JD cluster (two different roles that happen to share a title). A posting with no sibling
 * is its own group. Pure; order-independent.
 */
export function siblingGroups(postings: readonly SiblingLike[]): Map<string, string> {
  const byTitle = new Map<string, SiblingLike[]>();
  for (const p of postings) {
    const k = siblingTitleKey(p);
    const list = byTitle.get(k);
    if (list) list.push(p);
    else byTitle.set(k, [p]);
  }
  const out = new Map<string, string>();
  for (const [titleKey, members] of byTitle) {
    if (members.length === 1) {
      out.set(members[0]!.id, `${titleKey}#${members[0]!.id}`);
      continue;
    }
    // cluster by JD similarity, in id order so the result doesn't depend on input order
    const sorted = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const clusters: Array<{ members: SiblingLike[]; words: Set<string>; locs: Set<string> }> = [];
    for (const p of sorted) {
      const w = words(p.jdText ?? "");
      const lk = locKey(p);
      // a sibling is in ANOTHER place: two reqs at one place are separate headcount
      const into = clusters.find((c) => !c.locs.has(lk) && overlap(c.words, w) >= SIBLING_JD_SIMILARITY);
      if (into) {
        into.members.push(p);
        into.locs.add(lk);
      } else clusters.push({ members: [p], words: w, locs: new Set([lk]) });
    }
    clusters.forEach((c, i) => {
      // the first cluster keeps the bare title key (stable while it exists); others add their first id
      const key = i === 0 && c.members.length > 1 ? titleKey : `${titleKey}#${c.members[0]!.id}`;
      for (const m of c.members) out.set(m.id, key);
    });
  }
  return out;
}

const SHORT: Readonly<Record<string, string>> = { US: "US", GB: "UK", AE: "UAE" };
const REMOTE_REGION: Readonly<Record<string, string>> = { us_only: "US", eu_only: "Europe", us_eu: "US / Europe", india_ok: "India", apac_ok: "APAC", worldwide: "anywhere" };

/** a sibling's place in a few words: "UK", "Germany", "Canada (remote)", "anywhere (remote)" */
export function siblingPlace(loc: Posting["location"]): string {
  const d = describeLocation(loc);
  const names = d.countries.map((c, i) => SHORT[c] ?? (i === 0 ? d.country : null) ?? c);
  if (loc.mode === "remote") {
    // the countries it names when it names any ("Spain (remote)"), else its region
    const where = names.length ? names.slice(0, 2).join(" / ") : REMOTE_REGION[loc.remoteGeo];
    return where ? `${where} (remote)` : "remote";
  }
  return names[0] ?? (d.place || d.label);
}

export interface SiblingFold<T> {
  /** the items to show: one per sibling group, the group's first (best) item in input order */
  shown: T[];
  /** per shown item: the folded siblings (in input order), empty when it has none */
  siblings: Map<T, T[]>;
  /** how many items were folded under another card */
  folded: number;
}

/**
 * Fold a RANKED list so each sibling group shows once, at its best-ranked member's position
 * (the input order is the ranking — the first member of a group is the one that scores best
 * for this user). Nothing is rescored; `folded` says how many cards went under another.
 */
export function foldSiblings<T>(items: readonly T[], postingOf: (item: T) => SiblingLike): SiblingFold<T> {
  const keys = siblingGroups(items.map(postingOf));
  const lead = new Map<string, T>();
  const shown: T[] = [];
  const siblings = new Map<T, T[]>();
  let folded = 0;
  for (const it of items) {
    const key = keys.get(postingOf(it).id) ?? postingOf(it).id;
    const first = lead.get(key);
    if (first === undefined) {
      lead.set(key, it);
      shown.push(it);
      siblings.set(it, []);
    } else {
      siblings.get(first)!.push(it);
      folded++;
    }
  }
  return { shown, siblings, folded };
}

/** "Also posted for UK, Germany and Canada" / "… UK, Germany + 3 more" — card copy */
export function alsoPostedText(places: readonly string[]): string {
  const uniq = [...new Set(places.filter(Boolean))];
  if (!uniq.length) return "";
  const head = uniq.slice(0, 3);
  const rest = uniq.length - head.length;
  const list = rest > 0 ? `${head.join(", ")} + ${rest} more` : head.length === 1 ? head[0]! : `${head.slice(0, -1).join(", ")} and ${head.at(-1)}`;
  return `Also posted for ${list}`;
}
