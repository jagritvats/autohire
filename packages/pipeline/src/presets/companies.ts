import type { SeedCompany } from "../discover.js";

/**
 * Curated employers for the non-India presets — public, widely known boards. EVERY entry has
 * an explicit board URL: name-only resolution guesses a slug, and guesses go wrong here
 * (Ashby "lightspeed" is an Illinois firm, not Lightspeed Commerce; the "cursor" Ashby board
 * now carries another company's postings; Greenhouse "webflow" is an empty shell since
 * Webflow moved to Ashby). Each board was probed live 2026-11-18 through the real adapter and
 * kept only with at least one role workable in the preset's markets (for global-remote: open
 * worldwide or region-less remote). Trailing comments: those roles / of them engineering at
 * audit time — a yardstick, not a promise. Audit + method: docs/internal/PRESET_COVERAGE.md.
 */

const gh = (slug: string) => `https://boards.greenhouse.io/${slug}`;
const ashby = (slug: string) => `https://jobs.ashbyhq.com/${slug}`;
const lever = (slug: string) => `https://jobs.lever.co/${slug}`;
const sr = (slug: string) => `https://careers.smartrecruiters.com/${slug}`;
const wk = (slug: string) => `https://apply.workable.com/${slug}`;
const wd = (host: string, site: string) => `https://${host}.myworkdayjobs.com/${site}`;

/** remote-first / distributed employers — the global-remote preset. Counts: roles open worldwide (or remote with no stated region) / of those engineering. */
export const REMOTE_FIRST_COMPANIES: SeedCompany[] = [
  { name: "GitLab", careersUrl: gh("gitlab"), tags: ["remote", "devtools"], pollCadence: "daily" }, // 42 / 7
  { name: "Supabase", careersUrl: ashby("supabase"), tags: ["remote", "oss"] }, // 58 / 36
  { name: "Linear", careersUrl: ashby("Linear"), tags: ["remote", "product"] }, // 6 / 1
  { name: "Stripe", careersUrl: gh("stripe"), tags: ["fintech", "remote"], pollCadence: "daily" }, // 7 / 2
  { name: "Coinbase", careersUrl: gh("coinbase"), tags: ["fintech", "remote"] }, // 21 / 6
  { name: "Twilio", careersUrl: gh("twilio"), tags: ["devtools", "remote"] }, // 27 / 2
  { name: "Grafana Labs", careersUrl: gh("grafanalabs"), tags: ["oss", "remote", "infra"] }, // 17 / 10
  { name: "PostHog", careersUrl: ashby("posthog"), tags: ["oss", "remote", "devtools"] }, // 5 / 3
  { name: "Zapier", careersUrl: ashby("zapier"), tags: ["remote", "saas"] }, // 6 / 1
  { name: "Discord", careersUrl: gh("discord"), tags: ["consumer"] }, // 4 / 3
  { name: "Dropbox", careersUrl: gh("dropbox"), tags: ["saas", "remote"] }, // 10 / 6
  { name: "Vercel", careersUrl: gh("vercel"), tags: ["remote", "devtools"] }, // 1 / 1
  { name: "Sourcegraph", careersUrl: gh("sourcegraph91"), tags: ["remote", "devtools"] }, // 6 / 2
  { name: "Netlify", careersUrl: gh("netlify"), tags: ["remote", "devtools"] }, // 5 / 2
  { name: "Wikimedia Foundation", careersUrl: gh("wikimedia"), tags: ["remote", "oss", "nonprofit"] }, // 16 / 5
  { name: "Mozilla", careersUrl: gh("mozilla"), tags: ["remote", "oss"] }, // 35 / 24
  { name: "Metabase", careersUrl: lever("metabase"), tags: ["remote", "oss", "data"] }, // 13 / 8
  { name: "ElevenLabs", careersUrl: ashby("elevenlabs"), tags: ["remote", "ai"] }, // 31 / 5
  { name: "Kraken", careersUrl: ashby("kraken.com"), tags: ["remote", "fintech", "crypto"] }, // 8 / 5
  { name: "Improbable", careersUrl: ashby("improbable"), tags: ["remote"] }, // 4 / 1
  { name: "Prefect", careersUrl: ashby("prefect"), tags: ["remote", "oss", "data"] }, // 4 / 3
  { name: "Hugging Face", careersUrl: wk("huggingface"), tags: ["remote", "ai", "oss"] }, // 6 / 5
  { name: "ClickHouse", careersUrl: ashby("clickhouse"), tags: ["remote", "oss", "infra"] }, // 33 / 19
  { name: "Temporal", careersUrl: ashby("temporal"), tags: ["remote", "oss", "infra"] }, // 6 / 2
  { name: "1Password", careersUrl: ashby("1password"), tags: ["remote", "security"] }, // 7 / 1
  { name: "Bitwarden", careersUrl: gh("bitwarden"), tags: ["remote", "oss", "security"] }, // 8 / 2
  { name: "Brave", careersUrl: gh("brave"), tags: ["remote", "consumer"] }, // 1 / 1
  { name: "Sentry", careersUrl: ashby("sentry"), tags: ["devtools", "oss"] }, // 4 / 4
  { name: "Snyk", careersUrl: ashby("snyk"), tags: ["devtools", "security"] }, // 3 / 1
  { name: "Phantom", careersUrl: ashby("phantom"), tags: ["remote", "crypto"] }, // 9 / 9
  { name: "Zyte", careersUrl: wk("zyte"), tags: ["remote", "data"] }, // 18 / 14
];

/** US product / infra / fintech / AI employers — the us preset. Counts: US-workable roles / of those engineering. */
export const US_COMPANIES: SeedCompany[] = [
  { name: "Stripe", careersUrl: gh("stripe"), tags: ["fintech", "us"], pollCadence: "daily" }, // 361 / 81
  { name: "Airbnb", careersUrl: gh("airbnb"), tags: ["consumer", "us"] }, // 86 / 44
  { name: "Coinbase", careersUrl: gh("coinbase"), tags: ["fintech", "us"] }, // 193 / 91
  { name: "Databricks", careersUrl: gh("databricks"), tags: ["infra", "us"] }, // 415 / 190
  { name: "Ramp", careersUrl: ashby("ramp"), tags: ["fintech", "us"] }, // 168 / 45
  { name: "Plaid", careersUrl: ashby("plaid"), tags: ["fintech", "us"] }, // 131 / 51
  { name: "Palantir", careersUrl: lever("palantir"), tags: ["platform", "us"] }, // 142 / 74
  { name: "Notion", careersUrl: ashby("notion"), tags: ["saas", "us"] }, // 81 / 28
  { name: "Linear", careersUrl: ashby("Linear"), tags: ["product", "us"] }, // 18 / 7
  { name: "Snowflake", careersUrl: ashby("snowflake"), tags: ["infra", "us"] }, // 224 / 114
  { name: "Glean", careersUrl: gh("gleanwork"), tags: ["ai", "us"] }, // 90 / 32
  { name: "Rubrik", careersUrl: gh("rubrik"), tags: ["infra", "us"] }, // 71 / 16
  { name: "Toast", careersUrl: gh("toast"), tags: ["saas", "us"] }, // 192 / 30
  { name: "Twilio", careersUrl: gh("twilio"), tags: ["devtools", "us"] }, // 44 / 16
  { name: "New Relic", careersUrl: gh("newrelic"), tags: ["infra", "us"] }, // 15 / 0
  { name: "Okta", careersUrl: gh("okta"), tags: ["saas", "us"] }, // 126 / 38
  { name: "Zscaler", careersUrl: gh("zscaler"), tags: ["infra", "us", "security"] }, // 165 / 82
  { name: "MongoDB", careersUrl: gh("mongodb"), tags: ["infra", "us"] }, // 126 / 40
  { name: "Cloudflare", careersUrl: gh("cloudflare"), tags: ["infra", "us"] }, // 0 / 0 — board lists work modes ("Hybrid") in place of cities until the Greenhouse adapter reads offices[]
  { name: "Discord", careersUrl: gh("discord"), tags: ["consumer", "us"] }, // 22 / 9
  { name: "Figma", careersUrl: gh("figma"), tags: ["product", "us"] }, // 93 / 33
  { name: "Dropbox", careersUrl: gh("dropbox"), tags: ["saas", "us"] }, // 27 / 12
  { name: "Robinhood", careersUrl: gh("robinhood"), tags: ["fintech", "us"] }, // 139 / 49
  { name: "Pinterest", careersUrl: gh("pinterest"), tags: ["consumer", "us"] }, // 141 / 73
  { name: "Lyft", careersUrl: gh("lyft"), tags: ["consumer", "us"] }, // 62 / 19
  { name: "Datadog", careersUrl: gh("datadog"), tags: ["infra", "us"] }, // 210 / 42
  { name: "Instacart", careersUrl: gh("instacart"), tags: ["consumer", "us"] }, // 81 / 23
  { name: "Anthropic", careersUrl: gh("anthropic"), tags: ["ai", "us"] }, // 520 / 211
  { name: "OpenAI", careersUrl: ashby("openai"), tags: ["ai", "us"] }, // 649 / 330
  { name: "Vercel", careersUrl: gh("vercel"), tags: ["devtools", "us"] }, // 72 / 30
  { name: "Supabase", careersUrl: ashby("supabase"), tags: ["oss", "us"] }, // 51 / 33
  { name: "Brex", careersUrl: gh("brex"), tags: ["fintech", "us"] }, // 220 / 49
  { name: "Gusto", careersUrl: gh("gusto"), tags: ["saas", "us"] }, // 78 / 30
  { name: "Affirm", careersUrl: gh("affirm"), tags: ["fintech", "us"] }, // 184 / 105
  { name: "Asana", careersUrl: gh("asana"), tags: ["saas", "us"] }, // 43 / 7
  { name: "Airtable", careersUrl: gh("airtable"), tags: ["saas", "us"] }, // 7 / 0
  { name: "Samsara", careersUrl: gh("samsara"), tags: ["infra", "us"] }, // 189 / 62
  { name: "Duolingo", careersUrl: gh("duolingo"), tags: ["consumer", "us"] }, // 44 / 14
  { name: "Webflow", careersUrl: ashby("webflow"), tags: ["product", "us"] }, // 21 / 6 — moved Greenhouse → Ashby (the Greenhouse board is empty)
  { name: "Scale AI", careersUrl: gh("scaleai"), tags: ["ai", "us"] }, // 119 / 53
  { name: "Vanta", careersUrl: ashby("vanta"), tags: ["saas", "us", "security"] }, // 10 / 7
  { name: "Block", careersUrl: gh("block"), tags: ["fintech", "us"] }, // 123 / 36
  { name: "Chime", careersUrl: gh("chime"), tags: ["fintech", "us"] }, // 75 / 33
  { name: "Mercury", careersUrl: gh("mercury"), tags: ["fintech", "us"] }, // 74 / 22
  { name: "SoFi", careersUrl: gh("sofi"), tags: ["fintech", "us"] }, // 48 / 14
  { name: "Upstart", careersUrl: gh("upstart"), tags: ["fintech", "us", "ai"] }, // 75 / 32
  { name: "Wealthfront", careersUrl: lever("wealthfront"), tags: ["fintech", "us"] }, // 19 / 6
  { name: "Carta", careersUrl: gh("carta"), tags: ["fintech", "us"] }, // 40 / 2
  { name: "Gemini", careersUrl: gh("gemini"), tags: ["fintech", "crypto", "us"] }, // 22 / 11
  { name: "Kraken", careersUrl: ashby("kraken.com"), tags: ["fintech", "crypto", "us"] }, // 66 / 12
  { name: "Alchemy", careersUrl: ashby("alchemy"), tags: ["crypto", "devtools", "us"] }, // 16 / 6
  { name: "Uniswap Labs", careersUrl: ashby("uniswap"), tags: ["crypto", "us"] }, // 9 / 4
  { name: "Phantom", careersUrl: ashby("phantom"), tags: ["crypto", "us"] }, // 7 / 1
  { name: "Perplexity", careersUrl: ashby("perplexity"), tags: ["ai", "us"] }, // 126 / 44
  { name: "Harvey", careersUrl: ashby("harvey"), tags: ["ai", "us"] }, // 247 / 95
  { name: "Cohere", careersUrl: ashby("cohere"), tags: ["ai", "us"] }, // 82 / 30
  { name: "ElevenLabs", careersUrl: ashby("elevenlabs"), tags: ["ai", "us"] }, // 49 / 13
  { name: "Deepgram", careersUrl: ashby("deepgram"), tags: ["ai", "us"] }, // 41 / 18
  { name: "LangChain", careersUrl: ashby("langchain"), tags: ["ai", "devtools", "us"] }, // 74 / 25
  { name: "Modal", careersUrl: ashby("modal"), tags: ["ai", "infra", "us"] }, // 43 / 14
  { name: "Replit", careersUrl: ashby("replit"), tags: ["ai", "devtools", "us"] }, // 32 / 19
  { name: "Elastic", careersUrl: gh("elastic"), tags: ["infra", "us"] }, // 118 / 36
  { name: "Cockroach Labs", careersUrl: gh("cockroachlabs"), tags: ["infra", "us"] }, // 8 / 3
  { name: "ClickHouse", careersUrl: ashby("clickhouse"), tags: ["infra", "us"] }, // 95 / 56
  { name: "Temporal", careersUrl: ashby("temporal"), tags: ["infra", "us"] }, // 64 / 35
  { name: "Fivetran", careersUrl: gh("fivetran"), tags: ["data", "us"] }, // 128 / 39
  { name: "Airbyte", careersUrl: ashby("airbyte"), tags: ["data", "oss", "us"] }, // 14 / 8
  { name: "Astronomer", careersUrl: ashby("astronomer"), tags: ["data", "us"] }, // 12 / 4
  { name: "Hex", careersUrl: ashby("hex"), tags: ["data", "us"] }, // 41 / 19
  { name: "Metabase", careersUrl: lever("metabase"), tags: ["data", "oss", "us"] }, // 18 / 8
  { name: "Render", careersUrl: ashby("render"), tags: ["infra", "us"] }, // 36 / 26
  { name: "Docker", careersUrl: ashby("docker"), tags: ["devtools", "us"] }, // 45 / 29
  { name: "Sentry", careersUrl: ashby("sentry"), tags: ["devtools", "us"] }, // 36 / 28
  { name: "LaunchDarkly", careersUrl: gh("launchdarkly"), tags: ["devtools", "us"] }, // 18 / 1
  { name: "PagerDuty", careersUrl: gh("pagerduty"), tags: ["devtools", "us"] }, // 32 / 3
  { name: "Honeycomb", careersUrl: gh("honeycomb"), tags: ["devtools", "us"] }, // 21 / 10
  { name: "Tailscale", careersUrl: gh("tailscale"), tags: ["infra", "us"] }, // 65 / 25
  { name: "Coder", careersUrl: ashby("coder"), tags: ["devtools", "us"] }, // 11 / 5
  { name: "Warp", careersUrl: ashby("warp"), tags: ["devtools", "us"] }, // 17 / 3
  { name: "1Password", careersUrl: ashby("1password"), tags: ["security", "us"] }, // 59 / 23
  { name: "Snyk", careersUrl: ashby("snyk"), tags: ["security", "us"] }, // 20 / 1
  { name: "Tanium", careersUrl: gh("tanium"), tags: ["security", "us"] }, // 51 / 21
  { name: "Mozilla", careersUrl: gh("mozilla"), tags: ["oss", "us"] }, // 28 / 20
  { name: "Benchling", careersUrl: ashby("benchling"), tags: ["saas", "health", "us"] }, // 45 / 10
  { name: "Checkr", careersUrl: gh("checkr"), tags: ["saas", "us"] }, // 37 / 7
  { name: "Mixpanel", careersUrl: gh("mixpanel"), tags: ["saas", "us"] }, // 22 / 11
  { name: "Attio", careersUrl: ashby("attio"), tags: ["saas", "us"] }, // 10 / 2
  { name: "incident.io", careersUrl: ashby("incident"), tags: ["saas", "devtools", "us"] }, // 19 / 4
  { name: "Outreach", careersUrl: lever("outreach"), tags: ["saas", "us"] }, // 9 / 2
  { name: "Squarespace", careersUrl: gh("squarespace"), tags: ["product", "us"] }, // 11 / 4
  { name: "Faire", careersUrl: gh("faire"), tags: ["consumer", "us"] }, // 57 / 21
  { name: "DoorDash", careersUrl: gh("doordashusa"), tags: ["consumer", "us"] }, // 387 / 102
  { name: "Flexport", careersUrl: gh("flexport"), tags: ["logistics", "us"] }, // 85 / 9
  { name: "Nextdoor", careersUrl: gh("nextdoor"), tags: ["consumer", "us"] }, // 23 / 8
  { name: "Thumbtack", careersUrl: ashby("thumbtack"), tags: ["consumer", "us"] }, // 18 / 7
  { name: "Ro", careersUrl: lever("ro"), tags: ["health", "us"] }, // 54 / 17
  { name: "Roblox", careersUrl: gh("roblox"), tags: ["gaming", "us"] }, // 240 / 184
  { name: "Twitch", careersUrl: gh("twitch"), tags: ["consumer", "us"] }, // 51 / 21
  { name: "Riot Games", careersUrl: gh("riotgames"), tags: ["gaming", "us"] }, // 95 / 55
  { name: "Epic Games", careersUrl: gh("epicgames"), tags: ["gaming", "us"] }, // 56 / 23
  { name: "Waymo", careersUrl: gh("waymo"), tags: ["autonomy", "us"] }, // 302 / 160
  { name: "Zoox", careersUrl: lever("zoox"), tags: ["autonomy", "us"] }, // 200 / 118
  { name: "Nuro", careersUrl: gh("nuro"), tags: ["autonomy", "us"] }, // 98 / 74
  { name: "Verkada", careersUrl: gh("verkada"), tags: ["hardware", "us"] }, // 272 / 110
  { name: "Anduril", careersUrl: gh("andurilindustries"), tags: ["defense", "us"] }, // 2472 / 1574
  { name: "SpaceX", careersUrl: gh("spacex"), tags: ["aerospace", "us"] }, // 2665 / 1385
  { name: "Nvidia", careersUrl: wd("nvidia.wd5", "NVIDIAExternalCareerSite"), tags: ["bigtech", "us"] }, // 400 / 276
  { name: "Salesforce", careersUrl: wd("salesforce.wd12", "External_Career_Site"), tags: ["saas", "us"] }, // 400 / 116
  { name: "Adobe", careersUrl: wd("adobe.wd5", "external_experienced"), tags: ["us"] }, // 156 / 55
  { name: "PayPal", careersUrl: wd("paypal.wd1", "jobs"), tags: ["fintech", "us"] }, // 216 / 63
  { name: "Amazon", careersUrl: "https://www.amazon.jobs/en/", tags: ["bigtech", "us"] }, // 500 / 311
  { name: "Netflix", careersUrl: "https://explore.jobs.netflix.net/careers?domain=netflix.com", tags: ["consumer", "us"] }, // 200 / 65
  { name: "Qualcomm", careersUrl: "https://careers.qualcomm.com/careers?domain=qualcomm.com", tags: ["hardware", "us"] }, // 197 / 148
  { name: "JPMorgan Chase", careersUrl: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001", tags: ["fintech", "us"] }, // 1000 / 137
  { name: "Cisco", careersUrl: wd("cisco.wd5", "Cisco_Careers"), tags: ["infra", "us"] }, // 65 / 54
  { name: "Intel", careersUrl: wd("intel.wd1", "External"), tags: ["hardware", "us"] }, // 57 / 40
  { name: "Visa", careersUrl: wd("visa.wd5", "Visa"), tags: ["fintech", "us"] }, // 309 / 83
  { name: "CrowdStrike", careersUrl: wd("crowdstrike.wd5", "crowdstrikecareers"), tags: ["security", "us"] }, // 205 / 104
  { name: "Broadcom", careersUrl: wd("broadcom.wd1", "External_Career"), tags: ["hardware", "us"] }, // 78 / 64
  { name: "Workday", careersUrl: wd("workday.wd5", "Workday"), tags: ["saas", "us"] }, // 176 / 85
  { name: "Micron", careersUrl: wd("micron.wd1", "External"), tags: ["hardware", "us"] }, // 31 / 20
  { name: "Marvell", careersUrl: wd("marvell.wd1", "MarvellCareers"), tags: ["hardware", "us"] }, // 194 / 122
  { name: "Red Hat", careersUrl: wd("redhat.wd5", "jobs"), tags: ["oss", "us"] }, // 38 / 10
  { name: "Zoom", careersUrl: wd("zoom.wd5", "Zoom"), tags: ["saas", "us"] }, // 38 / 11
  { name: "Zillow", careersUrl: wd("zillow.wd5", "Zillow_Group_External"), tags: ["consumer", "us"] }, // 93 / 22
  { name: "eBay", careersUrl: wd("ebay.wd5", "apply"), tags: ["consumer", "us"] }, // 72 / 10
  { name: "Capital One", careersUrl: wd("capitalone.wd12", "Capital_One"), tags: ["fintech", "us"] }, // 52 / 23
  { name: "Fidelity Investments", careersUrl: wd("fmr.wd1", "FidelityCareers"), tags: ["fintech", "us"] }, // 400 / 47
  { name: "Target", careersUrl: wd("target.wd5", "targetcareers"), tags: ["consumer", "us"] }, // 400 / 9
  { name: "Walmart Global Tech", careersUrl: wd("walmart.wd504", "WalmartExternal"), tags: ["consumer", "us"] }, // 400 / 7
];

/** UK / EU employers — the eu-uk preset (UK, DE, NL, FR, IE, ES, Nordics; global firms with European engineering hubs). Counts: Europe-workable roles / of those engineering. */
export const EU_UK_COMPANIES: SeedCompany[] = [
  { name: "Wise", careersUrl: "https://careers.smartrecruiters.com/wise", tags: ["fintech", "eu"], pollCadence: "daily" }, // 207 / 68
  { name: "Stripe", careersUrl: gh("stripe"), tags: ["fintech", "eu"] }, // 159 / 32
  { name: "Datadog", careersUrl: gh("datadog"), tags: ["infra", "eu"] }, // 63 / 19
  { name: "Cloudflare", careersUrl: gh("cloudflare"), tags: ["infra", "eu"] }, // 1 / 1 — board lists work modes ("Hybrid") in place of cities until the Greenhouse adapter reads offices[]
  { name: "GitLab", careersUrl: gh("gitlab"), tags: ["devtools", "remote"] }, // 55 / 24
  { name: "MongoDB", careersUrl: gh("mongodb"), tags: ["infra", "eu"] }, // 92 / 33
  { name: "Databricks", careersUrl: gh("databricks"), tags: ["infra", "eu"] }, // 128 / 43
  { name: "Snowflake", careersUrl: ashby("snowflake"), tags: ["infra", "eu"] }, // 67 / 35
  { name: "Coinbase", careersUrl: gh("coinbase"), tags: ["fintech", "eu"] }, // 18 / 2
  { name: "Twilio", careersUrl: gh("twilio"), tags: ["devtools", "eu"] }, // 25 / 9
  { name: "Okta", careersUrl: gh("okta"), tags: ["saas", "eu"] }, // 31 / 12
  { name: "Airbnb", careersUrl: gh("airbnb"), tags: ["consumer", "eu"] }, // 42 / 3
  { name: "Supabase", careersUrl: ashby("supabase"), tags: ["oss", "remote"] }, // 49 / 35
  { name: "Spotify", careersUrl: lever("spotify"), tags: ["consumer", "eu"] }, // 38 / 16
  { name: "Monzo", careersUrl: gh("monzo"), tags: ["fintech", "uk"] }, // 63 / 20
  { name: "GoCardless", careersUrl: gh("gocardless"), tags: ["fintech", "uk"] }, // 18 / 8
  { name: "Deliveroo", careersUrl: gh("deliveroo"), tags: ["consumer", "uk"] }, // 129 / 40
  { name: "Checkout.com", careersUrl: ashby("checkout.com"), tags: ["fintech", "uk"] }, // 85 / 24 — on Ashby (no Greenhouse/Lever board)
  { name: "Zopa", careersUrl: lever("zopa"), tags: ["fintech", "uk"] }, // 24 / 10
  { name: "Form3", careersUrl: gh("form3"), tags: ["fintech", "uk", "remote"] }, // 4 / 1
  { name: "Paddle", careersUrl: ashby("paddle"), tags: ["fintech", "uk"] }, // 11 / 3
  { name: "Multiverse", careersUrl: ashby("multiverse"), tags: ["edtech", "uk"] }, // 24 / 5
  { name: "Synthesia", careersUrl: ashby("synthesia"), tags: ["ai", "uk"] }, // 21 / 6
  { name: "Wayve", careersUrl: ashby("wayve"), tags: ["ai", "autonomy", "uk"] }, // 65 / 43
  { name: "PolyAI", careersUrl: gh("polyai"), tags: ["ai", "uk"] }, // 4 / 2
  { name: "ElevenLabs", careersUrl: ashby("elevenlabs"), tags: ["ai", "uk"] }, // 47 / 28
  { name: "Granola", careersUrl: ashby("granola"), tags: ["ai", "uk"] }, // 14 / 8
  { name: "incident.io", careersUrl: ashby("incident"), tags: ["saas", "devtools", "uk"] }, // 15 / 6
  { name: "Attio", careersUrl: ashby("attio"), tags: ["saas", "uk"] }, // 12 / 9
  { name: "Trainline", careersUrl: ashby("trainline"), tags: ["consumer", "uk"] }, // 35 / 16
  { name: "Motorway", careersUrl: ashby("motorway"), tags: ["consumer", "uk"] }, // 12 / 8
  { name: "Preply", careersUrl: ashby("preply"), tags: ["edtech", "eu"] }, // 93 / 43
  { name: "Canonical", careersUrl: gh("canonical"), tags: ["oss", "remote", "eu"] }, // 152 / 67
  { name: "LSEG", careersUrl: wd("lseg.wd3", "Careers"), tags: ["fintech", "uk"] }, // 119 / 45
  { name: "Lloyds Banking Group", careersUrl: wd("lbg.wd3", "LBG_Careers"), tags: ["fintech", "uk"] }, // 43 / 6
  { name: "RELX", careersUrl: wd("relx.wd3", "relx"), tags: ["data", "uk"] }, // 128 / 24
  { name: "Vodafone", careersUrl: "https://vodafone.eightfold.ai/careers?domain=vodafone.com", tags: ["telecom", "uk"] }, // 352 / 20
  { name: "Intercom", careersUrl: gh("intercom"), tags: ["saas", "eu"] }, // 72 / 30
  { name: "Tines", careersUrl: gh("tines"), tags: ["security", "eu"] }, // 7 / 2
  { name: "Wayflyer", careersUrl: ashby("wayflyer"), tags: ["fintech", "eu"] }, // 10 / 4
  { name: "Celonis", careersUrl: gh("celonis"), tags: ["saas", "eu"] }, // 148 / 61
  { name: "Contentful", careersUrl: gh("contentful"), tags: ["saas", "eu"] }, // 21 / 7
  { name: "N26", careersUrl: gh("n26"), tags: ["fintech", "eu"] }, // 27 / 5
  { name: "Trade Republic", careersUrl: gh("traderepublicbank"), tags: ["fintech", "eu"] }, // 14 / 13
  { name: "SumUp", careersUrl: gh("sumup"), tags: ["fintech", "eu"] }, // 185 / 15
  { name: "Raisin", careersUrl: gh("raisin"), tags: ["fintech", "eu"] }, // 23 / 2
  { name: "Solaris", careersUrl: gh("solarisbank"), tags: ["fintech", "eu"] }, // 16 / 8
  { name: "HelloFresh", careersUrl: gh("hellofresh"), tags: ["consumer", "eu"] }, // 144 / 18
  { name: "GetYourGuide", careersUrl: ashby("getyourguide"), tags: ["consumer", "eu"] }, // 52 / 9
  { name: "Delivery Hero", careersUrl: sr("DeliveryHero"), tags: ["consumer", "eu"] }, // 30 / 5
  { name: "Grover", careersUrl: gh("grover"), tags: ["consumer", "eu"] }, // 11 / 1
  { name: "commercetools", careersUrl: gh("commercetools"), tags: ["saas", "eu"] }, // 21 / 17
  { name: "Helsing", careersUrl: gh("helsing"), tags: ["ai", "defense", "eu"] }, // 162 / 93
  { name: "n8n", careersUrl: ashby("n8n"), tags: ["devtools", "oss", "eu"] }, // 47 / 7
  { name: "Parloa", careersUrl: ashby("parloa"), tags: ["ai", "eu"] }, // 27 / 7
  { name: "Black Forest Labs", careersUrl: ashby("black-forest-labs"), tags: ["ai", "eu"] }, // 12 / 2
  { name: "DeepL", careersUrl: ashby("deepl"), tags: ["ai", "eu"] }, // 5 / 4
  { name: "Enpal", careersUrl: ashby("enpal"), tags: ["energy", "eu"] }, // 97 / 2
  { name: "Bosch", careersUrl: sr("BoschGroup"), tags: ["hardware", "eu"] }, // 672 / 54
  { name: "ZEISS", careersUrl: wd("zeissgroup.wd3", "External"), tags: ["hardware", "eu"] }, // 345 / 67
  { name: "Infineon", careersUrl: "https://jobs.infineon.com/careers?domain=infineon.com", tags: ["hardware", "eu"] }, // 163 / 46
  { name: "Adyen", careersUrl: gh("adyen"), tags: ["fintech", "eu"] }, // 99 / 23
  { name: "Mollie", careersUrl: ashby("mollie"), tags: ["fintech", "eu"] }, // 33 / 6
  { name: "Catawiki", careersUrl: gh("catawiki"), tags: ["consumer", "eu"] }, // 30 / 4
  { name: "IMC Trading", careersUrl: gh("imc"), tags: ["fintech", "trading", "eu"] }, // 31 / 9
  { name: "Flow Traders", careersUrl: gh("flowtraders"), tags: ["fintech", "trading", "eu"] }, // 18 / 11
  { name: "Elastic", careersUrl: gh("elastic"), tags: ["infra", "eu", "remote"] }, // 133 / 88
  { name: "Philips", careersUrl: wd("philips.wd3", "jobs-and-careers"), tags: ["health", "eu"] }, // 50 / 1
  { name: "Wolters Kluwer", careersUrl: wd("wk.wd3", "External"), tags: ["data", "eu"] }, // 24 / 11
  { name: "Doctolib", careersUrl: ashby("doctolib"), tags: ["health", "eu"] }, // 114 / 46
  { name: "Qonto", careersUrl: ashby("qonto"), tags: ["fintech", "eu"] }, // 43 / 12
  { name: "Alan", careersUrl: ashby("alan"), tags: ["health", "eu"] }, // 110 / 20
  { name: "Pennylane", careersUrl: ashby("pennylane"), tags: ["fintech", "saas", "eu"] }, // 84 / 6
  { name: "Back Market", careersUrl: ashby("backmarket"), tags: ["consumer", "eu"] }, // 24 / 8
  { name: "Ledger", careersUrl: ashby("ledger"), tags: ["crypto", "hardware", "eu"] }, // 17 / 6
  { name: "Pigment", careersUrl: lever("pigment"), tags: ["saas", "eu"] }, // 69 / 18
  { name: "Contentsquare", careersUrl: lever("contentsquare"), tags: ["saas", "eu"] }, // 11 / 1
  { name: "Dataiku", careersUrl: gh("dataiku"), tags: ["data", "ai", "eu"] }, // 5 / 3
  { name: "Photoroom", careersUrl: ashby("photoroom"), tags: ["ai", "eu"] }, // 7 / 2
  { name: "BlaBlaCar", careersUrl: lever("blablacar"), tags: ["consumer", "eu"] }, // 5 / 2
  { name: "Ubisoft", careersUrl: sr("Ubisoft2"), tags: ["gaming", "eu"] }, // 3 / 1
  { name: "Airbus", careersUrl: wd("ag.wd3", "Airbus"), tags: ["aerospace", "eu"] }, // 377 / 77
  { name: "Perk", careersUrl: ashby("perk"), tags: ["saas", "eu"] }, // 87 / 18
  { name: "Typeform", careersUrl: gh("typeform"), tags: ["saas", "eu", "remote"] }, // 4 / 1
  { name: "Lovable", careersUrl: ashby("lovable"), tags: ["ai", "eu"] }, // 31 / 15
  { name: "Legora", careersUrl: ashby("legora"), tags: ["ai", "eu"] }, // 69 / 21
  { name: "Pleo", careersUrl: ashby("pleo"), tags: ["fintech", "eu"] }, // 31 / 4
  { name: "Trustpilot", careersUrl: gh("trustpilot"), tags: ["consumer", "eu"] }, // 10 / 1
  { name: "Supercell", careersUrl: ashby("supercell"), tags: ["gaming", "eu"] }, // 9 / 2
  { name: "Wolt", careersUrl: gh("wolt"), tags: ["consumer", "eu"] }, // 33 / 7
  { name: "Veriff", careersUrl: gh("veriff"), tags: ["security", "eu"] }, // 5 / 2
  { name: "Maersk", careersUrl: wd("maersk.wd3", "Maersk_Careers"), tags: ["logistics", "eu"] }, // 36 / 2
  { name: "Proton", careersUrl: gh("proton"), tags: ["security", "eu"] }, // 9 / 3
  { name: "Scandit", careersUrl: gh("scandit"), tags: ["saas", "eu"] }, // 5 / 2
  { name: "ClickHouse", careersUrl: ashby("clickhouse"), tags: ["infra", "oss", "remote"] }, // 66 / 47
  { name: "Mozilla", careersUrl: gh("mozilla"), tags: ["oss", "remote"] }, // 58 / 46
  { name: "Sanity", careersUrl: ashby("sanity"), tags: ["saas", "eu"] }, // 14 / 5
  { name: "Fireblocks", careersUrl: gh("fireblocks"), tags: ["crypto", "security", "eu"] }, // 8 / 3
  { name: "Modal", careersUrl: ashby("modal"), tags: ["ai", "infra", "eu"] }, // 4 / 1
];

/** Employers hiring in Canada (Toronto, Vancouver, Montréal, Waterloo, Calgary) or Canada-remote — the canada preset. Counts: Canada-workable roles / of those engineering. */
export const CANADA_COMPANIES: SeedCompany[] = [
  { name: "Wealthsimple", careersUrl: ashby("wealthsimple"), tags: ["fintech", "canada"], pollCadence: "daily" }, // 40 / 11
  { name: "Cohere", careersUrl: ashby("cohere"), tags: ["ai", "canada"], pollCadence: "daily" }, // 50 / 19
  { name: "1Password", careersUrl: ashby("1password"), tags: ["security", "canada", "remote"] }, // 60 / 24
  { name: "Faire", careersUrl: gh("faire"), tags: ["consumer", "canada"] }, // 13 / 11
  { name: "Tailscale", careersUrl: gh("tailscale"), tags: ["infra", "canada", "remote"] }, // 70 / 25
  { name: "Honeycomb", careersUrl: gh("honeycomb"), tags: ["devtools", "canada", "remote"] }, // 21 / 10
  { name: "Thumbtack", careersUrl: ashby("thumbtack"), tags: ["consumer", "canada", "remote"] }, // 17 / 7
  { name: "Asana", careersUrl: gh("asana"), tags: ["saas", "canada"] }, // 33 / 14
  { name: "Hootsuite", careersUrl: gh("hootsuite"), tags: ["saas", "canada"] }, // 3 / 1
  { name: "Hopper", careersUrl: ashby("hopper"), tags: ["consumer", "canada"] }, // 9 / 3
  { name: "Geotab", careersUrl: gh("geotab"), tags: ["saas", "canada"] }, // 23 / 11
  { name: "Neo Financial", careersUrl: ashby("neofinancial"), tags: ["fintech", "canada"] }, // 21 / 3
  { name: "Questrade", careersUrl: gh("questrade"), tags: ["fintech", "canada"] }, // 55 / 20
  { name: "Waabi", careersUrl: lever("waabi"), tags: ["ai", "autonomy", "canada"] }, // 34 / 22
  { name: "Jobber", careersUrl: ashby("jobber"), tags: ["saas", "canada"] }, // 4 / 2
  { name: "Float", careersUrl: ashby("float"), tags: ["fintech", "canada"] }, // 20 / 3
  { name: "D2L", careersUrl: gh("d2l"), tags: ["edtech", "canada"] }, // 13 / 3
  { name: "Trulioo", careersUrl: ashby("trulioo"), tags: ["security", "canada"] }, // 16 / 3
  { name: "PointClickCare", careersUrl: lever("pointclickcare"), tags: ["health", "saas", "canada"] }, // 39 / 8
  { name: "Fullscript", careersUrl: lever("fullscript"), tags: ["health", "canada"] }, // 13 / 6
  { name: "Ubisoft", careersUrl: sr("Ubisoft2"), tags: ["gaming", "canada"] }, // 141 / 18
  { name: "Epic Games", careersUrl: gh("epicgames"), tags: ["gaming", "canada"] }, // 26 / 18
  { name: "Mozilla", careersUrl: gh("mozilla"), tags: ["oss", "canada", "remote"] }, // 27 / 20
  { name: "Docker", careersUrl: ashby("docker"), tags: ["devtools", "canada", "remote"] }, // 41 / 26
  { name: "Elastic", careersUrl: gh("elastic"), tags: ["infra", "canada", "remote"] }, // 30 / 22
  { name: "Lattice", careersUrl: gh("lattice"), tags: ["saas", "canada", "remote"] }, // 6 / 4
  { name: "Mercury", careersUrl: gh("mercury"), tags: ["fintech", "canada", "remote"] }, // 68 / 22
  { name: "PagerDuty", careersUrl: gh("pagerduty"), tags: ["devtools", "canada"] }, // 16 / 3
  { name: "Carta", careersUrl: gh("carta"), tags: ["fintech", "canada"] }, // 8 / 2
  { name: "Airbyte", careersUrl: ashby("airbyte"), tags: ["data", "canada", "remote"] }, // 12 / 8
  { name: "Benchling", careersUrl: ashby("benchling"), tags: ["saas", "health", "canada"] }, // 42 / 8
  { name: "Stripe", careersUrl: gh("stripe"), tags: ["fintech", "canada"] }, // 136 / 33
  { name: "Databricks", careersUrl: gh("databricks"), tags: ["infra", "canada"] }, // 66 / 16
  { name: "Pinterest", careersUrl: gh("pinterest"), tags: ["consumer", "canada"] }, // 77 / 40
  { name: "Instacart", careersUrl: gh("instacart"), tags: ["consumer", "canada"] }, // 81 / 23
  { name: "DoorDash", careersUrl: gh("doordashusa"), tags: ["consumer", "canada"] }, // 36 / 9
  { name: "Okta", careersUrl: gh("okta"), tags: ["saas", "canada"] }, // 48 / 37
  { name: "Ramp", careersUrl: ashby("ramp"), tags: ["fintech", "canada"] }, // 165 / 43
  { name: "Coinbase", careersUrl: gh("coinbase"), tags: ["fintech", "canada", "remote"] }, // 171 / 87
  { name: "Amazon", careersUrl: "https://www.amazon.jobs/en/", tags: ["bigtech", "canada"] }, // 213 / 154
  { name: "Salesforce", careersUrl: wd("salesforce.wd12", "External_Career_Site"), tags: ["saas", "canada"] }, // 47 / 7
  { name: "Nvidia", careersUrl: wd("nvidia.wd5", "NVIDIAExternalCareerSite"), tags: ["bigtech", "canada"] }, // 16 / 10
];
