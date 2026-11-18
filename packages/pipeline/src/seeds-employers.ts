import type { SeedCompany } from "./discover.js";

/**
 * Employers with India engineering centres, verified live 2026-09-27 against their
 * public boards (Workday CXS / Eightfold PCSX + older apply-v2 / Oracle HCM / iCIMS Jibe /
 * Radancy TalentBrew / SmartRecruiters / Greenhouse / Lever / Ashby). Comments: India
 * engineering roles / of those with junior-or-mid titles at verification time — a
 * yardstick, not a promise. Numbered ladders (Engineer 3/4/5) pass the title check; where
 * they dominate, the count without them is noted and the board polls weekly.
 *
 * Kept: ≥3 junior/mid India engineering roles, or ≥20 India engineering roles overall.
 * Boards with ≥20 junior/mid roles poll daily; the rest weekly (pollAll bounds how many
 * boards one run touches, so the first sweep spreads over several runs).
 * Semiconductor / industrial counts include hardware & VLSI roles — the ranker's
 * archetype signal pushes those down for a backend profile.
 */
const d = "daily" as const;

export const INDIA_EMPLOYER_BOARDS: SeedCompany[] = [
  // ── Workday ── (removed 2026-11: NXP — the tenant answers 422 for every site; LiveRamp —
  // its site answers 403 "permission denied")
  { name: "GE Vernova", careersUrl: "https://gevernova.wd5.myworkdayjobs.com/Vernova_ExternalSite", tags: ["global", "india", "energy"], pollCadence: d }, // 251 / 88
  { name: "Citi", careersUrl: "https://citi.wd5.myworkdayjobs.com/2", tags: ["global", "india", "fintech", "gcc"], pollCadence: d }, // 247 / 60
  { name: "Micron", careersUrl: "https://micron.wd1.myworkdayjobs.com/External", tags: ["global", "india", "hardware"], pollCadence: d }, // 230 / 53
  { name: "Amgen", careersUrl: "https://amgen.wd1.myworkdayjobs.com/Careers", tags: ["global", "india", "health", "gcc"], pollCadence: d }, // 182 / 82
  { name: "Cadence", careersUrl: "https://cadence.wd1.myworkdayjobs.com/External_Careers", tags: ["global", "india", "hardware"] }, // 179 / 19
  { name: "HPE", careersUrl: "https://hpe.wd5.myworkdayjobs.com/Jobsathpe", tags: ["global", "india", "hardware"], pollCadence: d }, // 178 / 117
  { name: "Walmart Global Tech", careersUrl: "https://walmart.wd504.myworkdayjobs.com/WalmartExternal", tags: ["global", "india", "consumer"] }, // 173 / 19
  { name: "Barclays", careersUrl: "https://barclays.wd3.myworkdayjobs.com/External_Career_Site_Barclays", tags: ["global", "india", "fintech", "gcc"], pollCadence: d }, // 143 / 79
  { name: "Airbus", careersUrl: "https://ag.wd3.myworkdayjobs.com/Airbus", tags: ["global", "india"], pollCadence: d }, // 113 / 89
  { name: "LSEG", careersUrl: "https://lseg.wd3.myworkdayjobs.com/Careers", tags: ["global", "india", "fintech"], pollCadence: d }, // 107 / 32
  { name: "Analog Devices", careersUrl: "https://analogdevices.wd1.myworkdayjobs.com/External", tags: ["global", "india", "hardware"] }, // 90 / 14
  { name: "Applied Materials", careersUrl: "https://amat.wd1.myworkdayjobs.com/External", tags: ["global", "india", "hardware"], pollCadence: d }, // 88 / 67
  { name: "Microchip", careersUrl: "https://microchiphr.wd5.myworkdayjobs.com/external", tags: ["global", "india", "hardware"] }, // 76 / 13
  { name: "Broadcom", careersUrl: "https://broadcom.wd1.myworkdayjobs.com/External_Career", tags: ["global", "india", "hardware"], pollCadence: d }, // 70 / 40
  { name: "Qualys", careersUrl: "https://qualys.wd5.myworkdayjobs.com/careers", tags: ["global", "india", "security"] }, // 70 / 14
  { name: "Harman", careersUrl: "https://harman.wd3.myworkdayjobs.com/HARMAN", tags: ["global", "india"], pollCadence: d }, // 67 / 61
  { name: "Nike", careersUrl: "https://nike.wd1.myworkdayjobs.com/nke", tags: ["global", "india", "consumer"] }, // 66 / 19
  { name: "State Street", careersUrl: "https://statestreet.wd1.myworkdayjobs.com/Global", tags: ["global", "india", "fintech", "gcc"] }, // 59 / 9
  { name: "Aptiv", careersUrl: "https://aptiv.wd5.myworkdayjobs.com/APTIV_CAREERS", tags: ["global", "india"], pollCadence: d }, // 55 / 26
  { name: "SimCorp", careersUrl: "https://simcorp.wd3.myworkdayjobs.com/SimCorp_Jobs", tags: ["global", "india", "fintech"] }, // 55 / 9
  { name: "Wells Fargo", careersUrl: "https://wf.wd1.myworkdayjobs.com/WellsFargoJobs", tags: ["global", "india", "fintech", "gcc"] }, // 55 / 0
  { name: "Johnson Controls", careersUrl: "https://jci.wd5.myworkdayjobs.com/JCI", tags: ["global", "india"], pollCadence: d }, // 54 / 42
  { name: "Danaher", careersUrl: "https://danaher.wd1.myworkdayjobs.com/DanaherJobs", tags: ["global", "india", "health"] }, // 52 / 15
  { name: "GE HealthCare", careersUrl: "https://gehc.wd5.myworkdayjobs.com/GEHC_ExternalSite", tags: ["global", "india", "health"], pollCadence: d }, // 49 / 20
  { name: "Medtronic", careersUrl: "https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers", tags: ["global", "india", "health"] }, // 48 / 13
  { name: "Cigna", careersUrl: "https://cigna.wd5.myworkdayjobs.com/cignacareers", tags: ["global", "india", "health", "gcc"] }, // 47 / 12
  { name: "Commonwealth Bank (CBA India)", careersUrl: "https://cba.wd3.myworkdayjobs.com/CommBank_Careers", tags: ["global", "india", "fintech", "gcc"] }, // 47 / 1
  { name: "Deutsche Bank", careersUrl: "https://db.wd3.myworkdayjobs.com/DBWebsite", tags: ["global", "india", "fintech", "gcc"] }, // 45 / 8
  { name: "Caterpillar", careersUrl: "https://cat.wd5.myworkdayjobs.com/CaterpillarCareers", tags: ["global", "india", "gcc"] }, // 40 / 16
  { name: "Intel", careersUrl: "https://intel.wd1.myworkdayjobs.com/External", tags: ["global", "india", "hardware"], pollCadence: d }, // 38 / 32
  { name: "FIS", careersUrl: "https://fis.wd5.myworkdayjobs.com/SearchJobs", tags: ["global", "india", "fintech"], pollCadence: d }, // 38 / 23
  { name: "Stryker", careersUrl: "https://stryker.wd1.myworkdayjobs.com/StrykerCareers", tags: ["global", "india", "health"] }, // 35 / 5
  { name: "Lloyds Technology Centre", careersUrl: "https://lbg.wd3.myworkdayjobs.com/Lloyds_Technology_Centre", tags: ["global", "india", "fintech", "gcc"] }, // 31 / 6
  { name: "ZEISS", careersUrl: "https://zeissgroup.wd3.myworkdayjobs.com/External", tags: ["global", "india"] }, // 29 / 12
  { name: "RELX", careersUrl: "https://relx.wd3.myworkdayjobs.com/relx", tags: ["global", "india"] }, // 29 / 7
  { name: "Wolters Kluwer", careersUrl: "https://wk.wd3.myworkdayjobs.com/External", tags: ["global", "india"] }, // 29 / 5
  { name: "Blue Yonder", careersUrl: "https://jda.wd5.myworkdayjobs.com/JDA_Careers", tags: ["global", "india", "saas"] }, // 28 / 6
  { name: "Solera", careersUrl: "https://solera.wd5.myworkdayjobs.com/global_career_site", tags: ["global", "india", "saas"] }, // 28 / 0
  { name: "Warner Bros. Discovery", careersUrl: "https://warnerbros.wd5.myworkdayjobs.com/global", tags: ["global", "india", "consumer"] }, // 27 / 4
  { name: "Motorola Solutions", careersUrl: "https://motorolasolutions.wd5.myworkdayjobs.com/Careers", tags: ["global", "india"] }, // 25 / 14
  { name: "BlackRock", careersUrl: "https://blackrock.wd1.myworkdayjobs.com/BlackRock_Professional", tags: ["global", "india", "fintech", "gcc"] }, // 25 / 8
  { name: "Maersk", careersUrl: "https://maersk.wd3.myworkdayjobs.com/Maersk_Careers", tags: ["global", "india", "gcc"] }, // 25 / 6
  { name: "Thomson Reuters", careersUrl: "https://thomsonreuters.wd5.myworkdayjobs.com/External_Career_Site", tags: ["global", "india"] }, // 25 / 4
  { name: "Eli Lilly", careersUrl: "https://lilly.wd115.myworkdayjobs.com/LLY", tags: ["global", "india", "health", "gcc"] }, // 23 / 8
  // no country facet on this tenant — the adapter filters by its "India - Chennai, …" sites
  { name: "Comcast", careersUrl: "https://comcast.wd115.myworkdayjobs.com/Comcast_Careers", tags: ["global", "india", "consumer", "gcc"] }, // 22 / 21 (10 without Engineer 3–5)
  { name: "Dexcom", careersUrl: "https://dexcom.wd1.myworkdayjobs.com/Dexcom", tags: ["global", "india", "health"] }, // 22 / 9
  { name: "First Citizens India", careersUrl: "https://svb.wd5.myworkdayjobs.com/firstcitizensindia", tags: ["global", "india", "fintech", "gcc"] }, // 22 / 6
  { name: "CrowdStrike", careersUrl: "https://crowdstrike.wd5.myworkdayjobs.com/crowdstrikecareers", tags: ["global", "india", "security"] }, // 21 / 13
  { name: "KLA", careersUrl: "https://kla.wd1.myworkdayjobs.com/Search", tags: ["global", "india", "hardware"] }, // 20 / 13
  { name: "Bristol Myers Squibb", careersUrl: "https://bristolmyerssquibb.wd5.myworkdayjobs.com/BMS", tags: ["global", "india", "health", "gcc"] }, // 20 / 9
  { name: "Zebra Technologies", careersUrl: "https://zebra.wd501.myworkdayjobs.com/Zebra_careers", tags: ["global", "india", "hardware"] }, // 20 / 6
  { name: "Disney", careersUrl: "https://disney.wd5.myworkdayjobs.com/disneycareer", tags: ["global", "india", "consumer"] }, // 20 / 3
  { name: "NCR Voyix", careersUrl: "https://ncr.wd1.myworkdayjobs.com/ext_apac", tags: ["global", "india"] }, // 19 / 11
  { name: "Chevron", careersUrl: "https://chevron.wd5.myworkdayjobs.com/jobs", tags: ["global", "india", "energy", "gcc"] }, // 19 / 11
  { name: "Harris Computer", careersUrl: "https://harriscomputer.wd3.myworkdayjobs.com/1", tags: ["global", "india", "saas"] }, // 19 / 8
  { name: "Morgan Stanley", careersUrl: "https://ms.wd5.myworkdayjobs.com/External", tags: ["global", "india", "fintech", "gcc"] }, // 19 / 2 (113 India roles; many titled "Associate")
  { name: "HP", careersUrl: "https://hp.wd5.myworkdayjobs.com/ExternalCareerSite", tags: ["global", "india", "hardware"] }, // 18 / 14
  { name: "Equifax", careersUrl: "https://equifax.wd5.myworkdayjobs.com/External", tags: ["global", "india", "fintech"] }, // 18 / 13
  { name: "Rockwell Automation", careersUrl: "https://rockwellautomation.wd1.myworkdayjobs.com/External_Rockwell_Automation", tags: ["global", "india"] }, // 18 / 13
  { name: "Finastra", careersUrl: "https://finastra.wd3.myworkdayjobs.com/FINC", tags: ["global", "india", "fintech", "saas"] }, // 18 / 5
  { name: "Northern Trust", careersUrl: "https://ntrs.wd1.myworkdayjobs.com/northerntrust", tags: ["global", "india", "fintech", "gcc"] }, // 18 / 3
  { name: "3M", careersUrl: "https://3m.wd1.myworkdayjobs.com/Search", tags: ["global", "india"] }, // 17 / 14
  { name: "MSD", careersUrl: "https://msd.wd5.myworkdayjobs.com/SearchJobs", tags: ["global", "india", "health", "gcc"] }, // 17 / 8
  { name: "Amex GBT", careersUrl: "https://travelhrportal.wd1.myworkdayjobs.com/Jobs", tags: ["global", "india", "consumer"] }, // 16 / 11
  { name: "Nasdaq", careersUrl: "https://nasdaq.wd1.myworkdayjobs.com/Global_External_Site", tags: ["global", "india", "fintech"] }, // 16 / 5
  { name: "Novartis", careersUrl: "https://novartis.wd3.myworkdayjobs.com/Novartis_Careers", tags: ["global", "india", "health", "gcc"] }, // 16 / 5
  { name: "Philips", careersUrl: "https://philips.wd3.myworkdayjobs.com/jobs-and-careers", tags: ["global", "india", "health"] }, // 15 / 11
  { name: "F5", careersUrl: "https://ffive.wd5.myworkdayjobs.com/f5jobs", tags: ["global", "india", "infra"] }, // 13 / 8
  { name: "Worldpay", careersUrl: "https://worldpay.wd5.myworkdayjobs.com/Worldpay_External_Careers_Site", tags: ["global", "india", "fintech"] }, // 13 / 6
  { name: "Trimble", careersUrl: "https://trimble.wd1.myworkdayjobs.com/TrimbleCareers", tags: ["global", "india", "saas"] }, // 12 / 3
  { name: "NCR Atleos", careersUrl: "https://ncratleos.wd1.myworkdayjobs.com/ext_apacatleos", tags: ["global", "india", "fintech"] }, // 10 / 7
  { name: "Newfold Digital", careersUrl: "https://web.wd1.myworkdayjobs.com/ExternalCareerSite", tags: ["global", "india"] }, // 10 / 3
  { name: "Broadridge", careersUrl: "https://broadridge.wd5.myworkdayjobs.com/Careers", tags: ["global", "india", "fintech"] }, // 8 / 5
  { name: "Fiserv", careersUrl: "https://fiserv.wd5.myworkdayjobs.com/EXT", tags: ["global", "india", "fintech"] }, // 8 / 4
  { name: "CME Group", careersUrl: "https://cmegroup.wd1.myworkdayjobs.com/cme_careers", tags: ["global", "india", "fintech"] }, // 7 / 5
  { name: "Invesco", careersUrl: "https://invesco.wd1.myworkdayjobs.com/IVZ", tags: ["global", "india", "fintech"] }, // 6 / 4
  { name: "Lowe's", careersUrl: "https://lowes.wd5.myworkdayjobs.com/LWS_External_CS", tags: ["global", "india", "consumer", "gcc"] }, // 6 / 3
  { name: "Veralto", careersUrl: "https://veralto.wd1.myworkdayjobs.com/HachJobs", tags: ["global", "india"] }, // 5 / 5
  { name: "Ciena", careersUrl: "https://ciena.wd5.myworkdayjobs.com/Careers", tags: ["global", "india", "infra"] }, // 5 / 4

  // ── Eightfold PCSX ──
  { name: "Vodafone (VOIS)", careersUrl: "https://vodafone.eightfold.ai/careers?domain=vodafone.com", tags: ["global", "india", "gcc"], pollCadence: d }, // 115 / 78
  { name: "Infineon", careersUrl: "https://jobs.infineon.com/careers?domain=infineon.com", tags: ["global", "india", "hardware"] }, // 90 / 8
  { name: "Lam Research", careersUrl: "https://careers.lamresearch.com/careers?domain=lamresearch.com", tags: ["global", "india", "hardware"] }, // 52 / 21 (8 without Engineer 3–4; mostly mechanical/electrical)
  { name: "Fortive", careersUrl: "https://fortive.eightfold.ai/careers?domain=fortive.com", tags: ["global", "india"] }, // 17 / 11
  { name: "Amdocs", careersUrl: "https://amdocs.eightfold.ai/careers?domain=amdocs.com", tags: ["global", "india", "saas"] }, // 3 / 3

  // ── Eightfold, older /api/apply/v2 (PCSX answers 403; the detector resolves "…/v2") ──
  { name: "NetApp", careersUrl: "https://netapp.eightfold.ai/careers?domain=netapp.com", tags: ["global", "india", "infra"] }, // 34 / 12
  { name: "Bayer", careersUrl: "https://talent.bayer.com/careers?domain=bayer.com", tags: ["global", "india", "health"] }, // 10 / 4
  { name: "HSBC", careersUrl: "https://portal.careers.hsbc.com/careers?domain=hsbc.com", tags: ["global", "india", "fintech", "gcc"] }, // 4 / 0 by title (159 India roles, 15 in Technology; ICs are titled "Consultant Specialist")

  // ── iCIMS Jibe (the careers site's own /api/jobs) ──
  { name: "PepsiCo", careersUrl: "https://www.pepsicojobs.com/main/jobs", tags: ["global", "india", "consumer", "gcc"] }, // 26 / 7 (232 India roles; the junior ones are "R&D Digital Platforms Analyst")
  { name: "Keysight", careersUrl: "https://jobs.keysight.com/external/jobs", tags: ["global", "india", "hardware"] }, // 20 / 18 by title, but ~1 below "Engineer 4" (ladder runs 1–6; posts Engineer 1 roles at times)

  // ── Radancy TalentBrew (the careers site's own search endpoint) ──
  { name: "Optum", careersUrl: "https://careers.unitedhealthgroup.com/search-jobs", tags: ["global", "india", "health", "gcc"], pollCadence: d }, // 148 / 23 (UnitedHealth Group board; 252 India roles)

  // ── Oracle HCM (CX site numbers resolved from recruitingCESites, never aliases) ──
  { name: "Honeywell", careersUrl: "https://ibqbjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1", tags: ["global", "india"], pollCadence: d }, // 165 / 145
  { name: "Texas Instruments", careersUrl: "https://edbz.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX", tags: ["global", "india", "hardware"], pollCadence: d }, // 102 / 74
  { name: "BNY", careersUrl: "https://eofe.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_3001", tags: ["global", "india", "fintech", "gcc"] }, // 77 / 2
  { name: "Honeywell Aerospace", careersUrl: "https://icfcjb.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_4001", tags: ["global", "india"], pollCadence: d }, // 34 / 21
  { name: "American Express", careersUrl: "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1", tags: ["global", "india", "fintech"] }, // 10 / 4
  { name: "Akamai", careersUrl: "https://fa-extu-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1", tags: ["global", "india", "infra"] }, // 11 / 3

  // ── SmartRecruiters ──
  { name: "Bosch", careersUrl: "https://careers.smartrecruiters.com/BoschGroup", tags: ["global", "india"], pollCadence: d }, // 200 / 127
  { name: "Eurofins", careersUrl: "https://careers.smartrecruiters.com/Eurofins", tags: ["global", "india", "gcc"], pollCadence: d }, // 157 / 69
  { name: "LinkedIn", careersUrl: "https://careers.smartrecruiters.com/LinkedIn3", tags: ["global", "india", "bigtech"] }, // 24 / 1
  { name: "Arista Networks", careersUrl: "https://careers.smartrecruiters.com/AristaNetworks", tags: ["global", "india", "infra"] }, // 20 / 19
  { name: "NielsenIQ", careersUrl: "https://careers.smartrecruiters.com/NielsenIQ", tags: ["global", "india", "data"] }, // 14 / 5
  { name: "Intuitive", careersUrl: "https://careers.smartrecruiters.com/intuitive", tags: ["global", "india", "health"] }, // 8 / 6
  { name: "Ubisoft", careersUrl: "https://careers.smartrecruiters.com/Ubisoft2", tags: ["global", "india", "consumer"] }, // 3 / 3

  // ── Greenhouse / Lever / Ashby / Workable ──
  { name: "Extreme Networks", careersUrl: "https://jobs.lever.co/extremenetworks", tags: ["global", "india", "infra"] }, // 39 / 3
  { name: "Pure Storage", careersUrl: "https://boards.greenhouse.io/purestorage", tags: ["global", "india", "infra"] }, // 32 / 11 (board is branded "Everpure")
  { name: "PubMatic", careersUrl: "https://boards.greenhouse.io/pubmatic", tags: ["global", "india", "adtech"] }, // 29 / 2
  { name: "GitLab", careersUrl: "https://boards.greenhouse.io/gitlab", tags: ["global", "india", "devtools", "remote"] }, // 23 / 3
  { name: "HackerRank", careersUrl: "https://boards.greenhouse.io/hackerrank", tags: ["india", "devtools"] }, // 12 / 7
  { name: "OpenGov", careersUrl: "https://jobs.ashbyhq.com/opengov", tags: ["global", "india", "saas"] }, // 9 / 7
  { name: "GHX", careersUrl: "https://boards.greenhouse.io/globalhealthcareexchangeinc", tags: ["global", "india", "health", "saas"] }, // 9 / 3
  { name: "Graviton Research", careersUrl: "https://boards.greenhouse.io/gravitonresearchcapital", tags: ["india", "fintech"] }, // 7 / 7
  { name: "Plane", careersUrl: "https://jobs.ashbyhq.com/plane", tags: ["india", "devtools", "oss"] }, // 7 / 4
  { name: "Zimperium", careersUrl: "https://jobs.lever.co/zimperium", tags: ["global", "india", "security"] }, // 5 / 4
  { name: "DoorDash India", careersUrl: "https://boards.greenhouse.io/doordashindia", tags: ["global", "india", "consumer"] }, // 5 / 3
  { name: "Netomi", careersUrl: "https://jobs.lever.co/netomi", tags: ["india", "ai", "saas"] }, // 4 / 4
  { name: "AiPrise", careersUrl: "https://jobs.ashbyhq.com/aiprise", tags: ["india", "fintech"] }, // 3 / 3
  { name: "Kong", careersUrl: "https://jobs.ashbyhq.com/kong", tags: ["global", "india", "devtools"] }, // 3 / 3
  { name: "CloudSEK", careersUrl: "https://boards.greenhouse.io/cloudsek", tags: ["india", "security"] }, // 3 / 3
  { name: "SigNoz", careersUrl: "https://jobs.ashbyhq.com/signoz", tags: ["india", "devtools", "oss", "infra"] }, // 9 / 2 (OSS, India-first)

  // ── added in the 2026-11-18 coverage audit (docs/internal/PRESET_COVERAGE.md) ──
  // Comments here: India-workable roles / of those engineering by title (any level) — a
  // different yardstick from the junior/mid counts above.
  { name: "eBay", careersUrl: "https://ebay.wd5.myworkdayjobs.com/apply", tags: ["global", "india", "consumer"], pollCadence: d }, // 105 / 45
  { name: "S&P Global", careersUrl: "https://spgi.wd5.myworkdayjobs.com/SPGI_Careers", tags: ["global", "india", "fintech", "data"] }, // 59 / 25
  { name: "Marvell", careersUrl: "https://marvell.wd1.myworkdayjobs.com/MarvellCareers", tags: ["global", "india", "hardware"] }, // 42 / 29
  { name: "Gartner", careersUrl: "https://gartner.wd5.myworkdayjobs.com/EXT", tags: ["global", "india", "data"] }, // 36 / 7
  { name: "Fidelity Investments", careersUrl: "https://fmr.wd1.myworkdayjobs.com/FidelityCareers", tags: ["global", "india", "fintech", "gcc"] }, // 17 / 10
  { name: "Red Hat", careersUrl: "https://redhat.wd5.myworkdayjobs.com/jobs", tags: ["global", "india", "oss"] }, // 6 / 1
  { name: "Zoom", careersUrl: "https://zoom.wd5.myworkdayjobs.com/Zoom", tags: ["global", "india", "saas"] }, // 4 / 2
  { name: "Fivetran", careersUrl: "https://boards.greenhouse.io/fivetran", tags: ["global", "india", "data"] }, // 18 / 13
  { name: "Bitwarden", careersUrl: "https://boards.greenhouse.io/bitwarden", tags: ["global", "india", "security", "oss"] }, // 17 / 17 (Noida)
  { name: "Elastic", careersUrl: "https://boards.greenhouse.io/elastic", tags: ["global", "india", "infra", "remote"] }, // 17 / 4
  { name: "IMC Trading", careersUrl: "https://boards.greenhouse.io/imc", tags: ["global", "india", "fintech"] }, // 15 / 8 (Mumbai)
  { name: "Commvault", careersUrl: "https://boards.greenhouse.io/commvault", tags: ["global", "india", "infra"] }, // 8 / 5
  { name: "Coursera", careersUrl: "https://boards.greenhouse.io/coursera", tags: ["global", "india", "edtech"] }, // 8 / 2
  { name: "LaunchDarkly", careersUrl: "https://boards.greenhouse.io/launchdarkly", tags: ["global", "india", "devtools"] }, // 3 / 1
  { name: "JumpCloud", careersUrl: "https://jobs.lever.co/jumpcloud", tags: ["global", "india", "saas", "remote"] }, // 15 / 8
  { name: "Outreach", careersUrl: "https://jobs.lever.co/outreach", tags: ["global", "india", "saas"] }, // 4 / 2 (Hyderabad)
  { name: "Ema", careersUrl: "https://jobs.ashbyhq.com/ema", tags: ["india", "ai"] }, // 15 / 10 (Bengaluru)
  { name: "Composio", careersUrl: "https://jobs.ashbyhq.com/composio", tags: ["india", "ai", "devtools"] }, // 4 / 1 (Bengaluru)
];

/** IT services / consulting — real employers for early-career engineers, tagged so the
 *  feed can tell them apart from product companies. ≥5 junior/mid India roles. */
export const INDIA_SERVICES_BOARDS: SeedCompany[] = [
  { name: "Embitel (diconium)", careersUrl: "https://diconium.wd3.myworkdayjobs.com/Embitel_Technologies", tags: ["india", "services"] }, // 179 / 107
  { name: "PwC", careersUrl: "https://pwc.wd3.myworkdayjobs.com/Global_Experienced_Careers", tags: ["global", "india", "services"] }, // 94 / 79
  { name: "Capco", careersUrl: "https://boards.greenhouse.io/capco", tags: ["global", "india", "services", "fintech"] }, // 50 / 47
  { name: "JLL Technologies", careersUrl: "https://jll.wd1.myworkdayjobs.com/jllcareers", tags: ["global", "india", "services"] }, // 46 / 30
  { name: "Brillio", careersUrl: "https://jobs.lever.co/brillio-2", tags: ["india", "services"] }, // 71 / 9
  { name: "Unisys", careersUrl: "https://unisys.wd5.myworkdayjobs.com/External", tags: ["global", "india", "services"] }, // 38 / 17
  { name: "R1 RCM", careersUrl: "https://r1rcm.wd1.myworkdayjobs.com/R1RCM", tags: ["global", "india", "health", "services"] }, // 31 / 17
  { name: "Dentsu", careersUrl: "https://dentsuaegis.wd3.myworkdayjobs.com/DAN_GLOBAL", tags: ["global", "india", "services"] }, // 24 / 11
  { name: "Fractal Analytics", careersUrl: "https://fractal.wd1.myworkdayjobs.com/Careers", tags: ["india", "ai", "data", "services"] }, // 35 / 8
  { name: "AHEAD", careersUrl: "https://jobs.lever.co/thinkahead", tags: ["global", "india", "services"] }, // 12 / 5
  { name: "Mindera", careersUrl: "https://apply.workable.com/minderacraft", tags: ["global", "india", "services"] }, // 11 / 5
  { name: "Sigmoid", careersUrl: "https://boards.greenhouse.io/sigmoid", tags: ["india", "data", "services"] }, // 5 / 5
];
