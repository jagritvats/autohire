// FROZEN copy of DEFAULT_DISCOVERY_FEEDS / DEFAULT_TELEGRAM_CHANNELS from poll.ts before the
// discovery presets existed — the india preset must reproduce these exactly (golden test).
import type { DiscoveryFeed } from "../../src/presets/types.js";

export const LEGACY_DISCOVERY_FEEDS: DiscoveryFeed[] = [
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
  // key-gated search APIs: no-ops (no request) until their keys are set — docs/configuration.md "Optional sources"
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
export const LEGACY_TELEGRAM_CHANNELS = ["gocareers", "techuprise_updates", "dot_aware"];
