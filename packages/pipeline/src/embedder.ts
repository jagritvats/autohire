import { localEmbed } from "@jobflow/core";

/** An embedder maps text → vector. Default is the offline hashing embedder; the
 *  LLM package provides a real-model embedder with the same signature for prod. */
export type Embedder = (text: string) => Promise<number[]>;

export const localEmbedder: Embedder = async (text: string) => localEmbed(text);
