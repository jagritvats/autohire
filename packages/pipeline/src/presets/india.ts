import { INDIA_SWE_QUERIES, INDIA_TECH_HUBS } from "@jobflow/adapters";
import { SEED_COMPANIES } from "../seed.js";
import type { DiscoveryFeed, DiscoveryPreset, PresetFeed } from "./types.js";

/**
 * Default feeds, biased to what's workable from India (§11.3) and to early-/mid-career
 * roles: sources are queried with their own geo + experience facets where they have
 * one (Himalayas country + seniority, Hirist min/max exp). That shapes what we poll —
 * ranking still scores every role (invariant #4). Arbeitnow is deliberately absent:
 * it's a German-market board (mostly German-language, EU-onsite roles).
 */
export const DEFAULT_DISCOVERY_FEEDS: DiscoveryFeed[] = [
  {
    source: "himalayas", // remote roles that explicitly name India as an allowed location
    targets: [
      { query: "backend", limit: 60, params: { country: "IN", seniority: "Entry-level,Mid-level" } },
      { query: "software engineer", limit: 40, params: { country: "IN", seniority: "Entry-level,Mid-level" } },
    ],
  },
  {
    source: "hirist", // India tech board; overlapping 1–4 yr experience band
    targets: [
      { query: "backend developer", limit: 60, params: { minexp: 1, maxexp: 4 } },
      { query: "java developer", limit: 40, params: { minexp: 1, maxexp: 4 } },
    ],
  },
  {
    source: "cutshort", // India startups; listing slugs are role × city
    targets: [
      { query: "backend-developer-jobs-in-bangalore-bengaluru", limit: 50 },
      { query: "backend-developer-jobs-in-pune", limit: 50 },
      { query: "backend-developer-jobs-in-hyderabad", limit: 50 },
    ],
  },
  {
    source: "timesjobs", // links go straight to the employer's own posting (board discovery)
    targets: [
      { query: "backend", limit: 60, params: { experience: 2 } },
      { query: "java", limit: 40, params: { experience: 2 } },
    ],
  },
  { source: "instahyre", targets: [{ limit: 40, params: { years: 2 } }] }, // product cos, ~2-yr band
  { source: "wellfound", targets: [{ query: "backend-engineer", limit: 120, params: { location: "india", maxPages: 4 } }] },
  { source: "reddit", slow: true, targets: [{ limit: 100, params: { subreddit: "developersIndia" } }] }, // monthly hiring thread
  { source: "remotive", targets: [{ query: "backend", limit: 60 }] },
  { source: "hn_whoishiring", targets: [{ query: "india", limit: 60 }, { query: "backend", limit: 60 }] },
  // key-gated search APIs: no-ops (no request) until their keys are set — docs/SETUP.md "Optional sources"
  {
    source: "adzuna", // broad India aggregator; same free keys as the salary enricher
    targets: [
      { query: "backend", limit: 50, params: { titleOnly: true, maxDaysOld: 14 } },
      { query: "software engineer", limit: 50, params: { titleOnly: true, maxDaysOld: 14 } },
    ],
  },
  { source: "careerjet", targets: [{ query: "backend developer", limit: 50 }, { query: "software engineer", limit: 50 }] }, // en_IN index
  {
    source: "jsearch", // PAID: each target is called at most once per JSEARCH_MIN_HOURS (default 24h)
    targets: [{ query: "backend developer", location: "India", limit: 50, params: { country: "in", datePosted: "week" } }],
  },
];

/**
 * Public Telegram channels harvested by default. Picked from a 2026-09 review of ~100
 * Indian job channels: these three post the most DIRECT company-board links for 1–4 YoE
 * engineers (54–72%), with no scams; gocareers is usually first, the others add a few
 * unique roles a day. Most large "freshers" channels route 90%+ of links through
 * ad-funded blogs and were left out. Only links are used — postings come from the board.
 */
export const DEFAULT_TELEGRAM_CHANNELS = ["gocareers", "techuprise_updates", "dot_aware"];

/** stable preset-feed id per source (each source appears once in the India list). */
const withIds = (feeds: DiscoveryFeed[], prefix: string): PresetFeed[] => feeds.map((f) => ({ id: `${prefix}.${f.source}`, ...f }));

/**
 * `india` — today's discovery, UNCHANGED (golden-tested): the same feeds, seed employers,
 * Telegram channels and Tier-3 hubs the app always polled. Existing installs default here.
 */
export const INDIA_PRESET: DiscoveryPreset = {
  id: "india",
  label: "India",
  description: "Indian tech boards (Hirist, Cutshort, TimesJobs, Instahyre, Wellfound), India-eligible remote roles, India engineering centres of global employers, and community channels.",
  markets: ["IN"],
  feeds: withIds(DEFAULT_DISCOVERY_FEEDS, "india"),
  seedCompanies: SEED_COMPANIES,
  telegramChannels: DEFAULT_TELEGRAM_CHANNELS,
  tier3: { hubs: [...INDIA_TECH_HUBS], queries: [...INDIA_SWE_QUERIES] },
  profileDefaults: {
    currency: "INR",
    remoteGeoOk: ["india_ok", "worldwide", "apac_ok"],
    locationWeights: [
      { label: "remote", weight: 1.0 },
      { label: "india", weight: 0.85 },
    ],
  },
};
