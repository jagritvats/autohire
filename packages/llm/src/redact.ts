/**
 * Mask credentials in text that may reach logs, job rows or an HTTP client (provider
 * error bodies, network error messages). Providers sometimes echo the key they were
 * sent ("Incorrect API key provided: sk-…"), and a gateway can echo the Authorization
 * header — none of that may leave the process unmasked (§ external flows: BYO keys).
 *
 * Pattern-based for the token shapes we hand out or accept (Anthropic, OpenAI, xAI,
 * bearer headers, JobFlow API tokens) plus exact `known` values (the key actually in
 * use), so an unusual key format is still caught.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // order matters: the Anthropic prefix before the generic OpenAI-style `sk-`
  [/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-***"],
  [/sk-[A-Za-z0-9_-]{6,}/g, "sk-***"],
  [/xai-[A-Za-z0-9_-]{6,}/g, "xai-***"],
  [/jft_[A-Za-z0-9._-]{4,}/g, "jft_***"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi, "$1***"],
  // header/JSON echoes of a key under its usual names
  [/((?:x-api-key|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\b)[^\s"',;}]{4,}/gi, "$1***"],
];

export function redactSecrets(msg: string, known: Array<string | undefined | null> = []): string {
  let out = String(msg ?? "");
  // exact values first (longest first so a key containing another isn't half-masked);
  // very short values are skipped — masking "k" would shred ordinary text
  const exact = [...new Set(known.filter((k): k is string => typeof k === "string" && k.trim().length >= 6))].sort(
    (a, b) => b.length - a.length,
  );
  for (const k of exact) out = out.split(k).join("***");
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}
