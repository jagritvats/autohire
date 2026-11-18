import { LOCAL_EMBEDDER_ID, localEmbed } from "@jobflow/core";
import { nonEmpty, type CompletionRequest, type LlmProvider, type ProviderConfig } from "../provider.js";
import {
  emptyOutputError,
  fetchWithTimeout,
  mapProviderError,
  refusalError,
  retryAfterMs,
  truncatedOutputError,
  withRetry,
} from "../http.js";

import { GROK_DEFAULT_CHEAP, GROK_DEFAULT_STRONG, OPENAI_DEFAULT_CHEAP, OPENAI_DEFAULT_STRONG } from "../models.js";

export { GROK_DEFAULT_CHEAP, GROK_DEFAULT_STRONG, OPENAI_DEFAULT_CHEAP, OPENAI_DEFAULT_STRONG };
const OPENAI_API = "https://api.openai.com/v1";

/**
 * Covers both xAI Grok and OpenAI — same Chat Completions shape, different base URL
 * + key. The user is "wired for Grok" (§12 Q2); this is the path for it. Also the path
 * for any OpenAI-compatible gateway (base URL override), so the request stays on the
 * classic `max_tokens` shape unless the model family needs otherwise.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private kind: "grok" | "openai";
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
    this.kind = kind;
    const useEnv = cfg.useEnvKey !== false;
    if (kind === "grok") {
      this.apiKey = nonEmpty(cfg.apiKey) ?? (useEnv ? nonEmpty(process.env.XAI_API_KEY) : undefined) ?? "";
      this.baseUrl = nonEmpty(cfg.baseUrl) ?? "https://api.x.ai/v1";
      this.cheapModel = nonEmpty(cfg.cheapModel) ?? GROK_DEFAULT_CHEAP;
      this.strongModel = nonEmpty(cfg.strongModel) ?? GROK_DEFAULT_STRONG;
      this.embedModel = "";
    } else {
      this.apiKey = nonEmpty(cfg.apiKey) ?? (useEnv ? nonEmpty(process.env.OPENAI_API_KEY) : undefined) ?? "";
      this.baseUrl = nonEmpty(cfg.baseUrl) ?? OPENAI_API;
      this.cheapModel = nonEmpty(cfg.cheapModel) ?? OPENAI_DEFAULT_CHEAP;
      this.strongModel = nonEmpty(cfg.strongModel) ?? OPENAI_DEFAULT_STRONG;
      this.embedModel = "text-embedding-3-small";
    }
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");
  }

  /** the exact JSON body sent for a request (exposed for tests). */
  buildBody(req: CompletionRequest): Record<string, unknown> {
    const model = req.task === "cheap" ? this.cheapModel : this.strongModel;
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }];
    const visible = req.maxTokens ?? 1024;
    const reasoning = isReasoningModel(model);
    // reasoning tokens are billed against the completion limit — add headroom so the
    // visible reply isn't starved (same reason as the Anthropic provider)
    const limit = reasoning ? visible + (req.task === "cheap" ? 2_048 : 8_192) : visible;
    const body: Record<string, unknown> = { model, messages };
    // OpenAI's reasoning families reject `max_tokens` (and any non-default temperature);
    // every model on OpenAI's own API takes `max_completion_tokens`. xAI and other
    // OpenAI-compatible gateways keep the classic field.
    const official = this.kind === "openai" && this.baseUrl === OPENAI_API;
    if (official || (reasoning && this.kind === "openai")) body.max_completion_tokens = limit;
    else body.max_tokens = limit;
    if (!reasoning) body.temperature = req.temperature ?? 0.3;
    if (req.json) body.response_format = { type: "json_object" };
    return body;
  }

  async complete(req: CompletionRequest): Promise<string> {
    const bodyObj = this.buildBody(req);
    const body = JSON.stringify(bodyObj);
    const label = this.name;
    const limit = (bodyObj.max_completion_tokens ?? bodyObj.max_tokens) as number;
    return withRetry(
      async () => {
        const res = await fetchWithTimeout(
          `${this.baseUrl}/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` }, body },
          req.timeoutMs ?? 45_000,
          label,
        );
        if (!res.ok) throw mapProviderError(res.status, await res.text(), label, retryAfterMs(res), [this.apiKey]);
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
        };
        const choice = data.choices?.[0];
        if (choice?.finish_reason === "content_filter" || choice?.message?.refusal) {
          throw refusalError(label, choice?.message?.refusal ?? "content_filter");
        }
        const text = choice?.message?.content ?? "";
        if (choice?.finish_reason === "length") {
          if (req.requireComplete) throw truncatedOutputError(label, limit);
          if (!text.trim()) throw emptyOutputError(label, limit);
        }
        return text;
      },
      { name: label, retries: req.retries },
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.embedModel || !this.apiKey) return texts.map((t) => localEmbed(t));
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/embeddings`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.embedModel, input: texts }),
        },
        30_000,
        this.name,
      );
      if (!res.ok) return texts.map((t) => localEmbed(t));
      const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      const vecs = data.data?.map((d) => d.embedding);
      return vecs && vecs.length === texts.length ? vecs : texts.map((t) => localEmbed(t));
    } catch {
      // a slow/unreachable embeddings endpoint must never stall or fail a poll
      return texts.map((t) => localEmbed(t));
    }
  }
}

/**
 * Model families that reason before answering: OpenAI o-series + GPT-5, xAI Grok 4 and
 * grok-3-mini. They reject sampling params (OpenAI: non-default temperature is a 400).
 */
export function isReasoningModel(model: string): boolean {
  const id = model.toLowerCase().replace(/^.*\//, "");
  return /^(?:o\d|gpt-5|grok-4|grok-3-mini)/.test(id) && !/non-reasoning|-chat/.test(id);
}
