import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, createProvider, providerForTenant, redactSecrets } from "../src/index.js";
import { AnthropicProvider, claudeCaps } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider, isReasoningModel } from "../src/providers/openai-compatible.js";

const ENV_KEYS = ["LLM_PROVIDER", "LLM_MODEL_CHEAP", "LLM_MODEL_STRONG", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

/** capture the request a provider sends, answer with `reply` */
function stubFetch(reply: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body ?? "{}")) });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status });
  });
  return calls;
}

describe("redactSecrets", () => {
  it("masks provider keys, bearer headers, JobFlow tokens and known values", () => {
    const msg =
      'Incorrect API key provided: sk-proj-abcDEF123456. anthropic sk-ant-api03-XYZxyz_987654 xai-AbCdEf123456 ' +
      "Authorization: Bearer abc.def.ghi jft_1a2b3c.secretpart x-api-key: plainkey99 custom=MyOddKey!42";
    const out = redactSecrets(msg, ["MyOddKey!42"]);
    for (const leaked of ["abcDEF123456", "XYZxyz_987654", "AbCdEf123456", "abc.def.ghi", "secretpart", "plainkey99", "MyOddKey!42"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("sk-***");
    expect(out).toContain("sk-ant-***");
    expect(out).toContain("Bearer ***");
  });

  it("leaves ordinary text alone and ignores very short known values", () => {
    expect(redactSecrets("model not found: claude-opus-5-5", ["k"])).toBe("model not found: claude-opus-5-5");
  });

  it("provider HTTP errors never carry the key", async () => {
    stubFetch({ error: { message: "Incorrect API key provided: tenant-secret-key-123" } }, 401);
    const llm = createProvider({ provider: "openai", apiKey: "tenant-secret-key-123" });
    const err = (await llm.complete({ prompt: "x", retries: 0 }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.detail).not.toContain("tenant-secret-key-123");
    expect(err.message).not.toContain("tenant-secret-key-123");
  });
});

describe("createProvider config merge", () => {
  it('treats "" as unset: env models are not clobbered by blank or undefined config', () => {
    process.env.LLM_MODEL_STRONG = "claude-sonnet-5-5";
    process.env.LLM_MODEL_CHEAP = "";
    const llm = createProvider({ provider: "anthropic", apiKey: "k", strongModel: undefined, cheapModel: "" }) as AnthropicProvider;
    expect(llm.buildBody({ prompt: "x" }).model).toBe("claude-sonnet-5-5");
    expect(llm.buildBody({ prompt: "x", task: "cheap" }).model).toBe("claude-haiku-5-5");
  });

  it('an empty LLM_PROVIDER falls back to echo; explicit "" model falls back to the default', () => {
    process.env.LLM_PROVIDER = "";
    expect(createProvider().name).toBe("echo");
    process.env.LLM_MODEL_STRONG = "";
    const llm = createProvider({ provider: "anthropic", apiKey: "k" }) as AnthropicProvider;
    expect(llm.buildBody({ prompt: "x" }).model).toBe("claude-opus-5-5");
  });
});

describe("Anthropic request shape", () => {
  it("never sends temperature to current models; keeps it for legacy ones", () => {
    const current = new AnthropicProvider({ apiKey: "k" });
    expect(current.buildBody({ prompt: "x", temperature: 0 })).not.toHaveProperty("temperature");
    const legacy = new AnthropicProvider({ apiKey: "k", strongModel: "claude-sonnet-4-6" });
    expect(legacy.buildBody({ prompt: "x", temperature: 0 }).temperature).toBe(0);
    for (const m of ["claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-next-unknown"]) {
      expect(claudeCaps(m).acceptsSampling, m).toBe(false);
    }
    for (const m of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-opus-4-6"]) {
      expect(claudeCaps(m).acceptsSampling, m).toBe(true);
    }
  });

  it("adds thinking headroom on models that think by default, not on legacy ones", () => {
    expect(new AnthropicProvider({ apiKey: "k" }).buildBody({ prompt: "x", maxTokens: 500 }).max_tokens).toBeGreaterThan(500);
    expect(new AnthropicProvider({ apiKey: "k", strongModel: "claude-opus-4-8" }).buildBody({ prompt: "x", maxTokens: 500 }).max_tokens).toBe(500);
  });

  it("only asks for server-side refusal fallbacks on the first-party API", () => {
    expect(new AnthropicProvider({ apiKey: "k" }).buildBody({ prompt: "x" }).fallbacks).toBe("default");
    expect(new AnthropicProvider({ apiKey: "k", baseUrl: "https://gw.example/v1" }).buildBody({ prompt: "x" })).not.toHaveProperty("fallbacks");
    expect(new AnthropicProvider({ apiKey: "k", cheapModel: "claude-haiku-5-5" }).buildBody({ prompt: "x", task: "cheap" })).not.toHaveProperty("fallbacks");
  });

  it("sends the beta header with fallbacks and returns only text blocks", async () => {
    const calls = stubFetch({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "ok" }], stop_reason: "end_turn" });
    const out = await createProvider({ provider: "anthropic", apiKey: "k" }).complete({ prompt: "x" });
    expect(out).toBe("ok");
    expect((calls[0]!.init.headers as Record<string, string>)["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
  });

  it("a refusal is an error, never text — and is not retried", async () => {
    const calls = stubFetch({ content: [{ type: "text", text: "partial" }], stop_reason: "refusal", stop_details: { category: "cyber", explanation: "x" } });
    const llm = createProvider({ provider: "anthropic", apiKey: "k" });
    await expect(llm.complete({ prompt: "x" })).rejects.toThrow(/declined/);
    expect(calls).toHaveLength(1);
  });

  it("max_tokens with no visible text is an error even when completeness isn't required", async () => {
    stubFetch({ content: [{ type: "thinking", thinking: "" }], stop_reason: "max_tokens" });
    await expect(createProvider({ provider: "anthropic", apiKey: "k" }).complete({ prompt: "x" })).rejects.toThrow(/output budget/);
  });
});

describe("OpenAI-compatible request shape", () => {
  it("OpenAI reasoning models: max_completion_tokens, no temperature", () => {
    const llm = new OpenAICompatibleProvider("openai", { apiKey: "k" });
    const body = llm.buildBody({ prompt: "x", maxTokens: 500, temperature: 0.4 });
    expect(body.model).toBe("gpt-5");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_completion_tokens).toBeGreaterThan(500);
  });

  it("gateways and classic models keep max_tokens + temperature", () => {
    const gw = new OpenAICompatibleProvider("openai", { apiKey: "k", baseUrl: "http://localhost:11434/v1", strongModel: "llama3.1" });
    const body = gw.buildBody({ prompt: "x", maxTokens: 500 });
    expect(body.max_tokens).toBe(500);
    expect(body.temperature).toBe(0.3);
    const grok = new OpenAICompatibleProvider("grok", { apiKey: "k" });
    expect(grok.buildBody({ prompt: "x" })).toHaveProperty("max_tokens");
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("o3-mini")).toBe(true);
  });

  it("content_filter is surfaced as a refusal", async () => {
    stubFetch({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] });
    await expect(createProvider({ provider: "openai", apiKey: "k" }).complete({ prompt: "x" })).rejects.toThrow(/declined/);
  });

  it("embed() falls back to local vectors when the endpoint fails", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const v = await createProvider({ provider: "openai", apiKey: "k" }).embed(["hello world"]);
    expect(v).toHaveLength(1);
    expect(v[0]!.length).toBeGreaterThan(0);
  });
});

describe("providerForTenant", () => {
  it("uses the tenant's own key, model and base URL", async () => {
    process.env.ANTHROPIC_API_KEY = "operator-key-xyz";
    process.env.LLM_PROVIDER = "anthropic";
    const calls = stubFetch({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
    const llm = providerForTenant(
      { llmChoice: "anthropic", llmApiKey: "tenant-key-abc", llmModel: "claude-sonnet-5-5", llmBaseUrl: "" },
      { operatorFallback: true },
    );
    await llm.complete({ prompt: "x" });
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("tenant-key-abc");
    expect(calls[0]!.body.model).toBe("claude-sonnet-5-5");
  });

  it("without a tenant key: echo unless the operator shares their key", () => {
    process.env.ANTHROPIC_API_KEY = "operator-key-xyz";
    process.env.LLM_PROVIDER = "anthropic";
    expect(providerForTenant({ llmChoice: "anthropic" }, { operatorFallback: false }).name).toBe("echo");
    expect(providerForTenant(null, { operatorFallback: false }).name).toBe("echo");
    expect(providerForTenant({ llmChoice: "anthropic" }, { operatorFallback: true }).name).toBe("anthropic");
    expect(providerForTenant({}, { operatorFallback: true }).name).toBe("anthropic");
  });

  it("a tenant's own base URL never receives the operator's key", async () => {
    process.env.OPENAI_API_KEY = "operator-key-xyz";
    process.env.LLM_PROVIDER = "openai";
    const calls = stubFetch({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    // keyless gateway → tenant path with no key at all
    await providerForTenant({ llmChoice: "openai", llmBaseUrl: "https://evil.example/v1" }, { operatorFallback: true }).complete({ prompt: "x" });
    expect(calls[0]!.url.startsWith("https://evil.example/v1")).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).not.toContain("operator-key-xyz");
  });

  it("operator fallback never mixes providers or honours echo", () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "operator-key-xyz";
    expect(providerForTenant({ llmChoice: "openai" }, { operatorFallback: true }).name).toBe("echo");
    expect(providerForTenant({ llmChoice: "echo", llmApiKey: "x" }, { operatorFallback: true }).name).toBe("echo");
  });
});
