import "server-only";
import { createProvider, providerEmbedder } from "@jobflow/llm";
import type { Embedder } from "@jobflow/pipeline";

let embedder: Embedder | null = null;

/**
 * The embedder the stored corpus was built with — the env-configured provider, exactly
 * as the worker uses. Profile and posting vectors must come from the same model (cosine
 * across two models is noise), so every web path that embeds or re-ranks uses this one,
 * not the per-tenant generation model from Settings.
 */
export function corpusEmbedder(): Embedder {
  embedder ??= providerEmbedder(createProvider());
  return embedder;
}
