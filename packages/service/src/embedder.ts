import { createProvider, providerEmbedder } from "@jobflow/llm";
import type { Embedder } from "@jobflow/pipeline";

let embedder: Embedder | null = null;

/**
 * The embedder the shared corpus is built with — the OPERATOR's env-configured provider,
 * exactly as the worker uses. Profile and posting vectors must come from the same model
 * (cosine across two models is noise), and a tenant's own LLM key is never spent on the
 * shared corpus, so every path that embeds or ranks uses this one.
 */
export function corpusEmbedder(): Embedder {
  embedder ??= providerEmbedder(createProvider());
  return embedder;
}
