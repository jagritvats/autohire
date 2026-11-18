import type { DiscoveryPreset } from "./types.js";
import { CANADA_COMPANIES } from "./companies.js";

/**
 * `canada` — Canadian market: Canada-eligible remote roles (Himalayas by country), the
 * key-gated Canadian indexes (Adzuna ca, Careerjet en_CA — no-ops without keys), remote
 * boards, HN, and employers with Canadian offices or Canada-remote hiring (every board
 * verified live with Canada-workable roles — docs/internal/PRESET_COVERAGE.md).
 */
export const CANADA_PRESET: DiscoveryPreset = {
  id: "canada",
  label: "Canada",
  description: "Canada-eligible remote roles, Canadian job indexes (with keys), Hacker News and employers hiring in Toronto, Vancouver, Montréal and Canada-remote.",
  markets: ["CA"],
  feeds: [
    {
      id: "canada.himalayas",
      source: "himalayas",
      targets: [
        { query: "software engineer", limit: 60, params: { country: "CA" } },
        { query: "backend", limit: 40, params: { country: "CA" } },
      ],
    },
    { id: "canada.remotive", source: "remotive", targets: [{ query: "software engineer", limit: 60 }] },
    { id: "canada.hn_whoishiring", source: "hn_whoishiring", targets: [{ query: "canada", limit: 60 }, { query: "toronto", limit: 60 }, { query: "vancouver", limit: 40 }] },
    {
      id: "canada.adzuna",
      source: "adzuna",
      targets: [{ query: "software engineer", limit: 50, params: { country: "ca", titleOnly: true, maxDaysOld: 14 } }],
    },
    { id: "canada.careerjet", source: "careerjet", targets: [{ query: "software engineer", limit: 50, params: { locale: "en_CA" } }] },
  ],
  seedCompanies: CANADA_COMPANIES,
  telegramChannels: [],
  tier3: null,
  profileDefaults: {
    currency: "CAD",
    // core files "Remote - Canada" under the North-American remote geo (us_only)
    remoteGeoOk: ["worldwide", "us_only"],
    locationWeights: [
      { label: "remote", weight: 1.0 },
      { label: "canada", weight: 0.9 },
    ],
  },
};
