import { LOCAL_EMBEDDER_ID, localEmbed } from "@jobflow/core";
import type { CompletionRequest, LlmProvider, ProviderConfig } from "../provider.js";
import { fetchWithTimeout, mapProviderError, retryAfterMs, truncatedOutputError, withRetry } from "../http.js";

/**
 * Covers both xAI Grok and OpenAI — same Chat Completions shape, different base URL
 * + key. The user is "wired for Grok" (§12 Q2); this is the path for it.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private apiKey: string;
  private cheapModel: string;
  private strongModel: string;
  private baseUrl: string;
  private embedModel: string;

  /** local when there's no embedding model/key — embed() then falls back to localEmbed */
  get embedderId(): string {
    return this.embedModel && this.apiKey ? `${this.name}:${this.embedModel}` : LOCAL_EMBEDDER_ID;
  }

  constructor(kind: "grok" | "openai", cfg: ProviderConfig) {
    this.name = kind;
    if (kind === "grok") {
      this.apiKey = cfg.apiKey ?? process.env.XAI_API_KEY ?? "";
      this.baseUrl = cfg.baseUrl ?? "https://api.x.ai/v1";
      this.cheapModel = cfg.cheapModel ?? "grok-3-mini";
      this.strongModel = cfg.strongModel ?? "grok-4";
      this.embedModel = "";
    } else {
      this.apiKey = cfg.apiKey ?? process.env.OPENAI_API_KEY ?? "";
      this.baseUrl = cfg.baseUrl ?? "https://api.openai.com/v1";
      this.cheapModel = cfg.cheapModel ?? "gpt-4o-mini";
      this.strongModel = cfg.strongModel ?? "gpt-4o";
      this.embedModel = "text-embedding-3-small";
    }
  }

  async complete(req: CompletionRequest): Promise<string> {
    const model = req.task === "cheap" ? this.cheapModel : this.strongModel;
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.prompt },
    ];
    const body = JSON.stringify({
      model,
      messages,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 1024,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    });
    const label = this.name;
    return withRetry(
      async () => {
        const res = await fetchWithTimeout(
          `${this.baseUrl}/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` }, body },
          req.timeoutMs ?? 45_000,
          label,
        );
        if (!res.ok) throw mapProviderError(res.status, await res.text(), label, retryAfterMs(res));
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
        if (req.requireComplete && data.choices?.[0]?.finish_reason === "length") throw truncatedOutputError(label, req.maxTokens);
        return data.choices?.[0]?.message?.content ?? "";
      },
      { name: label, retries: req.retries },
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.embedModel || !this.apiKey) return texts.map((t) => localEmbed(t));
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.embedModel, input: texts }),
    });
    if (!res.ok) return texts.map((t) => localEmbed(t));
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    return data.data?.map((d) => d.embedding) ?? texts.map((t) => localEmbed(t));
  }
}
