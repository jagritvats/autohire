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

export const ANTHROPIC_DEFAULT_CHEAP = "claude-haiku-5-5";
export const ANTHROPIC_DEFAULT_STRONG = "claude-opus-5-5";
const ANTHROPIC_API = "https://api.anthropic.com/v1";

/**
 * Claude via the Messages API. Strong model for re-rank/answers; cheap for normalize.
 *
 * Request shape follows what each model accepts — a parameter a model rejects is a 400
 * on EVERY call, so it must not be sent at all:
 *   - sampling params (`temperature`) were removed from current models (Opus 4.7+,
 *     Sonnet 5+, Haiku 5+, Fable/Mythos); only the 3.x / ≤4.6 generation takes them;
 *   - current models think by default and thinking tokens count against `max_tokens`,
 *     so the caller's visible-reply budget gets thinking headroom on top (else a 500-
 *     token JSON reply can be consumed entirely by reasoning).
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly embedderId = LOCAL_EMBEDDER_ID; // no embeddings endpoint — embed() is local
  private apiKey: string;
  private cheapModel: string;
  private strongModel: string;
  private baseUrl: string;

  constructor(cfg: ProviderConfig) {
    const envKey = cfg.useEnvKey === false ? undefined : nonEmpty(process.env.ANTHROPIC_API_KEY);
    this.apiKey = nonEmpty(cfg.apiKey) ?? envKey ?? "";
    this.cheapModel = nonEmpty(cfg.cheapModel) ?? ANTHROPIC_DEFAULT_CHEAP;
    this.strongModel = nonEmpty(cfg.strongModel) ?? ANTHROPIC_DEFAULT_STRONG;
    this.baseUrl = (nonEmpty(cfg.baseUrl) ?? ANTHROPIC_API).replace(/\/+$/, "");
  }

  /** the exact JSON body sent for a request (exposed for tests). */
  buildBody(req: CompletionRequest): Record<string, unknown> {
    const model = req.task === "cheap" ? this.cheapModel : this.strongModel;
    const system = req.json
      ? `${req.system ?? ""}\nRespond with ONLY valid JSON, no prose, no markdown fences.`.trim()
      : req.system;
    const visible = req.maxTokens ?? 1024;
    const caps = claudeCaps(model);
    const body: Record<string, unknown> = {
      model,
      max_tokens: caps.thinksByDefault ? Math.min(visible + thinkingHeadroom(req.task), MAX_NON_STREAMING) : visible,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: req.prompt }],
    };
    if (caps.acceptsSampling) body.temperature = req.temperature ?? 0.3;
    // cheap calls (normalize/extract) don't need deep reasoning; strong keeps the
    // model's own default effort
    if (caps.thinksByDefault && req.task === "cheap") body.output_config = { effort: "low" };
    // safety-declined requests are re-run on a fallback model server-side (only on the
    // first-party API — a gateway may not know the beta field)
    if (caps.serverFallback && this.baseUrl === ANTHROPIC_API) body.fallbacks = "default";
    return body;
  }

  async complete(req: CompletionRequest): Promise<string> {
    const bodyObj = this.buildBody(req);
    const body = JSON.stringify(bodyObj);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
    if (bodyObj.fallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    const secrets = [this.apiKey];
    return withRetry(
      async () => {
        const res = await fetchWithTimeout(`${this.baseUrl}/messages`, { method: "POST", headers, body }, req.timeoutMs ?? 45_000, "Anthropic");
        if (!res.ok) throw mapProviderError(res.status, await res.text(), "Anthropic", retryAfterMs(res), secrets);
        const data = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
          stop_reason?: string;
          stop_details?: { category?: string | null; explanation?: string | null } | null;
        };
        // check stop_reason BEFORE reading content: a refusal is never a draft
        if (data.stop_reason === "refusal") {
          const d = data.stop_details;
          throw refusalError("Anthropic", [d?.category, d?.explanation].filter(Boolean).join(": ") || "(no details)");
        }
        // thinking blocks are skipped — only the visible reply is returned
        const text = data.content?.map((c) => (c.type === undefined || c.type === "text" ? c.text ?? "" : "")).join("") ?? "";
        if (data.stop_reason === "max_tokens") {
          if (req.requireComplete) throw truncatedOutputError("Anthropic", bodyObj.max_tokens as number);
          if (!text.trim()) throw emptyOutputError("Anthropic", bodyObj.max_tokens as number);
        }
        return text;
      },
      { name: "Anthropic", retries: req.retries },
    );
  }

  /** Anthropic has no public embeddings endpoint → use the local embedder.
   *  Swap for Voyage/OpenAI embeddings in prod if higher fidelity is needed. */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => localEmbed(t));
  }
}

/** Raw-HTTP non-streaming requests stay well under the 10-minute request ceiling. */
const MAX_NON_STREAMING = 32_000;

function thinkingHeadroom(task: CompletionRequest["task"]): number {
  return task === "cheap" ? 2_048 : 8_192;
}

export interface ClaudeCaps {
  /** temperature/top_p/top_k accepted (removed on current models → 400). */
  acceptsSampling: boolean;
  /** adaptive thinking runs when `thinking` is omitted; its tokens share max_tokens. */
  thinksByDefault: boolean;
  /** supports the server-side refusal fallback (`fallbacks: "default"`). */
  serverFallback: boolean;
}

/**
 * What a Claude model id accepts, from its family + version. Unknown / future ids are
 * treated as current-generation (no sampling, thinks by default) — the safe direction:
 * omitting a param never 400s, sending a removed one does.
 */
export function claudeCaps(model: string): ClaudeCaps {
  const id = model.toLowerCase().replace(/^.*\//, "").replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
  if (/fable|mythos/.test(id)) {
    return { acceptsSampling: false, thinksByDefault: true, serverFallback: /fable-5-[12](?!\d)/.test(id) };
  }
  if (/^claude-(?:instant|2|3)/.test(id)) return { acceptsSampling: true, thinksByDefault: false, serverFallback: false };
  const m = /(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);
  if (!m) return { acceptsSampling: false, thinksByDefault: true, serverFallback: false };
  const family = m[1]!;
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  if (major < 4) return { acceptsSampling: true, thinksByDefault: false, serverFallback: false };
  if (major === 4) {
    // 4.0–4.6 take sampling params; 4.7/4.8 removed them but still think only on request
    return { acceptsSampling: minor <= 6, thinksByDefault: false, serverFallback: false };
  }
  // only the models documented to take `fallbacks` (Opus 5 / 5.5, Sonnet 5.5) — an
  // unknown model with the field would 400 on every call
  const serverFallback =
    (family === "opus" && major === 5 && (minor === 0 || minor === 5)) || (family === "sonnet" && major === 5 && minor === 5);
  return { acceptsSampling: false, thinksByDefault: true, serverFallback };
}
