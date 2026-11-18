/**
 * Links from the UI into the user guides (docs/ in the repo). Client-safe: the upstream
 * repository, the same default the footer's AGPL "source" link uses.
 */
const DOCS_BASE = "https://github.com/jagritvats/jobflow/blob/main/docs/";

export function docUrl(path: string): string {
  return DOCS_BASE + path.replace(/^\/+/, "");
}

export const LOCAL_AGENT_GUIDE = docUrl("guides/local-agent.md");
