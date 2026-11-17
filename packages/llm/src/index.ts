export * from "./provider.js";
export * from "./http.js";
export * from "./factory.js";
export * from "./prompts.js";
export * from "./rerank.js";
export * from "./generate.js";
export * from "./latex.js";
export * from "./markdown.js";
export * from "./extract.js";

import { localEmbed } from "@jobflow/core";
import type { LlmProvider } from "./provider.js";

/**
 * An Embedder (pipeline's type) backed by an LLM provider, with local fallback. `id`
 * names the model so stored vectors are reused only under the same one; a fallback
 * vector carries its own "local" origin (see embedOrigin), so it's re-embedded later.
 */
export function providerEmbedder(llm: LlmProvider): ((text: string) => Promise<number[]>) & { readonly id: string } {
  const embed = async (text: string) => {
    try {
      const [v] = await llm.embed([text]);
      return v ?? localEmbed(text);
    } catch {
      return localEmbed(text);
    }
  };
  return Object.assign(embed, { id: llm.embedderId ?? `provider:${llm.name}` });
}
