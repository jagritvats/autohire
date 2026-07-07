export * from "./provider.js";
export * from "./http.js";
export * from "./factory.js";
export * from "./prompts.js";
export * from "./rerank.js";
export * from "./generate.js";
export * from "./latex.js";
export * from "./markdown.js";

import { localEmbed } from "@jobflow/core";
import type { LlmProvider } from "./provider.js";

/** An Embedder (pipeline's type) backed by an LLM provider, with local fallback. */
export function providerEmbedder(llm: LlmProvider): (text: string) => Promise<number[]> {
  return async (text: string) => {
    try {
      const [v] = await llm.embed([text]);
      return v ?? localEmbed(text);
    } catch {
      return localEmbed(text);
    }
  };
}
