import { LOCAL_EMBEDDER_ID, localEmbed } from "@jobflow/core";
import type { CompletionRequest, LlmProvider, ProviderConfig } from "../provider.js";
import { fetchWithTimeout, mapProviderError, retryAfterMs, withRetry } from "../http.js";

/** Claude via the Messages API. Strong model for re-rank/answers; cheap for normalize. */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly embedderId = LOCAL_EMBEDDER_ID; // no embeddings endpoint — embed() is local
  private apiKey: string;
  private cheapModel: string;
  private strongModel: string;
  private baseUrl: string;

  constructor(cfg: ProviderConfig) {
    this.apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.cheapModel = cfg.cheapModel ?? "claude-haiku-4-5-20251001";
    this.strongModel = cfg.strongModel ?? "claude-opus-4-8";
    this.baseUrl = cfg.baseUrl ?? "https://api.anthropic.com/v1";
  }

  async complete(req: CompletionRequest): Promise<string> {
    const model = req.task === "cheap" ? this.cheapModel : this.strongModel;
    const system = req.json
      ? `${req.system ?? ""}\nRespond with ONLY valid JSON, no prose, no markdown fences.`.trim()
      : req.system;
    const body = JSON.stringify({
      model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.3,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: req.prompt }],
    });
    return withRetry(
      async () => {
        const res = await fetchWithTimeout(
          `${this.baseUrl}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
            body,
          },
          req.timeoutMs ?? 45_000,
          "Anthropic",
        );
        if (!res.ok) throw mapProviderError(res.status, await res.text(), "Anthropic", retryAfterMs(res));
        const data = (await res.json()) as { content?: Array<{ text?: string }> };
        return data.content?.map((c) => c.text ?? "").join("") ?? "";
      },
      { name: "Anthropic" },
    );
  }

  /** Anthropic has no public embeddings endpoint → use the local embedder.
   *  Swap for Voyage/OpenAI embeddings in prod if higher fidelity is needed. */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => localEmbed(t));
  }
}
