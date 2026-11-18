import type { DiscoveryPreset } from "./types.js";
import { EU_UK_COMPANIES } from "./companies.js";

/**
 * `eu-uk` — UK + EU: EU/UK-eligible remote roles (Himalayas by country), the key-gated
 * national indexes (Adzuna gb/de/nl, Careerjet en_GB/de_DE/nl_NL — no-ops without keys), Arbeitnow
 * (a German-market board, so EU-only), remote boards, HN, and well-known UK/EU employers.
 */
export const EU_UK_PRESET: DiscoveryPreset = {
  id: "eu-uk",
  label: "UK & Europe",
  description: "UK/EU-eligible remote roles, UK and German job indexes (with keys), Arbeitnow, Hacker News and well-known UK/EU employers.",
  markets: ["GB", "DE", "NL"],
  feeds: [
    {
      id: "eu-uk.himalayas",
      source: "himalayas",
      targets: [
        { query: "software engineer", limit: 40, params: { country: "GB" } },
        { query: "software engineer", limit: 40, params: { country: "DE" } },
        { query: "software engineer", limit: 40, params: { country: "NL" } },
      ],
    },
    { id: "eu-uk.arbeitnow", source: "arbeitnow", targets: [{ query: "engineer", limit: 60 }, { query: "developer", limit: 60 }] },
    { id: "eu-uk.remotive", source: "remotive", targets: [{ query: "software engineer", limit: 60 }] },
    {
      id: "eu-uk.hn_whoishiring",
      source: "hn_whoishiring",
      targets: [
        { query: "europe", limit: 60 },
        { query: "london", limit: 60 },
        { query: "berlin", limit: 40 },
        { query: "amsterdam", limit: 40 },
      ],
    },
    {
      id: "eu-uk.adzuna",
      source: "adzuna",
      targets: [
        { query: "software engineer", limit: 50, params: { country: "gb", titleOnly: true, maxDaysOld: 14 } },
        { query: "software engineer", limit: 50, params: { country: "de", titleOnly: true, maxDaysOld: 14 } },
        { query: "software engineer", limit: 50, params: { country: "nl", titleOnly: true, maxDaysOld: 14 } },
      ],
    },
    {
      id: "eu-uk.careerjet",
      source: "careerjet",
      targets: [
        { query: "software engineer", limit: 50, params: { locale: "en_GB" } },
        { query: "software engineer", limit: 50, params: { locale: "de_DE" } },
        { query: "software engineer", limit: 50, params: { locale: "nl_NL" } },
      ],
    },
  ],
  seedCompanies: EU_UK_COMPANIES,
  telegramChannels: [],
  tier3: null,
  profileDefaults: {
    currency: "EUR",
    remoteGeoOk: ["worldwide", "eu_only", "us_eu"],
    locationWeights: [
      { label: "remote", weight: 1.0 },
      { label: "europe", weight: 0.9 },
    ],
  },
};
