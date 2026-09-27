import { LOCAL_EMBEDDER_ID, localEmbed } from "@jobflow/core";

/**
 * An embedder maps text → vector. Default is the offline hashing embedder; the LLM
 * package provides a real-model embedder with the same signature for prod. `id` names
 * the model, so a stored vector is reused only when the same model would produce it.
 */
export type Embedder = ((text: string) => Promise<number[]>) & { readonly id?: string };

export const localEmbedder: Embedder = Object.assign(async (text: string) => localEmbed(text), { id: LOCAL_EMBEDDER_ID });
