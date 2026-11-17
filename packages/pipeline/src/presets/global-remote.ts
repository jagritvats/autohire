import type { DiscoveryPreset } from "./types.js";
import { REMOTE_FIRST_COMPANIES } from "./companies.js";

/**
 * `global-remote` — work-from-anywhere: worldwide remote roles (Himalayas with no country,
 * Remotive), HN, and remote-first employers. No market: country-filtered boards aren't
 * the point here, and nothing is assumed about where the user lives.
 */
export const GLOBAL_REMOTE_PRESET: DiscoveryPreset = {
  id: "global-remote",
  label: "Global remote",
  description: "Worldwide remote roles from remote boards and Hacker News, plus remote-first employers.",
  markets: [],
  feeds: [
    {
      id: "global-remote.himalayas",
      source: "himalayas",
      targets: [
        { query: "software engineer", limit: 60, params: { country: "" } },
        { query: "backend", limit: 40, params: { country: "" } },
      ],
    },
    {
      id: "global-remote.remotive",
      source: "remotive",
      targets: [
        { query: "software engineer", limit: 60 },
        { query: "backend", limit: 40 },
      ],
    },
    { id: "global-remote.hn_whoishiring", source: "hn_whoishiring", targets: [{ query: "remote", limit: 80 }] },
  ],
  seedCompanies: REMOTE_FIRST_COMPANIES,
  telegramChannels: [],
  tier3: null,
  profileDefaults: {
    currency: "USD",
    remoteGeoOk: ["worldwide"],
    locationWeights: [{ label: "remote", weight: 1.0 }],
  },
};
