import type { SeedCompany } from "../discover.js";

/**
 * Curated employers for the non-India presets — public, widely known boards. Entries with
 * a `careersUrl` are boards already polled by the India preset (verified live 2026-09) or
 * long-standing public ATS boards; NAMES-ONLY entries are ones whose board slug we haven't
 * verified: the ATS Detector resolves them at discover time and keeps a guess only if the
 * board lists a recent role workable in the preset's markets (`detectChecked`).
 */

const gh = (slug: string) => `https://boards.greenhouse.io/${slug}`;
const ashby = (slug: string) => `https://jobs.ashbyhq.com/${slug}`;
const lever = (slug: string) => `https://jobs.lever.co/${slug}`;

/** remote-first / distributed employers — the global-remote preset. */
export const REMOTE_FIRST_COMPANIES: SeedCompany[] = [
  { name: "GitLab", careersUrl: gh("gitlab"), tags: ["remote", "devtools"], pollCadence: "daily" },
  { name: "Supabase", careersUrl: ashby("supabase"), tags: ["remote", "oss"] },
  { name: "Vercel", careersUrl: gh("vercel"), tags: ["remote", "devtools"] },
  { name: "Linear", careersUrl: ashby("Linear"), tags: ["remote", "product"] },
  { name: "Notion", careersUrl: ashby("notion"), tags: ["saas"] },
  { name: "Stripe", careersUrl: gh("stripe"), tags: ["fintech", "remote"], pollCadence: "daily" },
  { name: "Coinbase", careersUrl: gh("coinbase"), tags: ["fintech", "remote"] },
  { name: "Twilio", careersUrl: gh("twilio"), tags: ["devtools", "remote"] },
  { name: "MongoDB", careersUrl: gh("mongodb"), tags: ["infra"] },
  { name: "Okta", careersUrl: gh("okta"), tags: ["saas"] },
  { name: "Cloudflare", careersUrl: gh("cloudflare"), tags: ["infra"] },
  { name: "Discord", careersUrl: gh("discord"), tags: ["consumer"] },
  { name: "Dropbox", careersUrl: gh("dropbox"), tags: ["saas", "remote"] },
  { name: "Reddit", careersUrl: gh("reddit"), tags: ["consumer", "remote"] },
  { name: "Canonical", tags: ["oss", "remote"] },
  { name: "Grafana Labs", tags: ["oss", "remote", "infra"] },
  { name: "PostHog", tags: ["oss", "remote", "devtools"] },
  { name: "Automattic", tags: ["remote", "oss"] },
  { name: "Zapier", tags: ["remote", "saas"] },
  { name: "Doist", tags: ["remote", "product"] },
  { name: "Sourcegraph", tags: ["remote", "devtools"] },
  { name: "Mattermost", tags: ["remote", "oss"] },
  { name: "Hotjar", tags: ["remote", "saas"] },
  { name: "Deel", tags: ["remote", "saas"] },
];

/** US product / infra / fintech employers — the us preset. */
export const US_COMPANIES: SeedCompany[] = [
  { name: "Stripe", careersUrl: gh("stripe"), tags: ["fintech", "us"], pollCadence: "daily" },
  { name: "Airbnb", careersUrl: gh("airbnb"), tags: ["consumer", "us"] },
  { name: "Coinbase", careersUrl: gh("coinbase"), tags: ["fintech", "us"] },
  { name: "Databricks", careersUrl: gh("databricks"), tags: ["infra", "us"] },
  { name: "Ramp", careersUrl: ashby("ramp"), tags: ["fintech", "us"] },
  { name: "Plaid", careersUrl: ashby("plaid"), tags: ["fintech", "us"] },
  { name: "Palantir", careersUrl: lever("palantir"), tags: ["platform", "us"] },
  { name: "Notion", careersUrl: ashby("notion"), tags: ["saas", "us"] },
  { name: "Linear", careersUrl: ashby("Linear"), tags: ["product", "us"] },
  { name: "Snowflake", careersUrl: ashby("snowflake"), tags: ["infra", "us"] },
  { name: "Glean", careersUrl: gh("gleanwork"), tags: ["ai", "us"] },
  { name: "Rubrik", careersUrl: gh("rubrik"), tags: ["infra", "us"] },
  { name: "Toast", careersUrl: gh("toast"), tags: ["saas", "us"] },
  { name: "Twilio", careersUrl: gh("twilio"), tags: ["devtools", "us"] },
  { name: "New Relic", careersUrl: gh("newrelic"), tags: ["infra", "us"] },
  { name: "Okta", careersUrl: gh("okta"), tags: ["saas", "us"] },
  { name: "Zscaler", careersUrl: gh("zscaler"), tags: ["infra", "us"] },
  { name: "MongoDB", careersUrl: gh("mongodb"), tags: ["infra", "us"] },
  { name: "Cloudflare", careersUrl: gh("cloudflare"), tags: ["infra", "us"] },
  { name: "Discord", careersUrl: gh("discord"), tags: ["consumer", "us"] },
  { name: "Figma", careersUrl: gh("figma"), tags: ["product", "us"] },
  { name: "Dropbox", careersUrl: gh("dropbox"), tags: ["saas", "us"] },
  { name: "Robinhood", careersUrl: gh("robinhood"), tags: ["fintech", "us"] },
  { name: "Pinterest", careersUrl: gh("pinterest"), tags: ["consumer", "us"] },
  { name: "Lyft", careersUrl: gh("lyft"), tags: ["consumer", "us"] },
  { name: "Datadog", careersUrl: gh("datadog"), tags: ["infra", "us"] },
  { name: "Instacart", careersUrl: gh("instacart"), tags: ["consumer", "us"] },
  { name: "Anthropic", careersUrl: gh("anthropic"), tags: ["ai", "us"] },
  { name: "OpenAI", careersUrl: ashby("openai"), tags: ["ai", "us"] },
  { name: "Vercel", careersUrl: gh("vercel"), tags: ["devtools", "us"] },
  { name: "Supabase", careersUrl: ashby("supabase"), tags: ["oss", "us"] },
  // big employers whose Workday boards are already verified (polled per market, server-side)
  { name: "Nvidia", careersUrl: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite", tags: ["bigtech", "us"] },
  { name: "Salesforce", careersUrl: "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site", tags: ["saas", "us"] },
  { name: "Adobe", careersUrl: "https://adobe.wd5.myworkdayjobs.com/external_experienced", tags: ["us"] },
  { name: "PayPal", careersUrl: "https://paypal.wd1.myworkdayjobs.com/jobs", tags: ["fintech", "us"] },
  { name: "Amazon", careersUrl: "https://www.amazon.jobs/en/", tags: ["bigtech", "us"] },
  // names-only: resolved (and verified) by the detector
  { name: "Brex", tags: ["fintech", "us"] },
  { name: "Gusto", tags: ["saas", "us"] },
  { name: "Affirm", tags: ["fintech", "us"] },
  { name: "Asana", tags: ["saas", "us"] },
  { name: "Airtable", tags: ["saas", "us"] },
  { name: "Samsara", tags: ["infra", "us"] },
  { name: "Duolingo", tags: ["consumer", "us"] },
  { name: "Webflow", tags: ["product", "us"] },
  { name: "Scale AI", tags: ["ai", "us"] },
  { name: "Retool", tags: ["devtools", "us"] },
  { name: "Vanta", tags: ["saas", "us"] },
];

/** UK / EU employers — the eu-uk preset. */
export const EU_UK_COMPANIES: SeedCompany[] = [
  { name: "Wise", careersUrl: "https://careers.smartrecruiters.com/wise", tags: ["fintech", "eu"], pollCadence: "daily" },
  { name: "Stripe", careersUrl: gh("stripe"), tags: ["fintech", "eu"] },
  { name: "Datadog", careersUrl: gh("datadog"), tags: ["infra", "eu"] },
  { name: "Cloudflare", careersUrl: gh("cloudflare"), tags: ["infra", "eu"] },
  { name: "GitLab", careersUrl: gh("gitlab"), tags: ["devtools", "remote"] },
  { name: "MongoDB", careersUrl: gh("mongodb"), tags: ["infra", "eu"] },
  { name: "Databricks", careersUrl: gh("databricks"), tags: ["infra", "eu"] },
  { name: "Snowflake", careersUrl: ashby("snowflake"), tags: ["infra", "eu"] },
  { name: "Coinbase", careersUrl: gh("coinbase"), tags: ["fintech", "eu"] },
  { name: "Twilio", careersUrl: gh("twilio"), tags: ["devtools", "eu"] },
  { name: "Okta", careersUrl: gh("okta"), tags: ["saas", "eu"] },
  { name: "Airbnb", careersUrl: gh("airbnb"), tags: ["consumer", "eu"] },
  { name: "Supabase", careersUrl: ashby("supabase"), tags: ["oss", "remote"] },
  { name: "Spotify", careersUrl: lever("spotify"), tags: ["consumer", "eu"] },
  // names-only: resolved (and verified) by the detector
  { name: "Monzo", tags: ["fintech", "uk"] },
  { name: "GoCardless", tags: ["fintech", "uk"] },
  { name: "Intercom", tags: ["saas", "eu"] },
  { name: "Deliveroo", tags: ["consumer", "uk"] },
  { name: "Checkout.com", tags: ["fintech", "uk"] },
  { name: "Contentful", tags: ["saas", "eu"] },
  { name: "Celonis", tags: ["saas", "eu"] },
  { name: "Adyen", tags: ["fintech", "eu"] },
  { name: "N26", tags: ["fintech", "eu"] },
  { name: "Klarna", tags: ["fintech", "eu"] },
  { name: "Mollie", tags: ["fintech", "eu"] },
  { name: "Personio", tags: ["saas", "eu"] },
  { name: "Miro", tags: ["product", "eu"] },
];
