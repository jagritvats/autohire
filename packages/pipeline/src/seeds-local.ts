import type { SeedCompany } from "./discover.js";

/**
 * Boards only the LOCAL agent can poll (invariant #1) — Darwinbox careers sites sit
 * behind Cloudflare, which rejects non-browser clients. The ATS Detector resolves these
 * URLs to (darwinbox, tenant) from the URL alone, with no network probe; the cloud poll
 * skips boards with no cloud adapter, and the agent's `local_board_poll` reads them in
 * the user's browser. Without the agent (or with `darwinbox` not opted in) they simply
 * stay unpolled.
 *
 * Verified 2026-09-27 in a browser session against
 * POST /ms/candidateapi/job/alljobs?companyId=main (job counts that day):
 *   Porter 123 (mostly operations; SDE / EM roles in Bengaluru), Upstox 24 (security,
 *   SRE…; Mumbai + Bengaluru), Seclore 15 (8 engineering, Mumbai), Rapido 0 (tenant live,
 *   nothing listed — kept so new roles surface; an empty fetch never stales anything).
 * Left out: CleverTap (its tenant has recruitment switched off — careers aren't on
 * Darwinbox), Udaan (21 listed, all posted 2022–23: a ghost board).
 */
export const LOCAL_BOARD_SEEDS: SeedCompany[] = [
  { name: "Porter", careersUrl: "https://porter.darwinbox.in/ms/candidate/careers", tags: ["india", "logistics", "local-board"] },
  { name: "Upstox", careersUrl: "https://upstox.darwinbox.in/ms/candidate/careers", tags: ["india", "fintech", "local-board"] },
  { name: "Seclore", careersUrl: "https://seclore.darwinbox.in/ms/candidate/careers", tags: ["india", "saas", "security", "local-board"] },
  { name: "Rapido", careersUrl: "https://rapido.darwinbox.in/ms/candidate/careers", tags: ["india", "consumer", "local-board"] },
];
