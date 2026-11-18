import type { DiscoveryPreset } from "./types.js";
import { US_COMPANIES } from "./companies.js";

/**
 * `us` — US market: US-eligible remote roles (Himalayas by country), the key-gated US
 * indexes (Adzuna us, Careerjet en_US — no-ops without keys), remote boards, HN, and
 * well-known US employers. Feed ids are stable (a tenant switches them off by id).
 */
export const US_PRESET: DiscoveryPreset = {
  id: "us",
  label: "United States",
  description: "US-eligible remote roles, US job indexes (with keys), Hacker News and well-known US product, infra and fintech employers.",
  markets: ["US"],
  feeds: [
    {
      id: "us.himalayas",
      source: "himalayas",
      targets: [
        { query: "software engineer", limit: 60, params: { country: "US" } },
        { query: "backend", limit: 40, params: { country: "US" } },
      ],
    },
    { id: "us.remotive", source: "remotive", targets: [{ query: "software engineer", limit: 60 }] },
    // Jobicy: remote roles by Jobicy geo, last 7 days. Its terms allow one automated pass an
    // hour, which the adapter enforces per target; `slow` keeps request-bound refreshes off it.
    { id: "us.jobicy", source: "jobicy", slow: true, targets: [{ limit: 100, params: { geo: "usa", industry: "engineering" } }] },
    { id: "us.hn_whoishiring", source: "hn_whoishiring", targets: [{ query: "backend", limit: 60 }, { query: "remote", limit: 60 }] },
    {
      id: "us.adzuna",
      source: "adzuna",
      targets: [{ query: "software engineer", limit: 50, params: { country: "us", titleOnly: true, maxDaysOld: 14 } }],
    },
    { id: "us.careerjet", source: "careerjet", targets: [{ query: "software engineer", limit: 50, params: { locale: "en_US" } }] },
  ],
  seedCompanies: US_COMPANIES,
  telegramChannels: [],
  tier3: null,
  profileDefaults: {
    currency: "USD",
    remoteGeoOk: ["worldwide", "us_only", "us_eu"],
    locationWeights: [
      { label: "remote", weight: 1.0 },
      { label: "united states", weight: 0.9 },
    ],
  },
};
