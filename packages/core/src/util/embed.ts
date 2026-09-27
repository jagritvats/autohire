/**
 * Deterministic local embedding (hashing trick). NOT a substitute for a real model
 * — it's the offline/dev fallback so semantic match + dedup stage-2 work with zero
 * API keys. In production the LLM package swaps in a real embedding model and the
 * vectors live in pgvector. Same downstream code (cosine) either way.
 *
 * Token-hashed into a fixed-dim sparse-ish vector with sublinear TF weighting, then
 * L2-normalized — enough to make "Go + Kafka + Postgres backend" land near a Java
 * distributed-systems profile.
 */

const DIM = 256;

/**
 * Identity of the local embedder, stored in `Posting.embedKey` so a re-poll can reuse an
 * unchanged vector. Bump the version if the hashing scheme ever changes.
 */
export const LOCAL_EMBEDDER_ID = "local-v1";

/**
 * Which embedder actually produced a vector. `localEmbed` tags its output (a
 * non-enumerable property, gone once serialized) because LLM providers fall back to it
 * silently — a fallback vector must be keyed "local", not as the model that failed.
 */
export function embedOrigin(vec: number[]): string | undefined {
  return (vec as number[] & { embedOrigin?: string }).embedOrigin;
}

function tagLocal(vec: number[]): number[] {
  Object.defineProperty(vec, "embedOrigin", { value: LOCAL_EMBEDDER_ID, enumerable: false });
  return vec;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && t.length < 30);
}

function hash(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function localEmbed(text: string, dim = DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  if (!text) return tagLocal(vec);
  const counts = new Map<string, number>();
  for (const tok of tokenize(text)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  for (const [tok, c] of counts) {
    const idx = hash(tok) % dim;
    const sign = (hash(tok + "_s") & 1) === 0 ? 1 : -1;
    vec[idx]! += sign * (1 + Math.log(c)); // sublinear TF
  }
  // L2 normalize
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  return tagLocal(vec.map((v) => v / n));
}
